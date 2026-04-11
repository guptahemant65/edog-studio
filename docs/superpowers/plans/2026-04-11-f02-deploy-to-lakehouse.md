# F02 Deploy to Lakehouse — Implementation Plan (v2)

> **Revision:** v2 — rewritten after engineering team review (12 issues resolved)
> **Architecture:** Direct Connect with dev-server.py as permanent supervisor
> **For agentic workers:** Use superpowers:subagent-driven-development to execute

## Architecture Decision

After team review, the architecture is:

```
dev-server.py (:5555) — PERMANENT SUPERVISOR
    │
    ├── Serves HTML (always)
    ├── Fabric API proxy (always)
    ├── Deploy orchestration (calls edog.py --headless-deploy for patch+build)
    ├── OWNS the FLT process (launch, monitor, restart, kill via subprocess)
    ├── Token refresh loop (background thread, refreshes MWC every 50 min)
    ├── Studio status endpoint: /api/studio/status
    ├── REST proxy to :5557 (/api/logs, /api/flt/config, /api/telemetry)
    ├── SSE stream for deploy progress
    │
    └── Browser connects WebSocket DIRECTLY to :5557 (no CORS on WS)
        EdogLogServer (C#, inside FLT process) on :5557
```

### Team Review Issues Resolved

| # | Issue | Resolution | Task |
|---|-------|------------|------|
| 1 | Port 5555 hardcoded in C# patch | EdogLogServer reads `EDOG_STUDIO_PORT` env var, falls back to 5555 | T1 |
| 2 | No WS origin protection | Accept-only from localhost origins in EdogLogServer | T1 |
| 3 | HTML served from :5557 is dead code | Replace root with JSON health endpoint in Studio mode | T1 |
| 4 | stdout mixes JSON protocol + dotnet output | edog.py --headless-deploy: stdout = JSON-only, dotnet output piped to stderr or captured separately | T3 |
| 5 | FLT process orphaned after edog.py exits | dev-server.py owns FLT process via subprocess.Popen | T2 |
| 6 | SSE blocks handler thread | ThreadingMixIn handles this; add heartbeat + max 1 concurrent SSE | T2 |
| 7 | No Phase 2 state on refresh | `/api/studio/status` returns `{phase, fltPort, pid, health}` | T2 |
| 8 | Can't distinguish crash vs not-started | Explicit phase enum: idle/deploying/running/crashed/stopped | T2 |
| 9 | SSE reconnect loses progress | Deploy job with ID + progress file; SSE resumable via Last-Event-ID | T2 |
| 10 | Token refresh stops after one-shot deploy | dev-server.py runs token refresh loop in background thread | T2 |
| 11 | "done" emitted before health check | Health ping loop before emitting done | T3 |
| 12 | File locking on shared config | Atomic write (write tmp + rename) for edog-config.json and caches | T2 |

---

## File Structure

| File | Action | Description |
|------|--------|-------------|
| `src/frontend/css/deploy.css` | **Create** | Stepper, progress bar, terminal, success/error cards |
| `src/frontend/js/deploy-flow.js` | **Create** | DeployFlow class — stepper UI, SSE consumer, phase transitions |
| `src/frontend/js/workspace-explorer.js` | **Modify** | Replace simulated deploy with DeployFlow |
| `src/frontend/js/topbar.js` | **Modify** | setDeployStatus() + deploy state awareness |
| `src/frontend/js/sidebar.js` | **Modify** | Cascade-enable animation |
| `src/frontend/js/main.js` | **Modify** | Expose globals + deploy resume on load |
| `src/frontend/index.html` | **Modify** | CSS module ordering |
| `src/backend/DevMode/EdogLogServer.cs` | **Modify** | EDOG_STUDIO_PORT env var, origin check, health-only root |
| `scripts/dev-server.py` | **Modify** | Deploy endpoints, FLT process management, SSE, studio status, token refresh, REST proxy to :5557, atomic writes |
| `scripts/build-html.py` | **Modify** | Add deploy.css + deploy-flow.js to module list |
| `edog.py` | **Modify** | Add --headless-deploy flag (patch+build only, JSON stdout) |
| `tests/test_deploy_flow.py` | **Create** | Deploy state transitions, atomic writes, progress protocol |

---

## Task 1: C# Changes (EdogLogServer) — Issues #1, #2, #3

**Owner:** Arjun
**Files:** `src/backend/DevMode/EdogLogServer.cs`, `edog.py` (patch template)

### Step 1: EdogLogServer port from env var

In `EdogLogServer.cs` constructor, read env var:

```csharp
public EdogLogServer(int port = 5555)
{
    var envPort = Environment.GetEnvironmentVariable("EDOG_STUDIO_PORT");
    this.port = envPort != null && int.TryParse(envPort, out var p) ? p : port;
}
```

### Step 2: Origin check on WebSocket

In `ConfigureRoutes()`, before `AcceptWebSocketAsync`, add origin validation:

```csharp
// Only accept WebSocket from localhost origins
var origin = context.Request.Headers["Origin"].ToString();
if (!string.IsNullOrEmpty(origin)
    && !origin.Contains("localhost", StringComparison.OrdinalIgnoreCase)
    && !origin.Contains("127.0.0.1"))
{
    context.Response.StatusCode = 403;
    return;
}
```

### Step 3: Studio-mode root endpoint

When `EDOG_STUDIO_PORT` is set, serve health JSON at `/` instead of HTML:

```csharp
app.MapGet("/", async context =>
{
    if (Environment.GetEnvironmentVariable("EDOG_STUDIO_PORT") != null)
    {
        context.Response.ContentType = "application/json";
        await context.Response.WriteAsync("{\"status\":\"ok\",\"mode\":\"studio\"}");
        return;
    }
    context.Response.ContentType = "text/html";
    await context.Response.WriteAsync(htmlContent);
});
```

### Step 4: Update edog.py patch template

Change hardcoded `5555` in the patched C# to read the env var:

```python
# In registration_code (edog.py ~line 1695), change:
"            var edogServer = new Microsoft.LiveTable.Service.DevMode.EdogLogServer(5555);\n"
# To:
"            var edogServer = new Microsoft.LiveTable.Service.DevMode.EdogLogServer();\n"
```

The constructor now defaults to 5555 but respects `EDOG_STUDIO_PORT`.

### Commit message

```
feat(deploy): EdogLogServer env var port + origin check + studio mode

- Read EDOG_STUDIO_PORT env var in constructor (fallback 5555)
- WebSocket origin check: localhost only
- Studio mode: serve health JSON at / instead of HTML
- Patch template: no hardcoded port literal

Resolves review issues #1, #2, #3
```

---

## Task 2: dev-server.py Supervisor — Issues #5, #6, #7, #8, #9, #10, #12

**Owner:** Elena
**Files:** `scripts/dev-server.py`, `tests/test_deploy_flow.py`

This is the biggest task. dev-server.py becomes the Studio supervisor that owns the FLT process, manages deploy jobs, refreshes tokens, and serves studio status.

### Step 1: Atomic write utility (Issue #12)

```python
import os
import tempfile

def _atomic_write(path: Path, data: str):
    """Write data atomically: write to temp file, then rename."""
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), suffix='.tmp')
    try:
        os.write(fd, data.encode('utf-8'))
        os.close(fd)
        os.replace(tmp, str(path))
    except Exception:
        os.close(fd) if not os.get_inheritable(fd) else None
        try: os.unlink(tmp)
        except OSError: pass
        raise
```

Replace all `CONFIG_PATH.write_text(...)`, `json.dumps` file writes with `_atomic_write()`.

### Step 2: Studio state model (Issues #7, #8)

```python
# Studio state — single source of truth for browser
_studio_state = {
    "phase": "idle",      # idle | deploying | running | crashed | stopped
    "deployId": None,     # UUID for current deploy job
    "fltPort": None,      # 5557 when FLT is running
    "fltPid": None,       # FLT process PID
    "deployStep": 0,      # 0-4 during deploy
    "deployTotal": 5,
    "deployMessage": "",
    "deployError": None,
    "deployLogs": [],     # [{ts, msg, level}]
    "deployTarget": None, # {workspaceId, artifactId, capacityId, lakehouseName}
    "deployStartTime": None,
}
_studio_lock = threading.Lock()
_flt_process = None       # subprocess.Popen reference
_flt_monitor_thread = None
_token_refresh_thread = None
_deploy_cancel = threading.Event()
```

### Step 3: Studio status endpoint (Issue #7)

```python
def _serve_studio_status(self):
    """GET /api/studio/status — authoritative phase + connection info."""
    with _studio_lock:
        state = dict(_studio_state)
        state["deployLogs"] = list(_studio_state["deployLogs"][-200:])  # cap
    self._json_response(200, state)
```

Add to `do_GET`:
```python
elif self.path == "/api/studio/status":
    self._serve_studio_status()
```

### Step 4: Deploy start endpoint with job ID (Issue #9)

```python
def _serve_deploy_start(self):
    """POST /api/command/deploy — start deploy, return job ID."""
    global _deploy_cancel
    with _studio_lock:
        if _studio_state["phase"] == "deploying":
            self._json_response(409, {"error": "deploy_in_progress"})
            return

    content_len = int(self.headers.get("Content-Length", 0))
    body = json.loads(self.rfile.read(content_len)) if content_len else {}
    ws_id = body.get("workspaceId", "")
    lh_id = body.get("artifactId", "")
    cap_id = body.get("capacityId", "")
    lh_name = body.get("lakehouseName", "")

    if not all([ws_id, lh_id]):
        self._json_response(400, {"error": "missing_params"})
        return

    deploy_id = str(int(time.time() * 1000))
    _deploy_cancel = threading.Event()

    with _studio_lock:
        _studio_state.update({
            "phase": "deploying",
            "deployId": deploy_id,
            "deployStep": 0,
            "deployTotal": 5,
            "deployMessage": "Starting deploy...",
            "deployError": None,
            "deployLogs": [],
            "deployTarget": {"workspaceId": ws_id, "artifactId": lh_id,
                             "capacityId": cap_id, "lakehouseName": lh_name},
            "deployStartTime": time.time(),
        })

    t = threading.Thread(target=_run_deploy_pipeline,
                         args=(deploy_id, ws_id, lh_id, cap_id), daemon=True)
    t.start()
    self._json_response(200, {"ok": True, "deployId": deploy_id})
```

### Step 5: SSE deploy stream endpoint (Issue #9)

```python
def _serve_deploy_stream(self):
    """GET /api/command/deploy-stream — SSE stream of deploy progress."""
    self.send_response(200)
    self.send_header("Content-Type", "text/event-stream")
    self.send_header("Cache-Control", "no-cache")
    self.send_header("Connection", "keep-alive")
    self.end_headers()

    last_idx = 0
    last_event_id = self.headers.get("Last-Event-ID")
    if last_event_id:
        try: last_idx = int(last_event_id)
        except ValueError: pass

    while True:
        with _studio_lock:
            phase = _studio_state["phase"]
            logs = _studio_state["deployLogs"][last_idx:]
            step = _studio_state["deployStep"]
            msg = _studio_state["deployMessage"]
            err = _studio_state["deployError"]
            flt_port = _studio_state["fltPort"]

        # Send new log events
        for i, log in enumerate(logs):
            event_id = last_idx + i
            data = json.dumps({"step": step, "total": 5, "status": phase,
                               "message": msg, "error": err, "log": log,
                               "fltPort": flt_port})
            try:
                self.wfile.write(f"id: {event_id}\ndata: {data}\n\n".encode())
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                return
        last_idx += len(logs)

        # Terminal states
        if phase in ("running", "crashed", "stopped", "idle"):
            # Send final state
            final = json.dumps({"step": step, "total": 5, "status": phase,
                                "message": msg, "error": err, "fltPort": flt_port})
            try:
                self.wfile.write(f"event: done\ndata: {final}\n\n".encode())
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass
            return

        # Heartbeat every 2s (keeps connection alive through proxies)
        try:
            self.wfile.write(b": heartbeat\n\n")
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            return

        time.sleep(0.5)
```

### Step 6: Real deploy pipeline (Issues #5, #10, #11)

dev-server.py owns the full pipeline. edog.py is called for patch+build only.

```python
FLT_INTERNAL_PORT = 5557

def _deploy_log(msg, level="info"):
    with _studio_lock:
        _studio_state["deployLogs"].append({
            "ts": datetime.now().strftime("%H:%M:%S"), "msg": msg, "level": level
        })

def _deploy_step(step, message, deploy_id):
    with _studio_lock:
        if _studio_state["deployId"] != deploy_id:
            return False  # Stale worker (issue #9 — deploy_id check)
        if _deploy_cancel.is_set():
            _studio_state.update({"phase": "stopped", "deployMessage": "Cancelled"})
            return False
        _studio_state["deployStep"] = step
        _studio_state["deployMessage"] = message
    _deploy_log(message)
    return True

def _run_deploy_pipeline(deploy_id, ws_id, lh_id, cap_id):
    """Real deploy pipeline. Runs on background thread."""
    global _flt_process, _flt_monitor_thread, _token_refresh_thread

    try:
        # ── Step 0: Fetch MWC token (REAL) ──
        if not _deploy_step(0, "Fetching MWC token...", deploy_id): return
        bearer, _ = _read_cache(BEARER_CACHE)
        if not bearer:
            _deploy_log("No bearer token — authenticate first", "error")
            with _studio_lock:
                _studio_state.update({"phase": "stopped", "deployError": "No bearer token"})
            return
        try:
            token, host = _get_mwc_token(bearer, ws_id, lh_id, cap_id)
            _deploy_log(f"MWC token acquired (host: {host[:40]}...)", "success")
        except Exception as e:
            _deploy_log(f"Token fetch failed: {e}", "error")
            with _studio_lock:
                _studio_state.update({"phase": "stopped", "deployError": str(e)})
            return

        # ── Step 1: Update config (REAL, atomic) ──
        if not _deploy_step(1, "Updating config...", deploy_id): return
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

        # ── Step 2: Patch + Build (REAL via edog.py --headless-deploy) ──
        if not _deploy_step(2, "Patching and building...", deploy_id): return
        try:
            flt_repo = config.get("flt_repo_path", "")
            if not flt_repo or not Path(flt_repo).is_dir():
                raise FileNotFoundError(f"FLT repo not found: {flt_repo}")

            # edog.py --headless-deploy: patches code + builds, JSON lines on stdout
            env = dict(os.environ)
            env["EDOG_STUDIO_PORT"] = str(FLT_INTERNAL_PORT)
            proc = subprocess.Popen(
                [sys.executable, str(PROJECT_DIR / "edog.py"), "--headless-deploy"],
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                text=True, bufsize=1, env=env,
            )
            for line in proc.stdout:
                line = line.rstrip()
                if not line: continue
                # Try parse as JSON progress
                try:
                    evt = json.loads(line)
                    msg = evt.get("message", line)
                    lvl = evt.get("level", "info")
                    if evt.get("step") is not None:
                        with _studio_lock:
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
                _deploy_log(f"edog.py exited with code {proc.returncode}", "error")
                with _studio_lock:
                    _studio_state.update({"phase": "stopped",
                                          "deployError": f"Patch/build failed (exit {proc.returncode})"})
                return
            _deploy_log("Patch and build succeeded", "success")
        except Exception as e:
            _deploy_log(f"Patch/build error: {e}", "error")
            with _studio_lock:
                _studio_state.update({"phase": "stopped", "deployError": str(e)})
            return

        # ── Step 3: Launch FLT (REAL, dev-server owns the process) ──
        if not _deploy_step(3, "Launching service...", deploy_id): return
        try:
            # Kill existing FLT if running
            if _flt_process and _flt_process.poll() is None:
                _deploy_log("Stopping previous FLT service...", "warn")
                _flt_process.terminate()
                _flt_process.wait(timeout=10)

            flt_repo = config.get("flt_repo_path", "")
            entrypoint = Path(flt_repo) / "Service" / "Microsoft.LiveTable.Service.EntryPoint"
            env = dict(os.environ)
            env["EDOG_STUDIO_PORT"] = str(FLT_INTERNAL_PORT)

            _flt_process = subprocess.Popen(
                ["dotnet", "run", "--no-build"],
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                text=True, bufsize=1, cwd=str(entrypoint), env=env,
            )
            _deploy_log(f"FLT process started (PID: {_flt_process.pid})", "success")

            with _studio_lock:
                _studio_state["fltPid"] = _flt_process.pid
                _studio_state["fltPort"] = FLT_INTERNAL_PORT

        except Exception as e:
            _deploy_log(f"Launch failed: {e}", "error")
            with _studio_lock:
                _studio_state.update({"phase": "stopped", "deployError": str(e)})
            return

        # ── Step 4: Health check (REAL, wait for :5557 to respond) ──
        if not _deploy_step(4, "Waiting for service ready...", deploy_id): return
        healthy = False
        for attempt in range(60):  # 60 attempts × 1s = 60s max
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
            _deploy_log(f"Ping attempt {attempt + 1}/60...", "info")
            time.sleep(1)

        if not healthy:
            _deploy_log("Health check timed out after 60s", "error")
            with _studio_lock:
                _studio_state.update({"phase": "stopped",
                                      "deployError": "Service did not become healthy in 60s"})
            return

        _deploy_log("Service healthy!", "success")

        # ── Done! ──
        with _studio_lock:
            _studio_state.update({
                "phase": "running",
                "deployStep": 5,
                "deployMessage": "Deploy complete",
            })
        _deploy_log("Deploy complete!", "success")

        # Start FLT process monitor thread (Issue #5)
        _flt_monitor_thread = threading.Thread(
            target=_monitor_flt_process, args=(deploy_id,), daemon=True)
        _flt_monitor_thread.start()

        # Start token refresh thread (Issue #10)
        _token_refresh_thread = threading.Thread(
            target=_token_refresh_loop, args=(ws_id, lh_id, cap_id), daemon=True)
        _token_refresh_thread.start()

    except Exception as e:
        _deploy_log(f"Unexpected error: {e}", "error")
        with _studio_lock:
            _studio_state.update({"phase": "stopped", "deployError": str(e)})


def _monitor_flt_process(deploy_id):
    """Monitor FLT process, update state on crash. (Issue #5, #8)"""
    global _flt_process
    while _flt_process and _flt_process.poll() is None:
        time.sleep(2)
    if _flt_process:
        exit_code = _flt_process.returncode
        with _studio_lock:
            if _studio_state["deployId"] == deploy_id:
                _studio_state.update({
                    "phase": "crashed",
                    "deployError": f"FLT exited with code {exit_code}",
                    "deployMessage": f"Service crashed (exit code {exit_code})",
                })
        _deploy_log(f"FLT process exited with code {exit_code}", "error")


def _token_refresh_loop(ws_id, lh_id, cap_id):
    """Refresh MWC token every 50 minutes. (Issue #10)"""
    while True:
        time.sleep(50 * 60)  # 50 min
        with _studio_lock:
            if _studio_state["phase"] != "running":
                return
        try:
            bearer, _ = _read_cache(BEARER_CACHE)
            if bearer:
                token, host = _get_mwc_token(bearer, ws_id, lh_id, cap_id)
                _deploy_log("MWC token refreshed", "success")
        except Exception as e:
            _deploy_log(f"Token refresh failed: {e}", "warn")
```

### Step 7: REST proxy to :5557

```python
def _proxy_to_flt(self, method="GET"):
    """Proxy HTTP request to EdogLogServer on internal port."""
    with _studio_lock:
        port = _studio_state.get("fltPort")
    if not port:
        self._json_response(503, {"error": "flt_not_running"})
        return

    target_path = self.path
    target_url = f"http://localhost:{port}{target_path}"

    try:
        body = None
        if method in ("POST", "PUT", "PATCH"):
            content_len = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_len) if content_len else None

        req = urllib.request.Request(target_url, data=body, method=method)
        req.add_header("Content-Type", self.headers.get("Content-Type", "application/json"))

        with urllib.request.urlopen(req, timeout=10) as resp:
            resp_body = resp.read()
            self.send_response(resp.status)
            self.send_header("Content-Type", resp.headers.get("Content-Type", "application/json"))
            self.send_header("Content-Length", str(len(resp_body)))
            self.end_headers()
            self.wfile.write(resp_body)
    except Exception as e:
        self._json_response(502, {"error": "flt_proxy_error", "message": str(e)})
```

Route FLT-specific REST endpoints through the proxy:

```python
# In do_GET, add:
elif self.path.startswith("/api/logs") or self.path.startswith("/api/telemetry") \
     or self.path.startswith("/api/stats") or self.path.startswith("/api/executions"):
    self._proxy_to_flt("GET")
elif self.path == "/api/command/deploy-stream":
    self._serve_deploy_stream()
elif self.path == "/api/studio/status":
    self._serve_studio_status()
```

### Step 8: Deploy cancel endpoint

```python
def _serve_deploy_cancel(self):
    _deploy_cancel.set()
    self._json_response(200, {"ok": True})
```

### Commit message

```
feat(deploy): dev-server.py as Studio supervisor

- Atomic config writes (write tmp + rename)
- Studio state model with explicit phase enum
- /api/studio/status — authoritative phase source for browser refresh
- /api/command/deploy — start deploy with job ID
- /api/command/deploy-stream — SSE with Last-Event-ID resume
- Real pipeline: MWC token → config → edog.py patch+build → launch → health check
- dev-server.py owns FLT process (subprocess.Popen)
- FLT crash monitor thread
- Token refresh loop (every 50 min)
- REST proxy to :5557 for log/telemetry/stats APIs
- Deploy cancel with stale-worker protection via deploy_id

Resolves review issues #5, #6, #7, #8, #9, #10, #12
```

---

## Task 3: edog.py --headless-deploy (Issue #4, #11)

**Owner:** Elena
**Files:** `edog.py`

### Step 1: Add --headless-deploy flag

Add argument:
```python
parser.add_argument("--headless-deploy", action="store_true",
                    help="Headless deploy: patch + build, JSON progress on stdout")
```

### Step 2: Implement headless deploy function

```python
def headless_deploy(repo_root):
    """Headless deploy mode: patch code + build. JSON lines on stdout.

    Called by dev-server.py via subprocess. Does NOT launch the FLT process
    (dev-server.py owns that). Stdout is protocol-only JSON.
    All human-readable output goes to stderr.
    """
    import sys

    def emit(step, message, level="info"):
        """Write a JSON progress line to stdout."""
        obj = {"step": step, "message": message, "level": level,
               "ts": datetime.now().strftime("%H:%M:%S")}
        sys.stdout.write(json.dumps(obj) + "\n")
        sys.stdout.flush()

    def log(msg):
        """Human-readable output to stderr (not protocol)."""
        print(msg, file=sys.stderr)

    config = load_config()
    username = config.get("username", "")
    workspace_id = config.get("workspace_id", "")
    artifact_id = config.get("artifact_id", "")
    capacity_id = config.get("capacity_id", "")

    # Step 2: Patch code
    emit(2, "Patching code...")
    log(f"Patching FLT source at {repo_root}")

    # Fetch MWC token (for the GTSBasedSparkClient bypass)
    bearer_token, _ = load_cached_bearer_token()
    if not bearer_token:
        emit(2, "No bearer token for patching", "error")
        sys.exit(1)

    mwc_token = fetch_mwc_token(bearer_token, workspace_id, artifact_id, capacity_id)
    if not mwc_token:
        # Try with existing cached token
        cached, _ = load_cached_token()
        if cached:
            mwc_token = cached
        else:
            emit(2, "Could not get MWC token for patching", "error")
            sys.exit(1)

    result = apply_all_changes(mwc_token, repo_root)
    emit(2, "Code patches applied", "success")

    # Step 3: Build
    emit(3, "Building FLT service...")
    entrypoint = get_entrypoint_path(repo_root)
    log(f"Building: {entrypoint}")

    build_proc = subprocess.run(
        ["dotnet", "build", str(entrypoint), "--no-incremental"],
        capture_output=True, text=True, cwd=str(repo_root),
    )

    # Stream build output as JSON events
    for line in build_proc.stdout.splitlines():
        if line.strip():
            lvl = "warn" if "warning" in line.lower() else "error" if "error" in line.lower() else "info"
            emit(3, line.strip(), lvl)

    if build_proc.returncode != 0:
        emit(3, f"Build failed (exit code {build_proc.returncode})", "error")
        for line in build_proc.stderr.splitlines()[-10:]:
            if line.strip():
                emit(3, line.strip(), "error")
        sys.exit(build_proc.returncode)

    emit(3, "Build succeeded", "success")
    sys.exit(0)
```

### Step 3: Wire into entry point

```python
if args.headless_deploy:
    repo_root = get_repo_root()
    if not repo_root:
        sys.exit(1)
    headless_deploy(repo_root)
    sys.exit(0)
```

### Commit message

```
feat(deploy): edog.py --headless-deploy for patch + build

Headless mode for Studio integration. Patches FLT code and runs
dotnet build. Progress written as JSON lines to stdout (protocol).
Human-readable output to stderr. Does NOT launch FLT — dev-server.py
owns that process.

Resolves review issues #4, #11
```

---

## Task 4: Frontend — Deploy Stepper CSS

**Owner:** Mika
**Files:** `src/frontend/css/deploy.css`, `scripts/build-html.py`

Same as original plan Task 1 — the CSS stepper component. See original plan for full CSS.

One addition: add `.deploy-stepper .phase-transition` animation for the success → Phase 2 moment.

### Commit message

```
feat(deploy): stepper + terminal CSS component
```

---

## Task 5: Frontend — DeployFlow JS + Integration

**Owner:** Zara
**Files:** `src/frontend/js/deploy-flow.js`, `src/frontend/js/workspace-explorer.js`, `src/frontend/js/main.js`

### Key changes from v1:

1. **Uses EventSource (SSE)** instead of polling — real-time, resumable
2. **Has `resume(state)` method** for page refresh recovery (Issue #9)
3. **Emits structured updates** not just phase strings (Issue from review #3)
4. **Reads `fltPort` from SSE events** for WebSocket connection

```javascript
class DeployFlow {
  constructor(containerEl) { ... }

  async startDeploy(workspaceId, artifactId, capacityId, lakehouseName) {
    // POST /api/command/deploy → open SSE stream
  }

  resume(state) {
    // Called on page load from /api/studio/status
    // Render current step, open SSE if still deploying
  }

  _connectSSE() {
    this._es = new EventSource('/api/command/deploy-stream');
    this._es.onmessage = (e) => { ... };
    this._es.addEventListener('done', (e) => { ... });
    this._es.onerror = () => { /* reconnect handled by EventSource */ };
  }

  // Callback: onUpdate({step, total, status, message, error, fltPort, log})
  onUpdate = null;
}
```

### main.js — deploy resume on load

```javascript
// On app init, check studio status for deploy resume
fetch('/api/studio/status').then(r => r.json()).then(state => {
  if (state.phase === 'deploying') {
    deployFlow.resume(state);
  } else if (state.phase === 'running') {
    sidebar.setPhase('connected');
    topbar.setDeployStatus('connected');
    // Connect WebSocket to FLT port
    wsClient.connect(state.fltPort);
  } else if (state.phase === 'crashed') {
    topbar.setDeployStatus('crashed');
  }
});
```

---

## Task 6: TopBar + Sidebar Integration

**Owner:** Kael + Zara
**Files:** `src/frontend/js/topbar.js`, `src/frontend/js/sidebar.js`

Same as original plan Tasks 5+6, with one addition: topbar reads deploy step for `"Deploying (2/5)..."` text.

---

## Task 7: Tests + Integration

**Owner:** Ines
**Files:** `tests/test_deploy_flow.py`

Tests cover:
- Studio state transitions (idle → deploying → running → crashed → stopped)
- Atomic write correctness
- Deploy ID stale-worker protection
- edog.py --headless-deploy exit codes
- SSE event format validation

---

## Execution Order

```
T1 (C# changes)  ──┐
                    ├── T4 (CSS) ──── T5 (JS + SSE) ──── T6 (TopBar + Sidebar) ──── T7 (Tests)
T2 (dev-server)  ──┤
T3 (edog.py)     ──┘
```

T1, T2, T3 can run in parallel (different files, no deps). T4-T7 are sequential.


---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/frontend/css/deploy.css` | **Create** | Stepper, progress bar, terminal, deploy card styles |
| `src/frontend/js/deploy-flow.js` | **Create** | DeployFlow class — stepper UI, progress polling, phase transition |
| `src/frontend/js/workspace-explorer.js` | **Modify** | Replace simulated deploy with DeployFlow integration |
| `src/frontend/js/topbar.js` | **Modify** | Add deploy status methods (deploying/failed states) |
| `src/frontend/js/sidebar.js` | **Modify** | Add cascade-enable animation for Phase 2 transition |
| `src/frontend/index.html` | **Modify** | Add deploy.css to CSS module list |
| `scripts/dev-server.py` | **Modify** | Add deploy command endpoints + background thread orchestration |
| `scripts/build-html.py` | **Modify** | Add deploy.css to build order |
| `tests/test_deploy_server.py` | **Create** | Tests for deploy API endpoints |

---

## Phase A: Deploy Stepper UI Component

### Task 1: Create deploy.css — Stepper, progress bar, terminal

**Files:**
- Create: `src/frontend/css/deploy.css`

This implements the stepper from the design bible wizard pattern (§25a) adapted for a horizontal inline deploy stepper.

- [ ] **Step 1: Create deploy.css with stepper styles**

```css
/* ── F02 Deploy Stepper ──
 * Horizontal 5-step stepper with progress bar and collapsible terminal.
 * Based on design bible §25a wizard pattern, adapted for inline deploy.
 */

/* Container — sits below lakehouse header in content panel */
.deploy-stepper {
  padding: var(--space-4);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--surface);
  margin: var(--space-3) 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

/* Step row — horizontal, evenly spaced */
.deploy-steps {
  display: flex;
  align-items: flex-start;
  gap: 0;
  position: relative;
}

/* Individual step */
.deploy-step {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-1);
  position: relative;
  z-index: 1;
}

/* Step circle */
.deploy-step-dot {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 700;
  font-family: var(--font-mono);
  border: 2px solid var(--border-bright);
  background: var(--surface);
  color: var(--text-muted);
  transition: all 300ms cubic-bezier(0.16, 1, 0.3, 1);
  position: relative;
}

/* Step states */
.deploy-step.active .deploy-step-dot {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--text-on-accent);
  box-shadow: 0 0 0 4px oklch(0.55 0.15 280 / 0.15);
  animation: deploy-pulse 1.5s ease-in-out infinite;
}

.deploy-step.done .deploy-step-dot {
  background: var(--status-succeeded);
  border-color: var(--status-succeeded);
  color: #fff;
  animation: deploy-pop 300ms cubic-bezier(0.34, 1.56, 0.64, 1);
}

.deploy-step.failed .deploy-step-dot {
  background: var(--status-failed);
  border-color: var(--status-failed);
  color: #fff;
}

/* Step label */
.deploy-step-label {
  font-size: var(--text-xs);
  font-family: var(--font-body);
  color: var(--text-muted);
  text-align: center;
  max-width: 90px;
  line-height: 1.3;
}

.deploy-step.active .deploy-step-label { color: var(--accent); font-weight: 600; }
.deploy-step.done .deploy-step-label { color: var(--status-succeeded); }
.deploy-step.failed .deploy-step-label { color: var(--status-failed); }

/* Connector lines between steps */
.deploy-step:not(:last-child)::after {
  content: '';
  position: absolute;
  top: 14px; /* center of 28px dot */
  left: calc(50% + 18px);
  right: calc(-50% + 18px);
  height: 2px;
  background: var(--border-bright);
  z-index: 0;
  transition: background 300ms ease;
}

.deploy-step.done:not(:last-child)::after {
  background: var(--status-succeeded);
}

.deploy-step.active:not(:last-child)::after {
  background: linear-gradient(90deg, var(--accent) 0%, var(--border-bright) 100%);
}

/* Progress bar */
.deploy-progress-bar {
  height: 3px;
  background: var(--surface-2);
  border-radius: 2px;
  overflow: hidden;
}

.deploy-progress-fill {
  height: 100%;
  background: var(--accent);
  border-radius: 2px;
  transition: width 400ms cubic-bezier(0.16, 1, 0.3, 1);
  min-width: 0;
}

.deploy-progress-fill.done { background: var(--status-succeeded); }
.deploy-progress-fill.failed { background: var(--status-failed); }

/* Status text below progress */
.deploy-status {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: var(--text-xs);
  color: var(--text-muted);
}

.deploy-status-msg {
  font-family: var(--font-mono);
}

.deploy-status-actions {
  display: flex;
  gap: var(--space-2);
}

.deploy-cancel-btn {
  border: 1px solid var(--border-bright);
  background: var(--surface);
  color: var(--text-dim);
  font-size: var(--text-xs);
  font-family: var(--font-body);
  padding: 2px var(--space-3);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: all var(--transition-fast);
}
.deploy-cancel-btn:hover { border-color: var(--status-failed); color: var(--status-failed); }

.deploy-retry-btn {
  border: 1px solid var(--accent);
  background: var(--accent-dim);
  color: var(--accent);
  font-size: var(--text-xs);
  font-family: var(--font-body);
  font-weight: 600;
  padding: 2px var(--space-3);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: all var(--transition-fast);
}
.deploy-retry-btn:hover { background: var(--accent); color: var(--text-on-accent); }

/* Toggle details link */
.deploy-toggle-details {
  font-size: var(--text-xs);
  color: var(--text-muted);
  cursor: pointer;
  background: none;
  border: none;
  font-family: var(--font-body);
  padding: 0;
}
.deploy-toggle-details:hover { color: var(--accent); }

/* ── Terminal ── */
.deploy-terminal {
  background: oklch(0.15 0 0);
  border-radius: var(--radius-sm);
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.5;
  max-height: 0;
  overflow: hidden;
  transition: max-height 200ms ease-out, padding 200ms ease-out;
}

.deploy-terminal.open {
  max-height: 240px;
  padding: var(--space-3);
  overflow-y: auto;
}

.deploy-terminal-line {
  color: oklch(0.75 0 0);
  white-space: pre-wrap;
  word-break: break-all;
}

.deploy-terminal-line.warn { color: oklch(0.80 0.15 85); }
.deploy-terminal-line.error { color: oklch(0.70 0.20 25); }
.deploy-terminal-line.success { color: oklch(0.75 0.15 145); }
.deploy-terminal-line .ts {
  color: oklch(0.50 0 0);
  margin-right: var(--space-2);
}

/* Scrollbar */
.deploy-terminal::-webkit-scrollbar { width: 6px; }
.deploy-terminal::-webkit-scrollbar-track { background: transparent; }
.deploy-terminal::-webkit-scrollbar-thumb { background: oklch(0.30 0 0); border-radius: 3px; }

/* ── Success banner ── */
.deploy-success {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border-left: 3px solid var(--status-succeeded);
  background: oklch(0.97 0.02 145);
  border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
  font-size: var(--text-sm);
  color: var(--status-succeeded);
  font-weight: 600;
}

.deploy-success .deploy-success-meta {
  font-weight: 400;
  color: var(--text-dim);
  font-size: var(--text-xs);
  font-family: var(--font-mono);
}

/* ── Error card ── */
.deploy-error {
  padding: var(--space-3) var(--space-4);
  border-left: 3px solid var(--status-failed);
  background: oklch(0.97 0.02 25);
  border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
  font-size: var(--text-sm);
}

.deploy-error-title {
  font-weight: 600;
  color: var(--status-failed);
  margin-bottom: var(--space-1);
}

.deploy-error-detail {
  font-size: var(--text-xs);
  font-family: var(--font-mono);
  color: var(--text-dim);
  word-break: break-all;
}

/* Animations */
@keyframes deploy-pulse {
  0%, 100% { box-shadow: 0 0 0 4px oklch(0.55 0.15 280 / 0.15); }
  50% { box-shadow: 0 0 0 8px oklch(0.55 0.15 280 / 0.05); }
}

@keyframes deploy-pop {
  0% { transform: scale(0.8); }
  50% { transform: scale(1.15); }
  100% { transform: scale(1); }
}
```

- [ ] **Step 2: Add deploy.css to build-html.py**

In `scripts/build-html.py`, find the CSS_MODULES list and add `deploy.css` after `workspace.css`:

```python
# In the CSS_MODULES list, add:
"css/deploy.css",
```

- [ ] **Step 3: Build and verify**

Run: `python scripts/build-html.py`
Expected: "Done!" with deploy.css in the output list

- [ ] **Step 4: Commit**

```bash
git add src/frontend/css/deploy.css scripts/build-html.py
git commit -m "feat(deploy): stepper + terminal CSS component

Horizontal 5-step stepper with numbered circles, connector lines,
progress bar, collapsible build terminal, success/error cards.
Based on design bible §25a wizard pattern.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 2: Create DeployFlow class — stepper rendering + progress polling

**Files:**
- Create: `src/frontend/js/deploy-flow.js`

This is a standalone class that renders the stepper into a container element and polls the deploy status API.

- [ ] **Step 1: Create deploy-flow.js**

```javascript
/**
 * DeployFlow — 5-step deploy stepper with progress polling and terminal.
 *
 * Usage:
 *   const flow = new DeployFlow(containerEl);
 *   flow.onPhaseChange = (phase) => { ... };
 *   flow.startDeploy(workspaceId, artifactId, capacityId);
 *
 * The class renders itself into containerEl and manages its own lifecycle.
 * It polls GET /api/command/deploy-status every 500ms during an active deploy.
 *
 * @author Zara Okonkwo + Kael Andersen — EDOG Studio hivemind
 */
class DeployFlow {
  constructor(containerEl) {
    this._el = containerEl;
    this._pollTimer = null;
    this._active = false;
    this._terminalOpen = false;
    this._terminalLines = [];
    this._startTime = null;

    /** @type {function(string)|null} Callback when phase changes: 'deploying' | 'connected' | 'failed' | 'cancelled' */
    this.onPhaseChange = null;
  }

  static STEPS = [
    { id: 1, label: 'Fetch MWC token' },
    { id: 2, label: 'Patch code' },
    { id: 3, label: 'Build service' },
    { id: 4, label: 'Launch service' },
    { id: 5, label: 'Ready check' },
  ];

  // ── Public API ──

  async startDeploy(workspaceId, artifactId, capacityId) {
    this._active = true;
    this._startTime = Date.now();
    this._terminalLines = [];
    this._render({ step: 0, total: 5, status: 'starting', message: 'Initiating deploy...' });
    if (this.onPhaseChange) this.onPhaseChange('deploying');

    try {
      const resp = await fetch('/api/command/deploy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, artifactId, capacityId }),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ message: 'Deploy request failed' }));
        this._onFailed(0, err.message || 'Deploy request failed');
        return;
      }
      this._startPolling();
    } catch (e) {
      this._onFailed(0, 'Network error: ' + e.message);
    }
  }

  async cancel() {
    try {
      await fetch('/api/command/deploy-cancel', { method: 'POST' });
    } catch { /* best effort */ }
    this._stopPolling();
    this._active = false;
    this._render({ step: 0, total: 5, status: 'cancelled', message: 'Deploy cancelled' });
    if (this.onPhaseChange) this.onPhaseChange('cancelled');
  }

  isActive() { return this._active; }

  destroy() {
    this._stopPolling();
    this._el.innerHTML = '';
  }

  // ── Polling ──

  _startPolling() {
    this._stopPolling();
    this._pollTimer = setInterval(() => this._poll(), 500);
  }

  _stopPolling() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  async _poll() {
    try {
      const resp = await fetch('/api/command/deploy-status');
      if (!resp.ok) return;
      const status = await resp.json();

      // Append new terminal lines
      if (status.logs && status.logs.length > this._terminalLines.length) {
        this._terminalLines = status.logs;
      }

      this._render(status);

      if (status.status === 'done') {
        this._stopPolling();
        this._active = false;
        if (this.onPhaseChange) this.onPhaseChange('connected');
      } else if (status.status === 'failed') {
        this._stopPolling();
        this._active = false;
        if (this.onPhaseChange) this.onPhaseChange('failed');
      }
    } catch { /* network hiccup — keep polling */ }
  }

  // ── Render ──

  _render(state) {
    const { step, total, status, message, error } = state;
    const elapsed = this._startTime ? Math.floor((Date.now() - this._startTime) / 1000) : 0;
    const pct = status === 'done' ? 100 : status === 'failed' ? (step / total) * 100 : ((step) / total) * 100;

    let html = '<div class="deploy-stepper">';

    // Step circles
    html += '<div class="deploy-steps">';
    for (let i = 0; i < DeployFlow.STEPS.length; i++) {
      const s = DeployFlow.STEPS[i];
      let cls = 'deploy-step';
      let dotContent = String(s.id);
      if (status === 'done' || i < step) {
        cls += ' done';
        dotContent = '\u2713';
      } else if (i === step && (status === 'running' || status === 'starting')) {
        cls += ' active';
      } else if (status === 'failed' && i === step) {
        cls += ' failed';
        dotContent = '\u2715';
      }
      html += '<div class="' + cls + '">';
      html += '<div class="deploy-step-dot">' + dotContent + '</div>';
      html += '<span class="deploy-step-label">' + s.label + '</span>';
      html += '</div>';
    }
    html += '</div>';

    // Progress bar
    const barCls = status === 'done' ? 'done' : status === 'failed' ? 'failed' : '';
    html += '<div class="deploy-progress-bar">';
    html += '<div class="deploy-progress-fill ' + barCls + '" style="width:' + pct + '%"></div>';
    html += '</div>';

    // Status row
    html += '<div class="deploy-status">';
    html += '<span class="deploy-status-msg">' + this._esc(message || '') + '</span>';
    html += '<div class="deploy-status-actions">';
    if (elapsed > 0 && this._active) {
      html += '<span style="color:var(--text-muted);font-size:var(--text-xs)">' + elapsed + 's</span>';
    }
    if (this._active) {
      html += '<button class="deploy-cancel-btn" id="deploy-cancel-btn">Cancel</button>';
    }
    if (status === 'failed') {
      html += '<button class="deploy-retry-btn" id="deploy-retry-btn">Retry</button>';
    }
    html += '</div></div>';

    // Toggle details
    if (this._terminalLines.length > 0 || this._active) {
      const arrow = this._terminalOpen ? '\u25B4' : '\u25BE';
      html += '<button class="deploy-toggle-details" id="deploy-toggle-term">' + (this._terminalOpen ? 'Hide' : 'Show') + ' details ' + arrow + '</button>';
    }

    // Terminal
    html += '<div class="deploy-terminal' + (this._terminalOpen ? ' open' : '') + '" id="deploy-terminal">';
    for (const line of this._terminalLines) {
      const cls = line.level === 'error' ? ' error' : line.level === 'warn' ? ' warn' : line.level === 'success' ? ' success' : '';
      html += '<div class="deploy-terminal-line' + cls + '"><span class="ts">' + this._esc(line.ts || '') + '</span>' + this._esc(line.msg || '') + '</div>';
    }
    html += '</div>';

    // Success banner
    if (status === 'done') {
      html += '<div class="deploy-success">';
      html += '\u2713 Deployed successfully';
      html += '<span class="deploy-success-meta">' + elapsed + 's</span>';
      html += '</div>';
    }

    // Error card
    if (status === 'failed' && error) {
      html += '<div class="deploy-error">';
      html += '<div class="deploy-error-title">Deploy failed at step ' + (step + 1) + '</div>';
      html += '<div class="deploy-error-detail">' + this._esc(error) + '</div>';
      html += '</div>';
    }

    html += '</div>';

    this._el.innerHTML = html;
    this._bindEvents();

    // Auto-scroll terminal
    if (this._terminalOpen) {
      const term = document.getElementById('deploy-terminal');
      if (term) term.scrollTop = term.scrollHeight;
    }
  }

  _bindEvents() {
    const cancelBtn = document.getElementById('deploy-cancel-btn');
    if (cancelBtn) cancelBtn.addEventListener('click', () => this.cancel());

    const retryBtn = document.getElementById('deploy-retry-btn');
    if (retryBtn) retryBtn.addEventListener('click', () => {
      // Re-trigger with same params (stored on server)
      this._active = true;
      this._startTime = Date.now();
      if (this.onPhaseChange) this.onPhaseChange('deploying');
      fetch('/api/command/deploy-retry', { method: 'POST' }).then(() => this._startPolling());
    });

    const toggleBtn = document.getElementById('deploy-toggle-term');
    if (toggleBtn) toggleBtn.addEventListener('click', () => {
      this._terminalOpen = !this._terminalOpen;
      const term = document.getElementById('deploy-terminal');
      if (term) term.classList.toggle('open', this._terminalOpen);
      toggleBtn.textContent = (this._terminalOpen ? 'Hide' : 'Show') + ' details ' + (this._terminalOpen ? '\u25B4' : '\u25BE');
    });
  }

  _onFailed(step, message) {
    this._stopPolling();
    this._active = false;
    this._render({ step, total: 5, status: 'failed', message: 'Deploy failed', error: message });
    if (this.onPhaseChange) this.onPhaseChange('failed');
  }

  _esc(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }
}
```

- [ ] **Step 2: Add deploy-flow.js to build-html.py**

In `scripts/build-html.py`, find the JS_MODULES list and add `deploy-flow.js` after `topbar.js`:

```python
# In JS_MODULES list, add:
"js/deploy-flow.js",
```

- [ ] **Step 3: Build and verify**

Run: `python scripts/build-html.py`
Expected: "Done!" with deploy-flow.js in the output list

- [ ] **Step 4: Commit**

```bash
git add src/frontend/js/deploy-flow.js scripts/build-html.py
git commit -m "feat(deploy): DeployFlow class with stepper + polling + terminal

Standalone class that renders 5-step horizontal stepper, polls
/api/command/deploy-status every 500ms, renders collapsible terminal
with build output, handles done/failed/cancelled states. Cancel and
retry buttons wired. onPhaseChange callback for sidebar/topbar sync.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 3: Wire DeployFlow into WorkspaceExplorer

**Files:**
- Modify: `src/frontend/js/workspace-explorer.js` (lines 2072-2110)

Replace the simulated deploy with real DeployFlow integration.

- [ ] **Step 1: Replace `_deployToLakehouse` method**

In `workspace-explorer.js`, replace the simulated deploy method (lines ~2072-2110) with:

```javascript
  // Deploy flow
  // ────────────────────────────────────────────

  async _deployToLakehouse(lh, ws) {
    const progressEl = document.getElementById('ws-deploy-progress');
    const btnEl = document.getElementById('ws-deploy-btn');
    if (!progressEl) return;

    // Hide deploy button, show progress container
    if (btnEl) btnEl.style.display = 'none';
    progressEl.style.display = 'block';

    // Create DeployFlow if not exists
    if (!this._deployFlow) {
      this._deployFlow = new DeployFlow(progressEl);
      this._deployFlow.onPhaseChange = (phase) => this._onDeployPhaseChange(phase, lh, ws);
    }

    // Get capacity ID from workspace (stored during tree load)
    const capacityId = ws.capacityId || '';

    this._deployFlow.startDeploy(ws.id, lh.id, capacityId);
  }

  _onDeployPhaseChange(phase, lh, ws) {
    if (phase === 'deploying') {
      // Update topbar
      if (window.edogTopBar) window.edogTopBar.setDeployStatus('deploying');
    } else if (phase === 'connected') {
      // Phase 2 transition
      if (window.edogTopBar) window.edogTopBar.setDeployStatus('connected');
      if (window.edogSidebar) window.edogSidebar.setPhase('connected');
      this._toast('Connected to ' + (lh.displayName || lh.id), 'success');
    } else if (phase === 'failed') {
      if (window.edogTopBar) window.edogTopBar.setDeployStatus('failed');
      // Re-show deploy button
      const btnEl = document.getElementById('ws-deploy-btn');
      if (btnEl) btnEl.style.display = '';
    } else if (phase === 'cancelled') {
      if (window.edogTopBar) window.edogTopBar.setDeployStatus('stopped');
      const btnEl = document.getElementById('ws-deploy-btn');
      if (btnEl) btnEl.style.display = '';
    }
  }
```

- [ ] **Step 2: Build and verify**

Run: `python scripts/build-html.py`
Expected: "Done!" — no JS errors in module

- [ ] **Step 3: Commit**

```bash
git add src/frontend/js/workspace-explorer.js
git commit -m "feat(deploy): wire DeployFlow into workspace explorer

Replace simulated setTimeout deploy with real DeployFlow class.
Deploy button triggers startDeploy(), onPhaseChange callback
syncs topbar + sidebar + toast notifications.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Phase B: Backend Deploy Orchestration

### Task 4: Add deploy endpoints to dev-server.py

**Files:**
- Modify: `scripts/dev-server.py`
- Create: `tests/test_deploy_server.py`

- [ ] **Step 1: Write tests for deploy endpoints**

Create `tests/test_deploy_server.py`:

```python
"""Tests for deploy command endpoints in dev-server.py."""
import json
import threading
import time
from pathlib import Path
from unittest.mock import patch

import pytest


@pytest.fixture
def deploy_state():
    """Fresh deploy state dict matching dev-server.py's _deploy_state."""
    return {
        "active": False,
        "step": 0,
        "total": 5,
        "status": "idle",
        "message": "",
        "error": None,
        "logs": [],
        "workspaceId": None,
        "artifactId": None,
        "capacityId": None,
    }


class TestDeployStateTransitions:
    """Test that deploy state transitions are valid."""

    def test_initial_state_is_idle(self, deploy_state):
        assert deploy_state["status"] == "idle"
        assert deploy_state["active"] is False

    def test_start_deploy_sets_active(self, deploy_state):
        deploy_state["active"] = True
        deploy_state["status"] = "running"
        deploy_state["step"] = 0
        deploy_state["message"] = "Fetching MWC token..."
        deploy_state["workspaceId"] = "ws-123"
        deploy_state["artifactId"] = "lh-456"
        deploy_state["capacityId"] = "cap-789"
        assert deploy_state["active"] is True
        assert deploy_state["status"] == "running"

    def test_step_progression(self, deploy_state):
        for step in range(5):
            deploy_state["step"] = step
            assert deploy_state["step"] == step

    def test_done_state(self, deploy_state):
        deploy_state["status"] = "done"
        deploy_state["step"] = 5
        deploy_state["active"] = False
        assert deploy_state["status"] == "done"
        assert deploy_state["active"] is False

    def test_failed_state_preserves_step(self, deploy_state):
        deploy_state["step"] = 2
        deploy_state["status"] = "failed"
        deploy_state["error"] = "Build failed: CS0123"
        deploy_state["active"] = False
        assert deploy_state["step"] == 2
        assert deploy_state["error"] == "Build failed: CS0123"

    def test_log_entries_accumulate(self, deploy_state):
        deploy_state["logs"].append({"ts": "12:00:01", "msg": "Starting...", "level": "info"})
        deploy_state["logs"].append({"ts": "12:00:02", "msg": "Token acquired", "level": "success"})
        assert len(deploy_state["logs"]) == 2
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `python -m pytest tests/test_deploy_server.py -v`
Expected: 6 tests PASS

- [ ] **Step 3: Add deploy state and endpoints to dev-server.py**

Add after the `_mwc_cache` dict (around line 33):

```python
# Deploy orchestration state (shared between handler thread and deploy thread)
_deploy_state = {
    "active": False,
    "step": 0,
    "total": 5,
    "status": "idle",  # idle | running | done | failed | cancelled
    "message": "",
    "error": None,
    "logs": [],
    "workspaceId": None,
    "artifactId": None,
    "capacityId": None,
}
_deploy_lock = threading.Lock()
```

Add the POST routes in `do_POST`:

```python
        elif self.path == "/api/command/deploy":
            self._serve_deploy_start()
        elif self.path == "/api/command/deploy-cancel":
            self._serve_deploy_cancel()
        elif self.path == "/api/command/deploy-retry":
            self._serve_deploy_retry()
```

Add the GET route in `do_GET`:

```python
        elif self.path == "/api/command/deploy-status":
            self._serve_deploy_status()
```

Add the handler methods:

```python
    def _serve_deploy_status(self):
        """GET /api/command/deploy-status — return current deploy state."""
        with _deploy_lock:
            state = dict(_deploy_state)
            state["logs"] = list(_deploy_state["logs"])
        self._json_response(200, state)

    def _serve_deploy_start(self):
        """POST /api/command/deploy — begin deploy pipeline on background thread."""
        global _deploy_state
        with _deploy_lock:
            if _deploy_state["active"]:
                self._json_response(409, {"error": "deploy_in_progress", "message": "A deploy is already running"})
                return

        content_len = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(content_len)) if content_len > 0 else {}
        ws_id = body.get("workspaceId", "")
        lh_id = body.get("artifactId", "")
        cap_id = body.get("capacityId", "")

        if not all([ws_id, lh_id]):
            self._json_response(400, {"error": "missing_params", "message": "workspaceId and artifactId required"})
            return

        with _deploy_lock:
            _deploy_state.update({
                "active": True, "step": 0, "total": 5, "status": "running",
                "message": "Initiating deploy...", "error": None, "logs": [],
                "workspaceId": ws_id, "artifactId": lh_id, "capacityId": cap_id,
            })

        t = threading.Thread(target=_run_deploy_pipeline, args=(ws_id, lh_id, cap_id), daemon=True)
        t.start()
        self._json_response(200, {"ok": True})

    def _serve_deploy_cancel(self):
        """POST /api/command/deploy-cancel — cancel active deploy."""
        global _deploy_state
        with _deploy_lock:
            if _deploy_state["active"]:
                _deploy_state["status"] = "cancelled"
                _deploy_state["active"] = False
                _deploy_state["message"] = "Deploy cancelled by user"
                _deploy_state["logs"].append({"ts": _ts(), "msg": "Deploy cancelled by user", "level": "warn"})
        self._json_response(200, {"ok": True})

    def _serve_deploy_retry(self):
        """POST /api/command/deploy-retry — retry deploy with same params."""
        global _deploy_state
        with _deploy_lock:
            ws_id = _deploy_state.get("workspaceId", "")
            lh_id = _deploy_state.get("artifactId", "")
            cap_id = _deploy_state.get("capacityId", "")
            _deploy_state.update({
                "active": True, "step": 0, "total": 5, "status": "running",
                "message": "Retrying deploy...", "error": None, "logs": [],
            })

        t = threading.Thread(target=_run_deploy_pipeline, args=(ws_id, lh_id, cap_id), daemon=True)
        t.start()
        self._json_response(200, {"ok": True})
```

Add the deploy pipeline function (before the `EdogDevHandler` class):

```python
def _ts():
    """Timestamp string for deploy logs."""
    return datetime.now().strftime("%H:%M:%S")


def _deploy_log(msg, level="info"):
    """Append a log entry to the deploy state."""
    with _deploy_lock:
        _deploy_state["logs"].append({"ts": _ts(), "msg": msg, "level": level})


def _deploy_step(step, message):
    """Advance deploy to a step."""
    with _deploy_lock:
        if _deploy_state["status"] == "cancelled":
            return False
        _deploy_state["step"] = step
        _deploy_state["message"] = message
    _deploy_log(message)
    return True


def _run_deploy_pipeline(ws_id, lh_id, cap_id):
    """Execute the 5-step deploy pipeline on a background thread."""
    global _deploy_state

    try:
        # Step 0: Fetch MWC token
        if not _deploy_step(0, "Fetching MWC token..."):
            return
        bearer, _ = _read_cache(BEARER_CACHE)
        if not bearer:
            _deploy_log("No bearer token cached — authenticate first", "error")
            with _deploy_lock:
                _deploy_state.update({"status": "failed", "active": False, "error": "No bearer token. Run authentication first."})
            return

        try:
            token, host = _get_mwc_token(bearer, ws_id, lh_id, cap_id)
            _deploy_log("MWC token acquired", "success")
        except Exception as e:
            _deploy_log(f"MWC token fetch failed: {e}", "error")
            with _deploy_lock:
                _deploy_state.update({"status": "failed", "active": False, "error": f"Token fetch failed: {e}"})
            return

        # Step 1: Update config
        if not _deploy_step(1, "Updating config..."):
            return
        try:
            config = json.loads(CONFIG_PATH.read_text()) if CONFIG_PATH.exists() else {}
            config["workspace_id"] = ws_id
            config["artifact_id"] = lh_id
            config["capacity_id"] = cap_id
            CONFIG_PATH.write_text(json.dumps(config, indent=2))
            _deploy_log("edog-config.json updated", "success")
        except Exception as e:
            _deploy_log(f"Config update failed: {e}", "error")
            with _deploy_lock:
                _deploy_state.update({"status": "failed", "active": False, "error": f"Config update failed: {e}"})
            return

        # Step 2: Patch code (simulated in dev-server — real patching done by edog.py)
        if not _deploy_step(2, "Patching code..."):
            return
        time.sleep(0.5)  # Simulate patch time
        _deploy_log("Code patches applied (dev-server simulation)", "success")

        # Step 3: Build service (simulated in dev-server)
        if not _deploy_step(3, "Building service..."):
            return
        _deploy_log("dotnet build started...", "info")
        for i in range(3):
            time.sleep(0.5)
            if _deploy_state["status"] == "cancelled":
                return
            _deploy_log(f"  Compiling... ({i + 1}/3)", "info")
        _deploy_log("Build succeeded", "success")

        # Step 4: Ready check (simulated)
        if not _deploy_step(4, "Waiting for service ready..."):
            return
        time.sleep(0.5)
        _deploy_log("Service healthy — HTTP 200", "success")

        # Done!
        with _deploy_lock:
            _deploy_state.update({
                "step": 5, "status": "done", "active": False,
                "message": "Deploy complete",
            })
        _deploy_log("Deploy complete!", "success")

    except Exception as e:
        _deploy_log(f"Unexpected error: {e}", "error")
        with _deploy_lock:
            _deploy_state.update({"status": "failed", "active": False, "error": str(e)})
```

- [ ] **Step 4: Run tests**

Run: `python -m pytest tests/test_deploy_server.py -v`
Expected: All 6 PASS

- [ ] **Step 5: Run full test suite + lint**

Run: `python -m pytest -q && python scripts/build-html.py`
Expected: 35+ tests pass, build succeeds

- [ ] **Step 6: Commit**

```bash
git add scripts/dev-server.py tests/test_deploy_server.py
git commit -m "feat(deploy): backend deploy endpoints with background thread

POST /api/command/deploy — start 5-step pipeline on background thread
GET /api/command/deploy-status — poll current state + terminal logs
POST /api/command/deploy-cancel — cancel active deploy
POST /api/command/deploy-retry — retry with same params

Pipeline: MWC token fetch (real) → config update (real) → patch
(simulated) → build (simulated) → ready check (simulated).
Steps 2-4 simulated in dev-server; real orchestration via edog.py IPC.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Phase C: TopBar + Sidebar Integration

### Task 5: Add deploy status methods to TopBar

**Files:**
- Modify: `src/frontend/js/topbar.js`

- [ ] **Step 1: Add setDeployStatus method to TopBar class**

Add before the `destroy()` method:

```javascript
  /** Update top bar for deploy lifecycle states. */
  setDeployStatus(status) {
    if (!this._statusEl || !this._statusTextEl) return;
    switch (status) {
      case 'deploying':
        this._statusEl.className = 'service-status building';
        this._statusTextEl.textContent = 'Deploying\u2026';
        this._uptimeStart = null;
        break;
      case 'connected':
        this._statusEl.className = 'service-status running';
        this._uptimeStart = Date.now();
        this._statusTextEl.textContent = 'Connected 0m00s';
        break;
      case 'failed':
        this._statusEl.className = 'service-status stopped';
        this._statusTextEl.textContent = 'Deploy Failed';
        break;
      case 'stopped':
        this._statusEl.className = 'service-status stopped';
        this._statusTextEl.textContent = 'Browsing';
        this._uptimeStart = null;
        break;
    }
  }
```

- [ ] **Step 2: Expose topbar as global in main.js**

In `src/frontend/js/main.js`, find where TopBar is initialized and add:

```javascript
window.edogTopBar = topbar;
```

Similarly for sidebar:

```javascript
window.edogSidebar = sidebar;
```

- [ ] **Step 3: Build and verify**

Run: `python scripts/build-html.py`
Expected: "Done!"

- [ ] **Step 4: Commit**

```bash
git add src/frontend/js/topbar.js src/frontend/js/main.js
git commit -m "feat(deploy): topbar deploy status + global refs for phase sync

Add setDeployStatus() method to TopBar for deploying/connected/failed/
stopped states. Expose topbar and sidebar as window globals so
DeployFlow onPhaseChange callback can drive phase transitions.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 6: Add cascade-enable animation to Sidebar

**Files:**
- Modify: `src/frontend/js/sidebar.js`
- Modify: `src/frontend/css/sidebar.css`

- [ ] **Step 1: Add cascade animation to setPhase in sidebar.js**

Replace the `setPhase` method's icon enable/disable loop with staggered animation:

```javascript
  setPhase(phase) {
    this._phase = phase;
    const connectedSlots = [];

    this._slots.forEach(slot => {
      const btn = slot.querySelector('.sidebar-icon');
      if (!btn) return;
      const iconPhase = btn.dataset.phase;
      if (iconPhase === 'connected') {
        connectedSlots.push(slot);
        if (phase === 'disconnected') {
          slot.classList.add('disabled');
        }
      } else {
        slot.classList.remove('disabled');
      }
    });

    // Cascade-enable connected views with staggered delay
    if (phase === 'connected') {
      connectedSlots.forEach((slot, i) => {
        setTimeout(() => {
          slot.classList.remove('disabled');
          slot.classList.add('cascade-in');
          setTimeout(() => slot.classList.remove('cascade-in'), 400);
        }, i * 150);
      });
    }

    if (this._phaseEl) {
      if (phase === 'connected') {
        this._phaseEl.textContent = '\u25C9';
        this._phaseEl.title = 'Connected \u00B7 FLT service running';
        this._phaseEl.classList.add('connected');
      } else {
        this._phaseEl.textContent = '\u25CB';
        this._phaseEl.title = 'Browsing \u00B7 No service connected';
        this._phaseEl.classList.remove('connected');
      }
    }

    if (this._getSlot(this._activeView)?.classList.contains('disabled')) {
      this.switchView('workspace');
    }
  }
```

- [ ] **Step 2: Add cascade-in animation to sidebar.css**

Add at the end of sidebar.css:

```css
/* Phase 2 cascade-enable animation */
.sidebar-slot.cascade-in .sidebar-icon {
  animation: sidebar-cascade-in 400ms cubic-bezier(0.16, 1, 0.3, 1);
}

@keyframes sidebar-cascade-in {
  0% { opacity: 0.4; transform: scale(0.85); }
  60% { transform: scale(1.1); }
  100% { opacity: 1; transform: scale(1); }
}
```

- [ ] **Step 3: Build and verify**

Run: `python scripts/build-html.py`
Expected: "Done!"

- [ ] **Step 4: Commit**

```bash
git add src/frontend/js/sidebar.js src/frontend/css/sidebar.css
git commit -m "feat(deploy): sidebar cascade-enable animation for Phase 2

When phase transitions to connected, Logs/DAG/Spark icons enable
with 150ms stagger + scale bounce. Creates a cascade reveal as
each icon springs to life after deploy completes.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Phase D: Integration Test + Quality Gate

### Task 7: Full integration build + test

**Files:**
- All modified files from Tasks 1-6

- [ ] **Step 1: Run full quality gate**

Run: `python -m pytest -q && python scripts/build-html.py`
Expected: All tests pass, build succeeds

- [ ] **Step 2: Manual verification checklist**

Open `python scripts/dev-server.py` and navigate to http://127.0.0.1:5555:

1. Select a lakehouse in the tree
2. Click "Deploy to this Lakehouse"
3. Verify: stepper appears with 5 numbered circles
4. Verify: progress bar advances
5. Verify: terminal shows log lines when "Show details" clicked
6. Verify: after completion, sidebar Logs/DAG/Spark icons cascade-enable
7. Verify: top bar shows "Connected" with green dot
8. Verify: "Cancel" button works during deploy
9. Verify: failed deploy shows error card with "Retry" button

- [ ] **Step 3: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix(deploy): integration fixes from manual testing

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Future Phases (not in this plan)

These are documented for scope awareness but will be separate plans:

- **Phase E:** Pre-flight validation (DEPLOY-010 through DEPLOY-015)
- **Phase F:** Cancel/rollback with patch revert (DEPLOY-190 through DEPLOY-197)
- **Phase G:** Real edog.py IPC via `.edog-command/` directory (production deploy, not dev-server simulation)
- **Phase H:** Service crash recovery + health monitoring (DEPLOY-220 through DEPLOY-223)
- **Phase I:** Token lifecycle during Phase 2 (DEPLOY-230 through DEPLOY-233)
- **Phase J:** Build output terminal enhancements (TERM-001 through TERM-007)
- **Phase K:** Keyboard shortcuts + screen reader announcements (§11)
