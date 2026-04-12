"""EDOG Dev Server — serves HTML, /api/flt/config, and proxies Fabric API calls.

Proxy strategy (per docs/fabric-api-reference.md):
  - Forward v1 paths as-is to the redirect host (they return clean shapes)
  - Only /workspaces (top-level) uses /metadata/workspaces (for capacityId)
  - Bearer token is attached server-side (avoids CORS)
"""
import base64
import json
import os
import ssl
import subprocess
import sys
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

# In-memory Jupyter session cache — keyed by "ws:nb:cap" composite
_jupyter_sessions: dict = {}  # value: {"kernelId": str, "sessionId": str, "capHost": str}
_jupyter_lock = threading.Lock()


def _atomic_write(path: Path, data: str):
    """Write data atomically: write to temp file, then rename."""
    import tempfile as _tf
    fd, tmp = _tf.mkstemp(dir=str(path.parent), suffix='.tmp')
    try:
        os.write(fd, data.encode('utf-8'))
        os.close(fd)
        os.replace(tmp, str(path))
    except Exception:
        try:
            os.close(fd)
        except OSError:
            pass
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


# ── Studio State ──────────────────────────────────────────────────────────
FLT_INTERNAL_PORT = 5557

_studio_state = {
    "phase": "idle",       # idle | deploying | running | crashed | stopped
    "deployId": None,
    "fltPort": None,
    "fltPid": None,
    "deployStep": 0,
    "deployTotal": 5,
    "deployMessage": "",
    "deployError": None,
    "deployLogs": [],
    "deployTarget": None,
    "deployStartTime": None,
}
_studio_lock = threading.Lock()
_flt_process = None
_deploy_cancel = threading.Event()


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


def _get_mwc_token(bearer: str, ws_id: str, artifact_id: str, cap_id: str,
                   workload_type: str = "Lakehouse") -> tuple:
    """Generate or retrieve cached MWC token for a workspace/artifact/capacity tuple.

    Args:
        bearer: Bearer token for authentication.
        ws_id: Workspace object ID.
        artifact_id: Artifact object ID (lakehouse, notebook, etc.).
        cap_id: Capacity object ID.
        workload_type: Fabric workload type (Lakehouse, Notebook, etc.).

    Returns:
        Tuple of (mwc_token, host_url).

    Raises:
        urllib.error.HTTPError: If the token endpoint returns an error.
    """
    cache_key = f"{ws_id}:{artifact_id}:{cap_id}:{workload_type}"
    with _mwc_lock:
        cached = _mwc_cache.get(cache_key)
        if cached and time.time() < cached["expiry"] - 300:
            print(f"  [MWC] Cache hit for {cache_key[:30]}...")
            return cached["token"], cached["host"]

    print(f"  [MWC] Generating {workload_type} token for ws={ws_id[:8]}... artifact={artifact_id[:8]}...")
    body = json.dumps({
        "type": "[Start] GetMWCToken",
        "workloadType": workload_type,
        "workspaceObjectId": ws_id,
        "artifactObjectIds": [artifact_id],
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


def _jupyter_api_path(cap_id: str, ws_id: str, nb_id: str) -> str:
    """Build the Jupyter API base path for a capacity/workspace/notebook tuple."""
    return (
        f"/webapi/capacities/{cap_id}/workloads/Notebook/Data/Automatic"
        f"/api/workspaces/{ws_id}/artifacts/{nb_id}"
        f"/jupyterApi/versions/1/api"
    )


def _resolve_mwc_for_jupyter(cap_id: str, ws_id: str = "", nb_id: str = "",
                             lh_id: str = ""):
    """Resolve MWC token for Jupyter operations.

    Jupyter requires a Notebook-workload MWC token, not a Lakehouse one.
    Tries in-memory cache, then generates a Notebook-scoped token.
    Returns (token, host) tuple or (None, None).
    """
    # Try in-memory cache — prefer Notebook-scoped token
    nb_key = f"{ws_id}:{nb_id}:{cap_id}:Notebook"
    with _mwc_lock:
        cached = _mwc_cache.get(nb_key)
        if cached and time.time() < cached["expiry"] - 300:
            print(f"  [JUPYTER] MWC Notebook cache hit")
            return cached["token"], cached.get("host", "")
        # Fall back to any token for this capacity
        for key, entry in _mwc_cache.items():
            if cap_id in key and time.time() < entry["expiry"] - 300:
                print(f"  [JUPYTER] MWC cache hit (non-notebook): {key[:30]}...")
                return entry["token"], entry.get("host", "")

    # Generate a Notebook-scoped MWC token
    if ws_id and nb_id:
        bearer, _ = _read_cache(BEARER_CACHE)
        if bearer:
            try:
                print(f"  [JUPYTER] Generating Notebook MWC token for nb={nb_id[:8]}...")
                token, host = _get_mwc_token(bearer, ws_id, nb_id, cap_id,
                                             workload_type="Notebook")
                return token, host
            except Exception as e:
                print(f"  [JUPYTER] Notebook MWC token failed: {e}")
                # Try Lakehouse-scoped as fallback
                if lh_id:
                    try:
                        print(f"  [JUPYTER] Falling back to Lakehouse MWC token...")
                        token, host = _get_mwc_token(bearer, ws_id, lh_id, cap_id,
                                                     workload_type="Lakehouse")
                        return token, host
                    except Exception as e2:
                        print(f"  [JUPYTER] Lakehouse MWC fallback also failed: {e2}")

    # File cache as last resort
    token, _ = _read_cache(MWC_CACHE)
    return token, None


async def _jupyter_ws_execute(cap_host, cap_id, ws_id, nb_id, kernel_id, token, code):
    """Execute code on a Jupyter kernel via WebSocket (Jupyter wire protocol).

    Connects to the tinymgr/lobby WebSocket, sends an execute_request message,
    and collects output until execute_reply is received.

    Returns dict with status, outputs, and error info.
    """
    import websockets
    import uuid

    ws_host = cap_host.replace("https://", "")
    ws_path = (
        f"/webapi/capacities/{cap_id}/workloads/Notebook"
        f"/AzNBProxy/Automatic/workspaces/{ws_id}"
        f"/api/proxy/ws/tinymgr/lobby"
    )
    ws_url = f"wss://{ws_host}{ws_path}"

    headers = {
        "Authorization": f"MwcToken {token}",
    }

    msg_id = str(uuid.uuid4())

    # Jupyter execute_request message
    execute_msg = json.dumps({
        "header": {
            "msg_id": msg_id,
            "msg_type": "execute_request",
            "username": "edog",
            "session": str(uuid.uuid4()),
            "version": "5.3",
        },
        "parent_header": {},
        "metadata": {},
        "content": {
            "code": code,
            "silent": False,
            "store_history": True,
            "user_expressions": {},
            "allow_stdin": False,
            "stop_on_error": True,
        },
        "buffers": [],
        "channel": "shell",
    })

    outputs = []
    status = "ok"
    error_name = ""
    error_value = ""
    traceback_lines = []

    try:
        async with websockets.connect(
            ws_url,
            additional_headers=headers,
            open_timeout=30,
            close_timeout=5,
            max_size=10 * 1024 * 1024,  # 10MB max message
        ) as ws:
            # Send execute request
            await ws.send(execute_msg)
            print(f"  [JUPYTER] Sent execute_request msg_id={msg_id[:8]}...")

            # Collect responses until execute_reply
            import asyncio
            deadline = asyncio.get_event_loop().time() + 300  # 5 min timeout

            while asyncio.get_event_loop().time() < deadline:
                try:
                    raw = await asyncio.wait_for(ws.recv(), timeout=10)
                except asyncio.TimeoutError:
                    continue

                try:
                    msg = json.loads(raw)
                except (json.JSONDecodeError, TypeError):
                    continue

                msg_type = msg.get("msg_type") or msg.get("header", {}).get("msg_type", "")
                parent_id = msg.get("parent_header", {}).get("msg_id", "")
                content = msg.get("content", {})

                # Only process messages that are replies to our request
                if parent_id and parent_id != msg_id:
                    continue

                if msg_type == "stream":
                    outputs.append({
                        "type": "stream",
                        "name": content.get("name", "stdout"),
                        "text": content.get("text", ""),
                    })
                elif msg_type == "execute_result":
                    data = content.get("data", {})
                    outputs.append({
                        "type": "execute_result",
                        "text": data.get("text/plain", ""),
                        "html": data.get("text/html", ""),
                    })
                elif msg_type == "display_data":
                    data = content.get("data", {})
                    outputs.append({
                        "type": "display_data",
                        "text": data.get("text/plain", ""),
                        "html": data.get("text/html", ""),
                    })
                elif msg_type == "error":
                    status = "error"
                    error_name = content.get("ename", "")
                    error_value = content.get("evalue", "")
                    traceback_lines = content.get("traceback", [])
                    outputs.append({
                        "type": "error",
                        "ename": error_name,
                        "evalue": error_value,
                        "traceback": traceback_lines,
                    })
                elif msg_type == "execute_reply":
                    reply_status = content.get("status", "ok")
                    if reply_status == "error":
                        status = "error"
                        error_name = content.get("ename", error_name)
                        error_value = content.get("evalue", error_value)
                    # execute_reply = done
                    break

    except Exception as e:
        return {
            "status": "error",
            "error": f"WebSocket error: {e}",
            "outputs": outputs,
        }

    return {
        "status": status,
        "outputs": outputs,
        "error_name": error_name,
        "error_value": error_value,
        "traceback": traceback_lines,
    }


# ── Deploy Helpers ────────────────────────────────────────────────────────

def _ts():
    return datetime.now().strftime("%H:%M:%S")


def _deploy_log(msg, level="info"):
    with _studio_lock:
        _studio_state["deployLogs"].append({"ts": _ts(), "msg": msg, "level": level})


def _deploy_step(step, message, deploy_id):
    with _studio_lock:
        if _studio_state.get("deployId") != deploy_id:
            return False
        if _deploy_cancel.is_set():
            _studio_state.update({"phase": "stopped", "deployMessage": "Cancelled"})
            return False
        _studio_state["deployStep"] = step
        _studio_state["deployMessage"] = message
    _deploy_log(message)
    return True


def _run_deploy_pipeline(deploy_id, ws_id, lh_id, cap_id):
    """Real deploy pipeline. Runs on background thread."""
    global _flt_process

    try:
        # Step 0: Fetch MWC token
        if not _deploy_step(0, "Fetching MWC token...", deploy_id):
            return
        bearer, _ = _read_cache(BEARER_CACHE)
        if not bearer:
            _deploy_log("No bearer token — authenticate first", "error")
            with _studio_lock:
                _studio_state.update({
                    "phase": "stopped",
                    "deployError": "No bearer token. Run authentication first.",
                })
            return
        try:
            token, host = _get_mwc_token(bearer, ws_id, lh_id, cap_id)
            _deploy_log("MWC token acquired", "success")
        except Exception as e:
            _deploy_log(f"Token fetch failed: {e}", "error")
            with _studio_lock:
                _studio_state.update({"phase": "stopped", "deployError": f"Token fetch failed: {e}"})
            return

        # Step 1: Update config (atomic write)
        if not _deploy_step(1, "Updating config...", deploy_id):
            return
        try:
            config = json.loads(CONFIG_PATH.read_text()) if CONFIG_PATH.exists() else {}
            config["workspace_id"] = ws_id
            config["artifact_id"] = lh_id
            config["capacity_id"] = cap_id
            _atomic_write(CONFIG_PATH, json.dumps(config, indent=2))
            _deploy_log("edog-config.json updated", "success")
        except Exception as e:
            _deploy_log(f"Config update failed: {e}", "error")
            with _studio_lock:
                _studio_state.update({"phase": "stopped", "deployError": str(e)})
            return

        # Step 2: Patch + Build (via edog.py --headless-deploy)
        if not _deploy_step(2, "Patching and building...", deploy_id):
            return
        try:
            config = json.loads(CONFIG_PATH.read_text()) if CONFIG_PATH.exists() else {}
            flt_repo = config.get("flt_repo_path", "")
            if not flt_repo or not Path(flt_repo).is_dir():
                raise FileNotFoundError(f"FLT repo not found: {flt_repo}")

            env = dict(os.environ)
            env["EDOG_STUDIO_PORT"] = str(FLT_INTERNAL_PORT)

            proc = subprocess.Popen(
                [sys.executable, str(PROJECT_DIR / "edog.py"), "--headless-deploy"],
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                text=True, bufsize=1, env=env, encoding="utf-8", errors="replace",
            )
            for line in proc.stdout:
                line = line.rstrip()
                if not line:
                    continue
                try:
                    evt = json.loads(line)
                    msg = evt.get("message", line)
                    lvl = evt.get("level", "info")
                    if evt.get("step") is not None:
                        with _studio_lock:
                            if _studio_state.get("deployId") == deploy_id:
                                _studio_state["deployStep"] = evt["step"]
                                _studio_state["deployMessage"] = msg
                    _deploy_log(msg, lvl)
                except json.JSONDecodeError:
                    _deploy_log(line, "info")

                if _deploy_cancel.is_set():
                    proc.terminate()
                    with _studio_lock:
                        _studio_state.update({"phase": "stopped", "deployMessage": "Cancelled"})
                    return

            proc.wait()
            if proc.returncode != 0:
                _deploy_log(f"Patch/build failed (exit {proc.returncode})", "error")
                with _studio_lock:
                    _studio_state.update({
                        "phase": "stopped",
                        "deployError": f"Patch/build failed (exit {proc.returncode})",
                    })
                return
            _deploy_log("Patch and build succeeded", "success")

        except Exception as e:
            _deploy_log(f"Patch/build error: {e}", "error")
            with _studio_lock:
                _studio_state.update({"phase": "stopped", "deployError": str(e)})
            return

        # Step 3: Launch FLT (dev-server owns the process)
        if not _deploy_step(3, "Launching service...", deploy_id):
            return
        try:
            if _flt_process and _flt_process.poll() is None:
                _deploy_log("Stopping previous FLT service...", "warn")
                _flt_process.terminate()
                try:
                    _flt_process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    _flt_process.kill()

            config = json.loads(CONFIG_PATH.read_text()) if CONFIG_PATH.exists() else {}
            flt_repo = config.get("flt_repo_path", "")
            entrypoint = Path(flt_repo) / "Service" / "Microsoft.LiveTable.Service.EntryPoint"
            env = dict(os.environ)
            env["EDOG_STUDIO_PORT"] = str(FLT_INTERNAL_PORT)

            _flt_process = subprocess.Popen(
                ["dotnet", "run", "--no-build"],
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                text=True, bufsize=1, cwd=str(entrypoint), env=env,
                encoding="utf-8", errors="replace",
            )
            _deploy_log(f"FLT started (PID: {_flt_process.pid})", "success")

            with _studio_lock:
                _studio_state["fltPid"] = _flt_process.pid
                _studio_state["fltPort"] = FLT_INTERNAL_PORT

        except Exception as e:
            _deploy_log(f"Launch failed: {e}", "error")
            with _studio_lock:
                _studio_state.update({"phase": "stopped", "deployError": str(e)})
            return

        # Step 4: Health check
        if not _deploy_step(4, "Waiting for service ready...", deploy_id):
            return
        healthy = False
        for attempt in range(60):
            if _deploy_cancel.is_set():
                _flt_process.terminate()
                with _studio_lock:
                    _studio_state.update({"phase": "stopped", "deployMessage": "Cancelled"})
                return
            try:
                url = f"http://localhost:{FLT_INTERNAL_PORT}/api/stats"
                req = urllib.request.Request(url)
                with urllib.request.urlopen(req, timeout=2) as resp:
                    if resp.status == 200:
                        healthy = True
                        break
            except Exception:
                pass
            if attempt % 5 == 0:
                _deploy_log(f"Ping attempt {attempt + 1}/60...", "info")
            time.sleep(1)

        if not healthy:
            _deploy_log("Health check timed out after 60s", "error")
            with _studio_lock:
                _studio_state.update({
                    "phase": "stopped",
                    "deployError": "Service did not become healthy in 60s",
                })
            return

        _deploy_log("Service healthy!", "success")

        # Done
        with _studio_lock:
            _studio_state.update({
                "phase": "running",
                "deployStep": 5,
                "deployMessage": "Deploy complete",
            })
        _deploy_log("Deploy complete!", "success")

        # Start monitor thread
        monitor = threading.Thread(target=_monitor_flt, args=(deploy_id,), daemon=True)
        monitor.start()

        # Start token refresh thread
        refresher = threading.Thread(
            target=_token_refresh_loop, args=(ws_id, lh_id, cap_id), daemon=True,
        )
        refresher.start()

    except Exception as e:
        _deploy_log(f"Unexpected error: {e}", "error")
        with _studio_lock:
            _studio_state.update({"phase": "stopped", "deployError": str(e)})


def _monitor_flt(deploy_id):
    """Monitor FLT process for crashes."""
    global _flt_process
    while _flt_process and _flt_process.poll() is None:
        time.sleep(2)
    if _flt_process:
        code = _flt_process.returncode
        with _studio_lock:
            if _studio_state.get("deployId") == deploy_id and _studio_state["phase"] == "running":
                _studio_state.update({
                    "phase": "crashed",
                    "deployError": f"FLT exited with code {code}",
                    "deployMessage": f"Service crashed (exit code {code})",
                })
        _deploy_log(f"FLT process exited with code {code}", "error")


def _token_refresh_loop(ws_id, lh_id, cap_id):
    """Refresh MWC token every 50 minutes."""
    while True:
        time.sleep(50 * 60)
        with _studio_lock:
            if _studio_state["phase"] != "running":
                return
        try:
            bearer, _ = _read_cache(BEARER_CACHE)
            if bearer:
                _get_mwc_token(bearer, ws_id, lh_id, cap_id)
                _deploy_log("MWC token refreshed", "success")
        except Exception as e:
            _deploy_log(f"Token refresh failed: {e}", "warn")


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
        elif self.path.startswith("/api/mwc/table-stats"):
            self._serve_table_stats()
        elif self.path.startswith("/api/notebook/content"):
            self._serve_notebook_content()
        elif self.path.startswith("/api/notebook/kernel-specs"):
            self._serve_jupyter_kernel_specs()
        elif self.path.startswith("/api/notebook/run-status"):
            self._serve_notebook_run_status()
        elif self.path.startswith("/edog-logs.html") or self.path == "/":
            self._serve_html()
        elif self.path == "/api/studio/status":
            self._serve_studio_status()
        elif self.path == "/api/command/deploy-stream":
            self._serve_deploy_stream()
        elif self.path.startswith("/api/logs") or self.path.startswith("/api/telemetry") \
                or self.path.startswith("/api/stats") or self.path.startswith("/api/executions"):
            self._proxy_to_flt("GET")
        elif self.path == "/ws/logs":
            # WebSocket upgrade request — can't handle in stdlib HTTP server.
            # Return 426 so the client knows to use the FLT port instead.
            self._json_response(426, {"error": "ws_not_here", "message": "WebSocket available on FLT port after deploy"})
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
        elif self.path == "/api/notebook/save":
            self._serve_notebook_save()
        elif self.path == "/api/notebook/run":
            self._serve_notebook_run()
        elif self.path == "/api/notebook/cancel":
            self._serve_notebook_cancel()
        elif self.path == "/api/notebook/create-session":
            self._serve_jupyter_create_session()
        elif self.path == "/api/notebook/execute-cell":
            self._serve_jupyter_execute_cell()
        elif self.path == "/api/notebook/close-session":
            self._serve_jupyter_close_session()
        elif self.path == "/api/command/deploy":
            self._serve_deploy_start()
        elif self.path == "/api/command/deploy-cancel":
            self._serve_deploy_cancel()
        elif self.path == "/api/command/undeploy":
            self._serve_undeploy()
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
            "fltPort": _studio_state.get("fltPort"),
            "studioPhase": _studio_state.get("phase", "idle"),
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

    # ── Studio Supervisor Endpoints ───────────────────────────────────────

    def _serve_studio_status(self):
        """GET /api/studio/status — authoritative studio phase.

        Auto-corrects stale state: if phase is 'deploying' but no deploy
        thread is running, or 'running' but FLT process is dead, fix it.
        """
        with _studio_lock:
            # Auto-correct: deploying but no active pipeline → reset to idle
            if _studio_state["phase"] == "deploying":
                # Check if deploy thread is actually running
                deploy_id = _studio_state.get("deployId")
                start_time = _studio_state.get("deployStartTime", 0)
                # If deploy started >5min ago and still "deploying", it's stale
                if start_time and (time.time() - start_time) > 300:
                    _studio_state.update({"phase": "idle", "deployId": None})

            # Auto-correct: running but FLT process is dead → crashed
            if _studio_state["phase"] == "running" and _flt_process and _flt_process.poll() is not None:
                _studio_state.update({
                    "phase": "crashed",
                    "deployError": f"FLT exited with code {_flt_process.returncode}",
                })

            # Auto-correct: running but no FLT process reference → idle
            if _studio_state["phase"] == "running" and _flt_process is None:
                _studio_state.update({"phase": "idle"})

            state = dict(_studio_state)
            state["deployLogs"] = list(_studio_state["deployLogs"][-200:])
        self._json_response(200, state)

    def _serve_deploy_start(self):
        """POST /api/command/deploy — start deploy pipeline.

        If already deployed to a different lakehouse, returns 409 with
        current target info so the frontend can show a confirmation dialog.
        Pass {"force": true} to allow re-deploy/switch.
        """
        content_len = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(content_len)) if content_len else {}
        ws_id = body.get("workspaceId", "")
        lh_id = body.get("artifactId", "")
        cap_id = body.get("capacityId", "")
        lh_name = body.get("lakehouseName", "")
        force = body.get("force", False)

        if not all([ws_id, lh_id]):
            self._json_response(400, {
                "error": "missing_params",
                "message": "workspaceId and artifactId required",
            })
            return

        with _studio_lock:
            phase = _studio_state["phase"]
            current_target = _studio_state.get("deployTarget")

            # Block if deploy is actively running
            if phase == "deploying":
                self._json_response(409, {
                    "error": "deploy_in_progress",
                    "message": "A deployment is already in progress",
                })
                return

            # If running/crashed on a DIFFERENT lakehouse, require confirmation
            if phase in ("running", "crashed") and current_target and not force:
                current_lh = current_target.get("artifactId", "")
                if current_lh and current_lh != lh_id:
                    self._json_response(409, {
                        "error": "already_deployed",
                        "message": f"Currently deployed to {current_target.get('lakehouseName', current_lh)}",
                        "currentTarget": current_target,
                    })
                    return

        # If already running, stop current service first
        global _flt_process
        if _flt_process and _flt_process.poll() is None:
            _deploy_log("Stopping current service for re-deploy...", "warn")
            _flt_process.terminate()
            try:
                _flt_process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                _flt_process.kill()
            _flt_process = None

        deploy_id = str(int(time.time() * 1000))
        _deploy_cancel.clear()

        with _studio_lock:
            _studio_state.update({
                "phase": "deploying", "deployId": deploy_id,
                "deployStep": 0, "deployTotal": 5,
                "deployMessage": "Starting deploy...", "deployError": None,
                "deployLogs": [],
                "deployTarget": {
                    "workspaceId": ws_id, "artifactId": lh_id,
                    "capacityId": cap_id, "lakehouseName": lh_name,
                },
                "deployStartTime": time.time(),
                "fltPort": None, "fltPid": None,
            })

        t = threading.Thread(
            target=_run_deploy_pipeline,
            args=(deploy_id, ws_id, lh_id, cap_id), daemon=True,
        )
        t.start()
        self._json_response(200, {"ok": True, "deployId": deploy_id})

    def _serve_deploy_cancel(self):
        """POST /api/command/deploy-cancel."""
        _deploy_cancel.set()
        self._json_response(200, {"ok": True})

    def _serve_undeploy(self):
        """POST /api/command/undeploy — stop FLT service, reset to Phase 1."""
        global _flt_process
        stopped = False

        if _flt_process and _flt_process.poll() is None:
            _deploy_log("Stopping FLT service...", "warn")
            _flt_process.terminate()
            try:
                _flt_process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                _flt_process.kill()
            stopped = True
            _flt_process = None

        with _studio_lock:
            target_name = ""
            if _studio_state.get("deployTarget"):
                target_name = _studio_state["deployTarget"].get("lakehouseName", "")
            _studio_state.update({
                "phase": "idle",
                "deployId": None,
                "fltPort": None,
                "fltPid": None,
                "deployStep": 0,
                "deployMessage": "",
                "deployError": None,
                "deployLogs": [],
                "deployTarget": None,
                "deployStartTime": None,
            })

        self._json_response(200, {"ok": True, "stopped": stopped, "lakehouse": target_name})

    def _serve_deploy_stream(self):
        """GET /api/command/deploy-stream — SSE stream."""
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.end_headers()

        last_idx = 0
        last_event_id = self.headers.get("Last-Event-ID")
        if last_event_id:
            try:
                last_idx = int(last_event_id)
            except ValueError:
                pass

        while True:
            with _studio_lock:
                phase = _studio_state["phase"]
                logs = _studio_state["deployLogs"][last_idx:]
                step = _studio_state["deployStep"]
                total = _studio_state["deployTotal"]
                msg = _studio_state["deployMessage"]
                err = _studio_state["deployError"]
                flt_port = _studio_state["fltPort"]

            for i, log_entry in enumerate(logs):
                event_id = last_idx + i
                data = json.dumps({
                    "step": step, "total": total, "status": phase,
                    "message": msg, "error": err, "log": log_entry,
                    "fltPort": flt_port,
                })
                try:
                    self.wfile.write(f"id: {event_id}\ndata: {data}\n\n".encode())
                    self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError):
                    return
            last_idx += len(logs)

            if phase in ("running", "crashed", "stopped", "idle"):
                final = json.dumps({
                    "step": step, "total": total, "status": phase,
                    "message": msg, "error": err, "fltPort": flt_port,
                })
                try:
                    self.wfile.write(f"event: complete\ndata: {final}\n\n".encode())
                    self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError):
                    pass
                return

            try:
                self.wfile.write(b": heartbeat\n\n")
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                return

            time.sleep(0.5)

    def _proxy_to_flt(self, method="GET"):
        """Proxy REST request to EdogLogServer on internal port."""
        with _studio_lock:
            port = _studio_state.get("fltPort")
        if not port:
            self._json_response(503, {
                "error": "flt_not_running",
                "message": "FLT service not running",
            })
            return

        target_url = f"http://localhost:{port}{self.path}"
        try:
            body = None
            if method in ("POST", "PUT", "PATCH"):
                cl = int(self.headers.get("Content-Length", 0))
                body = self.rfile.read(cl) if cl else None

            req = urllib.request.Request(target_url, data=body, method=method)
            ct = self.headers.get("Content-Type")
            if ct:
                req.add_header("Content-Type", ct)

            with urllib.request.urlopen(req, timeout=10) as resp:
                resp_body = resp.read()
                self.send_response(resp.status)
                self.send_header("Content-Type",
                                 resp.headers.get("Content-Type", "application/json"))
                self.send_header("Content-Length", str(len(resp_body)))
                self.end_headers()
                self.wfile.write(resp_body)
        except urllib.error.HTTPError as e:
            self._json_response(e.code, {"error": "flt_proxy_error", "message": str(e)})
        except Exception as e:
            self._json_response(502, {"error": "flt_proxy_error", "message": str(e)})

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

        # Git info from the FLT repo (workload-fabriclivetable), not edog-studio
        git_branch = ""
        git_dirty = 0
        flt_repo = ""
        try:
            cfg = json.loads(CONFIG_PATH.read_text()) if CONFIG_PATH.exists() else {}
            flt_repo = cfg.get("flt_repo_path", "")
        except Exception:
            pass
        git_cwd = flt_repo if flt_repo and Path(flt_repo).is_dir() else str(PROJECT_DIR)
        try:
            git_branch = subprocess.check_output(
                ["git", "rev-parse", "--abbrev-ref", "HEAD"],
                cwd=git_cwd, timeout=3, stderr=subprocess.DEVNULL,
            ).decode().strip()
            porcelain = subprocess.check_output(
                ["git", "status", "--porcelain"],
                cwd=git_cwd, timeout=3, stderr=subprocess.DEVNULL,
            ).decode().strip()
            git_dirty = len(porcelain.splitlines()) if porcelain else 0
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

    def _serve_table_stats(self):
        """GET /api/mwc/table-stats — read row count and size from OneLake delta log.

        Query params: wsId, lhId, tableName
        Returns: { rowCount: int, sizeBytes: int }
        """
        parsed = urllib.parse.urlparse(self.path)
        params = urllib.parse.parse_qs(parsed.query)
        ws_id = params.get("wsId", [None])[0]
        lh_id = params.get("lhId", [None])[0]
        table_name = params.get("tableName", [None])[0]

        if not all([ws_id, lh_id, table_name]):
            self._json_response(400, {"error": "missing_params",
                                      "message": "wsId, lhId, and tableName required"})
            return

        bearer, _ = _read_cache(BEARER_CACHE)
        if not bearer:
            self._json_response(401, {"error": "no_bearer_token"})
            return

        onelake_host = "https://onelake-int-edog.dfs.pbidedicated.windows-int.net"
        log_path = f"/{ws_id}/{lh_id}/Tables/dbo/{table_name}/_delta_log"
        ctx = ssl.create_default_context()

        try:
            # List delta log files
            list_url = f"{onelake_host}{log_path}?resource=filesystem&recursive=false"
            req = urllib.request.Request(list_url, headers={
                "Authorization": f"Bearer {bearer}",
                "x-ms-version": "2021-06-08",
            })
            with urllib.request.urlopen(req, timeout=10, context=ctx) as resp:
                listing = json.loads(resp.read())

            # Find JSON commit files, sorted by name (version order)
            json_files = sorted(
                [p["name"] for p in listing.get("paths", [])
                 if p["name"].endswith(".json") and not p.get("isDirectory")],
            )

            # Read each commit and accumulate active files
            active_files = {}  # path → {size, numRecords}
            for jf in json_files:
                file_url = f"{onelake_host}/{ws_id}/{jf}"
                req = urllib.request.Request(file_url, headers={
                    "Authorization": f"Bearer {bearer}",
                    "x-ms-version": "2021-06-08",
                })
                with urllib.request.urlopen(req, timeout=10, context=ctx) as resp:
                    content = resp.read().decode()

                for line in content.strip().split("\n"):
                    if not line.strip():
                        continue
                    entry = json.loads(line)
                    if "add" in entry:
                        add = entry["add"]
                        stats_raw = add.get("stats", "{}")
                        stats = json.loads(stats_raw) if isinstance(stats_raw, str) else stats_raw
                        active_files[add["path"]] = {
                            "size": add.get("size", 0),
                            "numRecords": stats.get("numRecords", 0),
                        }
                    elif "remove" in entry:
                        active_files.pop(entry["remove"]["path"], None)

            total_rows = sum(f["numRecords"] for f in active_files.values())
            total_size = sum(f["size"] for f in active_files.values())

            self._json_response(200, {
                "tableName": table_name,
                "rowCount": total_rows,
                "sizeBytes": total_size,
                "fileCount": len(active_files),
            })
        except urllib.error.HTTPError as e:
            if e.code == 404:
                self._json_response(200, {
                    "tableName": table_name,
                    "rowCount": None,
                    "sizeBytes": None,
                    "error": "delta_log_not_found",
                })
            else:
                body = e.read().decode("utf-8", "replace")[:200]
                self._json_response(e.code, {"error": "onelake_error", "message": body})
        except Exception as e:
            self._json_response(502, {"error": "stats_error", "message": str(e)})

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

    # ── Notebook LRO Endpoints ────────────────────────────────────────

    def _serve_notebook_content(self):
        """GET /api/notebook/content?wsId=X&nbId=Y — fetch notebook definition via LRO."""
        parsed = urllib.parse.urlparse(self.path)
        params = urllib.parse.parse_qs(parsed.query)
        ws_id = params.get("wsId", [None])[0]
        nb_id = params.get("nbId", [None])[0]

        if not all([ws_id, nb_id]):
            self._json_response(400, {"error": "missing_params", "message": "wsId and nbId are required"})
            return

        bearer, _ = _read_cache(BEARER_CACHE)
        if not bearer:
            self._json_response(401, {"error": "no_bearer_token", "message": "Bearer token not cached"})
            return

        ctx = ssl.create_default_context()
        headers = {
            "Authorization": f"Bearer {bearer}",
            "Content-Type": "application/json",
        }

        # Step 1: POST getDefinition → expect 202 with Location header
        url = f"{REDIRECT_HOST}/v1/workspaces/{ws_id}/notebooks/{nb_id}/getDefinition"
        print(f"  [NOTEBOOK] POST getDefinition ws={ws_id[:8]}... nb={nb_id[:8]}...")

        try:
            location = None
            resp_data = None
            req = urllib.request.Request(url, data=b"{}", headers=headers, method="POST")
            try:
                with urllib.request.urlopen(req, timeout=30, context=ctx) as resp:
                    status_code = resp.getcode()
                    if status_code == 202:
                        # 202 Accepted — extract Location for LRO polling
                        location = resp.headers.get("Location", "")
                        retry_after = int(resp.headers.get("Retry-After", "2"))
                        resp.read()  # drain body
                    else:
                        # Synchronous 200 — definition returned directly
                        resp_data = json.loads(resp.read())
            except urllib.error.HTTPError as e:
                if e.code == 202:
                    # Some servers raise HTTPError for 202
                    location = e.headers.get("Location", "")
                    retry_after = int(e.headers.get("Retry-After", "2"))
                    e.read()
                else:
                    body = e.read().decode("utf-8", "replace")[:500]
                    self._json_response(e.code, {"error": "getDefinition_error", "message": body})
                    return

            # Step 2: If LRO, poll Location URL until Succeeded (max 60s)
            if location and not resp_data:
                if not location:
                    self._json_response(502, {"error": "no_location", "message": "202 without Location header"})
                    return

                print(f"  [NOTEBOOK] Polling LRO: {location[:80]}...")
                for attempt in range(30):
                    time.sleep(retry_after if attempt == 0 else 2)
                    poll_req = urllib.request.Request(location, headers=headers, method="GET")
                    with urllib.request.urlopen(poll_req, timeout=30, context=ctx) as poll_resp:
                        poll_data = json.loads(poll_resp.read())

                    status = poll_data.get("status", "").lower()
                    if status == "succeeded":
                        print(f"  [NOTEBOOK] LRO succeeded after {(attempt + 1) * 2}s")
                        resp_data = poll_data
                        break
                    if status in ("failed", "cancelled"):
                        self._json_response(500, {"error": "lro_failed", "status": status, "detail": poll_data})
                        return

                if resp_data is None:
                    self._json_response(504, {
                        "error": "lro_timeout",
                        "message": "getDefinition did not complete in 60s",
                    })
                    return

                # Step 3: GET the result URL
                result_url = location + "/result"
                result_req = urllib.request.Request(result_url, headers=headers, method="GET")
                with urllib.request.urlopen(result_req, timeout=30, context=ctx) as result_resp:
                    resp_data = json.loads(result_resp.read())

            # Step 4: Decode base64 parts from the definition
            parts = resp_data.get("definition", {}).get("parts", [])
            all_parts = []
            content_text = ""
            platform_text = ""
            for part in parts:
                path = part.get("path", "")
                payload = part.get("payload", "")
                try:
                    decoded = base64.b64decode(payload).decode("utf-8", "replace")
                except Exception:
                    decoded = payload
                all_parts.append({"path": path, "decoded": decoded})
                if path == "notebook-content.sql":
                    content_text = decoded
                elif path == ".platform":
                    platform_text = decoded

            self._json_response(200, {
                "content": content_text,
                "platform": platform_text,
                "allParts": all_parts,
            })
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", "replace")[:500]
            self._json_response(e.code, {"error": "notebook_content_error", "message": body})
        except Exception as e:
            traceback.print_exc()
            self._json_response(502, {"error": "notebook_content_error", "message": str(e)})

    def _serve_notebook_save(self):
        """POST /api/notebook/save — update notebook definition."""
        content_len = int(self.headers.get("Content-Length", 0))
        if content_len == 0:
            self._json_response(400, {"error": "empty_body", "message": "Request body required"})
            return

        body = json.loads(self.rfile.read(content_len))
        ws_id = body.get("wsId")
        nb_id = body.get("nbId")
        content = body.get("content", "")

        if not all([ws_id, nb_id]):
            self._json_response(400, {"error": "missing_params", "message": "wsId and nbId are required"})
            return

        bearer, _ = _read_cache(BEARER_CACHE)
        if not bearer:
            self._json_response(401, {"error": "no_bearer_token", "message": "Bearer token not cached"})
            return

        # Build definition parts with base64-encoded payloads
        parts = [
            {
                "path": "notebook-content.sql",
                "payload": base64.b64encode(content.encode("utf-8")).decode(),
                "payloadType": "InlineBase64",
            },
        ]
        platform = body.get("platform")
        if platform:
            parts.append({
                "path": ".platform",
                "payload": base64.b64encode(platform.encode("utf-8")).decode(),
                "payloadType": "InlineBase64",
            })

        url = f"{REDIRECT_HOST}/v1/workspaces/{ws_id}/notebooks/{nb_id}/updateDefinition"
        req_body = json.dumps({"definition": {"parts": parts}}).encode()
        print(f"  [NOTEBOOK] POST updateDefinition ws={ws_id[:8]}... nb={nb_id[:8]}...")

        try:
            ctx = ssl.create_default_context()
            req = urllib.request.Request(url, data=req_body, headers={
                "Authorization": f"Bearer {bearer}",
                "Content-Type": "application/json",
            }, method="POST")
            with urllib.request.urlopen(req, timeout=30, context=ctx) as resp:
                resp.read()  # drain
            self._json_response(200, {"status": "saved"})
        except urllib.error.HTTPError as e:
            # 202 Accepted is also a success for updateDefinition
            if e.code == 202:
                e.read()
                self._json_response(200, {"status": "saved"})
            else:
                err_body = e.read().decode("utf-8", "replace")[:500]
                self._json_response(e.code, {"error": "save_error", "message": err_body})
        except Exception as e:
            traceback.print_exc()
            self._json_response(502, {"error": "save_error", "message": str(e)})

    def _serve_notebook_run(self):
        """POST /api/notebook/run — start a notebook job execution."""
        content_len = int(self.headers.get("Content-Length", 0))
        if content_len == 0:
            self._json_response(400, {"error": "empty_body", "message": "Request body required"})
            return

        body = json.loads(self.rfile.read(content_len))
        ws_id = body.get("wsId")
        nb_id = body.get("nbId")

        if not all([ws_id, nb_id]):
            self._json_response(400, {"error": "missing_params", "message": "wsId and nbId are required"})
            return

        bearer, _ = _read_cache(BEARER_CACHE)
        if not bearer:
            self._json_response(401, {"error": "no_bearer_token", "message": "Bearer token not cached"})
            return

        url = (
            f"{REDIRECT_HOST}/v1/workspaces/{ws_id}/items/{nb_id}"
            f"/jobs/instances?jobType=RunNotebook"
        )
        print(f"  [NOTEBOOK] POST run ws={ws_id[:8]}... nb={nb_id[:8]}...")

        try:
            ctx = ssl.create_default_context()
            req = urllib.request.Request(url, data=b"{}", headers={
                "Authorization": f"Bearer {bearer}",
                "Content-Type": "application/json",
            }, method="POST")
            try:
                with urllib.request.urlopen(req, timeout=30, context=ctx) as resp:
                    # Unexpected 200 — return whatever we got
                    resp_data = json.loads(resp.read())
                    self._json_response(200, {"status": "started", "detail": resp_data})
            except urllib.error.HTTPError as e:
                if e.code == 202:
                    location = e.headers.get("Location", "")
                    e.read()  # drain
                    self._json_response(200, {"location": location, "status": "started"})
                else:
                    err_body = e.read().decode("utf-8", "replace")[:500]
                    self._json_response(e.code, {"error": "run_error", "message": err_body})
        except Exception as e:
            traceback.print_exc()
            self._json_response(502, {"error": "run_error", "message": str(e)})

    def _serve_notebook_run_status(self):
        """GET /api/notebook/run-status?location=URL — poll notebook job status."""
        parsed = urllib.parse.urlparse(self.path)
        params = urllib.parse.parse_qs(parsed.query)
        location = params.get("location", [None])[0]

        if not location:
            self._json_response(400, {"error": "missing_params", "message": "location query param is required"})
            return

        bearer, _ = _read_cache(BEARER_CACHE)
        if not bearer:
            self._json_response(401, {"error": "no_bearer_token", "message": "Bearer token not cached"})
            return

        print(f"  [NOTEBOOK] GET run-status → {location[:80]}...")

        try:
            ctx = ssl.create_default_context()
            req = urllib.request.Request(location, headers={
                "Authorization": f"Bearer {bearer}",
                "Content-Type": "application/json",
            }, method="GET")
            with urllib.request.urlopen(req, timeout=30, context=ctx) as resp:
                resp_data = json.loads(resp.read())
            self._json_response(200, resp_data)
        except urllib.error.HTTPError as e:
            err_body = e.read().decode("utf-8", "replace")[:500]
            self._json_response(e.code, {"error": "run_status_error", "message": err_body})
        except Exception as e:
            traceback.print_exc()
            self._json_response(502, {"error": "run_status_error", "message": str(e)})

    def _serve_notebook_cancel(self):
        """POST /api/notebook/cancel — cancel a running notebook job."""
        content_len = int(self.headers.get("Content-Length", 0))
        if content_len == 0:
            self._json_response(400, {"error": "empty_body", "message": "Request body required"})
            return

        body = json.loads(self.rfile.read(content_len))
        location = body.get("location")

        if not location:
            self._json_response(400, {"error": "missing_params", "message": "location is required"})
            return

        bearer, _ = _read_cache(BEARER_CACHE)
        if not bearer:
            self._json_response(401, {"error": "no_bearer_token", "message": "Bearer token not cached"})
            return

        cancel_url = f"{location}/cancel"
        print(f"  [NOTEBOOK] POST cancel → {cancel_url[:80]}...")

        try:
            ctx = ssl.create_default_context()
            req = urllib.request.Request(cancel_url, data=b"{}", headers={
                "Authorization": f"Bearer {bearer}",
                "Content-Type": "application/json",
            }, method="POST")
            with urllib.request.urlopen(req, timeout=30, context=ctx) as resp:
                resp.read()  # drain
            self._json_response(200, {"status": "cancelled"})
        except urllib.error.HTTPError as e:
            # 202 is also success for cancel
            if e.code == 202:
                e.read()
                self._json_response(200, {"status": "cancelled"})
            else:
                err_body = e.read().decode("utf-8", "replace")[:500]
                self._json_response(e.code, {"error": "cancel_error", "message": err_body})
        except Exception as e:
            traceback.print_exc()
            self._json_response(502, {"error": "cancel_error", "message": str(e)})

    # ── Jupyter Cell Execution Endpoints ──────────────────────────────

    def _serve_jupyter_create_session(self):
        """POST /api/notebook/create-session — create a Jupyter kernel session."""
        content_len = int(self.headers.get("Content-Length", 0))
        if content_len == 0:
            print("  [JUPYTER] Rejected: empty body")
            self._json_response(400, {"error": "empty_body", "message": "Request body required"})
            return

        body = json.loads(self.rfile.read(content_len))
        ws_id = body.get("wsId")
        nb_id = body.get("nbId")
        cap_id = body.get("capId")
        lh_id = body.get("lhId", "")
        print(f"  [JUPYTER] create-session wsId={ws_id} nbId={nb_id} capId={cap_id}")

        if not all([ws_id, nb_id, cap_id]):
            print(f"  [JUPYTER] Rejected: missing params ws={bool(ws_id)} nb={bool(nb_id)} cap={bool(cap_id)}")
            self._json_response(400, {
                "error": "missing_params",
                "message": f"wsId, nbId, and capId are required. Got ws={bool(ws_id)} nb={bool(nb_id)} cap={bool(cap_id)}",
            })
            return

        token, cap_host = _resolve_mwc_for_jupyter(cap_id, ws_id, nb_id, lh_id)
        if not token:
            print(f"  [JUPYTER] Rejected: no MWC token for capId={cap_id}")
            self._json_response(400, {
                "error": "no_mwc_token",
                "message": "MWC token not available. Deploy to a lakehouse first to enable cell execution.",
            })
            return
        if not cap_host:
            cap_host = f"https://{cap_id.replace('-', '')}.pbidedicated.windows-int.net"

        base = _jupyter_api_path(cap_id, ws_id, nb_id)
        url = f"{cap_host}{base}/sessions"

        session_body = json.dumps({
            "kernel": {"id": None, "name": "synapse_pyspark"},
            "name": "",
            "path": f"notebooks/{nb_id}.ipynb",
            "type": "notebook",
        }).encode()

        print(f"  [JUPYTER] POST create-session ws={ws_id[:8]}... nb={nb_id[:8]}...")

        try:
            ctx = ssl.create_default_context()
            req = urllib.request.Request(url, data=session_body, headers={
                "Authorization": f"MwcToken {token}",
                "Content-Type": "application/json",
            }, method="POST")
            with urllib.request.urlopen(req, timeout=60, context=ctx) as resp:
                resp_data = json.loads(resp.read())

            kernel_id = resp_data.get("kernel", {}).get("id", "")
            session_id = resp_data.get("id", "")
            exec_state = resp_data.get("kernel", {}).get("execution_state", "unknown")

            cache_key = f"{ws_id}:{nb_id}:{cap_id}"
            with _jupyter_lock:
                _jupyter_sessions[cache_key] = {
                    "kernelId": kernel_id,
                    "sessionId": session_id,
                    "capHost": cap_host,
                }

            print(f"  [JUPYTER] Session created kernel={kernel_id[:8]}... state={exec_state}")
            self._json_response(200, {
                "kernelId": kernel_id,
                "sessionId": session_id,
                "executionState": exec_state,
                "capHost": cap_host,
            })
        except urllib.error.HTTPError as e:
            err_body = e.read().decode("utf-8", "replace")[:500]
            print(f"  [JUPYTER] Session creation failed: {e.code}")
            self._json_response(e.code, {"error": "jupyter_session_error", "message": err_body})
        except Exception as e:
            traceback.print_exc()
            self._json_response(502, {"error": "jupyter_session_error", "message": str(e)})

    def _serve_jupyter_kernel_specs(self):
        """GET /api/notebook/kernel-specs — list available Jupyter kernels."""
        parsed = urllib.parse.urlparse(self.path)
        params = urllib.parse.parse_qs(parsed.query)
        ws_id = params.get("wsId", [None])[0]
        nb_id = params.get("nbId", [None])[0]
        cap_id = params.get("capId", [None])[0]

        if not all([ws_id, nb_id, cap_id]):
            self._json_response(400, {
                "error": "missing_params",
                "message": "wsId, nbId, and capId are required",
            })
            return

        token, cap_host = _resolve_mwc_for_jupyter(cap_id, ws_id, nb_id)
        if not token:
            self._json_response(400, {
                "error": "no_mwc_token",
                "message": "MWC token not available.",
            })
            return
        if not cap_host:
            cap_host = f"https://{cap_id.replace('-', '')}.pbidedicated.windows-int.net"

        base = _jupyter_api_path(cap_id, ws_id, nb_id)
        url = f"{cap_host}{base}/kernelspecs"

        print(f"  [JUPYTER] GET kernel-specs ws={ws_id[:8]}... nb={nb_id[:8]}...")

        try:
            ctx = ssl.create_default_context()
            req = urllib.request.Request(url, headers={
                "Authorization": f"MwcToken {token}",
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
            err_body = e.read().decode("utf-8", "replace")[:500]
            self._json_response(e.code, {"error": "kernel_specs_error", "message": err_body})
        except Exception as e:
            traceback.print_exc()
            self._json_response(502, {"error": "kernel_specs_error", "message": str(e)})

    def _serve_jupyter_execute_cell(self):
        """POST /api/notebook/execute-cell — execute a single notebook cell.

        Flow: poll session until idle → connect WebSocket → send execute_request
        → collect output messages → return results.
        """
        content_len = int(self.headers.get("Content-Length", 0))
        if content_len == 0:
            self._json_response(400, {"error": "empty_body", "message": "Request body required"})
            return

        body = json.loads(self.rfile.read(content_len))
        ws_id = body.get("wsId")
        nb_id = body.get("nbId")
        cap_id = body.get("capId")
        code = body.get("code", "")
        language = body.get("language", "python")

        if not all([ws_id, nb_id, cap_id]):
            self._json_response(400, {
                "error": "missing_params",
                "message": "wsId, nbId, capId, and code are required",
            })
            return
        if not code.strip():
            self._json_response(400, {"error": "empty_code", "message": "code must not be empty"})
            return

        token, cap_host = _resolve_mwc_for_jupyter(cap_id, ws_id, nb_id, body.get("lhId", ""))
        if not token:
            self._json_response(400, {
                "error": "no_mwc_token",
                "message": "MWC token not available. Deploy to a lakehouse first.",
            })
            return
        if not cap_host:
            cap_host = f"https://{cap_id.replace('-', '')}.pbidedicated.windows-int.net"

        # Reuse cached session or create a new one
        cache_key = f"{ws_id}:{nb_id}:{cap_id}"
        with _jupyter_lock:
            cached = _jupyter_sessions.get(cache_key)

        kernel_id = None
        session_id = None
        base = _jupyter_api_path(cap_id, ws_id, nb_id)

        if cached:
            kernel_id = cached["kernelId"]
            session_id = cached["sessionId"]
            print(f"  [JUPYTER] Reusing session kernel={kernel_id[:8]}...")
        else:
            url = f"{cap_host}{base}/sessions"
            session_body = json.dumps({
                "kernel": {"id": None, "name": "synapse_pyspark"},
                "name": "",
                "path": f"notebooks/{nb_id}.ipynb",
                "type": "notebook",
            }).encode()

            print("  [JUPYTER] Auto-creating session for execute-cell...")
            try:
                ctx = ssl.create_default_context()
                req = urllib.request.Request(url, data=session_body, headers={
                    "Authorization": f"MwcToken {token}",
                    "Content-Type": "application/json",
                }, method="POST")
                with urllib.request.urlopen(req, timeout=60, context=ctx) as resp:
                    resp_data = json.loads(resp.read())
                kernel_id = resp_data.get("kernel", {}).get("id", "")
                session_id = resp_data.get("id", "")
                with _jupyter_lock:
                    _jupyter_sessions[cache_key] = {
                        "kernelId": kernel_id,
                        "sessionId": session_id,
                        "capHost": cap_host,
                    }
                print(f"  [JUPYTER] Session auto-created kernel={kernel_id[:8]}...")
            except urllib.error.HTTPError as e:
                err_body = e.read().decode("utf-8", "replace")[:500]
                self._json_response(e.code, {"error": "jupyter_session_error", "message": err_body})
                return
            except Exception as e:
                traceback.print_exc()
                self._json_response(502, {"error": "jupyter_session_error", "message": str(e)})
                return

        # Step 1: Poll session until kernel is idle (max 10 min)
        session_url = f"{cap_host}{base}/sessions/{session_id}"
        print(f"  [JUPYTER] Polling session until kernel idle...")
        ctx = ssl.create_default_context()
        kernel_ready = False
        for attempt in range(300):  # Max 10 min (300 x 2s)
            try:
                req = urllib.request.Request(session_url, headers={
                    "Authorization": f"MwcToken {token}",
                }, method="GET")
                with urllib.request.urlopen(req, timeout=15, context=ctx) as resp:
                    sdata = json.loads(resp.read())
                kstate = sdata.get("kernel", {}).get("execution_state", "unknown")
                if kstate == "idle":
                    kernel_ready = True
                    print(f"  [JUPYTER] Kernel idle after {attempt * 2}s")
                    break
                if kstate == "dead":
                    self._json_response(500, {"error": "kernel_dead", "message": "Kernel died during startup"})
                    return
                if attempt % 15 == 0:
                    print(f"  [JUPYTER] Kernel state: {kstate} ({attempt * 2}s elapsed)...")
            except Exception as e:
                print(f"  [JUPYTER] Poll error: {e}")
            time.sleep(2)

        if not kernel_ready:
            self._json_response(504, {
                "error": "kernel_timeout",
                "message": "Kernel did not become idle within 10 minutes. Try again.",
            })
            return

        # Step 2: Execute via Jupyter WebSocket protocol
        print(f"  [JUPYTER] Executing cell via WebSocket ({len(code)} chars, lang={language})...")
        try:
            import asyncio
            result = asyncio.run(_jupyter_ws_execute(
                cap_host, cap_id, ws_id, nb_id, kernel_id, token, code
            ))
            print(f"  [JUPYTER] Execution complete: {result.get('status', 'unknown')}")
            self._json_response(200, result)
        except Exception as e:
            traceback.print_exc()
            self._json_response(502, {"error": "execute_error", "message": str(e)})

    def _serve_jupyter_close_session(self):
        """POST /api/notebook/close-session — close a Jupyter kernel session."""
        content_len = int(self.headers.get("Content-Length", 0))
        if content_len == 0:
            self._json_response(400, {"error": "empty_body", "message": "Request body required"})
            return

        body = json.loads(self.rfile.read(content_len))
        ws_id = body.get("wsId")
        nb_id = body.get("nbId")
        cap_id = body.get("capId")
        session_id = body.get("sessionId")

        if not all([ws_id, nb_id, cap_id, session_id]):
            self._json_response(400, {
                "error": "missing_params",
                "message": "wsId, nbId, capId, and sessionId are required",
            })
            return

        token, cap_host = _resolve_mwc_for_jupyter(cap_id, ws_id, nb_id, body.get("lhId", ""))
        if not token:
            self._json_response(400, {
                "error": "no_mwc_token",
                "message": "MWC token not available.",
            })
            return
        if not cap_host:
            cap_host = f"https://{cap_id.replace('-', '')}.pbidedicated.windows-int.net"

        base = _jupyter_api_path(cap_id, ws_id, nb_id)
        url = f"{cap_host}{base}/sessions/{session_id}"
        print(f"  [JUPYTER] DELETE session={session_id[:8]}...")

        try:
            ctx = ssl.create_default_context()
            req = urllib.request.Request(url, headers={
                "Authorization": f"MwcToken {token}",
                "Content-Type": "application/json",
            }, method="DELETE")
            with urllib.request.urlopen(req, timeout=30, context=ctx) as resp:
                resp.read()  # drain
        except urllib.error.HTTPError as e:
            if e.code in (204, 404):
                e.read()  # 204=success, 404=already deleted
            else:
                err_body = e.read().decode("utf-8", "replace")[:500]
                self._json_response(e.code, {"error": "close_session_error", "message": err_body})
                return
        except Exception as e:
            traceback.print_exc()
            self._json_response(502, {"error": "close_session_error", "message": str(e)})
            return

        cache_key = f"{ws_id}:{nb_id}:{cap_id}"
        with _jupyter_lock:
            _jupyter_sessions.pop(cache_key, None)

        print("  [JUPYTER] Session closed")
        self._json_response(200, {"status": "closed"})

    def _send_json(self, status, obj):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        msg = str(args)
        quiet_paths = (
            "/api/flt/config", "/ws/logs", "/api/logs",
            "/api/telemetry", "/api/stats",
        )
        if any(p in msg for p in quiet_paths):
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
        print("\nShutting down...")
        # Kill FLT process if we own one
        if _flt_process and _flt_process.poll() is None:
            print(f"  Stopping FLT service (PID: {_flt_process.pid})...")
            _flt_process.terminate()
            try:
                _flt_process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                _flt_process.kill()
            print("  FLT service stopped.")
        server.server_close()
        print("Server stopped.")
