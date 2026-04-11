"""EDOG Dev Server — serves HTML, /api/flt/config, and proxies Fabric API calls.

Proxy strategy (per docs/fabric-api-reference.md):
  - Forward v1 paths as-is to the redirect host (they return clean shapes)
  - Only /workspaces (top-level) uses /metadata/workspaces (for capacityId)
  - Bearer token is attached server-side (avoids CORS)
"""
import base64
import json
import ssl
import subprocess
import threading
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from socketserver import ThreadingMixIn

PROJECT_DIR = Path(__file__).parent.parent
CONFIG_PATH = PROJECT_DIR / "edog-config.json"
BEARER_CACHE = PROJECT_DIR / ".edog-bearer-cache"
MWC_CACHE = PROJECT_DIR / ".edog-token-cache"
SESSION_FILE = PROJECT_DIR / ".edog-session.json"
HTML_PATH = PROJECT_DIR / "src" / "edog-logs.html"

REDIRECT_HOST = "https://biazure-int-edog-redirect.analysis-df.windows.net"

# In-memory MWC token cache — keyed by "ws:lh:cap" composite
_mwc_cache: dict = {}  # value: {"token": str, "host": str, "expiry": float}
_mwc_lock = threading.Lock()


def _write_cache(path: Path, token: str, expiry: float):
    """Write base64-encoded timestamp|token cache file."""
    data = f"{expiry}|{token}"
    path.write_text(base64.b64encode(data.encode()).decode(), encoding="utf-8")


def _read_cache(path: Path) -> tuple:
    """Read base64-encoded timestamp|token cache file."""
    if not path.exists():
        return None, None
    try:
        raw = path.read_text().strip()
        decoded = base64.b64decode(raw.encode()).decode()
        expiry_str, token = decoded.split("|", 1)
        expiry = float(expiry_str)
        if time.time() >= expiry - 300:
            return None, None
        return token, expiry
    except Exception:
        return None, None


def _save_session(data: dict):
    """Merge data into the session file."""
    existing = _load_session()
    existing.update(data)
    SESSION_FILE.write_text(json.dumps(existing, indent=2), encoding="utf-8")


def _load_session() -> dict:
    """Load session file or return empty dict."""
    if not SESSION_FILE.exists():
        return {}
    try:
        return json.loads(SESSION_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _map_path(fabric_path: str) -> str:
    """Map browser path to redirect host path.

    Most v1 paths forward as-is — they work on the redirect host.
    Only top-level /workspaces needs rewriting to /metadata/workspaces
    because /v1/workspaces returns 401 on the redirect host.
    """
    # Top-level workspace listing → use metadata endpoint (has capacityObjectId)
    if fabric_path == "/workspaces" or fabric_path.startswith("/workspaces?"):
        return fabric_path.replace("/workspaces", "/metadata/workspaces", 1)

    # Everything else: forward v1 path as-is — the redirect host handles them
    # /workspaces/{id}/items → /v1/workspaces/{id}/items  (already correct)
    # /workspaces/{id}/lakehouses → /v1/workspaces/{id}/lakehouses
    # /workspaces/{id}/lakehouses/{id}/tables → /v1/workspaces/{id}/lakehouses/{id}/tables
    # PATCH /workspaces/{id} → PATCH /v1/workspaces/{id}
    return "/v1" + fabric_path


def _normalize_workspaces(resp_body: bytes) -> bytes:
    """Transform /metadata/workspaces {folders:[...]} → {value:[...]} with standard field names."""
    try:
        data = json.loads(resp_body)
    except (json.JSONDecodeError, ValueError):
        return resp_body

    if not isinstance(data, dict) or "folders" not in data:
        return resp_body

    normalized = []
    for f in data["folders"]:
        normalized.append({
            "id": f.get("objectId", str(f.get("id", ""))),
            "displayName": f.get("displayName", ""),
            "type": "Workspace",
            "capacityId": f.get("capacityObjectId", ""),
            "state": "Active",
            "description": f.get("description", ""),
        })
    return json.dumps({"value": normalized}).encode()


def _get_mwc_token(bearer: str, ws_id: str, lh_id: str, cap_id: str) -> tuple:
    """Generate or retrieve cached MWC token for a workspace/lakehouse/capacity tuple.

    Args:
        bearer: Bearer token for authentication.
        ws_id: Workspace object ID.
        lh_id: Lakehouse object ID.
        cap_id: Capacity object ID.

    Returns:
        Tuple of (mwc_token, host_url).

    Raises:
        urllib.error.HTTPError: If the token endpoint returns an error.
    """
    cache_key = f"{ws_id}:{lh_id}:{cap_id}"
    with _mwc_lock:
        cached = _mwc_cache.get(cache_key)
        if cached and time.time() < cached["expiry"] - 300:
            print(f"  [MWC] Cache hit for {cache_key[:20]}...")
            return cached["token"], cached["host"]

    print(f"  [MWC] Generating token for ws={ws_id[:8]}... lh={lh_id[:8]}...")
    body = json.dumps({
        "type": "[Start] GetMWCToken",
        "workloadType": "Lakehouse",
        "workspaceObjectId": ws_id,
        "artifactObjectIds": [lh_id],
        "capacityObjectId": cap_id,
    }).encode()

    url = f"{REDIRECT_HOST}/metadata/v201606/generatemwctoken"
    req = urllib.request.Request(url, data=body, headers={
        "Authorization": f"Bearer {bearer}",
        "Content-Type": "application/json",
    }, method="POST")

    ctx = ssl.create_default_context()
    with urllib.request.urlopen(req, timeout=30, context=ctx) as resp:
        resp_data = json.loads(resp.read())

    if not resp_data.get("Token"):
        raise ValueError(f"MWC response missing Token. Keys: {list(resp_data.keys())}")

    token = resp_data["Token"]
    host_raw = resp_data.get("TargetUriHost")
    if not host_raw:
        raise ValueError(f"MWC response missing TargetUriHost. Keys: {list(resp_data.keys())}")
    host = f"https://{host_raw}"
    # Expiration may be None in some PPE responses — default to 1hr
    exp_raw = resp_data.get("Expiration")
    if exp_raw:
        expiry_str = exp_raw.replace("Z", "+00:00")
        expiry = datetime.fromisoformat(expiry_str).timestamp()
    else:
        expiry = time.time() + 3600  # fallback: 1 hour

    with _mwc_lock:
        _mwc_cache[cache_key] = {"token": token, "host": host, "expiry": expiry}
    remaining = int((expiry - time.time()) / 60)
    print(f"  [MWC] Token cached, expires in {remaining} min")
    return token, host


def _capacity_base_path(cap_id: str, ws_id: str) -> str:
    """Build the MWC API base path for a capacity/workspace pair."""
    return (
        f"/webapi/capacities/{cap_id}/workloads/Lakehouse"
        f"/LakehouseService/automatic/v1/workspaces/{ws_id}"
    )


class EdogDevHandler(SimpleHTTPRequestHandler):
    """HTTP handler for EDOG development server."""

    def do_GET(self):
        if self.path == "/api/flt/config":
            self._serve_config()
        elif self.path.startswith("/api/fabric/"):
            self._proxy_fabric("GET")
        elif self.path == "/api/edog/certs":
            self._serve_certs()
        elif self.path == "/api/edog/health":
            self._serve_health()
        elif self.path.startswith("/api/mwc/tables"):
            self._serve_mwc_tables()
        elif self.path.startswith("/edog-logs.html") or self.path == "/":
            self._serve_html()
        else:
            self.send_error(404)

    def do_PATCH(self):
        if self.path.startswith("/api/fabric/"):
            self._proxy_fabric("PATCH")
        else:
            self.send_error(404)

    def do_DELETE(self):
        if self.path.startswith("/api/fabric/"):
            self._proxy_fabric("DELETE")
        else:
            self.send_error(404)

    def do_POST(self):
        if self.path.startswith("/api/fabric/"):
            self._proxy_fabric("POST")
        elif self.path == "/api/edog/auth":
            self._serve_auth()
        elif self.path == "/api/edog/mwc-token":
            self._serve_mwc_token()
        elif self.path == "/api/mwc/table-details":
            self._serve_mwc_table_details()
        else:
            self.send_error(404)

    def _serve_config(self):
        config = {}
        if CONFIG_PATH.exists():
            config = json.loads(CONFIG_PATH.read_text())

        bearer, _ = _read_cache(BEARER_CACHE)
        mwc, mwc_exp = _read_cache(MWC_CACHE)

        resp = {
            "workspaceId": config.get("workspace_id", ""),
            "artifactId": config.get("artifact_id", ""),
            "capacityId": config.get("capacity_id", ""),
            "tokenExpiryMinutes": int((mwc_exp - time.time()) / 60) if mwc_exp else 0,
            "tokenExpired": mwc is None,
            "mwcToken": mwc,
            "fabricBaseUrl": None,
            "bearerToken": bearer,
            "phase": "connected" if mwc else "disconnected",
        }

        body = json.dumps(resp).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _serve_html(self):
        content = HTML_PATH.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.end_headers()
        self.wfile.write(content)

    def _proxy_fabric(self, method):
        """Proxy /api/fabric/* to redirect host with bearer token."""
        bearer, _ = _read_cache(BEARER_CACHE)
        if not bearer:
            self._send_json(401, {"error": "no_bearer_token", "message": "Bearer token not cached"})
            return

        # /api/fabric/workspaces/{id}/items → /workspaces/{id}/items
        fabric_path = self.path[len("/api/fabric"):]
        target_path = _map_path(fabric_path)
        is_workspace_list = "/metadata/workspaces" in target_path and "/" not in target_path.split("/metadata/workspaces")[1].lstrip("/")

        url = REDIRECT_HOST + target_path
        print(f"  [PROXY] {method} {fabric_path} → {target_path}")

        headers = {
            "Authorization": f"Bearer {bearer}",
            "Content-Type": "application/json",
        }

        req_body = None
        content_len = int(self.headers.get("Content-Length", 0))
        if content_len > 0:
            req_body = self.rfile.read(content_len)

        try:
            ctx = ssl.create_default_context()
            req = urllib.request.Request(url, data=req_body, headers=headers, method=method)
            with urllib.request.urlopen(req, timeout=30, context=ctx) as resp:
                resp_body = resp.read()
                # Only workspace listing needs normalization
                if is_workspace_list:
                    resp_body = _normalize_workspaces(resp_body)
                self.send_response(resp.status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(resp_body)))
                self.end_headers()
                self.wfile.write(resp_body)
        except urllib.error.HTTPError as e:
            resp_body = e.read()
            self.send_response(e.code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(resp_body)))
            self.end_headers()
            self.wfile.write(resp_body)
        except Exception as e:
            self._send_json(502, {"error": "proxy_error", "message": str(e)})

    def _json_response(self, code, data):
        body = json.dumps(data).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def _serve_certs(self):
        """List CBA certs from Windows cert store."""
        helper = PROJECT_DIR / "scripts" / "token-helper" / "bin" / "Debug" / "net8.0" / "token-helper.exe"
        if not helper.exists():
            # Try net472 fallback
            helper = PROJECT_DIR / "scripts" / "token-helper" / "bin" / "Debug" / "net472" / "token-helper.exe"
        if not helper.exists():
            self._json_response(500, {"error": "token-helper not built"})
            return
        try:
            result = subprocess.run(
                [str(helper), "--list-certs"],
                capture_output=True, text=True, timeout=10,
            )
            if result.returncode == 0:
                certs = json.loads(result.stdout)
                self._json_response(200, certs)
            else:
                self._json_response(500, {"error": result.stderr.strip()[:200]})
        except subprocess.TimeoutExpired:
            self._json_response(500, {"error": "cert scan timed out"})
        except Exception as e:
            self._json_response(500, {"error": str(e)[:200]})

    def _serve_auth(self):
        """Authenticate via Silent CBA."""
        content_len = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(content_len)) if content_len else {}
        username = body.get("username", "")
        if not username:
            self._json_response(400, {"error": "username required"})
            return

        # Find cert thumbprint from the certs list
        cert_cn = username.replace("@", ".")
        helper = PROJECT_DIR / "scripts" / "token-helper" / "bin" / "Debug" / "net8.0" / "token-helper.exe"
        if not helper.exists():
            helper = PROJECT_DIR / "scripts" / "token-helper" / "bin" / "Debug" / "net472" / "token-helper.exe"
        if not helper.exists():
            self._json_response(500, {"error": "token-helper not built"})
            return

        # Find thumbprint
        try:
            list_result = subprocess.run(
                [str(helper), "--list-certs"],
                capture_output=True, text=True, timeout=10,
            )
            thumbprint = None
            if list_result.returncode == 0:
                for c in json.loads(list_result.stdout):
                    if cert_cn.lower() in c.get("cn", "").lower() or cert_cn.lower() in c.get("subject", "").lower():
                        thumbprint = c["thumbprint"]
                        break
        except Exception:
            thumbprint = None

        if not thumbprint:
            self._json_response(404, {
                "error": f"No certificate found for {cert_cn}",
                "help": "https://dev.azure.com/powerbi/Trident/_wiki/wikis/Trident.wiki/80942/PPE-Ephemeral-Tenants-(ES-Maintained-Rotated)"
            })
            return

        # Run Silent CBA
        try:
            result = subprocess.run(
                [str(helper), thumbprint, username],
                capture_output=True, text=True, timeout=30,
            )
            if result.returncode == 0:
                token = result.stdout.strip()
                # Parse JWT expiry
                try:
                    payload_b64 = token.split(".")[1]
                    payload_b64 += "=" * (4 - len(payload_b64) % 4)
                    claims = json.loads(base64.b64decode(payload_b64).decode("utf-8", "replace"))
                    expiry = float(claims.get("exp", time.time() + 3600))
                    upn = claims.get("upn", username)
                except Exception:
                    expiry = time.time() + 3600
                    upn = username

                # Cache bearer
                _write_cache(BEARER_CACHE, token, expiry)

                # Save last authenticated user for auto-reauth
                _save_session({"lastUsername": upn, "lastAuth": time.time()})

                self._json_response(200, {
                    "token": token,
                    "username": upn,
                    "expiresIn": int(expiry - time.time()),
                })
            else:
                self._json_response(401, {
                    "error": "Authentication failed",
                    "detail": result.stderr.strip()[:300]
                })
        except subprocess.TimeoutExpired:
            self._json_response(504, {"error": "Authentication timed out (30s)"})

    def _serve_health(self):
        """Pre-flight health check."""
        bearer, bearer_exp = _read_cache(BEARER_CACHE)
        session = _load_session()
        helper = PROJECT_DIR / "scripts" / "token-helper" / "bin" / "Debug" / "net8.0" / "token-helper.exe"
        if not helper.exists():
            helper = PROJECT_DIR / "scripts" / "token-helper" / "bin" / "Debug" / "net472" / "token-helper.exe"

        # Git info from project directory
        git_branch = ""
        git_dirty = 0
        try:
            git_branch = subprocess.check_output(
                ["git", "rev-parse", "--abbrev-ref", "HEAD"],
                cwd=str(PROJECT_DIR), timeout=3, stderr=subprocess.DEVNULL,
            ).decode().strip()
            git_dirty = len(subprocess.check_output(
                ["git", "diff", "--name-only"],
                cwd=str(PROJECT_DIR), timeout=3, stderr=subprocess.DEVNULL,
            ).decode().strip().splitlines())
        except Exception:
            pass

        self._json_response(200, {
            "tokenHelperBuilt": helper.exists(),
            "hasBearerToken": bearer is not None,
            "bearerExpiresIn": int(bearer_exp - time.time()) if bearer_exp else 0,
            "lastUsername": session.get("lastUsername", ""),
            "gitBranch": git_branch,
            "gitDirtyFiles": git_dirty,
        })

    def _serve_mwc_tables(self):
        """GET /api/mwc/tables — list lakehouse tables via MWC token."""
        parsed = urllib.parse.urlparse(self.path)
        params = urllib.parse.parse_qs(parsed.query)
        ws_id = params.get("wsId", [None])[0]
        lh_id = params.get("lhId", [None])[0]
        cap_id = params.get("capId", [None])[0]

        if not all([ws_id, lh_id, cap_id]):
            self._json_response(400, {"error": "missing_params", "message": "wsId, lhId, and capId are required"})
            return

        bearer, _ = _read_cache(BEARER_CACHE)
        if not bearer:
            self._json_response(401, {"error": "no_bearer_token", "message": "Bearer token not cached"})
            return

        try:
            token, host = _get_mwc_token(bearer, ws_id, lh_id, cap_id)
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", "replace")[:500]
            self._json_response(e.code, {"error": "mwc_token_error", "message": body})
            return
        except Exception as e:
            traceback.print_exc()
            self._json_response(502, {"error": "mwc_token_error", "message": str(e)})
            return

        base = _capacity_base_path(cap_id, ws_id)
        url = f"{host}{base}/artifacts/DataArtifact/{lh_id}/schemas/dbo/tables"
        print(f"  [MWC] GET tables → {url[:80]}...")

        try:
            ctx = ssl.create_default_context()
            req = urllib.request.Request(url, headers={
                "Authorization": f"MwcToken {token}",
                "x-ms-workload-resource-moniker": lh_id,
                "Content-Type": "application/json",
            }, method="GET")
            with urllib.request.urlopen(req, timeout=30, context=ctx) as resp:
                resp_body = resp.read()
                self.send_response(resp.status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Content-Length", str(len(resp_body)))
                self.end_headers()
                self.wfile.write(resp_body)
        except urllib.error.HTTPError as e:
            resp_body = e.read()
            self.send_response(e.code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(resp_body)))
            self.end_headers()
            self.wfile.write(resp_body)
        except Exception as e:
            self._json_response(502, {"error": "mwc_request_error", "message": str(e)})

    def _serve_mwc_table_details(self):
        """POST /api/mwc/table-details — batch get table details with polling."""
        content_len = int(self.headers.get("Content-Length", 0))
        if content_len == 0:
            self._json_response(400, {"error": "empty_body", "message": "Request body required"})
            return

        body = json.loads(self.rfile.read(content_len))
        ws_id = body.get("wsId")
        lh_id = body.get("lhId")
        cap_id = body.get("capId")
        tables = body.get("tables", [])

        if not all([ws_id, lh_id, cap_id, tables]):
            self._json_response(400, {
                "error": "missing_params",
                "message": "wsId, lhId, capId, and tables are required",
            })
            return

        bearer, _ = _read_cache(BEARER_CACHE)
        if not bearer:
            self._json_response(401, {"error": "no_bearer_token", "message": "Bearer token not cached"})
            return

        try:
            token, host = _get_mwc_token(bearer, ws_id, lh_id, cap_id)
        except urllib.error.HTTPError as e:
            err_body = e.read().decode("utf-8", "replace")[:500]
            self._json_response(e.code, {"error": "mwc_token_error", "message": err_body})
            return
        except Exception as e:
            self._json_response(502, {"error": "mwc_token_error", "message": str(e)})
            return

        base = _capacity_base_path(cap_id, ws_id)
        url = f"{host}{base}/artifacts/DataArtifact/{lh_id}/schemas/dbo/batchGetTableDetails"
        mwc_headers = {
            "Authorization": f"MwcToken {token}",
            "x-ms-workload-resource-moniker": lh_id,
            "Content-Type": "application/json",
        }
        print(f"  [MWC] POST batchGetTableDetails ({len(tables)} tables)")

        try:
            ctx = ssl.create_default_context()
            req_body = json.dumps({"tables": tables}).encode()
            req = urllib.request.Request(url, data=req_body, headers=mwc_headers, method="POST")
            with urllib.request.urlopen(req, timeout=30, context=ctx) as resp:
                resp_data = json.loads(resp.read())

            operation_id = resp_data.get("operationId")
            if not operation_id:
                self._json_response(200, resp_data)
                return

            # Poll for async operation completion
            poll_url = f"{url}/operationResults/{operation_id}"
            print(f"  [MWC] Polling operation {operation_id[:8]}...")
            for attempt in range(20):
                time.sleep(1)
                poll_req = urllib.request.Request(poll_url, headers=mwc_headers, method="GET")
                with urllib.request.urlopen(poll_req, timeout=30, context=ctx) as poll_resp:
                    poll_data = json.loads(poll_resp.read())

                status = poll_data.get("status", "").lower()
                if status in ("succeeded", "completed"):
                    print(f"  [MWC] Operation completed after {attempt + 1}s")
                    self._json_response(200, poll_data)
                    return
                if status in ("failed", "cancelled"):
                    print(f"  [MWC] Operation {status} after {attempt + 1}s")
                    self._json_response(500, {"error": "operation_failed", "detail": poll_data})
                    return

            self._json_response(504, {
                "error": "poll_timeout",
                "message": f"Operation {operation_id} did not complete in 20s",
            })
        except urllib.error.HTTPError as e:
            resp_body = e.read()
            self.send_response(e.code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(resp_body)))
            self.end_headers()
            self.wfile.write(resp_body)
        except Exception as e:
            self._json_response(502, {"error": "mwc_request_error", "message": str(e)})

    def _serve_mwc_token(self):
        """POST /api/edog/mwc-token — explicitly generate and return an MWC token."""
        content_len = int(self.headers.get("Content-Length", 0))
        if content_len == 0:
            self._json_response(400, {"error": "empty_body", "message": "Request body required"})
            return

        body = json.loads(self.rfile.read(content_len))
        ws_id = body.get("workspaceId")
        lh_id = body.get("lakehouseId")
        cap_id = body.get("capacityId")

        if not all([ws_id, lh_id, cap_id]):
            self._json_response(400, {
                "error": "missing_params",
                "message": "workspaceId, lakehouseId, and capacityId are required",
            })
            return

        bearer, _ = _read_cache(BEARER_CACHE)
        if not bearer:
            self._json_response(401, {"error": "no_bearer_token", "message": "Bearer token not cached"})
            return

        try:
            token, host = _get_mwc_token(bearer, ws_id, lh_id, cap_id)
        except urllib.error.HTTPError as e:
            err_body = e.read().decode("utf-8", "replace")[:500]
            self._json_response(e.code, {"error": "mwc_token_error", "message": err_body})
            return
        except Exception as e:
            self._json_response(502, {"error": "mwc_token_error", "message": str(e)})
            return

        cache_key = f"{ws_id}:{lh_id}:{cap_id}"
        cached = _mwc_cache.get(cache_key, {})
        self._json_response(200, {
            "token": token,
            "host": host,
            "expiry": cached.get("expiry", 0),
        })

    def _send_json(self, status, obj):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        msg = str(args)
        if "/api/flt/config" in msg or "/ws/logs" in msg or "/api/logs" in msg or "/api/telemetry" in msg or "/api/stats" in msg:
            return
        super().log_message(format, *args)


if __name__ == "__main__":

    class ThreadedHTTPServer(ThreadingMixIn, HTTPServer):
        """Handle each request in a new thread to avoid blocking on slow MWC calls."""
        daemon_threads = True

    server = ThreadedHTTPServer(("127.0.0.1", 5555), EdogDevHandler)
    print("EDOG Dev Server running at http://127.0.0.1:5555/")
    print(f"  Config:  {CONFIG_PATH}")
    print(f"  Bearer:  {BEARER_CACHE} (exists={BEARER_CACHE.exists()})")
    print(f"  HTML:    {HTML_PATH}")
    print(f"  Proxy:   /api/fabric/* → {REDIRECT_HOST}/v1/*")
    print("  Open:    http://127.0.0.1:5555/edog-logs.html")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServer stopped.")
        server.server_close()
