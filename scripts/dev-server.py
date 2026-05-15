"""EDOG Dev Server — serves HTML, /api/flt/config, and proxies Fabric API calls.

Proxy strategy (per docs/fabric-api-reference.md):
  - Forward v1 paths as-is to the redirect host (they return clean shapes)
  - Only /workspaces (top-level) uses /metadata/workspaces (for capacityId)
  - Bearer token is attached server-side (avoids CORS)
"""

import base64
import contextlib
import json
import os
import re
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

from file_watcher import FileWatcher
from flt_catalog import controllers_dir_mtime, extract_catalog
from repo_discovery import find_flt_repos, get_configured_repo, validate_repo

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

# ADO token cache — single token, refreshed when expired
_ado_token_cache: dict = {}  # {"token": str, "expiry": float}
_ado_token_lock = threading.Lock()

ADO_RESOURCE_ID = "499b84ac-1321-427f-aa17-267ca6975798"
_ADO_PR_URL_RE = None  # lazily compiled

# F09 Playground catalog cache — keyed by flt_repo_path.
# Value: {"mtime": float, "payload": dict}.
# Invalidated when any controller file mtime is newer than the cached mtime.
_playground_catalog_cache: dict = {}
_playground_catalog_lock = threading.Lock()


def _get_flt_repo_dir() -> str:
    """Return configured flt_repo_path or empty string. Module-level so tests can patch."""
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            return (json.load(f).get("flt_repo_path") or "").strip()
    except Exception:
        return ""

# ── F09 API Playground header-forwarding policy ──────────────────────────
# Denylist for headers the playground UI is NOT allowed to forward to upstream
# Fabric/FLT services. Names compared lowercased. Rationale per category:
#   - auth: dispatcher injects bearer/MWC; client-supplied auth would override
#   - hop-by-hop (RFC 7230 §6.1): not end-to-end, breaks urllib framing
#   - framing: re-emitted by urllib from the actual body it sends
#   - browser pollution: irrelevant or rejected by upstream
#   - cookies: cross-context session leak risk
_PLAYGROUND_HEADER_DENYLIST = frozenset({
    "authorization", "proxy-authorization", "proxy-authenticate",
    "connection", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade",
    "host", "content-length",
    "origin", "referer", "user-agent", "accept-encoding",
    "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "sec-fetch-user",
    "sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform",
    "cookie", "set-cookie",
})

# RFC 7230 token grammar (header field names). Tightened slightly: no leading/trailing dot.
_PLAYGROUND_HEADER_NAME_RE = re.compile(r"^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$")

# Header values: ASCII printable + tab; CR/LF forbidden (CRLF-injection guard).
_PLAYGROUND_HEADER_VALUE_FORBIDDEN_RE = re.compile(r"[\r\n\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")

_PLAYGROUND_MAX_HEADERS = 50
_PLAYGROUND_MAX_HEADER_VALUE_BYTES = 8 * 1024
_PLAYGROUND_MAX_REQUEST_BODY_BYTES = 1 * 1024 * 1024
_PLAYGROUND_MAX_RESPONSE_BODY_BYTES = 5 * 1024 * 1024
_PLAYGROUND_DEFAULT_TIMEOUT = 30
_PLAYGROUND_MAX_TIMEOUT = 60

_PLAYGROUND_METHODS = frozenset({"GET", "POST", "PUT", "PATCH", "DELETE"})
_PLAYGROUND_BEARER_PATH_PREFIXES = ("/v1/", "/v1.0/", "/metadata/", "/workspaces")
_PLAYGROUND_MWC_PATH_PREFIXES = (
    "/liveTable", "/liveTableSchedule", "/liveTableMaintanance",
)

# ── Azure OpenAI Proxy Config ────────────────────────────────────────────
_openai_config: dict = {}  # {"endpoint", "api_key", "api_version", "deployment"}


def _load_openai_config() -> dict:
    """Load Azure OpenAI config from env vars or local .env file."""
    endpoint = os.environ.get("AZURE_OPENAI_PRO_ENDPOINT") or os.environ.get("AZURE_OPENAI_ENDPOINT")
    api_key = os.environ.get("AZURE_OPENAI_PRO_API_KEY") or os.environ.get("AZURE_OPENAI_API_KEY")
    api_version = os.environ.get("AZURE_OPENAI_PRO_API_VERSION") or os.environ.get("AZURE_OPENAI_API_VERSION") or "2025-04-01-preview"
    deployment = os.environ.get("AZURE_OPENAI_PRO_DEPLOYMENT") or os.environ.get("AZURE_OPENAI_DEPLOYMENT") or "gpt-5.4-pro"

    if not endpoint or not api_key:
        # Load from .env in project root
        env_file = PROJECT_DIR / ".env"
        if env_file.exists():
            env_vars: dict[str, str] = {}
            for line in env_file.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, _, v = line.partition("=")
                env_vars[k.strip()] = v.strip()
            if not endpoint:
                endpoint = env_vars.get("AZURE_OPENAI_PRO_ENDPOINT") or env_vars.get("AZURE_OPENAI_ENDPOINT")
            if not api_key:
                api_key = env_vars.get("AZURE_OPENAI_PRO_API_KEY") or env_vars.get("AZURE_OPENAI_API_KEY")
            api_version = env_vars.get("AZURE_OPENAI_PRO_API_VERSION") or env_vars.get("AZURE_OPENAI_API_VERSION") or api_version
            deployment = env_vars.get("AZURE_OPENAI_PRO_DEPLOYMENT") or env_vars.get("AZURE_OPENAI_DEPLOYMENT") or deployment

    if endpoint and api_key:
        return {"endpoint": endpoint, "api_key": api_key, "api_version": api_version, "deployment": deployment}
    return {}


def _atomic_write(path: Path, data: str):
    """Write data atomically: write to temp file, then rename."""
    import tempfile as _tf

    fd, tmp = _tf.mkstemp(dir=str(path.parent), suffix=".tmp")
    try:
        os.write(fd, data.encode("utf-8"))
        os.close(fd)
        os.replace(tmp, str(path))
    except Exception:
        with contextlib.suppress(OSError):
            os.close(fd)
        with contextlib.suppress(OSError):
            os.unlink(tmp)
        raise


# ── Studio State ──────────────────────────────────────────────────────────
FLT_INTERNAL_PORT = 5557

_studio_state = {
    "phase": "idle",  # idle | deploying | running | crashed | stopped
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
_file_watcher: FileWatcher | None = None
_file_watcher_thread: threading.Thread | None = None
_file_watcher_stop = threading.Event()


def _file_watcher_loop():
    """Background thread: polls FileWatcher every 3 seconds."""
    import contextlib

    while not _file_watcher_stop.is_set():
        if _file_watcher and _file_watcher.is_active():
            with contextlib.suppress(Exception):
                _file_watcher.poll_changes()
        _file_watcher_stop.wait(3.0)


def _start_file_watcher(service_dir: str):
    """Start watching the FLT Service directory for file changes."""
    global _file_watcher, _file_watcher_thread
    _file_watcher_stop.clear()
    _file_watcher = FileWatcher(service_dir)
    _file_watcher.snapshot_deployed()
    _file_watcher_thread = threading.Thread(target=_file_watcher_loop, daemon=True, name="file-watcher")
    _file_watcher_thread.start()


def _stop_file_watcher():
    """Stop the file watcher background thread."""
    global _file_watcher, _file_watcher_thread
    _file_watcher_stop.set()
    if _file_watcher_thread and _file_watcher_thread.is_alive():
        _file_watcher_thread.join(timeout=5)
    _file_watcher_thread = None
    if _file_watcher:
        _file_watcher.reset()


def _capture_git_head(repo_path: str) -> dict | None:
    """Capture HEAD commit info from the FLT repo.

    Returns dict with commitSha, commitMessage, commitAuthor, commitDate, or None
    if the repo isn't a git checkout or git is unavailable. Used to populate the
    Connected strip so the user can see exactly what code is running.
    """
    if not repo_path or not Path(repo_path).is_dir():
        return None
    try:
        # Single git call: SHA \n author \n subject \n ISO date
        result = subprocess.run(
            ["git", "log", "-1", "--pretty=format:%H%n%an%n%s%n%cI"],
            cwd=repo_path,
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
        if result.returncode != 0:
            return None
        lines = result.stdout.split("\n", 3)
        if len(lines) < 4:
            return None
        return {
            "commitSha": lines[0].strip(),
            "commitAuthor": lines[1].strip(),
            "commitMessage": lines[2].strip(),
            "commitDate": lines[3].strip(),
        }
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        return None


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


# ── F09 API Playground validators (pure functions) ───────────────────────


def _sanitize_playground_headers(raw_headers):
    """Filter and validate playground-supplied headers.

    Returns (ok, sanitized_dict_or_error). On success, sanitized_dict has
    header names preserved in original casing but deduplicated case-insensitively.
    On failure, error is a dict suitable for the dispatcher error envelope.
    """
    if raw_headers is None:
        return True, {}
    if not isinstance(raw_headers, dict):
        return False, {"error": "bad_header", "message": "headers must be an object"}

    if len(raw_headers) > _PLAYGROUND_MAX_HEADERS:
        return False, {
            "error": "bad_header",
            "message": f"too many headers (max {_PLAYGROUND_MAX_HEADERS})",
        }

    sanitized = {}
    seen_lower = set()
    for name, value in raw_headers.items():
        if not isinstance(name, str) or not isinstance(value, str):
            return False, {
                "error": "bad_header",
                "message": "header name and value must be strings",
            }
        name_lower = name.lower()
        if name_lower in _PLAYGROUND_HEADER_DENYLIST:
            # Silently drop — UI hint already greys these out; don't fail the request.
            continue
        if not _PLAYGROUND_HEADER_NAME_RE.match(name):
            return False, {
                "error": "bad_header",
                "message": f"invalid header name: {name!r}",
            }
        if _PLAYGROUND_HEADER_VALUE_FORBIDDEN_RE.search(value):
            return False, {
                "error": "bad_header",
                "message": f"header {name!r} value contains forbidden characters",
            }
        if len(value.encode("utf-8", errors="replace")) > _PLAYGROUND_MAX_HEADER_VALUE_BYTES:
            return False, {
                "error": "bad_header",
                "message": f"header {name!r} value exceeds {_PLAYGROUND_MAX_HEADER_VALUE_BYTES} bytes",
            }
        if name_lower in seen_lower:
            # Duplicate (case-insensitive). Last write wins to match HTTP intuition.
            # Remove prior entry preserving order roughly.
            for existing in list(sanitized):
                if existing.lower() == name_lower:
                    del sanitized[existing]
                    break
        seen_lower.add(name_lower)
        sanitized[name] = value
    return True, sanitized


def _validate_playground_envelope(envelope):
    """Validate the inbound dispatch request envelope.

    Returns (ok, parsed_or_error). On success, parsed is a dict with
    normalized values: tokenType, method, path, headers (sanitized),
    body (bytes or None), timeout (int).
    """
    if not isinstance(envelope, dict):
        return False, {"error": "bad_request", "message": "envelope must be a JSON object"}

    token_type = envelope.get("tokenType")
    if token_type not in ("bearer", "mwc"):
        return False, {
            "error": "bad_request",
            "message": "tokenType must be 'bearer' or 'mwc'",
        }

    method = envelope.get("method")
    if not isinstance(method, str) or method.upper() not in _PLAYGROUND_METHODS:
        return False, {
            "error": "bad_request",
            "message": f"method must be one of {sorted(_PLAYGROUND_METHODS)}",
        }
    method = method.upper()

    path = envelope.get("path")
    if not isinstance(path, str) or not path.startswith("/"):
        return False, {"error": "invalid_path", "message": "path must start with '/'"}
    if "://" in path:
        return False, {
            "error": "invalid_path",
            "message": "absolute URLs not allowed; supply path only",
        }
    # Open-proxy guard: refuse protocol-relative paths like '//evil.com/x'
    if path.startswith("//"):
        return False, {
            "error": "invalid_path",
            "message": "protocol-relative paths not allowed",
        }

    # Per-tokenType prefix policy
    if token_type == "bearer":
        if not path.startswith(_PLAYGROUND_BEARER_PATH_PREFIXES):
            return False, {
                "error": "invalid_path",
                "message": f"bearer paths must start with one of {list(_PLAYGROUND_BEARER_PATH_PREFIXES)}",
            }
    else:  # mwc
        if not path.startswith(_PLAYGROUND_MWC_PATH_PREFIXES):
            return False, {
                "error": "invalid_path",
                "message": f"mwc paths must start with one of {list(_PLAYGROUND_MWC_PATH_PREFIXES)}",
            }

    ok, headers_or_err = _sanitize_playground_headers(envelope.get("headers"))
    if not ok:
        return False, headers_or_err
    headers = headers_or_err

    body_raw = envelope.get("body")
    body_bytes = None
    if body_raw is not None:
        if not isinstance(body_raw, str):
            return False, {
                "error": "bad_request",
                "message": "body must be a string or null",
            }
        body_bytes = body_raw.encode("utf-8", errors="replace")
        if len(body_bytes) > _PLAYGROUND_MAX_REQUEST_BODY_BYTES:
            return False, {
                "error": "body_too_large",
                "message": f"body exceeds {_PLAYGROUND_MAX_REQUEST_BODY_BYTES} bytes",
            }

    timeout_raw = envelope.get("timeout", _PLAYGROUND_DEFAULT_TIMEOUT)
    try:
        timeout = int(timeout_raw)
    except (TypeError, ValueError):
        return False, {"error": "bad_request", "message": "timeout must be an integer"}
    if timeout < 1:
        timeout = 1
    if timeout > _PLAYGROUND_MAX_TIMEOUT:
        timeout = _PLAYGROUND_MAX_TIMEOUT

    return True, {
        "tokenType": token_type,
        "method": method,
        "path": path,
        "headers": headers,
        "body": body_bytes,
        "timeout": timeout,
    }


def _compose_playground_bearer_url(path: str) -> str:
    """Compose upstream URL for a bearer-token playground request.

    Convention: /v1/* and /v1.0/* pass straight through (matches Fabric API docs
    style used in the playground catalog). /workspaces and /metadata/* go
    through _map_path for compatibility with the DAG Studio convention.
    """
    if path.startswith(("/v1/", "/v1.0/", "/metadata/")):
        return REDIRECT_HOST + path
    # /workspaces or /workspaces?... — let _map_path translate to /metadata/workspaces
    return REDIRECT_HOST + _map_path(path)


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
        normalized.append(
            {
                "id": f.get("objectId", str(f.get("id", ""))),
                "displayName": f.get("displayName", ""),
                "type": "Workspace",
                "capacityId": f.get("capacityObjectId", ""),
                "state": "Active",
                "description": f.get("description", ""),
            }
        )
    return json.dumps({"value": normalized}).encode()


def _get_ado_token() -> str:
    """Get an Azure DevOps access token via Azure CLI, with in-memory caching."""
    global _ado_token_cache
    with _ado_token_lock:
        cached = _ado_token_cache
        if cached and cached.get("expiry", 0) > time.time() + 60:
            return cached["token"]

        # Refresh inside the lock to prevent stampede
        result = subprocess.run(
            ["az", "account", "get-access-token", "--resource", ADO_RESOURCE_ID, "--query", "accessToken", "-o", "tsv"],
            capture_output=True, text=True, timeout=30, shell=True,
        )
        if result.returncode != 0:
            raise RuntimeError(f"az CLI failed: {result.stderr.strip()}")
        token = result.stdout.strip()
        if not token:
            raise RuntimeError("az CLI returned empty ADO token")

        _ado_token_cache = {"token": token, "expiry": time.time() + 3000}
        return token


def _parse_ado_pr_url(pr_url: str) -> dict:
    """Parse an ADO PR URL into org, project, repo, prId components.

    Accepts:
      https://dev.azure.com/{org}/{project}/_git/{repo}/pullrequest/{prId}
      https://dev.azure.com/{org}/{project}/_git/{repo}/pullrequest/{prId}?_a=files
    """
    global _ADO_PR_URL_RE
    import re
    if _ADO_PR_URL_RE is None:
        _ADO_PR_URL_RE = re.compile(
            r"https?://dev\.azure\.com/(?P<org>[^/]+)/(?P<project>[^/]+)/"
            r"_git/(?P<repo>[^/]+)/pullrequest/(?P<prId>\d+)"
        )
    m = _ADO_PR_URL_RE.match(pr_url.split("?")[0])
    if not m:
        raise ValueError(f"Cannot parse ADO PR URL: {pr_url}")
    return {
        "org": m.group("org"),
        "project": m.group("project"),
        "repo": m.group("repo"),
        "prId": int(m.group("prId")),
    }


def _ado_api_get(token: str, url: str) -> dict | str:
    """Call an ADO REST API endpoint. Returns parsed JSON or raw text."""
    req = urllib.request.Request(url, headers={
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
    })
    ctx = ssl.create_default_context()
    with urllib.request.urlopen(req, context=ctx, timeout=30) as resp:
        content_type = resp.headers.get("Content-Type", "")
        body = resp.read().decode("utf-8")
        if "application/json" in content_type:
            return json.loads(body)
        return body


def _ado_api_get_text(token: str, url: str) -> str:
    """Call an ADO REST API endpoint expecting raw text (file content)."""
    req = urllib.request.Request(url, headers={
        "Authorization": f"Bearer {token}",
        "Accept": "text/plain",
    })
    ctx = ssl.create_default_context()
    with urllib.request.urlopen(req, context=ctx, timeout=30) as resp:
        raw = resp.read()
        try:
            return raw.decode("utf-8")
        except UnicodeDecodeError:
            return None  # binary file


def _fetch_pr_diff(pr_url: str) -> dict:
    """Fetch the unified diff for a pull request from Azure DevOps.

    Returns dict with: prId, title, author, filesChanged, linesAdded,
    linesRemoved, diff (unified diff string), skippedFiles (list).
    """
    import difflib

    parsed = _parse_ado_pr_url(pr_url)
    org, project, repo, pr_id = parsed["org"], parsed["project"], parsed["repo"], parsed["prId"]
    base_url = f"https://dev.azure.com/{org}/{project}/_apis/git/repositories/{repo}"
    token = _get_ado_token()

    # 1. Get PR metadata
    pr_data = _ado_api_get(token, f"{base_url}/pullRequests/{pr_id}?api-version=7.0")
    title = pr_data.get("title", "")
    author = pr_data.get("createdBy", {}).get("displayName", "")

    # 2. Get iterations to find the latest source/common commits
    iterations = _ado_api_get(token, f"{base_url}/pullRequests/{pr_id}/iterations?api-version=7.0")
    iter_list = iterations.get("value", [])
    if not iter_list:
        raise RuntimeError(f"PR {pr_id} has no iterations")
    latest = iter_list[-1]
    source_commit = latest.get("sourceRefCommit", {}).get("commitId")
    common_commit = latest.get("commonRefCommit", {}).get("commitId")
    if not source_commit or not common_commit:
        raise RuntimeError(f"PR {pr_id}: missing source/common commit in iteration {latest.get('id')}")

    # 3. Get cumulative changed files (compareTo=1 gives full PR diff, not just latest push)
    iter_id = latest["id"]
    changes_data = _ado_api_get(
        token, f"{base_url}/pullRequests/{pr_id}/iterations/{iter_id}/changes?compareTo=1&api-version=7.0"
    )
    change_entries = changes_data.get("changeEntries", [])
    file_changes = [c for c in change_entries if not c.get("item", {}).get("isFolder")]

    # 4. Build unified diff for each file
    MAX_FILES = 50
    MAX_FILE_BYTES = 200_000
    SKIP_EXTENSIONS = {".dll", ".exe", ".png", ".jpg", ".jpeg", ".gif", ".ico", ".woff", ".woff2", ".ttf", ".eot", ".zip", ".nupkg", ".snk"}

    diff_parts = []
    skipped = []
    total_added = 0
    total_removed = 0

    for entry in file_changes[:MAX_FILES]:
        item = entry.get("item", {})
        raw_change_type = entry.get("changeType", "").lower()
        file_path = item.get("path", "")

        # Normalize composite ADO change types (e.g. "rename, edit" → {"rename", "edit"})
        change_tokens = {t.strip() for t in raw_change_type.replace(",", " ").split()}
        is_add = "add" in change_tokens
        is_delete = "delete" in change_tokens
        is_rename = "rename" in change_tokens or "sourcerename" in change_tokens

        # Skip binary/large/irrelevant files
        ext = os.path.splitext(file_path)[1].lower()
        if ext in SKIP_EXTENSIONS:
            skipped.append({"path": file_path, "reason": "binary"})
            continue

        original_path = entry.get("sourceServerItem") or file_path

        # Fetch base version (from common commit) — skip for pure adds
        base_content = ""
        if not is_add:
            fetch_path = original_path if is_rename else file_path
            try:
                encoded_path = urllib.parse.quote(fetch_path, safe="/")
                base_content = _ado_api_get_text(
                    token,
                    f"{base_url}/items?path={encoded_path}&versionType=Commit&version={common_commit}&api-version=7.0",
                )
                if base_content is None:
                    skipped.append({"path": file_path, "reason": "binary"})
                    continue
                if len(base_content) > MAX_FILE_BYTES:
                    skipped.append({"path": file_path, "reason": "too_large"})
                    continue
            except urllib.error.HTTPError as e:
                if e.code == 404:
                    base_content = ""
                else:
                    skipped.append({"path": file_path, "reason": f"fetch_error_{e.code}"})
                    continue

        # Fetch target version (from source commit) — skip for pure deletes
        target_content = ""
        if not is_delete:
            try:
                encoded_path = urllib.parse.quote(file_path, safe="/")
                target_content = _ado_api_get_text(
                    token,
                    f"{base_url}/items?path={encoded_path}&versionType=Commit&version={source_commit}&api-version=7.0",
                )
                if target_content is None:
                    skipped.append({"path": file_path, "reason": "binary"})
                    continue
                if len(target_content) > MAX_FILE_BYTES:
                    skipped.append({"path": file_path, "reason": "too_large"})
                    continue
            except urllib.error.HTTPError as e:
                if e.code == 404:
                    target_content = ""
                else:
                    skipped.append({"path": file_path, "reason": f"fetch_error_{e.code}"})
                    continue

        # Generate unified diff
        from_file = f"a{original_path}" if not is_add else "/dev/null"
        to_file = f"b{file_path}" if not is_delete else "/dev/null"

        base_lines = base_content.splitlines(keepends=True)
        target_lines = target_content.splitlines(keepends=True)

        file_diff = list(difflib.unified_diff(base_lines, target_lines, fromfile=from_file, tofile=to_file, lineterm="\n"))
        if file_diff:
            diff_parts.append("".join(file_diff))
            for line in file_diff:
                if line.startswith("+") and not line.startswith("+++"):
                    total_added += 1
                elif line.startswith("-") and not line.startswith("---"):
                    total_removed += 1

    if len(file_changes) > MAX_FILES:
        skipped.append({"path": f"({len(file_changes) - MAX_FILES} more files)", "reason": "file_limit"})

    combined_diff = "\n".join(diff_parts)

    return {
        "prId": pr_id,
        "title": title,
        "author": author,
        "filesChanged": len(file_changes),
        "filesDiffed": len(diff_parts),
        "linesAdded": total_added,
        "linesRemoved": total_removed,
        "skippedFiles": skipped,
        "iterationId": iter_id,
        "sourceCommit": source_commit[:12],
        "commonCommit": common_commit[:12],
        "diff": combined_diff,
    }


def _get_mwc_token(bearer: str, ws_id: str, artifact_id: str, cap_id: str, workload_type: str = "Lakehouse") -> tuple:
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
    body = json.dumps(
        {
            "type": "[Start] GetMWCToken",
            "workloadType": workload_type,
            "workspaceObjectId": ws_id,
            "artifactObjectIds": [artifact_id],
            "capacityObjectId": cap_id,
        }
    ).encode()

    url = f"{REDIRECT_HOST}/metadata/v201606/generatemwctoken"
    req = urllib.request.Request(
        url,
        data=body,
        headers={
            "Authorization": f"Bearer {bearer}",
            "Content-Type": "application/json",
        },
        method="POST",
    )

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
    return f"/webapi/capacities/{cap_id}/workloads/Lakehouse/LakehouseService/automatic/v1/workspaces/{ws_id}"


def _jupyter_api_path(cap_id: str, ws_id: str, nb_id: str) -> str:
    """Build the Jupyter API base path for a capacity/workspace/notebook tuple."""
    return (
        f"/webapi/capacities/{cap_id}/workloads/Notebook/Data/Automatic"
        f"/api/workspaces/{ws_id}/artifacts/{nb_id}"
        f"/jupyterApi/versions/1/api"
    )


def _resolve_mwc_for_jupyter(cap_id: str, ws_id: str = "", nb_id: str = "", lh_id: str = ""):
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
            print("  [JUPYTER] MWC Notebook cache hit")
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
                token, host = _get_mwc_token(bearer, ws_id, nb_id, cap_id, workload_type="Notebook")
                return token, host
            except Exception as e:
                print(f"  [JUPYTER] Notebook MWC token failed: {e}")
                # Try Lakehouse-scoped as fallback
                if lh_id:
                    try:
                        print("  [JUPYTER] Falling back to Lakehouse MWC token...")
                        token, host = _get_mwc_token(bearer, ws_id, lh_id, cap_id, workload_type="Lakehouse")
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
    import uuid

    import websockets

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
    execute_msg = json.dumps(
        {
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
        }
    )

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
                    outputs.append(
                        {
                            "type": "stream",
                            "name": content.get("name", "stdout"),
                            "text": content.get("text", ""),
                        }
                    )
                elif msg_type == "execute_result":
                    data = content.get("data", {})
                    outputs.append(
                        {
                            "type": "execute_result",
                            "text": data.get("text/plain", ""),
                            "html": data.get("text/html", ""),
                        }
                    )
                elif msg_type == "display_data":
                    data = content.get("data", {})
                    outputs.append(
                        {
                            "type": "display_data",
                            "text": data.get("text/plain", ""),
                            "html": data.get("text/html", ""),
                        }
                    )
                elif msg_type == "error":
                    status = "error"
                    error_name = content.get("ename", "")
                    error_value = content.get("evalue", "")
                    traceback_lines = content.get("traceback", [])
                    outputs.append(
                        {
                            "type": "error",
                            "ename": error_name,
                            "evalue": error_value,
                            "traceback": traceback_lines,
                        }
                    )
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


# Event set when FLT stdout shows "DevConnection started" (service fully ready)
_flt_ready_event = threading.Event()


def _drain_flt_stdout(proc, deploy_id):
    """Read FLT process stdout continuously to prevent pipe buffer blocking.

    Also captures output as deploy log entries and sets _flt_ready_event
    when the service is fully deployed (DevConnection started).
    """
    try:
        while proc.poll() is None:
            line = proc.stdout.readline()
            if not line:
                break
            line = line.rstrip()
            if line:
                _deploy_log("[FLT] " + line, "info")
                # Check for deployment success markers
                if "DevConnection started" in line:
                    _flt_ready_event.set()
    except Exception:
        pass


def _handle_account_picker(username, timeout=45):
    """Auto-select the DevMode account picker that appears when FLT starts.

    Uses pywinauto to find the Edge/browser window and keyboard to select
    the account matching the edog-config username. Runs silently — the user
    should not notice this happening.
    """
    try:
        from pywinauto import Desktop
    except ImportError:
        _deploy_log("pywinauto not installed — please select account manually", "warn")
        return False

    account_name = username.split("@")[0] if "@" in username else username
    _deploy_log(f"Watching for account picker (account: {username})...", "info")

    start = time.time()
    while (time.time() - start) < timeout:
        try:
            desktop = Desktop(backend="uia")
            for win in desktop.windows():
                try:
                    title = win.window_text().lower()
                    is_login = any(
                        kw in title
                        for kw in [
                            "pick an account",
                            "sign in to your account",
                            "login.microsoftonline",
                            "login.windows",
                            "sign in -",
                        ]
                    )
                    if is_login and ("edge" in title or "chrome" in title or "msedge" in title):
                        _deploy_log("Account picker detected — looking for account...", "info")
                        try:
                            win.set_focus()
                            time.sleep(0.5)
                            # Find the account tile matching our username
                            account_name = username.split("@")[0] if "@" in username else username
                            found = False
                            try:
                                # Search all child elements for text matching our account
                                descendants = win.descendants()
                                for el in descendants:
                                    try:
                                        el_text = el.window_text()
                                        if (
                                            account_name.lower() in el_text.lower()
                                            or username.lower() in el_text.lower()
                                        ):
                                            _deploy_log(f"Found account element: {el_text[:50]}", "info")
                                            el.click_input()
                                            found = True
                                            break
                                    except Exception:
                                        continue
                            except Exception as e:
                                _deploy_log(f"Could not search account elements: {e}", "warn")

                            if found:
                                _deploy_log(f"Account selected: {username}", "success")
                            else:
                                _deploy_log(
                                    f"Account '{account_name}' not found in picker — please select manually", "warn"
                                )
                            return found
                        except Exception as e:
                            _deploy_log(f"Account picker error: {e}", "warn")
                except Exception:
                    continue
        except Exception:
            pass
        time.sleep(1)

    _deploy_log(f"Account picker not found within {timeout}s — select manually if prompted", "warn")
    return False


def _inject_devmode_token(config):
    """Acquire a bearer token via Silent CBA and inject into workload-dev-mode.json.

    Uses the MwcFrontendBaseEndpoint as the token audience — this is what
    DevConnection's InteractiveBrowserCredential would request. By pre-populating
    UserAuthorizationToken, the WCL SDK skips the browser popup entirely.

    Returns True if token was injected, False otherwise (graceful fallback).
    """
    try:
        username = config.get("username", "")
        flt_repo = config.get("flt_repo_path", "")
        if not username or not flt_repo:
            _deploy_log("Skipping token injection — username or flt_repo_path not set", "warn")
            return False

        # Find workload-dev-mode.json
        sys.path.insert(0, str(PROJECT_DIR))
        try:
            from edog import _find_cert_thumbprint, get_workload_dev_mode_path

            devmode_path = get_workload_dev_mode_path(flt_repo)
        except Exception as e:
            _deploy_log(f"Could not locate workload-dev-mode.json: {e}", "warn")
            return False
        finally:
            if str(PROJECT_DIR) in sys.path:
                sys.path.remove(str(PROJECT_DIR))

        if not devmode_path or not Path(devmode_path).exists():
            _deploy_log("workload-dev-mode.json not found — skipping token injection", "warn")
            return False

        # Read MwcFrontendBaseEndpoint from config — this is the token audience
        devmode = json.loads(Path(devmode_path).read_text())
        mwc_endpoint = devmode.get("MwcFrontendBaseEndpoint", "")
        if not mwc_endpoint:
            _deploy_log("No MwcFrontendBaseEndpoint in config — skipping", "warn")
            return False

        # Strip trailing port/slash for the resource URI
        resource = mwc_endpoint.rstrip("/")
        if resource.endswith(":443"):
            resource = resource[:-4]

        # Get cert thumbprint
        cert_cn = username.replace("@", ".")
        thumbprint = _find_cert_thumbprint(cert_cn)
        if not thumbprint:
            _deploy_log(f"No cert found for {cert_cn} — skipping token injection", "warn")
            return False

        # Find token-helper executable
        helper = PROJECT_DIR / "scripts" / "token-helper" / "bin" / "Debug" / "net8.0" / "token-helper.exe"
        if not helper.exists():
            helper = PROJECT_DIR / "scripts" / "token-helper" / "bin" / "Debug" / "net472" / "token-helper.exe"
        if not helper.exists():
            _deploy_log("token-helper not built — skipping token injection", "warn")
            return False

        # Acquire token with the CORRECT audience (MwcFrontendBaseEndpoint)
        _deploy_log(f"Acquiring DevMode token (audience: {resource})...", "info")
        client_id = "ea0616ba-638b-4df5-95b9-636659ae5121"
        authority = "https://login.windows-ppe.net/organizations"

        result = subprocess.run(
            [str(helper), thumbprint, username, client_id, authority, resource],
            capture_output=True,
            text=True,
            timeout=30,
        )

        if result.returncode != 0 or not result.stdout.strip().startswith("eyJ"):
            stderr_msg = (result.stderr or "").strip().split("\n")[-1][:100] if result.stderr else "unknown"
            _deploy_log(f"Token acquisition failed: {stderr_msg}", "warn")
            return False

        token = result.stdout.strip()
        _deploy_log(f"DevMode token acquired ({len(token)} chars) — zero-popup auth!", "success")

        # Inject into workload-dev-mode.json
        devmode["UserAuthorizationToken"] = token

        # Sync CapacityGuid so FLT connects to the correct capacity
        cap_id = config.get("capacity_id", "")
        if cap_id and devmode.get("CapacityGuid", "").lower() != cap_id.lower():
            old_cap = devmode.get("CapacityGuid", "(none)")
            devmode["CapacityGuid"] = cap_id
            _deploy_log(f"Synced CapacityGuid: {old_cap[:8]}… → {cap_id[:8]}…", "info")

        _atomic_write(Path(devmode_path), json.dumps(devmode, indent=4))
        _deploy_log("Injected UserAuthorizationToken — no browser popup needed", "success")
        global _devmode_token_was_injected
        _devmode_token_was_injected = True
        return True

    except subprocess.TimeoutExpired:
        _deploy_log("Token acquisition timed out — falling back to browser", "warn")
        return False
    except Exception as e:
        _deploy_log(f"Token injection failed: {e} — falling back to browser", "warn")
        return False


# Track whether we injected the DevMode token (for safe cleanup)
_devmode_token_was_injected = False


def _cleanup_devmode_token():
    """Remove UserAuthorizationToken from workload-dev-mode.json if we injected it."""
    global _devmode_token_was_injected
    if not _devmode_token_was_injected:
        return

    try:
        config = json.loads(CONFIG_PATH.read_text()) if CONFIG_PATH.exists() else {}
        flt_repo = config.get("flt_repo_path", "")
        if not flt_repo:
            return

        sys.path.insert(0, str(PROJECT_DIR))
        try:
            from edog import get_workload_dev_mode_path
            devmode_path = get_workload_dev_mode_path(flt_repo)
        finally:
            if str(PROJECT_DIR) in sys.path:
                sys.path.remove(str(PROJECT_DIR))

        if not devmode_path or not Path(devmode_path).exists():
            return

        data = json.loads(Path(devmode_path).read_text())
        if "UserAuthorizationToken" in data:
            del data["UserAuthorizationToken"]
            _atomic_write(Path(devmode_path), json.dumps(data, indent=4))
            _deploy_log("Cleaned up UserAuthorizationToken", "info")
        _devmode_token_was_injected = False
    except Exception as e:
        _deploy_log(f"Token cleanup failed: {e}", "warn")


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
                _studio_state.update(
                    {
                        "phase": "stopped",
                        "deployError": "No bearer token. Run authentication first.",
                        "deployMessage": "Deploy failed — no bearer token",
                    }
                )
            return
        try:
            _token, _host = _get_mwc_token(bearer, ws_id, lh_id, cap_id)
            _deploy_log("MWC token acquired", "success")
        except Exception as e:
            _deploy_log(f"Token fetch failed: {e}", "error")
            with _studio_lock:
                _studio_state.update(
                    {
                        "phase": "stopped",
                        "deployError": f"Token fetch failed: {e}",
                        "deployMessage": "Deploy failed — token fetch error",
                    }
                )
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

            # Also sync CapacityGuid into workload-dev-mode.json so FLT connects
            # to the right capacity even when token injection is skipped later
            if cap_id:
                flt_repo = config.get("flt_repo_path", "")
                if flt_repo:
                    sys.path.insert(0, str(PROJECT_DIR))
                    try:
                        from edog import get_workload_dev_mode_path
                        wdm_path = get_workload_dev_mode_path(flt_repo)
                        if wdm_path and Path(wdm_path).exists():
                            wdm = json.loads(Path(wdm_path).read_text())
                            if wdm.get("CapacityGuid", "").lower() != cap_id.lower():
                                wdm["CapacityGuid"] = cap_id
                                _atomic_write(Path(wdm_path), json.dumps(wdm, indent=4))
                                _deploy_log(f"Synced CapacityGuid in workload-dev-mode.json", "success")
                    except Exception as e:
                        _deploy_log(f"Could not sync CapacityGuid: {e}", "warn")
                    finally:
                        if str(PROJECT_DIR) in sys.path:
                            sys.path.remove(str(PROJECT_DIR))
        except Exception as e:
            _deploy_log(f"Config update failed: {e}", "error")
            with _studio_lock:
                _studio_state.update(
                    {"phase": "stopped", "deployError": str(e), "deployMessage": "Deploy failed — config update error"}
                )
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
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
                env=env,
                encoding="utf-8",
                errors="replace",
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
                    _studio_state.update(
                        {
                            "phase": "stopped",
                            "deployError": f"Patch/build failed (exit {proc.returncode})",
                            "deployMessage": "Deploy failed — patch/build error",
                        }
                    )
                return
            _deploy_log("Patch and build succeeded", "success")

        except Exception as e:
            _deploy_log(f"Patch/build error: {e}", "error")
            with _studio_lock:
                _studio_state.update(
                    {"phase": "stopped", "deployError": str(e), "deployMessage": "Deploy failed — patch/build error"}
                )
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

            # Zero-popup auth: inject Silent CBA token into workload-dev-mode.json
            # so DevConnection uses it directly instead of opening a browser
            token_injected = _inject_devmode_token(config)

            _flt_process = subprocess.Popen(
                ["dotnet", "run", "--no-build"],
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
                cwd=str(entrypoint),
                env=env,
                encoding="utf-8",
                errors="replace",
            )
            _deploy_log(f"FLT started (PID: {_flt_process.pid})", "success")

            with _studio_lock:
                _studio_state["fltPid"] = _flt_process.pid
                _studio_state["fltPort"] = FLT_INTERNAL_PORT

            # Drain stdout in background (prevents pipe buffer blocking)
            threading.Thread(target=_drain_flt_stdout, args=(_flt_process, deploy_id), daemon=True).start()

            # Fallback: account picker automation if token injection failed
            if not token_injected:
                username = config.get("username", "")
                threading.Thread(target=_handle_account_picker, args=(username,), daemon=True).start()

        except Exception as e:
            _deploy_log(f"Launch failed: {e}", "error")
            with _studio_lock:
                _studio_state.update(
                    {"phase": "stopped", "deployError": str(e), "deployMessage": "Deploy failed — launch error"}
                )
            return

        # Step 4: Wait for FLT to be fully deployed
        # The real indicator is "DevConnection started" in FLT stdout
        # (captured by _drain_flt_stdout which sets _flt_ready_event)
        if not _deploy_step(4, "Waiting for DevMode connection...", deploy_id):
            return
        _flt_ready_event.clear()
        healthy = _flt_ready_event.wait(timeout=180)  # 3 min max

        # Check if cancelled or process died while waiting
        if _deploy_cancel.is_set():
            _flt_process.terminate()
            with _studio_lock:
                _studio_state.update({"phase": "stopped", "deployMessage": "Cancelled"})
            return

        if _flt_process.poll() is not None:
            _deploy_log(f"FLT process exited with code {_flt_process.returncode}", "error")
            with _studio_lock:
                _studio_state.update(
                    {
                        "phase": "stopped",
                        "deployError": f"FLT process exited with code {_flt_process.returncode}",
                        "deployMessage": "Deploy failed — service crashed during startup",
                    }
                )
            return

        if not healthy:
            _deploy_log("DevConnection not established within 180s", "error")
            with _studio_lock:
                _studio_state.update(
                    {
                        "phase": "stopped",
                        "deployError": "Service did not fully start within 180s",
                        "deployMessage": "Deploy failed — DevMode connection timeout",
                    }
                )
            return

        _deploy_log("DevConnection started — service fully deployed!", "success")

        # Capture FLT repo git HEAD for the Connected strip (issue: commit info
        # was never populated, so commit SHA/message never showed up in UI).
        git_info = None
        try:
            cfg = json.loads(CONFIG_PATH.read_text()) if CONFIG_PATH.exists() else {}
            git_info = _capture_git_head(cfg.get("flt_repo_path", ""))
            if git_info and git_info.get("commitSha"):
                _deploy_log(
                    f"FLT @ {git_info['commitSha'][:7]} — {git_info['commitMessage']}",
                    "dim",
                )
        except Exception:
            pass  # Non-fatal — strip just won't show commit chip

        # Done
        with _studio_lock:
            target = _studio_state.get("deployTarget") or {}
            if git_info:
                target.update(git_info)
            _studio_state.update(
                {
                    "phase": "running",
                    "deployStep": 5,
                    "deployMessage": "Deploy complete",
                    "deployTarget": target,
                }
            )
        _deploy_log("Deploy complete!", "success")

        # Start file change detection after successful deploy
        try:
            config = json.loads(CONFIG_PATH.read_text()) if CONFIG_PATH.exists() else {}
            flt_repo = config.get("flt_repo_path", "")
            if flt_repo:
                service_dir = str(Path(flt_repo) / "Service" / "Microsoft.LiveTable.Service")
                _start_file_watcher(service_dir)
        except Exception:
            pass  # File watcher is non-critical

        # Start monitor thread
        monitor = threading.Thread(target=_monitor_flt, args=(deploy_id,), daemon=True)
        monitor.start()

        # Start token refresh thread
        refresher = threading.Thread(
            target=_token_refresh_loop,
            args=(ws_id, lh_id, cap_id),
            daemon=True,
        )
        refresher.start()

    except Exception as e:
        _deploy_log(f"Unexpected error: {e}", "error")
        with _studio_lock:
            _studio_state.update(
                {"phase": "stopped", "deployError": str(e), "deployMessage": "Deploy failed — unexpected error"}
            )


def _monitor_flt(deploy_id):
    """Monitor FLT process for crashes."""
    global _flt_process
    while _flt_process and _flt_process.poll() is None:
        time.sleep(2)
    if _flt_process:
        code = _flt_process.returncode
        with _studio_lock:
            if _studio_state.get("deployId") == deploy_id and _studio_state["phase"] == "running":
                _studio_state.update(
                    {
                        "phase": "crashed",
                        "deployError": f"FLT exited with code {code}",
                        "deployMessage": f"Service crashed (exit code {code})",
                    }
                )
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
        elif (
            self.path.startswith("/api/logs")
            or self.path.startswith("/api/telemetry")
            or self.path.startswith("/api/stats")
            or self.path.startswith("/api/executions")
        ):
            self._proxy_to_log_server("GET")
        elif self.path.startswith("/api/flt-proxy/"):
            self._proxy_to_flt("GET")
        elif self.path == "/ws/logs":
            # WebSocket upgrade request — can't handle in stdlib HTTP server.
            # Return 426 so the client knows to use the FLT port instead.
            self._json_response(
                426, {"error": "ws_not_here", "message": "WebSocket available on FLT port after deploy"}
            )
        elif self.path == "/api/studio/file-changes":
            self._serve_file_changes()
        elif self.path == "/api/templates":
            self._serve_templates_list()
        elif self.path.startswith("/api/templates/"):
            self._serve_template_get()
        elif self.path.startswith("/api/ado-proxy/pr-diff"):
            self._serve_ado_pr_diff()
        elif self.path == "/api/playground/catalog":
            self._serve_playground_catalog()
        else:
            self._json_response(404, {"error": "not_found", "message": f"No handler for GET {self.path}"})

    def do_OPTIONS(self):
        """CORS preflight handler for all mutable routes."""
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, x-ms-continuation-token")
        self.send_header("Access-Control-Max-Age", "86400")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_PUT(self):
        if self.path.startswith("/api/fabric/"):
            self._proxy_fabric("PUT")
        elif self.path.startswith("/api/flt-proxy/"):
            self._proxy_to_flt("PUT")
        else:
            self._json_response(404, {"error": "not_found", "message": f"No handler for PUT {self.path}"})

    def do_PATCH(self):
        if self.path.startswith("/api/fabric/"):
            self._proxy_fabric("PATCH")
        elif self.path.startswith("/api/flt-proxy/"):
            self._proxy_to_flt("PATCH")
        else:
            self._json_response(404, {"error": "not_found", "message": f"No handler for PATCH {self.path}"})

    def do_DELETE(self):
        if self.path.startswith("/api/fabric/"):
            self._proxy_fabric("DELETE")
        elif self.path.startswith("/api/flt-proxy/"):
            self._proxy_to_flt("DELETE")
        elif self.path.startswith("/api/templates/"):
            self._serve_template_delete()
        else:
            self._json_response(404, {"error": "not_found", "message": f"No handler for DELETE {self.path}"})

    def do_POST(self):
        if self.path.startswith("/api/fabric/"):
            self._proxy_fabric("POST")
        elif self.path == "/api/edog/auth":
            self._serve_auth()
        elif self.path == "/api/edog/repo-scan":
            self._serve_repo_scan()
        elif self.path == "/api/edog/repo-set":
            self._serve_repo_set()
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
        elif self.path == "/api/studio/file-changes/dismiss":
            self._serve_file_changes_dismiss()
        elif self.path == "/api/studio/feedback":
            self._serve_feedback()
        elif self.path.startswith("/api/flt-proxy/"):
            self._proxy_to_flt("POST")
        elif self.path == "/api/templates":
            self._serve_template_save()
        elif self.path == "/api/openai-proxy/chat":
            self._serve_openai_proxy()
        elif self.path == "/api/playground/dispatch":
            self._serve_playground_dispatch()
        else:
            self._json_response(404, {"error": "not_found", "message": f"No handler for POST {self.path}"})

    def _serve_config(self):
        config = {}
        if CONFIG_PATH.exists():
            config = json.loads(CONFIG_PATH.read_text())

        bearer, _ = _read_cache(BEARER_CACHE)

        with _studio_lock:
            flt_port = _studio_state.get("fltPort")
            studio_phase = _studio_state.get("phase", "idle")

        has_flt = bool(flt_port)
        mwc_available = bool(bearer and has_flt and config.get("workspace_id") and config.get("capacity_id"))

        resp = {
            "workspaceId": config.get("workspace_id", ""),
            "artifactId": config.get("artifact_id", ""),
            "capacityId": config.get("capacity_id", ""),
            "tokenExpiryMinutes": 0,
            "tokenExpired": not mwc_available,
            "mwcToken": "proxy-managed" if mwc_available else None,
            "fabricBaseUrl": None,  # routing handled by proxy, not direct localhost
            "bearerToken": bearer,
            "phase": "connected" if mwc_available else "disconnected",
            "fltPort": flt_port,
            "studioPhase": studio_phase,
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
        fabric_path = self.path[len("/api/fabric") :]
        target_path = _map_path(fabric_path)
        is_workspace_list = "/metadata/workspaces" in target_path and "/" not in target_path.split(
            "/metadata/workspaces"
        )[1].lstrip("/")

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

    # ── ADO Proxy Endpoints ───────────────────────────────────────────────

    def _serve_ado_pr_diff(self):
        """GET /api/ado-proxy/pr-diff?prUrl=... — fetch unified diff for a PR."""
        parsed_url = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(parsed_url.query)
        pr_url = qs.get("prUrl", [None])[0]

        if not pr_url:
            self._json_response(400, {"error": "missing_param", "message": "prUrl query parameter required"})
            return

        print(f"  [ADO] Fetching PR diff: {pr_url}")
        try:
            result = _fetch_pr_diff(pr_url)
            print(f"  [ADO] PR #{result['prId']}: {result['filesDiffed']} files diffed, "
                  f"+{result['linesAdded']}/-{result['linesRemoved']}, "
                  f"{len(result['diff'])} chars")
            if result["skippedFiles"]:
                print(f"  [ADO] Skipped: {[s['path'] for s in result['skippedFiles']]}")
            self._json_response(200, result)
        except ValueError as e:
            self._json_response(400, {"error": "invalid_pr_url", "message": str(e)})
        except RuntimeError as e:
            self._json_response(502, {"error": "ado_api_error", "message": str(e)})
        except urllib.error.HTTPError as e:
            status = 502 if e.code >= 500 else (401 if e.code in (401, 403) else 502)
            self._json_response(status, {"error": f"ado_http_{e.code}", "message": f"ADO returned {e.code}: {e.reason}"})
        except urllib.error.URLError as e:
            self._json_response(502, {"error": "ado_unreachable", "message": f"Cannot reach ADO: {e.reason}"})
        except subprocess.TimeoutExpired:
            self._json_response(504, {"error": "az_cli_timeout", "message": "Azure CLI timed out acquiring ADO token"})
        except TimeoutError:
            self._json_response(504, {"error": "ado_timeout", "message": "ADO API request timed out"})
        except Exception as e:
            print(f"  [ADO] Error: {e}")
            self._json_response(500, {"error": "internal_error", "message": str(e)})

    def _serve_openai_proxy(self):
        """POST /api/openai-proxy/chat — proxy to Azure OpenAI Responses API.

        Accepts Chat Completions format from C# callers and translates to the
        Responses API format (``/openai/responses``).  Translates the response
        back to Chat Completions shape so callers don't need to change.
        """
        global _openai_config
        if not _openai_config:
            _openai_config = _load_openai_config()
        if not _openai_config:
            self._json_response(503, {"error": "openai_not_configured",
                                      "message": "Azure OpenAI credentials not found in env or donna-app/.env"})
            return

        content_length = int(self.headers.get("Content-Length", 0))
        raw_body = self.rfile.read(content_length)

        cfg = _openai_config
        url = f"{cfg['endpoint'].rstrip('/')}/openai/responses?api-version={cfg['api_version']}"

        # Translate Chat Completions request → Responses API request
        try:
            chat_req = json.loads(raw_body)
        except json.JSONDecodeError as e:
            self._json_response(400, {"error": "invalid_json", "message": str(e)})
            return

        # Convert messages → input (system→developer, rest stay same)
        messages = chat_req.get("messages", [])
        resp_input = []
        for msg in messages:
            role = msg.get("role", "user")
            if role == "system":
                role = "developer"
            resp_input.append({"role": role, "content": msg.get("content", "")})

        resp_body_req: dict = {
            "model": cfg["deployment"],
            "input": resp_input,
        }

        # max_tokens / max_completion_tokens → max_output_tokens
        max_tok = chat_req.get("max_completion_tokens") or chat_req.get("max_tokens")
        if max_tok:
            resp_body_req["max_output_tokens"] = max_tok

        # response_format → text.format
        rf = chat_req.get("response_format")
        if rf:
            resp_body_req["text"] = {"format": rf}

        out_body = json.dumps(resp_body_req).encode()

        print(f"  [OpenAI] Proxying via Responses API → {cfg['endpoint']} / {cfg['deployment']}")
        req = urllib.request.Request(
            url, data=out_body, method="POST",
            headers={"Content-Type": "application/json", "api-key": cfg["api_key"]},
        )
        try:
            ctx = ssl.create_default_context()
            with urllib.request.urlopen(req, timeout=300, context=ctx) as resp:
                resp_data = json.loads(resp.read())

            # Translate Responses API response → Chat Completions response
            content_text = ""
            for item in resp_data.get("output", []):
                if item.get("type") == "message":
                    for c in item.get("content", []):
                        if c.get("type") == "output_text":
                            content_text = c.get("text", "")
                            break
                    if content_text:
                        break

            usage = resp_data.get("usage", {})
            chat_resp = {
                "id": resp_data.get("id", ""),
                "object": "chat.completion",
                "model": resp_data.get("model", cfg["deployment"]),
                "choices": [{
                    "index": 0,
                    "message": {"role": "assistant", "content": content_text},
                    "finish_reason": "stop",
                }],
                "usage": {
                    "prompt_tokens": usage.get("input_tokens", 0),
                    "completion_tokens": usage.get("output_tokens", 0),
                    "total_tokens": usage.get("total_tokens", 0),
                },
            }
            chat_resp_bytes = json.dumps(chat_resp).encode()

            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(chat_resp_bytes)))
            self._cors_headers()
            self.end_headers()
            self.wfile.write(chat_resp_bytes)
        except urllib.error.HTTPError as e:
            err_body = e.read().decode("utf-8", errors="replace")[:2000]
            print(f"  [OpenAI] API error {e.code}: {err_body[:200]}")
            self._json_response(e.code, {"error": f"openai_api_{e.code}", "message": err_body})
        except urllib.error.URLError as e:
            self._json_response(502, {"error": "openai_unreachable", "message": str(e.reason)})
        except TimeoutError:
            self._json_response(504, {"error": "openai_timeout", "message": "Azure OpenAI request timed out (300s)"})
        except Exception as e:
            print(f"  [OpenAI] Error: {e}")
            self._json_response(500, {"error": "openai_proxy_error", "message": str(e)})

    def _serve_studio_status(self):
        """GET /api/studio/status — authoritative studio phase.

        Auto-corrects stale state: if phase is 'deploying' but no deploy
        thread is running, or 'running' but FLT process is dead, fix it.
        """
        with _studio_lock:
            # Auto-correct: deploying but no active pipeline → reset to idle
            if _studio_state["phase"] == "deploying":
                # Check if deploy thread is actually running
                start_time = _studio_state.get("deployStartTime", 0)
                # If deploy started >5min ago and still "deploying", it's stale
                if start_time and (time.time() - start_time) > 900:
                    _studio_state.update({"phase": "idle", "deployId": None})

            # Auto-correct: running but FLT process is dead → crashed
            if _studio_state["phase"] == "running" and _flt_process and _flt_process.poll() is not None:
                _studio_state.update(
                    {
                        "phase": "crashed",
                        "deployError": f"FLT exited with code {_flt_process.returncode}",
                    }
                )

            # Auto-correct: running but no FLT process reference → idle
            if _studio_state["phase"] == "running" and _flt_process is None:
                _studio_state.update({"phase": "idle"})

            state = dict(_studio_state)
            state["deployLogs"] = list(_studio_state["deployLogs"][-200:])
            if _file_watcher and _file_watcher.is_active():
                fc = _file_watcher.get_changes()
                state["fileChanges"] = fc["files"]
                state["fileChangesVersion"] = fc["version"]
            else:
                state["fileChanges"] = []
                state["fileChangesVersion"] = 0
        self._json_response(200, state)

    def _serve_file_changes(self):
        """GET /api/studio/file-changes — return changed files since deploy."""
        if _file_watcher and _file_watcher.is_active():
            result = _file_watcher.get_changes()
        else:
            result = {"files": [], "version": 0}
        self._json_response(200, result)

    def _serve_file_changes_dismiss(self):
        """POST /api/studio/file-changes/dismiss — acknowledge changes through version."""
        try:
            content_length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(content_length)) if content_length else {}
            version = body.get("version", 0)
        except (json.JSONDecodeError, ValueError):
            version = 0
        if _file_watcher:
            _file_watcher.dismiss(version)
        self._json_response(200, {"ok": True})

    def _serve_feedback(self):
        """POST /api/studio/feedback — create GitHub issue via gh CLI."""
        import shutil

        try:
            content_length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(content_length)) if content_length else {}
        except (json.JSONDecodeError, ValueError):
            self._json_response(400, {"error": "Invalid JSON"})
            return

        title = (body.get("title") or "").strip()
        if not title:
            self._json_response(400, {"error": "Title is required"})
            return

        description = (body.get("body") or "").strip()
        repo = "guptahemant65/edog-studio"

        gh = shutil.which("gh")
        if not gh:
            self._json_response(503, {"error": "gh CLI not found"})
            return

        cmd = [gh, "issue", "create", "--repo", repo, "--title", title]
        if description:
            cmd.extend(["--body", description])
        else:
            cmd.extend(["--body", "(No description provided)"])

        try:
            result = subprocess.run(
                cmd, capture_output=True, text=True, timeout=15
            )
            if result.returncode == 0:
                url = result.stdout.strip()
                # Extract issue number from URL like https://github.com/.../issues/42
                issue_number = None
                if "/issues/" in url:
                    try:
                        issue_number = int(url.rsplit("/issues/", 1)[1])
                    except (ValueError, IndexError):
                        pass
                self._json_response(200, {
                    "ok": True,
                    "issueUrl": url,
                    "issueNumber": issue_number,
                })
            else:
                logger.warning("gh issue create failed: %s", result.stderr)
                self._json_response(502, {"error": "gh issue create failed", "detail": result.stderr.strip()})
        except subprocess.TimeoutExpired:
            self._json_response(504, {"error": "gh CLI timed out"})
        except Exception as exc:
            logger.warning("Feedback error: %s", exc)
            self._json_response(500, {"error": str(exc)})

    # ── Template CRUD ──────────────────────────────────────────────

    def _get_templates_path(self) -> Path:
        return Path(__file__).parent.parent / "data" / "edog-templates.json"

    def _read_templates(self) -> dict:
        path = self._get_templates_path()
        if not path.exists():
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps({"version": "1.0", "templates": []}, indent=2))
        return json.loads(path.read_text())

    def _write_templates(self, data: dict) -> None:
        path = self._get_templates_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data, indent=2))

    def _serve_templates_list(self):
        """GET /api/templates — list all saved template summaries."""
        data = self._read_templates()
        summaries = []
        for t in data.get("templates", []):
            summaries.append(
                {
                    "id": t["id"],
                    "name": t["name"],
                    "description": t.get("description", ""),
                    "createdAt": t["createdAt"],
                    "updatedAt": t.get("updatedAt", t["createdAt"]),
                    "nodeCount": len(t.get("state", {}).get("nodes", [])),
                    "theme": t.get("state", {}).get("theme", ""),
                }
            )
        self._json_response(200, {"templates": summaries})

    def _serve_template_get(self):
        """GET /api/templates/<id> — return a single template with full state."""
        template_id = self.path.split("/api/templates/")[1]
        data = self._read_templates()
        for t in data.get("templates", []):
            if t["id"] == template_id:
                self._json_response(200, t)
                return
        self._json_response(404, {"error": "Template not found"})

    def _serve_template_save(self):
        """POST /api/templates — save a new template."""
        body_len = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(body_len)) if body_len > 0 else {}

        name = body.get("name", "").strip()
        if not name:
            self._json_response(400, {"error": "Template name is required"})
            return

        now = datetime.utcnow().isoformat() + "Z"
        template_id = "tpl-" + str(int(time.time() * 1000))

        template = {
            "id": template_id,
            "name": name,
            "description": body.get("description", ""),
            "createdAt": now,
            "updatedAt": now,
            "state": body.get("state", {}),
        }

        data = self._read_templates()
        data["templates"].append(template)
        self._write_templates(data)

        self._json_response(201, {"id": template_id, "name": name, "savedAt": now, "success": True})

    def _serve_template_delete(self):
        """DELETE /api/templates/<id> — remove a template."""
        template_id = self.path.split("/api/templates/")[1]
        data = self._read_templates()
        original_count = len(data.get("templates", []))
        data["templates"] = [t for t in data.get("templates", []) if t["id"] != template_id]
        if len(data["templates"]) == original_count:
            self._json_response(404, {"error": "Template not found"})
            return
        self._write_templates(data)
        self._json_response(200, {"success": True, "deleted": template_id})

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
        ws_name = body.get("workspaceName", "")
        force = body.get("force", False)

        if not all([ws_id, lh_id]):
            self._json_response(
                400,
                {
                    "error": "missing_params",
                    "message": "workspaceId and artifactId required",
                },
            )
            return

        with _studio_lock:
            phase = _studio_state["phase"]
            current_target = _studio_state.get("deployTarget")

            # Block if deploy is actively running
            if phase == "deploying":
                self._json_response(
                    409,
                    {
                        "error": "deploy_in_progress",
                        "message": "A deployment is already in progress",
                    },
                )
                return

            # If running/crashed on a DIFFERENT lakehouse, require confirmation
            if phase in ("running", "crashed") and current_target and not force:
                current_lh = current_target.get("artifactId", "")
                if current_lh and current_lh != lh_id:
                    self._json_response(
                        409,
                        {
                            "error": "already_deployed",
                            "message": f"Currently deployed to {current_target.get('lakehouseName', current_lh)}",
                            "currentTarget": current_target,
                        },
                    )
                    return

        _stop_file_watcher()

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
            _studio_state.update(
                {
                    "phase": "deploying",
                    "deployId": deploy_id,
                    "deployStep": 0,
                    "deployTotal": 5,
                    "deployMessage": "Starting deploy...",
                    "deployError": None,
                    "deployLogs": [],
                    "deployTarget": {
                        "workspaceId": ws_id,
                        "artifactId": lh_id,
                        "capacityId": cap_id,
                        "lakehouseName": lh_name,
                        "workspaceName": ws_name,
                    },
                    "deployStartTime": time.time(),
                    "fltPort": None,
                    "fltPid": None,
                }
            )

        t = threading.Thread(
            target=_run_deploy_pipeline,
            args=(deploy_id, ws_id, lh_id, cap_id),
            daemon=True,
        )
        t.start()
        self._json_response(200, {"ok": True, "deployId": deploy_id})

    def _serve_deploy_cancel(self):
        """POST /api/command/deploy-cancel."""
        _deploy_cancel.set()
        self._json_response(200, {"ok": True})

    def _serve_undeploy(self):
        """POST /api/command/undeploy — stop FLT service + revert patches."""
        _stop_file_watcher()
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

        # Clean up injected DevMode token before reverting code
        _cleanup_devmode_token()

        # Revert code changes (restore FLT source to clean state)
        try:
            import sys as _sys

            result = subprocess.run(
                [_sys.executable, str(PROJECT_DIR / "edog.py"), "--revert"],
                capture_output=True,
                text=True,
                timeout=30,
                encoding="utf-8",
                errors="replace",
            )
            reverted = result.returncode == 0
            if reverted:
                _deploy_log("Code changes reverted", "success")
        except Exception as e:
            _deploy_log(f"Revert failed: {e}", "warn")
            reverted = False

        with _studio_lock:
            target_name = ""
            if _studio_state.get("deployTarget"):
                target_name = _studio_state["deployTarget"].get("lakehouseName", "")
            _studio_state.update(
                {
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
                }
            )

        self._json_response(200, {"ok": True, "stopped": stopped, "reverted": reverted, "lakehouse": target_name})

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
            with contextlib.suppress(ValueError):
                last_idx = int(last_event_id)

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
                # NOTE: step/message/error are snapshot values at read time,
                # not the step that was active when this log was produced.
                # Known limitation — acceptable for now.
                data = json.dumps(
                    {
                        "step": step,
                        "total": total,
                        "status": phase,
                        "message": msg,
                        "error": err,
                        "log": log_entry,
                        "fltPort": flt_port,
                    }
                )
                try:
                    self.wfile.write(f"id: {event_id}\ndata: {data}\n\n".encode())
                    self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError):
                    return
            last_idx += len(logs)

            if phase in ("running", "crashed", "stopped"):
                final = json.dumps(
                    {
                        "step": step,
                        "total": total,
                        "status": phase,
                        "message": msg,
                        "error": err,
                        "fltPort": flt_port,
                    }
                )
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

    def _proxy_to_log_server(self, method="GET"):
        """Proxy request to the EDOG log server running inside FLT on localhost."""
        with _studio_lock:
            port = _studio_state.get("fltPort")
        if not port:
            self._json_response(503, {"error": "flt_not_running", "message": "FLT service not running"})
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
            auth = self.headers.get("Authorization")
            if auth:
                req.add_header("Authorization", auth)

            with urllib.request.urlopen(req, timeout=10) as resp:
                resp_body = resp.read()
                self.send_response(resp.status)
                self.send_header("Content-Type", resp.headers.get("Content-Type", "application/json"))
                self.send_header("Content-Length", str(len(resp_body)))
                self.end_headers()
                self.wfile.write(resp_body)
        except urllib.error.HTTPError as e:
            self._json_response(e.code, {"error": "log_proxy_error", "message": str(e)})
        except Exception as e:
            self._json_response(502, {"error": "log_proxy_error", "message": str(e)})

    def _proxy_to_flt(self, method="GET"):
        """Proxy REST request to FLT service through Fabric capacity endpoint.

        FLT API controllers are only accessible through the Fabric infrastructure,
        not via localhost. The proxy generates an MWC token on-demand and routes
        through: https://{host}/webapi/capacities/{capId}/workloads/LiveTable/
        LiveTableService/automatic/v1/workspaces/{wsId}/lakehouses/{artId}{path}
        """
        # Read config for workspace/artifact/capacity IDs
        cfg = json.loads(CONFIG_PATH.read_text()) if CONFIG_PATH.exists() else {}
        ws_id = cfg.get("workspace_id", "")
        art_id = cfg.get("artifact_id", "")
        cap_id = cfg.get("capacity_id", "")
        if not ws_id or not art_id or not cap_id:
            self._json_response(
                503,
                {
                    "error": "flt_not_configured",
                    "message": "Missing workspace/artifact/capacity IDs in config",
                },
            )
            return

        bearer, _ = _read_cache(BEARER_CACHE)
        if not bearer:
            self._json_response(401, {"error": "no_bearer", "message": "No bearer token available"})
            return

        # Strip /api/flt-proxy prefix to get the controller-relative path
        flt_path = self.path
        if flt_path.startswith("/api/flt-proxy/"):
            flt_path = flt_path[len("/api/flt-proxy"):]

        try:
            mwc_token, host = _get_mwc_token(bearer, ws_id, art_id, cap_id)
        except Exception as e:
            self._json_response(502, {"error": "mwc_token_error", "message": str(e)})
            return

        # Build full capacity endpoint URL
        target_url = (
            f"{host}/webapi/capacities/{cap_id}/workloads/LiveTable"
            f"/LiveTableService/automatic"
            f"/v1/workspaces/{ws_id}/lakehouses/{art_id}{flt_path}"
        )

        try:
            body = None
            if method in ("POST", "PUT", "PATCH"):
                cl = int(self.headers.get("Content-Length", 0))
                body = self.rfile.read(cl) if cl else None

            req = urllib.request.Request(target_url, data=body, method=method)
            ct = self.headers.get("Content-Type")
            if ct:
                req.add_header("Content-Type", ct)
            req.add_header("Authorization", f"MwcToken {mwc_token}")

            ctx = ssl.create_default_context()
            with urllib.request.urlopen(req, timeout=30, context=ctx) as resp:
                resp_body = resp.read()
                self.send_response(resp.status)
                self.send_header("Content-Type", resp.headers.get("Content-Type", "application/json"))
                self.send_header("Content-Length", str(len(resp_body)))
                # Forward pagination token for paginated FLT endpoints
                cont_token = resp.headers.get("x-ms-continuation-token")
                if cont_token:
                    self.send_header("x-ms-continuation-token", cont_token)
                    self.send_header("Access-Control-Expose-Headers", "x-ms-continuation-token")
                self.end_headers()
                self.wfile.write(resp_body)
        except urllib.error.HTTPError as e:
            err_body = ""
            try:
                err_body = e.read().decode("utf-8", errors="replace")[:500]
            except Exception:
                pass
            self._json_response(e.code, {"error": "flt_proxy_error", "message": str(e), "detail": err_body})
        except Exception as e:
            self._json_response(502, {"error": "flt_proxy_error", "message": str(e)})

    def _serve_playground_catalog(self):
        """F09 API Playground — return the dynamically-extracted FLT API catalog.

        Reads flt_repo_path from config, scans the C# controllers, returns
        a JSON-serialized catalog. Results are cached by the max mtime of
        the Controllers directory tree, so repeat panel-opens are O(stat),
        and adding/editing a controller file invalidates the cache naturally.

        Response shapes:
          200  {endpoints, groups, source, extractedAt, warnings, stats}
          404  {error: "flt-not-configured", message: ...}   when no flt_repo_path
          500  {error: "extraction-failed", message: ...}    on unexpected error
        """
        flt_repo = _get_flt_repo_dir()
        if not flt_repo:
            self._json_response(
                404,
                {
                    "error": "flt-not-configured",
                    "message": (
                        "flt_repo_path is not set in edog-config.json. "
                        "Frontend should fall back to the bundled catalog."
                    ),
                },
            )
            return

        try:
            current_mtime = controllers_dir_mtime(flt_repo)
        except Exception as exc:
            self._json_response(
                500,
                {"error": "extraction-failed", "message": f"mtime probe failed: {exc}"},
            )
            return

        if current_mtime is None:
            self._json_response(
                404,
                {
                    "error": "flt-controllers-not-found",
                    "message": (
                        f"Controllers directory not found under {flt_repo}. "
                        f"Expected: Service/Microsoft.LiveTable.Service/Controllers/"
                    ),
                },
            )
            return

        # Cache lookup (read-only fast path).
        with _playground_catalog_lock:
            cached = _playground_catalog_cache.get(flt_repo)
            if cached and cached["mtime"] >= current_mtime:
                self._json_response(200, cached["payload"])
                return

        # Cache miss — extract under lock to avoid two concurrent scans of the
        # same repo. The lock is held during a typically-fast extraction (~tens
        # of ms for 5-10 controllers); acceptable for the playground use case.
        try:
            with _playground_catalog_lock:
                # Re-check after acquiring the lock — another thread may have
                # populated the cache while we were waiting.
                cached = _playground_catalog_cache.get(flt_repo)
                if cached and cached["mtime"] >= current_mtime:
                    self._json_response(200, cached["payload"])
                    return
                payload = extract_catalog(flt_repo)
                _playground_catalog_cache[flt_repo] = {
                    "mtime": current_mtime,
                    "payload": payload,
                }
        except Exception as exc:
            self._json_response(
                500,
                {"error": "extraction-failed", "message": str(exc)},
            )
            return

        self._json_response(200, payload)

    def _serve_playground_dispatch(self):
        """Dispatcher for the F09 API Playground with custom header forwarding.

        Decoupled from _proxy_fabric and _proxy_to_flt so playground-only
        sanitization concerns don't pollute DAG Studio's request path.

        Envelope:
          IN:  {tokenType, method, path, headers, body, timeout}
          OUT: {status, statusText, headers, body, duration, bodySize, truncated}

        Discriminator rule:
          - Upstream returned anything (incl. 5xx) -> HTTP 200, envelope carries details
          - We couldn't proxy (validation, token, transport) -> HTTP 4xx/5xx + {error,message}
        """
        # Read request body
        try:
            cl = int(self.headers.get("Content-Length", 0))
            raw = self.rfile.read(cl) if cl else b""
            envelope = json.loads(raw.decode("utf-8", errors="replace")) if raw else {}
        except (ValueError, json.JSONDecodeError) as e:
            self._json_response(400, {"error": "bad_request", "message": f"invalid JSON: {e}"})
            return

        ok, parsed = _validate_playground_envelope(envelope)
        if not ok:
            status = {
                "body_too_large": 413,
                "invalid_path": 400,
                "bad_header": 400,
                "bad_request": 400,
            }.get(parsed.get("error"), 400)
            self._json_response(status, parsed)
            return

        token_type = parsed["tokenType"]
        method = parsed["method"]
        path = parsed["path"]
        sanitized_headers = parsed["headers"]
        body = parsed["body"]
        timeout = parsed["timeout"]

        # Resolve token + compose upstream URL per tokenType
        bearer, _ = _read_cache(BEARER_CACHE)
        if not bearer:
            self._json_response(401, {"error": "no_token", "message": "Bearer cache empty — re-auth required"})
            return

        if token_type == "bearer":
            target_url = _compose_playground_bearer_url(path)
            auth_header_value = f"Bearer {bearer}"
        else:  # mwc
            cfg = json.loads(CONFIG_PATH.read_text()) if CONFIG_PATH.exists() else {}
            ws_id = cfg.get("workspace_id", "")
            art_id = cfg.get("artifact_id", "")
            cap_id = cfg.get("capacity_id", "")
            if not ws_id or not art_id or not cap_id:
                self._json_response(
                    503,
                    {"error": "flt_not_configured", "message": "Missing workspace/artifact/capacity IDs"},
                )
                return
            try:
                mwc_token, host = _get_mwc_token(bearer, ws_id, art_id, cap_id)
            except Exception as e:
                self._json_response(502, {"error": "mwc_token_error", "message": str(e)})
                return
            target_url = (
                f"{host}/webapi/capacities/{cap_id}/workloads/LiveTable"
                f"/LiveTableService/automatic/v1/workspaces/{ws_id}/lakehouses/{art_id}{path}"
            )
            auth_header_value = f"MwcToken {mwc_token}"

        # Build upstream request
        try:
            req = urllib.request.Request(target_url, data=body, method=method)
            for name, value in sanitized_headers.items():
                req.add_header(name, value)
            # Ensure Content-Type defaults for body-bearing methods if client didn't set one
            if body is not None and not any(k.lower() == "content-type" for k in sanitized_headers):
                req.add_header("Content-Type", "application/json")
            req.add_header("Authorization", auth_header_value)
        except Exception as e:
            self._json_response(400, {"error": "bad_request", "message": f"failed to build request: {e}"})
            return

        # Dispatch
        ctx = ssl.create_default_context()
        t0 = time.time()
        upstream_status = 0
        upstream_reason = ""
        upstream_headers_list = []
        upstream_body = b""
        try:
            with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
                upstream_status = resp.status
                upstream_reason = resp.reason or ""
                upstream_headers_list = list(resp.headers.items())
                upstream_body = resp.read(_PLAYGROUND_MAX_RESPONSE_BODY_BYTES + 1)
        except urllib.error.HTTPError as e:
            # Upstream returned non-2xx — that's data, not dispatcher failure
            upstream_status = e.code
            upstream_reason = e.reason or ""
            try:
                upstream_headers_list = list(e.headers.items()) if e.headers else []
            except Exception:
                upstream_headers_list = []
            try:
                upstream_body = e.read(_PLAYGROUND_MAX_RESPONSE_BODY_BYTES + 1) or b""
            except Exception:
                upstream_body = b""
        except (TimeoutError, urllib.error.URLError) as e:
            elapsed = int((time.time() - t0) * 1000)
            reason = getattr(e, "reason", e)
            print(f"[PLAYGROUND-ERR] upstream_timeout: {reason} ({elapsed}ms)")
            self._json_response(
                504,
                {"error": "upstream_timeout", "message": f"upstream did not respond within {timeout}s: {reason}"},
            )
            return
        except Exception as e:
            print(f"[PLAYGROUND-ERR] transport: {e}")
            self._json_response(502, {"error": "upstream_error", "message": str(e)})
            return

        duration_ms = int((time.time() - t0) * 1000)
        truncated = len(upstream_body) > _PLAYGROUND_MAX_RESPONSE_BODY_BYTES
        if truncated:
            upstream_body = upstream_body[:_PLAYGROUND_MAX_RESPONSE_BODY_BYTES]

        # Build response envelope
        headers_dict = {}
        for hname, hvalue in upstream_headers_list:
            # Last-write-wins for duplicates (matches HTTP intuition for view purposes)
            headers_dict[hname] = hvalue

        envelope_out = {
            "status": upstream_status,
            "statusText": upstream_reason,
            "headers": headers_dict,
            "body": upstream_body.decode("utf-8", errors="replace"),
            "duration": duration_ms,
            "bodySize": len(upstream_body),
            "truncated": truncated,
        }
        print(f"[PLAYGROUND] {token_type} {method} {path} -> {upstream_status} ({duration_ms}ms, {len(upstream_body)}B)")
        self._json_response(200, envelope_out)

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
                capture_output=True,
                text=True,
                timeout=10,
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
                capture_output=True,
                text=True,
                timeout=10,
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
            self._json_response(
                404,
                {
                    "error": f"No certificate found for {cert_cn}",
                    "help": "https://dev.azure.com/powerbi/Trident/_wiki/wikis/Trident.wiki/80942/PPE-Ephemeral-Tenants-(ES-Maintained-Rotated)",
                },
            )
            return

        # Run Silent CBA
        try:
            result = subprocess.run(
                [str(helper), thumbprint, username],
                capture_output=True,
                text=True,
                timeout=30,
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

                # Sync username into edog-config.json so deploy uses the right tenant
                try:
                    cfg = json.loads(CONFIG_PATH.read_text()) if CONFIG_PATH.exists() else {}
                    if cfg.get("username") != upn:
                        cfg["username"] = upn
                        _atomic_write(CONFIG_PATH, json.dumps(cfg, indent=2))
                except Exception:
                    pass

                self._json_response(
                    200,
                    {
                        "token": token,
                        "username": upn,
                        "expiresIn": int(expiry - time.time()),
                    },
                )
            else:
                self._json_response(401, {"error": "Authentication failed", "detail": result.stderr.strip()[:300]})
        except subprocess.TimeoutExpired:
            self._json_response(504, {"error": "Authentication timed out (30s)"})

    def _serve_health(self):
        """Pre-flight health check."""
        bearer, bearer_exp = _read_cache(BEARER_CACHE)
        session = _load_session()
        helper = PROJECT_DIR / "scripts" / "token-helper" / "bin" / "Debug" / "net8.0" / "token-helper.exe"
        if not helper.exists():
            helper = PROJECT_DIR / "scripts" / "token-helper" / "bin" / "Debug" / "net472" / "token-helper.exe"

        # FLT repo status via shared discovery module
        cfg = {}
        with contextlib.suppress(Exception):
            cfg = json.loads(CONFIG_PATH.read_text()) if CONFIG_PATH.exists() else {}
        repo_info = get_configured_repo(cfg)
        if repo_info and repo_info["valid"]:
            flt_repo_resp = {
                "configured": True,
                "valid": True,
                "path": repo_info["path"],
            }
            git_branch = repo_info.get("gitBranch", "")
            git_dirty = repo_info.get("gitDirty", 0)
        else:
            flt_repo_resp = {
                "configured": repo_info is not None,
                "valid": False,
                "path": repo_info["path"] if repo_info else "",
                "reason": repo_info["reason"] if repo_info else "not_configured",
            }
            git_branch = ""
            git_dirty = 0

        self._json_response(
            200,
            {
                "tokenHelperBuilt": helper.exists(),
                "hasBearerToken": bearer is not None,
                "bearerExpiresIn": int(bearer_exp - time.time()) if bearer_exp else 0,
                "lastUsername": session.get("lastUsername", ""),
                "gitBranch": git_branch,
                "gitDirtyFiles": git_dirty,
                "fltRepo": flt_repo_resp,
            },
        )

    def _serve_repo_scan(self):
        """POST /api/edog/repo-scan — auto-detect FLT repos on disk."""
        result = find_flt_repos(max_depth=4, limit=10, timeout_sec=5.0)
        self._json_response(200, result)

    def _serve_repo_set(self):
        """POST /api/edog/repo-set — validate and persist FLT repo path."""
        try:
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length)) if length else {}
        except (json.JSONDecodeError, ValueError):
            self._json_response(400, {"error": "invalid_json"})
            return

        path = body.get("path", "")
        if not path:
            self._json_response(400, {"error": "missing_path"})
            return

        info = validate_repo(path)
        if not info["valid"]:
            self._json_response(
                400,
                {"error": "invalid_repo", "reason": info["reason"], "path": info["path"]},
            )
            return

        # Persist to config
        try:
            cfg = json.loads(CONFIG_PATH.read_text()) if CONFIG_PATH.exists() else {}
        except Exception:
            cfg = {}
        cfg["flt_repo_path"] = info["path"]
        _atomic_write(CONFIG_PATH, json.dumps(cfg, indent=2))

        self._json_response(200, info)

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
            req = urllib.request.Request(
                url,
                headers={
                    "Authorization": f"MwcToken {token}",
                    "x-ms-workload-resource-moniker": lh_id,
                    "Content-Type": "application/json",
                },
                method="GET",
            )
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
            self._json_response(
                400,
                {
                    "error": "missing_params",
                    "message": "wsId, lhId, capId, and tables are required",
                },
            )
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

            self._json_response(
                504,
                {
                    "error": "poll_timeout",
                    "message": f"Operation {operation_id} did not complete in 20s",
                },
            )
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
            self._json_response(400, {"error": "missing_params", "message": "wsId, lhId, and tableName required"})
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
            req = urllib.request.Request(
                list_url,
                headers={
                    "Authorization": f"Bearer {bearer}",
                    "x-ms-version": "2021-06-08",
                },
            )
            with urllib.request.urlopen(req, timeout=10, context=ctx) as resp:
                listing = json.loads(resp.read())

            # Find JSON commit files, sorted by name (version order)
            json_files = sorted(
                [
                    p["name"]
                    for p in listing.get("paths", [])
                    if p["name"].endswith(".json") and not p.get("isDirectory")
                ],
            )

            # Read each commit and accumulate active files
            active_files = {}  # path → {size, numRecords}
            for jf in json_files:
                file_url = f"{onelake_host}/{ws_id}/{jf}"
                req = urllib.request.Request(
                    file_url,
                    headers={
                        "Authorization": f"Bearer {bearer}",
                        "x-ms-version": "2021-06-08",
                    },
                )
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

            self._json_response(
                200,
                {
                    "tableName": table_name,
                    "rowCount": total_rows,
                    "sizeBytes": total_size,
                    "fileCount": len(active_files),
                },
            )
        except urllib.error.HTTPError as e:
            if e.code == 404:
                self._json_response(
                    200,
                    {
                        "tableName": table_name,
                        "rowCount": None,
                        "sizeBytes": None,
                        "error": "delta_log_not_found",
                    },
                )
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
            self._json_response(
                400,
                {
                    "error": "missing_params",
                    "message": "workspaceId, lakehouseId, and capacityId are required",
                },
            )
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
        self._json_response(
            200,
            {
                "token": token,
                "host": host,
                "expiry": cached.get("expiry", 0),
            },
        )

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
                    self._json_response(
                        504,
                        {
                            "error": "lro_timeout",
                            "message": "getDefinition did not complete in 60s",
                        },
                    )
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

            self._json_response(
                200,
                {
                    "content": content_text,
                    "platform": platform_text,
                    "allParts": all_parts,
                },
            )
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
            parts.append(
                {
                    "path": ".platform",
                    "payload": base64.b64encode(platform.encode("utf-8")).decode(),
                    "payloadType": "InlineBase64",
                }
            )

        url = f"{REDIRECT_HOST}/v1/workspaces/{ws_id}/notebooks/{nb_id}/updateDefinition"
        req_body = json.dumps({"definition": {"parts": parts}}).encode()
        print(f"  [NOTEBOOK] POST updateDefinition ws={ws_id[:8]}... nb={nb_id[:8]}...")

        try:
            ctx = ssl.create_default_context()
            req = urllib.request.Request(
                url,
                data=req_body,
                headers={
                    "Authorization": f"Bearer {bearer}",
                    "Content-Type": "application/json",
                },
                method="POST",
            )
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

        url = f"{REDIRECT_HOST}/v1/workspaces/{ws_id}/items/{nb_id}/jobs/instances?jobType=RunNotebook"
        print(f"  [NOTEBOOK] POST run ws={ws_id[:8]}... nb={nb_id[:8]}...")

        try:
            ctx = ssl.create_default_context()
            req = urllib.request.Request(
                url,
                data=b"{}",
                headers={
                    "Authorization": f"Bearer {bearer}",
                    "Content-Type": "application/json",
                },
                method="POST",
            )
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
            req = urllib.request.Request(
                location,
                headers={
                    "Authorization": f"Bearer {bearer}",
                    "Content-Type": "application/json",
                },
                method="GET",
            )
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
            req = urllib.request.Request(
                cancel_url,
                data=b"{}",
                headers={
                    "Authorization": f"Bearer {bearer}",
                    "Content-Type": "application/json",
                },
                method="POST",
            )
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
            self._json_response(
                400,
                {
                    "error": "missing_params",
                    "message": f"wsId, nbId, and capId are required. Got ws={bool(ws_id)} nb={bool(nb_id)} cap={bool(cap_id)}",
                },
            )
            return

        token, cap_host = _resolve_mwc_for_jupyter(cap_id, ws_id, nb_id, lh_id)
        if not token:
            print(f"  [JUPYTER] Rejected: no MWC token for capId={cap_id}")
            self._json_response(
                400,
                {
                    "error": "no_mwc_token",
                    "message": "MWC token not available. Deploy to a lakehouse first to enable cell execution.",
                },
            )
            return
        if not cap_host:
            cap_host = f"https://{cap_id.replace('-', '')}.pbidedicated.windows-int.net"

        base = _jupyter_api_path(cap_id, ws_id, nb_id)
        url = f"{cap_host}{base}/sessions"

        session_body = json.dumps(
            {
                "kernel": {"id": None, "name": "synapse_pyspark"},
                "name": "",
                "path": f"notebooks/{nb_id}.ipynb",
                "type": "notebook",
            }
        ).encode()

        print(f"  [JUPYTER] POST create-session ws={ws_id[:8]}... nb={nb_id[:8]}...")

        try:
            ctx = ssl.create_default_context()
            req = urllib.request.Request(
                url,
                data=session_body,
                headers={
                    "Authorization": f"MwcToken {token}",
                    "Content-Type": "application/json",
                },
                method="POST",
            )
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
            self._json_response(
                200,
                {
                    "kernelId": kernel_id,
                    "sessionId": session_id,
                    "executionState": exec_state,
                    "capHost": cap_host,
                },
            )
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
            self._json_response(
                400,
                {
                    "error": "missing_params",
                    "message": "wsId, nbId, and capId are required",
                },
            )
            return

        token, cap_host = _resolve_mwc_for_jupyter(cap_id, ws_id, nb_id)
        if not token:
            self._json_response(
                400,
                {
                    "error": "no_mwc_token",
                    "message": "MWC token not available.",
                },
            )
            return
        if not cap_host:
            cap_host = f"https://{cap_id.replace('-', '')}.pbidedicated.windows-int.net"

        base = _jupyter_api_path(cap_id, ws_id, nb_id)
        url = f"{cap_host}{base}/kernelspecs"

        print(f"  [JUPYTER] GET kernel-specs ws={ws_id[:8]}... nb={nb_id[:8]}...")

        try:
            ctx = ssl.create_default_context()
            req = urllib.request.Request(
                url,
                headers={
                    "Authorization": f"MwcToken {token}",
                    "Content-Type": "application/json",
                },
                method="GET",
            )
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
            self._json_response(
                400,
                {
                    "error": "missing_params",
                    "message": "wsId, nbId, capId, and code are required",
                },
            )
            return
        if not code.strip():
            self._json_response(400, {"error": "empty_code", "message": "code must not be empty"})
            return

        token, cap_host = _resolve_mwc_for_jupyter(cap_id, ws_id, nb_id, body.get("lhId", ""))
        if not token:
            self._json_response(
                400,
                {
                    "error": "no_mwc_token",
                    "message": "MWC token not available. Deploy to a lakehouse first.",
                },
            )
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
            session_body = json.dumps(
                {
                    "kernel": {"id": None, "name": "synapse_pyspark"},
                    "name": "",
                    "path": f"notebooks/{nb_id}.ipynb",
                    "type": "notebook",
                }
            ).encode()

            print("  [JUPYTER] Auto-creating session for execute-cell...")
            try:
                ctx = ssl.create_default_context()
                req = urllib.request.Request(
                    url,
                    data=session_body,
                    headers={
                        "Authorization": f"MwcToken {token}",
                        "Content-Type": "application/json",
                    },
                    method="POST",
                )
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
        print("  [JUPYTER] Polling session until kernel idle...")
        ctx = ssl.create_default_context()
        kernel_ready = False
        for attempt in range(300):  # Max 10 min (300 x 2s)
            try:
                req = urllib.request.Request(
                    session_url,
                    headers={
                        "Authorization": f"MwcToken {token}",
                    },
                    method="GET",
                )
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
            self._json_response(
                504,
                {
                    "error": "kernel_timeout",
                    "message": "Kernel did not become idle within 10 minutes. Try again.",
                },
            )
            return

        # Step 2: Execute via Jupyter WebSocket protocol
        print(f"  [JUPYTER] Executing cell via WebSocket ({len(code)} chars, lang={language})...")
        try:
            import asyncio

            result = asyncio.run(_jupyter_ws_execute(cap_host, cap_id, ws_id, nb_id, kernel_id, token, code))
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
            self._json_response(
                400,
                {
                    "error": "missing_params",
                    "message": "wsId, nbId, capId, and sessionId are required",
                },
            )
            return

        token, cap_host = _resolve_mwc_for_jupyter(cap_id, ws_id, nb_id, body.get("lhId", ""))
        if not token:
            self._json_response(
                400,
                {
                    "error": "no_mwc_token",
                    "message": "MWC token not available.",
                },
            )
            return
        if not cap_host:
            cap_host = f"https://{cap_id.replace('-', '')}.pbidedicated.windows-int.net"

        base = _jupyter_api_path(cap_id, ws_id, nb_id)
        url = f"{cap_host}{base}/sessions/{session_id}"
        print(f"  [JUPYTER] DELETE session={session_id[:8]}...")

        try:
            ctx = ssl.create_default_context()
            req = urllib.request.Request(
                url,
                headers={
                    "Authorization": f"MwcToken {token}",
                    "Content-Type": "application/json",
                },
                method="DELETE",
            )
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
            "/api/flt/config",
            "/ws/logs",
            "/api/logs",
            "/api/telemetry",
            "/api/stats",
        )
        if any(p in msg for p in quiet_paths):
            return
        super().log_message(format, *args)


if __name__ == "__main__":

    class ThreadedHTTPServer(ThreadingMixIn, HTTPServer):
        """Handle each request in a new thread to avoid blocking on slow MWC calls."""

        daemon_threads = True

    server = ThreadedHTTPServer(("127.0.0.1", 5555), EdogDevHandler)

    # Load Azure OpenAI config for QA LLM proxy
    _openai_config = _load_openai_config()
    if _openai_config:
        print(f"  OpenAI:  {_openai_config['endpoint']} / {_openai_config['deployment']}")
    else:
        print("  OpenAI:  NOT configured (LLM scenarios will be synthetic)")

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
        if _flt_process and _flt_process.poll() is None:
            print(f"  Stopping FLT service (PID: {_flt_process.pid})...")
            _flt_process.terminate()
            try:
                _flt_process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                _flt_process.kill()
            print("  FLT service stopped.")
            # Clean up injected DevMode token
            _cleanup_devmode_token()
            # Revert code changes
            print("  Reverting EDOG patches...")
            try:
                import sys as _sys

                subprocess.run(
                    [_sys.executable, str(PROJECT_DIR / "edog.py"), "--revert"],
                    capture_output=True,
                    text=True,
                    timeout=30,
                    encoding="utf-8",
                    errors="replace",
                )
                print("  Patches reverted.")
            except Exception:
                print("  Revert failed — run: edog --revert")
        server.server_close()
        print("Server stopped.")
