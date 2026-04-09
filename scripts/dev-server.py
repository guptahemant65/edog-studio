"""EDOG Dev Server — serves HTML, /api/flt/config, and proxies Fabric API calls.

Proxy strategy (per docs/fabric-api-reference.md):
  - Forward v1 paths as-is to the redirect host (they return clean shapes)
  - Only /workspaces (top-level) uses /metadata/workspaces (for capacityId)
  - Bearer token is attached server-side (avoids CORS)
"""
import base64
import json
import re
import ssl
import time
import urllib.request
import urllib.error
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path

PROJECT_DIR = Path(__file__).parent.parent
CONFIG_PATH = PROJECT_DIR / "edog-config.json"
BEARER_CACHE = PROJECT_DIR / ".edog-bearer-cache"
MWC_CACHE = PROJECT_DIR / ".edog-token-cache"
HTML_PATH = PROJECT_DIR / "src" / "edog-logs.html"
REDIRECT_HOST = "https://biazure-int-edog-redirect.analysis-df.windows.net"


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


class EdogDevHandler(SimpleHTTPRequestHandler):
    """HTTP handler for EDOG development server."""

    def do_GET(self):
        if self.path == "/api/flt/config":
            self._serve_config()
        elif self.path.startswith("/api/fabric/"):
            self._proxy_fabric("GET")
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
    server = HTTPServer(("127.0.0.1", 5555), EdogDevHandler)
    print("EDOG Dev Server running at http://127.0.0.1:5555/")
    print(f"  Config:  {CONFIG_PATH}")
    print(f"  Bearer:  {BEARER_CACHE} (exists={BEARER_CACHE.exists()})")
    print(f"  HTML:    {HTML_PATH}")
    print(f"  Proxy:   /api/fabric/* → {REDIRECT_HOST}/v1/*")
    print("  Open:    http://127.0.0.1:5555/edog-logs.html")
    server.serve_forever()
