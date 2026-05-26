"""EDOG Dev Server — serves HTML, /api/flt/config, and proxies Fabric API calls.

Proxy strategy (per docs/fabric-api-reference.md):
  - Forward v1 paths as-is to the redirect host (they return clean shapes)
  - Only /workspaces (top-level) uses /metadata/workspaces (for capacityId)
  - Bearer token is attached server-side (avoids CORS)
"""

import base64
import contextlib
import json
import logging
import os
import re
import secrets
import ssl
import subprocess
import sys
import threading
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
import zlib
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from socketserver import ThreadingMixIn

import feature_flags_catalog
import feature_manager_cache
import feature_overrides
from file_watcher import FileWatcher
from flt_catalog import controllers_dir_mtime, extract_catalog, framework_endpoints_mtime
from repo_discovery import (
    find_flt_repos,
    get_configured_repo,
    get_configured_swagger_path,
    validate_repo,
)
from swagger_baseline import load_baseline as _load_swagger_baseline
from swagger_baseline import remove_baseline as _remove_swagger_baseline
from swagger_baseline import save_baseline as _save_swagger_baseline
from swagger_diff_assemble import build_diff_payload as _build_swagger_diff_payload
from swagger_normalize import normalize as _normalize_swagger
from swagger_runtime import fetch_runtime_swagger as _fetch_runtime_swagger

PROJECT_DIR = Path(__file__).parent.parent
CONFIG_PATH = PROJECT_DIR / "edog-config.json"
BEARER_CACHE = PROJECT_DIR / ".edog-bearer-cache"
ONELAKE_BEARER_CACHE = PROJECT_DIR / ".edog-onelake-bearer-cache"
MWC_CACHE = PROJECT_DIR / ".edog-token-cache"
SESSION_FILE = PROJECT_DIR / ".edog-session.json"
HTML_PATH = PROJECT_DIR / "src" / "edog-logs.html"

logger = logging.getLogger(__name__)


def _time_ago(epoch: int) -> str:
    """Return a coarse human-readable relative time (e.g. '3 days ago')."""
    if not epoch:
        return ""
    import time as _t

    delta = max(0, int(_t.time()) - int(epoch))
    if delta < 60:
        return "just now"
    if delta < 3600:
        m = delta // 60
        return f"{m} minute{'s' if m != 1 else ''} ago"
    if delta < 86400:
        h = delta // 3600
        return f"{h} hour{'s' if h != 1 else ''} ago"
    if delta < 86400 * 30:
        d = delta // 86400
        return f"{d} day{'s' if d != 1 else ''} ago"
    if delta < 86400 * 365:
        mo = delta // (86400 * 30)
        return f"{mo} month{'s' if mo != 1 else ''} ago"
    y = delta // (86400 * 365)
    return f"{y} year{'s' if y != 1 else ''} ago"


REDIRECT_HOST = "https://biazure-int-edog-redirect.analysis-df.windows.net"
ONELAKE_HOST = "https://onelake-int-edog.dfs.pbidedicated.windows-int.net"
ONELAKE_RESOURCE = "https://storage.azure.com"
TOKEN_HELPER_CLIENT_ID = "ea0616ba-638b-4df5-95b9-636659ae5121"
TOKEN_HELPER_AUTHORITY = "https://login.windows-ppe.net/organizations"


class CapacityRoutingError(Exception):
    """Raised when the capacity routing layer is not ready (e.g. LiveTable
    workload not yet registered, MWC endpoint returns 404).  The deploy
    warmup loop and proxy handler treat this as a retryable condition."""


# Lock for bearer mint — prevent N parallel mints racing on expiry
_bearer_mint_lock = threading.Lock()
# Lock for OneLake bearer mint — prevent N parallel mints racing on cold start
_onelake_mint_lock = threading.Lock()

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
        with open(CONFIG_PATH, encoding="utf-8") as f:
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
_PLAYGROUND_HEADER_DENYLIST = frozenset(
    {
        "authorization",
        "proxy-authorization",
        "proxy-authenticate",
        "connection",
        "keep-alive",
        "transfer-encoding",
        "te",
        "trailer",
        "upgrade",
        "host",
        "content-length",
        "origin",
        "referer",
        "user-agent",
        "accept-encoding",
        "sec-fetch-site",
        "sec-fetch-mode",
        "sec-fetch-dest",
        "sec-fetch-user",
        "sec-ch-ua",
        "sec-ch-ua-mobile",
        "sec-ch-ua-platform",
        "cookie",
        "set-cookie",
    }
)

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
    "/liveTable",
    "/liveTableSchedule",
    "/liveTableMaintanance",
)

# ── Azure OpenAI Proxy Config ────────────────────────────────────────────
_openai_config: dict = {}  # {"endpoint", "api_key", "api_version", "deployment"}


def _load_openai_config() -> dict:
    """Load Azure OpenAI config from env vars or local .env file."""
    endpoint = os.environ.get("AZURE_OPENAI_PRO_ENDPOINT") or os.environ.get("AZURE_OPENAI_ENDPOINT")
    api_key = os.environ.get("AZURE_OPENAI_PRO_API_KEY") or os.environ.get("AZURE_OPENAI_API_KEY")
    api_version = (
        os.environ.get("AZURE_OPENAI_PRO_API_VERSION")
        or os.environ.get("AZURE_OPENAI_API_VERSION")
        or "2025-04-01-preview"
    )
    deployment = os.environ.get("AZURE_OPENAI_PRO_DEPLOYMENT") or os.environ.get("AZURE_OPENAI_DEPLOYMENT") or "gpt-5.4"

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
            api_version = (
                env_vars.get("AZURE_OPENAI_PRO_API_VERSION") or env_vars.get("AZURE_OPENAI_API_VERSION") or api_version
            )
            deployment = (
                env_vars.get("AZURE_OPENAI_PRO_DEPLOYMENT") or env_vars.get("AZURE_OPENAI_DEPLOYMENT") or deployment
            )

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

# Per-session control token for FLT's override HTTP endpoints. Regenerated
# every dev-server start; written into FLT's env on spawn. Browser never sees
# this value — dev-server adds the X-EDOG-Control-Token header when proxying
# override writes to FLT. See F11/architecture.md §3.7.
EDOG_CONTROL_TOKEN = secrets.token_urlsafe(32)

# Shared FeatureManagement cache. First catalog request kicks off the
# background clone; subsequent requests reuse the in-memory index. See
# feature_manager_cache.py for sync semantics.
_FM_CACHE = feature_manager_cache.FeatureManagementCache()


def _is_edog_patch_warning(line: str) -> bool:
    """True if a deploy stdout line represents an edog.py regex-anchor failure.

    Centralised so the deploy pipeline parser and tests stay in sync.
    """
    if not line:
        return False
    lowered = line.lower()
    return "pattern not found" in lowered or "\u26a0" in line


_studio_state = {
    "phase": "idle",  # idle | deploying | running | crashed | stopped
    "deployId": None,
    "fltPort": None,
    "fltPid": None,
    "deployStep": 0,
    "deployTotal": 5,
    "deployMessage": "",
    "deployError": None,
    # Structured failure classification. When set, the frontend renders a
    # rich error card with mitigation steps instead of the generic banner.
    # Known kinds: "mwc_registration" (DevInstanceRegistrationFailedException).
    "deployErrorKind": None,
    "deployErrorDetail": None,
    "deployLogs": [],
    "deployTarget": None,
    "deployStartTime": None,
    "patchWarnings": [],
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


def _map_path(fabric_path: str, method: str = "GET") -> str:
    """Map browser path to redirect host path.

    Most v1 paths forward as-is — they work on the redirect host.
    Only top-level GET /workspaces needs rewriting to /metadata/workspaces
    because /v1/workspaces returns 401 on the redirect host for listing.
    POST /workspaces (create) must go to /v1/workspaces.
    """
    # Top-level workspace listing (GET only) → use metadata endpoint
    if method == "GET" and (fabric_path == "/workspaces" or fabric_path.startswith("/workspaces?")):
        return fabric_path.replace("/workspaces", "/metadata/workspaces", 1)

    # Everything else: forward v1 path as-is
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
            capture_output=True,
            text=True,
            timeout=30,
            shell=True,
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
    req = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
        },
    )
    ctx = ssl.create_default_context()
    with urllib.request.urlopen(req, context=ctx, timeout=30) as resp:
        content_type = resp.headers.get("Content-Type", "")
        body = resp.read().decode("utf-8")
        if "application/json" in content_type:
            return json.loads(body)
        return body


def _ado_api_get_text(token: str, url: str) -> str:
    """Call an ADO REST API endpoint expecting raw text (file content)."""
    req = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "text/plain",
        },
    )
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
    SKIP_EXTENSIONS = {
        ".dll",
        ".exe",
        ".png",
        ".jpg",
        ".jpeg",
        ".gif",
        ".ico",
        ".woff",
        ".woff2",
        ".ttf",
        ".eot",
        ".zip",
        ".nupkg",
        ".snk",
    }

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

        file_diff = list(
            difflib.unified_diff(base_lines, target_lines, fromfile=from_file, tofile=to_file, lineterm="\n")
        )
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

    response = {
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

    # F27 QA "pinnacle" extras — best-effort PR context for LLM scenario
    # generation. Failures are captured per-field; the diff response above is
    # always returned even if every enrichment field fails.
    try:
        extras = _collect_pr_context_extras(token, base_url, pr_data, change_entries)
        response.update(extras)
    except Exception as exc:
        response["extrasWarnings"] = [f"context_extras_top_level_failed: {exc}"]
        response["description"] = pr_data.get("description") or ""
        response["workItems"] = []
        response["linkedSpecExcerpts"] = []
        response["apiCatalog"] = None
        response["priorTests"] = []

    return response


# ─────────────────────────────────────────────────────────────
# F27 QA Testing — PR context enrichment for LLM scenario gen
# ─────────────────────────────────────────────────────────────

# Per-field caps so enriched response stays bounded.
_PR_DESCRIPTION_MAX = 4000
_WI_AC_MAX_CHARS = 1500
_WI_DESC_MAX_CHARS = 1000
_WI_MAX_COUNT = 5
_SPEC_EXCERPT_MAX_CHARS = 4000
_SPEC_EXCERPT_MAX_COUNT = 3
_CATALOG_ENDPOINT_LIMIT = 50
_PRIOR_TEST_METHOD_LIMIT = 60

_HTML_TAG_RE = re.compile(r"<[^>]+>")
_HTML_ENTITY_MAP = {
    "&nbsp;": " ",
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&#39;": "'",
    "&apos;": "'",
}
_MD_URL_RE = re.compile(r"https?://[^\s)\"'<>]+\.md(?:[?#][^\s)\"'<>]*)?", re.IGNORECASE)
_TEST_METHOD_SIG_RE = re.compile(
    r"\[TestMethod[\s\S]{0,200}?\]\s*(?:\[[^\]]+\]\s*)*"
    r"public\s+(?:async\s+)?(?:Task|void|ValueTask)\s+(\w+)\s*\(",
)


def _strip_html(text: str) -> str:
    """Strip HTML tags and decode common entities from ADO rich-text fields."""
    if not text:
        return ""
    plain = _HTML_TAG_RE.sub("\n", text)
    for entity, replacement in _HTML_ENTITY_MAP.items():
        plain = plain.replace(entity, replacement)
    # Collapse runs of whitespace but preserve paragraph breaks.
    plain = re.sub(r"[ \t]+", " ", plain)
    plain = re.sub(r"\n[ \t]+", "\n", plain)
    plain = re.sub(r"\n{3,}", "\n\n", plain)
    return plain.strip()


def _collect_pr_context_extras(token: str, base_url: str, pr_data: dict, change_entries: list) -> dict:
    """Best-effort PR context for F27 LLM scenario generation.

    Returns a dict with: description, workItems, linkedSpecExcerpts,
    apiCatalog, priorTests, extrasWarnings. Each field is independently
    degraded: failure in one section does NOT prevent the others from
    being returned.

    Token-budget controlled by the module-level caps. The Hub passes
    these straight through to the analyzer; the analyzer's
    BuildUserMessage re-applies its own caps before sending to the LLM.
    """
    extras = {
        "description": "",
        "workItems": [],
        "linkedSpecExcerpts": [],
        "apiCatalog": None,
        "priorTests": [],
        "extrasWarnings": [],
    }

    # 1) Plain-text PR description.
    raw_desc = (pr_data.get("description") or "").strip()
    extras["description"] = raw_desc[:_PR_DESCRIPTION_MAX]
    if len(raw_desc) > _PR_DESCRIPTION_MAX:
        extras["extrasWarnings"].append(f"description_truncated_from_{len(raw_desc)}_chars")

    # 2) Work-item acceptance criteria.
    wi_refs = pr_data.get("workItemRefs") or []
    org_match = re.search(r"https?://dev\.azure\.com/([^/]+)/", base_url)
    org = org_match.group(1) if org_match else None
    for wi_ref in wi_refs[:_WI_MAX_COUNT]:
        wi_id = wi_ref.get("id")
        if not wi_id or not org:
            continue
        try:
            wi_url = (
                f"https://dev.azure.com/{org}/_apis/wit/workitems/{wi_id}"
                "?fields=System.Title,System.State,"
                "Microsoft.VSTS.Common.AcceptanceCriteria,System.Description"
                "&api-version=7.0"
            )
            wi_data = _ado_api_get(token, wi_url)
            fields = wi_data.get("fields", {}) if isinstance(wi_data, dict) else {}
            ac = _strip_html(fields.get("Microsoft.VSTS.Common.AcceptanceCriteria", ""))
            desc = _strip_html(fields.get("System.Description", ""))
            extras["workItems"].append(
                {
                    "id": wi_id,
                    "title": fields.get("System.Title", ""),
                    "state": fields.get("System.State", ""),
                    "acceptanceCriteria": ac[:_WI_AC_MAX_CHARS],
                    "descriptionSnippet": desc[:_WI_DESC_MAX_CHARS],
                }
            )
        except Exception as exc:
            extras["extrasWarnings"].append(f"wi_{wi_id}_fetch_failed: {exc}")

    # 3) Linked spec excerpts — only ADO-hosted .md URLs are auth-reachable.
    try:
        md_urls = _MD_URL_RE.findall(raw_desc or "")
        seen = set()
        for url in md_urls:
            if "dev.azure.com" not in url.lower():
                continue
            if url in seen:
                continue
            seen.add(url)
            if len(extras["linkedSpecExcerpts"]) >= _SPEC_EXCERPT_MAX_COUNT:
                break
            try:
                content = _ado_api_get_text(token, url)
                if content:
                    extras["linkedSpecExcerpts"].append(
                        {
                            "url": url,
                            "content": content[:_SPEC_EXCERPT_MAX_CHARS],
                        }
                    )
            except Exception as exc:
                extras["extrasWarnings"].append(f"spec_fetch_failed_{url[:80]}: {exc}")
    except Exception as exc:
        extras["extrasWarnings"].append(f"linkedSpecs_failed: {exc}")

    # 4) FLT API catalog filtered to changed controllers; 5) prior tests.
    flt_repo_path = ""
    try:
        flt_repo_path = _get_flt_repo_dir()
    except Exception:
        flt_repo_path = ""

    changed_controllers: set = set()
    for entry in change_entries or []:
        item = entry.get("item") or {}
        path = item.get("path") or ""
        base = os.path.basename(path)
        if base.endswith("Controller.cs"):
            changed_controllers.add(base[: -len(".cs")])

    if changed_controllers and flt_repo_path:
        try:
            catalog = extract_catalog(flt_repo_path)
            endpoints = catalog.get("endpoints", []) if isinstance(catalog, dict) else []
            filtered = [ep for ep in endpoints if ep.get("controller") in changed_controllers]
            if filtered:
                extras["apiCatalog"] = {
                    "controllers": sorted(changed_controllers),
                    "endpoints": filtered[:_CATALOG_ENDPOINT_LIMIT],
                    "truncated": len(filtered) > _CATALOG_ENDPOINT_LIMIT,
                }
        except Exception as exc:
            extras["extrasWarnings"].append(f"catalog_failed: {exc}")

        try:
            test_root = Path(flt_repo_path) / "test"
            if test_root.is_dir():
                for ctrl in sorted(changed_controllers):
                    target = f"{ctrl}Tests.cs"
                    for hit in test_root.rglob(target):
                        try:
                            text = hit.read_text(encoding="utf-8", errors="ignore")
                            methods = _TEST_METHOD_SIG_RE.findall(text)
                            if methods:
                                rel = hit.relative_to(flt_repo_path).as_posix()
                                extras["priorTests"].append(
                                    {
                                        "file": rel,
                                        "controller": ctrl,
                                        "methods": methods[:_PRIOR_TEST_METHOD_LIMIT],
                                        "totalMethods": len(methods),
                                    }
                                )
                        except Exception as exc:
                            extras["extrasWarnings"].append(f"prior_test_read_failed_{hit.name}: {exc}")
                        break  # one canonical test file per controller
        except Exception as exc:
            extras["extrasWarnings"].append(f"prior_tests_failed: {exc}")
    elif changed_controllers and not flt_repo_path:
        extras["extrasWarnings"].append("catalog_and_prior_tests_skipped: flt_repo_path_not_configured")

    return extras


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
        if cached and time.time() < cached["expiry"] - 300 and cached.get("bearer") == bearer:
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
    try:
        with urllib.request.urlopen(req, timeout=30, context=ctx) as resp:
            resp_data = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        err_body = ""
        with contextlib.suppress(Exception):
            err_body = e.read().decode("utf-8", errors="replace")[:500]
        if e.code == 404:
            raise CapacityRoutingError(
                f"LiveTable workload not registered on capacity {cap_id}. "
                f"MWC token endpoint returned 404 EndpointNotFound."
            ) from e
        if e.code in (401, 403):
            raise urllib.error.HTTPError(
                e.url,
                e.code,
                f"Bearer token rejected (HTTP {e.code}) — re-authenticate. {err_body}",
                e.headers,
                None,
            ) from e
        raise

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
        _mwc_cache[cache_key] = {"token": token, "host": host, "expiry": expiry, "bearer": bearer}
    remaining = int((expiry - time.time()) / 60)
    print(f"  [MWC] Token cached, expires in {remaining} min")
    return token, host


def _capacity_base_path(cap_id: str, ws_id: str) -> str:
    """Build the MWC API base path for a capacity/workspace pair."""
    return f"/webapi/capacities/{cap_id}/workloads/Lakehouse/LakehouseService/automatic/v1/workspaces/{ws_id}"


def _find_token_helper() -> Path | None:
    """Locate the compiled token-helper.exe, preferring net8.0 then net472."""
    base = PROJECT_DIR / "scripts" / "token-helper" / "bin" / "Debug"
    for tfm in ("net8.0", "net472"):
        candidate = base / tfm / "token-helper.exe"
        if candidate.exists():
            return candidate
    return None


def _parse_jwt_expiry(jwt: str) -> float:
    """Extract `exp` claim from a JWT. Returns time.time()+3600 on parse failure."""
    try:
        parts = jwt.split(".")
        if len(parts) != 3:
            return time.time() + 3600
        payload_b64 = parts[1] + "=" * (4 - len(parts[1]) % 4)
        claims = json.loads(base64.urlsafe_b64decode(payload_b64).decode("utf-8", "replace"))
        return float(claims.get("exp", time.time() + 3600))
    except Exception:
        return time.time() + 3600


def _mint_token_for_resource(resource: str) -> tuple[str, float]:
    """Mint a CBA token for a specific resource audience using the cached cert + username.

    Args:
        resource: Audience URI (e.g. "https://storage.azure.com" for OneLake DFS).

    Returns:
        Tuple of (jwt, expiry_unix_seconds).

    Raises:
        RuntimeError if token-helper is missing, no username is configured, or the
        matching CBA cert cannot be found in the Windows cert store.
    """
    helper = _find_token_helper()
    if helper is None:
        raise RuntimeError("token-helper not built (run `make token-helper`)")

    # Username — prefer config (synced at every successful auth), fall back to session.
    username = None
    try:
        cfg = json.loads(CONFIG_PATH.read_text(encoding="utf-8")) if CONFIG_PATH.exists() else {}
        username = cfg.get("username")
    except Exception:
        username = None
    if not username:
        session = _load_session()
        username = session.get("lastUsername")
    if not username:
        raise RuntimeError("No authenticated user — sign in once first")

    # Find the CBA cert that matches this user (CN convention: user@tenant -> user.tenant)
    cert_cn = username.replace("@", ".")
    try:
        list_result = subprocess.run(
            [str(helper), "--list-certs"],
            capture_output=True,
            text=True,
            timeout=10,
        )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError("Cert discovery timed out (10s)") from exc

    if list_result.returncode != 0:
        raise RuntimeError(f"Cert discovery failed: {list_result.stderr.strip()[:200]}")

    thumbprint = None
    try:
        certs = json.loads(list_result.stdout)
        cn_lower = cert_cn.lower()
        for c in certs:
            if cn_lower in c.get("cn", "").lower() or cn_lower in c.get("subject", "").lower():
                thumbprint = c.get("thumbprint")
                break
    except Exception as exc:
        raise RuntimeError(f"Cert list parse failed: {exc}") from exc

    if not thumbprint:
        raise RuntimeError(f"No CBA cert matching {cert_cn} in current-user store")

    # Mint the token with the requested resource audience.
    try:
        result = subprocess.run(
            [str(helper), thumbprint, username, TOKEN_HELPER_CLIENT_ID, TOKEN_HELPER_AUTHORITY, resource],
            capture_output=True,
            text=True,
            timeout=45,
        )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(f"Token mint timed out for {resource}") from exc

    if result.returncode != 0:
        raise RuntimeError(f"Token mint failed for {resource}: {result.stderr.strip()[:300]}")

    token = result.stdout.strip()
    if not token or "." not in token:
        raise RuntimeError(f"Token mint returned malformed token (len={len(token)})")

    expiry = _parse_jwt_expiry(token)
    return token, expiry


def _ensure_onelake_bearer() -> str:
    """Return a valid OneLake-scoped bearer (audience https://storage.azure.com).

    The OneLake DFS endpoint validates a different audience than the Power BI bearer
    cached in `.edog-bearer-cache`. We cache the OneLake token separately and mint a
    fresh one (via token-helper) when the cache is empty or expired.
    """
    cached, _ = _read_cache(ONELAKE_BEARER_CACHE)
    if cached:
        return cached

    # Serialize concurrent mints — token-helper drives Silent CBA which takes ~10-30s.
    with _onelake_mint_lock:
        cached, _ = _read_cache(ONELAKE_BEARER_CACHE)
        if cached:
            return cached

        print(f"  [OneLake] Minting bearer for audience {ONELAKE_RESOURCE}...")
        token, expiry = _mint_token_for_resource(ONELAKE_RESOURCE)
        _write_cache(ONELAKE_BEARER_CACHE, token, expiry)
        remaining = int((expiry - time.time()) / 60)
        print(f"  [OneLake] Bearer cached, expires in {remaining} min")
        return token


def _mint_bearer() -> tuple[str, float]:
    """Mint a fresh Fabric bearer token using Silent CBA.

    Uses the same 2-argument token-helper invocation as ``_serve_auth`` so the
    resulting JWT carries the default Power BI audience.

    Returns:
        Tuple of (jwt, expiry_unix_seconds).

    Raises:
        RuntimeError if token-helper is missing, no saved username exists, or
        the matching CBA certificate cannot be found.
    """
    helper = _find_token_helper()
    if helper is None:
        raise RuntimeError("token-helper not built (run `make token-helper`)")

    username = None
    try:
        cfg = json.loads(CONFIG_PATH.read_text(encoding="utf-8")) if CONFIG_PATH.exists() else {}
        username = cfg.get("username")
    except Exception:
        username = None
    if not username:
        session = _load_session()
        username = session.get("lastUsername")
    if not username:
        raise RuntimeError("No authenticated user — sign in once first")

    cert_cn = username.replace("@", ".")
    try:
        list_result = subprocess.run(
            [str(helper), "--list-certs"],
            capture_output=True,
            text=True,
            timeout=10,
        )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError("Cert discovery timed out (10s)") from exc

    if list_result.returncode != 0:
        raise RuntimeError(f"Cert discovery failed: {list_result.stderr.strip()[:200]}")

    thumbprint = None
    try:
        certs = json.loads(list_result.stdout)
        cn_lower = cert_cn.lower()
        for c in certs:
            if cn_lower in c.get("cn", "").lower() or cn_lower in c.get("subject", "").lower():
                thumbprint = c.get("thumbprint")
                break
    except Exception as exc:
        raise RuntimeError(f"Cert list parse failed: {exc}") from exc

    if not thumbprint:
        raise RuntimeError(f"No CBA cert matching {cert_cn} in current-user store")

    try:
        result = subprocess.run(
            [str(helper), thumbprint, username],
            capture_output=True,
            text=True,
            timeout=30,
        )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError("Bearer mint timed out (30s)") from exc

    if result.returncode != 0:
        raise RuntimeError(f"Bearer mint failed: {result.stderr.strip()[:300]}")

    token = result.stdout.strip()
    if not token or "." not in token:
        raise RuntimeError(f"Bearer mint returned malformed token (len={len(token)})")

    expiry = _parse_jwt_expiry(token)
    return token, expiry


def _ensure_bearer() -> str | None:
    """Return a valid Fabric bearer token, auto-refreshing via CBA if expired.

    Returns the cached bearer if still valid.  When the cache is empty or
    expired and a ``lastUsername`` is stored in the session, silently mints a
    fresh token using CBA (same mechanism as the /api/edog/auth endpoint).

    Returns:
        Bearer JWT string, or ``None`` if no user has ever authenticated and
        silent refresh is therefore impossible.
    """
    cached, _ = _read_cache(BEARER_CACHE)
    if cached:
        return cached

    with _bearer_mint_lock:
        # Double-check after acquiring lock — another thread may have refreshed.
        cached, _ = _read_cache(BEARER_CACHE)
        if cached:
            return cached

        try:
            print("  [Bearer] Auto-refreshing expired Fabric bearer token...")
            token, expiry = _mint_bearer()
            _write_cache(BEARER_CACHE, token, expiry)
            remaining = int((expiry - time.time()) / 60)
            print(f"  [Bearer] Bearer cached, expires in {remaining} min")
            return token
        except RuntimeError as exc:
            print(f"  [Bearer] Auto-refresh failed: {exc}")
            return None


def _enumerate_delta_active_files_full(
    ws_id: str,
    lh_id: str,
    schema: str,
    table_name: str,
    *,
    max_commits: int = 200,
    timeout: int = 15,
) -> tuple[dict, list[str]]:
    """Replay a Delta table's commit log → set of currently-active `add` actions.

    Delta tables do not have a "latest file" notion at the storage layer: the
    current snapshot is `(checkpointAdds union subsequentAdds) minus subsequentRemoves`.
    Reading raw parquet from `Tables/{schema}/{table}/` without log replay will
    silently resurrect tombstoned files and partition columns vanish (they live
    in `add.partitionValues`, not in the parquet itself).

    v1 limitations (surfaced as warnings, never as failures):
      - Skips `*.checkpoint.parquet` — replays only `.json` commits. For tables
        with > `max_commits` commits, the oldest are truncated and a warning is
        appended; the active-file set may be incomplete.
      - Does not honor deletion vectors. If any active file has a
        `deletionVector` action, a warning is appended so the UI can surface it.

    Returns:
        (active_files, warnings) where:
          - active_files: dict[str, dict] mapping relative path → full Delta
            `add` action (includes `path`, `size`, `partitionValues`,
            optionally `stats`, `deletionVector`).
          - warnings: list[str] of human-readable caveats about replay fidelity.

    Raises:
        urllib.error.HTTPError: On non-2xx responses (404 = no `_delta_log/`).
        RuntimeError: If the OneLake bearer cannot be minted.
    """
    onelake_bearer = _ensure_onelake_bearer()
    log_path = f"/{ws_id}/{lh_id}/Tables/{schema}/{table_name}/_delta_log"
    ctx = ssl.create_default_context()
    warnings: list[str] = []

    list_url = f"{ONELAKE_HOST}{log_path}?resource=filesystem&recursive=false"
    req = urllib.request.Request(list_url, headers={"Authorization": f"Bearer {onelake_bearer}"})
    with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
        listing = json.loads(resp.read())

    json_files = sorted(
        p["name"] for p in listing.get("paths", []) if p["name"].endswith(".json") and not p.get("isDirectory")
    )

    has_checkpoint = any(p["name"].endswith(".checkpoint.parquet") for p in listing.get("paths", []))
    if has_checkpoint:
        warnings.append(
            "Delta checkpoint detected; preview replays commit JSONs only and "
            "may miss state captured in the checkpoint."
        )

    if len(json_files) > max_commits:
        warnings.append(f"Long Delta log: replaying only the latest {max_commits} of {len(json_files)} commits.")
        json_files = json_files[-max_commits:]

    active: dict[str, dict] = {}
    has_dv = False
    for jf in json_files:
        file_url = f"{ONELAKE_HOST}/{ws_id}/{jf}"
        req = urllib.request.Request(file_url, headers={"Authorization": f"Bearer {onelake_bearer}"})
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
            content = resp.read().decode()
        for line in content.strip().split("\n"):
            if not line.strip():
                continue
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            if "add" in entry:
                add = entry["add"]
                if add.get("deletionVector"):
                    has_dv = True
                active[add["path"]] = add
            elif "remove" in entry:
                active.pop(entry["remove"]["path"], None)

    if has_dv:
        warnings.append(
            "Deletion vectors present; preview does not yet honor them, so "
            "some rows shown below may be logically deleted."
        )

    return active, warnings


def _coerce_parquet_value(v):
    """Convert a value produced by `pyarrow.Table.to_pylist()` to a JSON-safe form.

    pyarrow returns native Python types: int/float/str/bool/None for primitives;
    `datetime.datetime|date|time` for temporal; `decimal.Decimal` for decimals;
    `bytes` for binary; `dict`/`list` (recursive) for struct/list/map.

    JSON has no native support for datetimes, decimals, or binary. We coerce:
      - temporals  -> ISO 8601 string
      - decimals   -> string (preserves precision; JS Number would lose it)
      - binary     -> "0x..." hex (<=64B) or "<binary, N bytes>" placeholder
      - struct/list -> recursive coercion
      - everything else -> str() fallback (never crash the response)
    """
    import datetime
    import decimal

    if v is None or isinstance(v, (bool, int, float, str)):
        return v
    if isinstance(v, decimal.Decimal):
        return str(v)
    if isinstance(v, (datetime.datetime, datetime.date, datetime.time)):
        return v.isoformat()
    if isinstance(v, (bytes, bytearray, memoryview)):
        b = bytes(v)
        if len(b) <= 64:
            return f"0x{b.hex()}"
        return f"<binary, {len(b)} bytes>"
    if isinstance(v, dict):
        return {k: _coerce_parquet_value(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_coerce_parquet_value(x) for x in v]
    return str(v)


def _coerce_partition_value(raw):
    """Cast a Delta partition value (always serialized as a string) to a number
    when it cleanly parses; otherwise leave it as a string.

    The Delta protocol stores `add.partitionValues` as `dict[str, str|null]`,
    where `null` represents the partition NULL. We don't have the schema column
    type guaranteed here, so we just try int → float, and otherwise leave it.
    """
    if raw is None:
        return None
    if not isinstance(raw, str):
        return raw
    if raw == "":
        return ""
    try:
        if "." not in raw and "e" not in raw.lower():
            return int(raw)
    except ValueError:
        pass
    try:
        return float(raw)
    except ValueError:
        return raw


def _arrow_type_label(arrow_type) -> str:
    """Short, human-readable label for a pyarrow type (mirrors Spark DDL names)."""
    import pyarrow as pa

    if pa.types.is_string(arrow_type) or pa.types.is_large_string(arrow_type):
        return "string"
    if pa.types.is_boolean(arrow_type):
        return "boolean"
    if (
        pa.types.is_int8(arrow_type)
        or pa.types.is_int16(arrow_type)
        or pa.types.is_int32(arrow_type)
        or pa.types.is_uint8(arrow_type)
        or pa.types.is_uint16(arrow_type)
        or pa.types.is_uint32(arrow_type)
    ):
        return "int"
    if pa.types.is_int64(arrow_type) or pa.types.is_uint64(arrow_type):
        return "long"
    if pa.types.is_floating(arrow_type):
        return "double"
    if pa.types.is_date(arrow_type):
        return "date"
    if pa.types.is_timestamp(arrow_type):
        return "timestamp"
    if pa.types.is_decimal(arrow_type):
        return f"decimal({arrow_type.precision},{arrow_type.scale})"
    if pa.types.is_binary(arrow_type) or pa.types.is_large_binary(arrow_type):
        return "binary"
    return str(arrow_type)


def _list_lakehouse_schemas(ws_id: str, lh_id: str, timeout: int = 30) -> list[dict]:
    """List schemas in a schemas-enabled lakehouse via OneLake DFS.

    Each directory under `Tables/` is a schema. Mirrors FLT's own discovery path
    (see workload-fabriclivetable's LakeHouseMetastoreClientWithShortcutSupport.ListAllSchemasAsync).

    Args:
        ws_id: Workspace object ID.
        lh_id: Lakehouse object ID.
        timeout: Per-request timeout in seconds (default 30; first call is slow).

    Returns:
        List of `{"name": str, "isShortcut": bool}` dicts in directory order.

    Raises:
        urllib.error.HTTPError: On non-2xx responses from OneLake DFS.
        RuntimeError: If the OneLake bearer cannot be obtained.
    """
    token = _ensure_onelake_bearer()
    qs = urllib.parse.urlencode(
        {
            "directory": f"{lh_id}/Tables",
            "recursive": "false",
            "resource": "filesystem",
            "getShortcutMetadata": "true",
        }
    )
    url = f"{ONELAKE_HOST}/{ws_id}?{qs}"
    print(f"  [OneLake] GET schemas → {url[:90]}...")

    ctx = ssl.create_default_context()
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
        payload = json.loads(resp.read())

    schemas: list[dict] = []
    for entry in payload.get("paths", []):
        if not entry.get("isDirectory"):
            continue
        name = entry.get("name", "")
        # name shape: "{lh_id}/Tables/{schemaName}" → take the last segment
        schema_name = name.rsplit("/", 1)[-1]
        if not schema_name:
            continue
        schemas.append(
            {
                "name": schema_name,
                # OneLake returns "isShortcut" only when true; absence means false.
                "isShortcut": bool(entry.get("isShortcut", False)),
            }
        )
    return schemas


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
        bearer = _ensure_bearer()
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

# Event set when FLT stdout shows DevInstanceRegistrationFailedException.
# Lets the deploy waiter fail fast (with structured detail) instead of timing
# out 180s on a failure MWC has already told us about.
_flt_registration_failed_event = threading.Event()

# Timestamp when the most recent FLT deploy completed (routing confirmed).
# Used by the proxy to apply a post-deploy grace window: 400s from FLT during
# this window are treated as transient (FLT internal state not yet ready).
_flt_deploy_completed_at: float = 0.0


def _kill_stale_flt_processes(keep_pid=None, deploy_id=None):
    """Kill any orphaned FLT (Microsoft.LiveTable.Service.EntryPoint) processes from prior runs.

    Returns the list of (pid, reason) killed. Skips keep_pid (the FLT we currently own).
    On Windows, uses tasklist + taskkill; on POSIX, falls back to pgrep + kill.
    """
    killed = []
    try:
        if sys.platform == "win32":
            result = subprocess.run(
                ["tasklist", "/FI", "IMAGENAME eq Microsoft.LiveTable.Service.EntryPoint.exe", "/FO", "CSV", "/NH"],
                capture_output=True,
                text=True,
                timeout=10,
            )
            for line in result.stdout.splitlines():
                line = line.strip()
                if not line or "INFO:" in line:
                    continue
                parts = [p.strip('"') for p in line.split('","')]
                if len(parts) < 2:
                    continue
                try:
                    pid = int(parts[1].strip('"'))
                except ValueError:
                    continue
                if keep_pid is not None and pid == keep_pid:
                    continue
                try:
                    subprocess.run(["taskkill", "/F", "/T", "/PID", str(pid)], capture_output=True, timeout=10)
                    killed.append((pid, "stale FLT EntryPoint"))
                except Exception as e:
                    print(f"[zombie-sweep] Failed to kill PID {pid}: {e}", file=sys.stderr)
        else:
            result = subprocess.run(
                ["pgrep", "-f", "Microsoft.LiveTable.Service.EntryPoint"], capture_output=True, text=True, timeout=10
            )
            for line in result.stdout.splitlines():
                try:
                    pid = int(line.strip())
                except ValueError:
                    continue
                if keep_pid is not None and pid == keep_pid:
                    continue
                try:
                    os.kill(pid, 9)
                    killed.append((pid, "stale FLT EntryPoint"))
                except Exception as e:
                    print(f"[zombie-sweep] Failed to kill PID {pid}: {e}", file=sys.stderr)
    except Exception as e:
        print(f"[zombie-sweep] Sweep failed: {e}", file=sys.stderr)

    if killed and deploy_id is not None:
        for pid, reason in killed:
            _deploy_log(f"Killed stale FLT process (PID {pid}): {reason}", "warn")
    return killed


def _kill_port_listeners(port: int) -> list[int]:
    """Kill any process currently LISTENING on ``port`` on 127.0.0.1.

    Windows in particular will happily let a second process bind to the same
    port when the previous owner didn't release the socket cleanly (e.g.,
    Ctrl-Break vs Ctrl-C), which then load-balances incoming connections
    between stale and fresh code. Call this just before binding to guarantee
    a clean slate.

    Returns the list of killed PIDs.
    """
    killed: list[int] = []
    own_pid = os.getpid()
    try:
        if sys.platform == "win32":
            result = subprocess.run(
                ["netstat", "-ano", "-p", "TCP"],
                capture_output=True,
                text=True,
                timeout=10,
            )
            seen: set[int] = set()
            for line in result.stdout.splitlines():
                parts = line.split()
                if len(parts) < 5 or parts[0] != "TCP":
                    continue
                local, _remote, state, pid_str = parts[1], parts[2], parts[3], parts[4]
                if state != "LISTENING":
                    continue
                if not (local.endswith(f":{port}")):
                    continue
                try:
                    pid = int(pid_str)
                except ValueError:
                    continue
                if pid == own_pid or pid in seen:
                    continue
                seen.add(pid)
                try:
                    subprocess.run(["taskkill", "/F", "/PID", str(pid)], capture_output=True, timeout=10)
                    killed.append(pid)
                except Exception as e:
                    print(f"[port-guard] Failed to kill PID {pid} on :{port}: {e}", file=sys.stderr)
        else:
            # POSIX: lsof gives us the LISTEN-state PIDs.
            result = subprocess.run(
                ["lsof", "-ti", f"tcp:{port}", "-sTCP:LISTEN"],
                capture_output=True,
                text=True,
                timeout=10,
            )
            for line in result.stdout.splitlines():
                try:
                    pid = int(line.strip())
                except ValueError:
                    continue
                if pid == own_pid:
                    continue
                try:
                    os.kill(pid, 9)
                    killed.append(pid)
                except Exception as e:
                    print(f"[port-guard] Failed to kill PID {pid} on :{port}: {e}", file=sys.stderr)
    except FileNotFoundError:
        # netstat/lsof not on PATH — nothing we can do; let bind() fail loudly.
        return killed
    except Exception as e:
        print(f"[port-guard] Sweep failed for :{port}: {e}", file=sys.stderr)

    if killed:
        # Give the kernel a moment to release the socket.
        time.sleep(0.5)
    return killed


def _wait_for_port_free(port: int, timeout: float = 10) -> bool:
    """Poll until no process is LISTENING on ``port``, or timeout.

    Returns True if the port is free, False if timeout elapsed with the
    port still occupied.  Uses a short polling interval so we proceed as
    soon as the kernel releases the socket instead of sleeping a fixed
    arbitrary duration.
    """
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            if sys.platform == "win32":
                result = subprocess.run(
                    ["netstat", "-ano", "-p", "TCP"],
                    capture_output=True,
                    text=True,
                    timeout=5,
                )
                listening = any(
                    parts[3] == "LISTENING" and parts[1].endswith(f":{port}")
                    for line in result.stdout.splitlines()
                    if len(parts := line.split()) >= 4 and parts[0] == "TCP"
                )
            else:
                result = subprocess.run(
                    ["lsof", "-ti", f"tcp:{port}", "-sTCP:LISTEN"],
                    capture_output=True,
                    text=True,
                    timeout=5,
                )
                listening = bool(result.stdout.strip())
            if not listening:
                return True
        except Exception:
            return True  # Can't check — proceed optimistically
        time.sleep(0.3)
    print(f"[port-guard] Port :{port} still occupied after {timeout}s", file=sys.stderr)
    return False


def _parse_registration_failure(line):
    """Extract structured detail from a DevInstanceRegistrationFailedException line.

    The exception message embeds the registration request struct and the MWC
    error response JSON on a single output line. We pull out:
      - capacityGuid (from CapacityGuid = <guid>)
      - rootActivityId (from "code":"RootActivityId","message":"<guid>")
      - clusterDns (from "code":"ClusterDNS","message":"<host>")
      - httpStatusCode (from HTTP status code: <name>)

    Returns dict with whatever was found, or None if this isn't the marker line.
    """
    if "DevInstanceRegistrationFailedException" not in line:
        return None
    detail = {}
    m = re.search(r"CapacityGuid\s*=\s*([0-9a-fA-F-]{36})", line)
    if m:
        detail["capacityGuid"] = m.group(1)
    m = re.search(r'"code":"RootActivityId","message":"([^"]+)"', line)
    if m:
        detail["rootActivityId"] = m.group(1)
    m = re.search(r'"code":"ClusterDNS","message":"([^"]+)"', line)
    if m:
        detail["clusterDns"] = m.group(1)
    m = re.search(r"HTTP status code:\s*([A-Za-z]+)", line)
    if m:
        detail["httpStatus"] = m.group(1)
    return detail


def _drain_flt_stdout(proc, deploy_id):
    """Read FLT process stdout continuously to prevent pipe buffer blocking.

    Also captures output as deploy log entries and sets _flt_ready_event
    when the service is fully deployed (DevConnection started). Detects
    known-fatal exception markers (DevInstanceRegistrationFailedException)
    and sets _flt_registration_failed_event with structured detail so the
    deploy waiter can fail fast instead of timing out at 180s.

    Reads until EOF (not until poll() flips) so crash stack traces that
    are still buffered in the pipe after the process exits are captured.
    """
    try:
        for line in proc.stdout:
            line = line.rstrip()
            if line:
                # Elevate EDOG-side fatals (e.g., EdogLogServer bind failures)
                # so they surface as errors in the studio deploy log instead
                # of being lost in the info stream.
                lvl = "error" if "[EDOG][FATAL]" in line else "info"
                _deploy_log("[FLT] " + line, lvl)
                # Check for deployment success markers
                if "DevConnection started" in line or "Dev Connection established" in line:
                    _flt_ready_event.set()
                # Check for known-fatal markers — fail fast rather than
                # waiting for the 180s healthy-timeout to elapse.
                if "DevInstanceRegistrationFailedException" in line and not _flt_registration_failed_event.is_set():
                    detail = _parse_registration_failure(line) or {}
                    with _studio_lock:
                        _studio_state["deployErrorKind"] = "mwc_registration"
                        _studio_state["deployErrorDetail"] = detail
                    _flt_registration_failed_event.set()
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


def _warmup_capacity_route(ws_id: str, lh_id: str, cap_id: str, deploy_id: str) -> bool:
    """Probe the capacity routing layer until LiveTable APIs are reachable.

    After FLT's DevConnection fires, the capacity routing table may take
    10-60 s to propagate.  This function retries MWC token generation +
    a lightweight GET through the capacity path, blocking the deploy
    pipeline until the end-to-end path works (or timeout).

    Returns True if routing was confirmed, False if timeout expired.
    """
    deadline = time.time() + 60
    backoff_seq = [2, 3, 5, 8]  # then 8, 8, 8... until deadline
    attempt = 0

    while time.time() < deadline:
        # Bail if deploy was cancelled
        if _deploy_cancel.is_set():
            _deploy_log("Warmup cancelled", "warn")
            return False

        # Bail if FLT process died
        if _flt_process and _flt_process.poll() is not None:
            _deploy_log(f"FLT process exited during warmup (code {_flt_process.returncode})", "error")
            return False

        try:
            bearer = _ensure_bearer()
            if not bearer:
                _deploy_log("Warmup: no bearer token", "warn")
                break

            # Single probe: MWC token + GET through capacity in one shot.
            mwc_token, host = _get_mwc_token(bearer, ws_id, lh_id, cap_id, workload_type="LiveTable")
            probe_url = (
                f"{host}/webapi/capacities/{cap_id}/workloads/LiveTable"
                f"/LiveTableService/automatic"
                f"/v1/workspaces/{ws_id}/lakehouses/{lh_id}"
                f"/devmode/edogSessions/list"
            )
            req = urllib.request.Request(probe_url, method="GET")
            req.add_header("Authorization", f"MwcToken {mwc_token}")
            req.add_header("x-ms-workload-resource-moniker", lh_id)
            ctx = ssl.create_default_context()
            with urllib.request.urlopen(req, timeout=15, context=ctx) as resp:
                resp.read()

            _deploy_log(
                f"Capacity routing confirmed (attempt {attempt + 1})",
                "success",
            )
            return True

        except Exception as e:
            phase = str(e)[:80]

        attempt += 1
        delay = backoff_seq[min(attempt - 1, len(backoff_seq) - 1)]
        remaining = int(deadline - time.time())
        _deploy_log(
            f"Warmup attempt {attempt} failed ({phase}), retrying in {delay}s... ({remaining}s left)",
            "dim",
        )
        time.sleep(delay)

    _deploy_log("Warmup timeout — capacity routing not confirmed within 60s", "warn")
    return False


def _run_deploy_pipeline(deploy_id, ws_id, lh_id, cap_id):
    """Real deploy pipeline. Runs on background thread."""
    global _flt_process

    try:
        # Step 0: Fetch MWC token
        if not _deploy_step(0, "Fetching MWC token...", deploy_id):
            return
        bearer = _ensure_bearer()
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
                                _deploy_log("Synced CapacityGuid in workload-dev-mode.json", "success")
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

        # Stop the previous FLT *before* `dotnet build` runs inside
        # edog.py --headless-deploy. Otherwise the still-running process
        # holds file locks on Microsoft.LiveTable.Service.EntryPoint.exe
        # and MSBuild fails with MSB3027 ("file in use"), leaving the user
        # in a "patches applied but build failed" half-state. Wrapped in
        # try/except so a stop failure (rare — terminate is best-effort)
        # doesn't abort the deploy; if a lock still bites, MSBuild surfaces
        # the error and revert kicks in.
        try:
            if _flt_process and _flt_process.poll() is None:
                _deploy_log("Stopping previous FLT service before build...", "warn")
                _flt_process.terminate()
                try:
                    _flt_process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    _flt_process.kill()

            # Sweep any stale FLT processes from prior dev-server runs or crashes
            # (our own _flt_process tracking only catches FLTs we spawned in this session)
            _kill_stale_flt_processes(deploy_id=deploy_id)

            # Always ensure port 5557 is free before launching — even if our
            # own terminate() handled the old process, the kernel may not have
            # released the socket yet.  _kill_port_listeners handles that and
            # sleeps 0.5 s if it kills anything.
            _kill_port_listeners(FLT_INTERNAL_PORT)

            # Condition-based wait: poll until nothing is LISTENING on the port
            # (replaces the old arbitrary 1s sleep that was skipped when
            # stale_killed was empty).
            _wait_for_port_free(FLT_INTERNAL_PORT, timeout=10)
        except Exception as stop_err:
            _deploy_log(
                f"Pre-build FLT stop hit an error ({stop_err}); continuing to build "
                "anyway — MSBuild will surface MSB3027 if file locks remain.",
                "warn",
            )

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
            patch_warnings: list[str] = []
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
                    if _is_edog_patch_warning(msg):
                        patch_warnings.append(msg.strip())
                except json.JSONDecodeError:
                    _deploy_log(line, "info")
                    if _is_edog_patch_warning(line):
                        patch_warnings.append(line.strip())

                if _deploy_cancel.is_set():
                    proc.terminate()
                    with _studio_lock:
                        _studio_state.update({"phase": "stopped", "deployMessage": "Cancelled"})
                    return

            proc.wait()
            with _studio_lock:
                _studio_state["patchWarnings"] = patch_warnings
            if patch_warnings:
                _deploy_log(
                    f"⚠️ {len(patch_warnings)} patch warning(s) — some EDOG interceptors may be inactive. "
                    "Check the Inspector → EDOG Health tile.",
                    "warn",
                )
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
        # Note: previous FLT was stopped + port cleared at start of step 2 so
        # the build could run against a quiescent bin/. No second stop needed.
        if not _deploy_step(3, "Launching service...", deploy_id):
            return
        try:
            config = json.loads(CONFIG_PATH.read_text()) if CONFIG_PATH.exists() else {}
            flt_repo = config.get("flt_repo_path", "")
            entrypoint = Path(flt_repo) / "Service" / "Microsoft.LiveTable.Service.EntryPoint"

            # Layer the repo .env onto os.environ + alias PRO→base so the
            # QA Testing Tool's V2 capability probe finds AZURE_OPENAI_*
            # vars in the FLT process. Without this the .env file sits on
            # disk but never reaches FLT through this launch path — the
            # studio "Deploy" button bypasses edog.py's start_flt_service.
            # Logic lives in edog._build_flt_subprocess_env so both
            # launchers share one source of truth.
            sys.path.insert(0, str(PROJECT_DIR))
            try:
                from edog import _build_flt_subprocess_env

                env = _build_flt_subprocess_env(PROJECT_DIR, base_env=os.environ)
            except Exception as env_load_err:
                _deploy_log(
                    f"Could not load .env for FLT subprocess ({env_load_err}); QA V2 LLM will fall back to legacy.",
                    "warn",
                )
                env = dict(os.environ)
            finally:
                if str(PROJECT_DIR) in sys.path:
                    sys.path.remove(str(PROJECT_DIR))

            env["EDOG_STUDIO_PORT"] = str(FLT_INTERNAL_PORT)
            # F11/architecture.md §3.7: per-session token gates the override
            # control plane on FLT. Without this env var, FLT returns 503.
            env["EDOG_CONTROL_TOKEN"] = EDOG_CONTROL_TOKEN

            aoai_keys_visible = sum(1 for k in env if k.startswith("AZURE_OPENAI_") and env[k])
            if aoai_keys_visible > 0:
                _deploy_log(
                    f"AZURE_OPENAI_* env vars propagated to FLT process: {aoai_keys_visible}",
                    "info",
                )
            else:
                _deploy_log(
                    "No AZURE_OPENAI_* env vars visible to FLT process — "
                    "QA V2 LLM will fall back to legacy single-prompt path.",
                    "warn",
                )

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

            # Clear ready/failure events BEFORE starting the drain thread — if
            # FLT boots fast the drain thread may see "DevConnection started"
            # (or the failure marker) and set() the event; clearing AFTER would
            # erase that signal (race). Also reset structured-error fields so a
            # prior failure doesn't bleed into this deploy's UI.
            _flt_ready_event.clear()
            _flt_registration_failed_event.clear()
            with _studio_lock:
                _studio_state["deployErrorKind"] = None
                _studio_state["deployErrorDetail"] = None

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
        # (captured by _drain_flt_stdout which sets _flt_ready_event).
        # We also race against _flt_registration_failed_event so that when
        # MWC rejects the dev-instance registration we surface a clean
        # structured error in ~1s instead of waiting 180s.
        if not _deploy_step(4, "Waiting for DevMode connection...", deploy_id):
            return
        # _flt_ready_event was cleared before the drain thread started (above)
        healthy = False
        wait_deadline = time.time() + 180  # 3 min max
        while time.time() < wait_deadline:
            if _flt_ready_event.is_set():
                healthy = True
                break
            if _flt_registration_failed_event.is_set():
                # Known-fatal MWC-side failure already surfaced by the drain
                # thread (deployErrorKind/Detail already populated).
                break
            if _deploy_cancel.is_set():
                break
            if _flt_process.poll() is not None:
                break
            time.sleep(0.5)

        # Check if cancelled or process died while waiting
        if _deploy_cancel.is_set():
            _flt_process.terminate()
            with _studio_lock:
                _studio_state.update({"phase": "stopped", "deployMessage": "Cancelled"})
            return

        # Known-fatal: MWC rejected the dev-instance registration. The drain
        # thread already populated deployErrorKind/Detail; surface a clean
        # message and stop the workload so the user can act on the mitigation
        # steps the UI renders without waiting for the 180s timeout.
        if _flt_registration_failed_event.is_set():
            with _studio_lock:
                detail = _studio_state.get("deployErrorDetail") or {}
            cap = detail.get("capacityGuid") or "unknown"
            _deploy_log(
                f"MWC dev-instance registration failed for capacity {cap} — see error card for mitigation steps",
                "error",
            )
            with contextlib.suppress(Exception):
                _flt_process.terminate()
            with _studio_lock:
                _studio_state.update(
                    {
                        "phase": "stopped",
                        "deployError": "MWC rejected dev-instance registration",
                        "deployMessage": "Deploy failed — MWC dev-relay returned 500",
                    }
                )
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

        # Step 5: Warmup — verify capacity routing is propagated before
        # declaring "running". Without this, the frontend fires API calls
        # into a routing gap (MWC 404 / capacity 400) for 10-60s.
        if not _deploy_step(5, "Verifying capacity routing...", deploy_id):
            return

        warmup_ok = _warmup_capacity_route(ws_id, lh_id, cap_id, deploy_id)

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
            state_update = {
                "phase": "running",
                "deployStep": 6,
                "deployMessage": "Deploy complete",
                "deployTarget": target,
            }
            if not warmup_ok:
                state_update["warmupIncomplete"] = True
                state_update["warmupMessage"] = (
                    "Capacity route not fully propagated yet. Some FLT APIs may take a few seconds to start working."
                )
            _studio_state.update(state_update)
        _deploy_log("Deploy complete!" + ("" if warmup_ok else " (warmup incomplete)"), "success")

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
    """Refresh bearer and MWC tokens every 50 minutes."""
    while True:
        time.sleep(50 * 60)
        with _studio_lock:
            if _studio_state["phase"] != "running":
                return
        try:
            bearer = _ensure_bearer()
            if bearer:
                _get_mwc_token(bearer, ws_id, lh_id, cap_id)
                _deploy_log("MWC token refreshed", "success")
            else:
                _deploy_log("Token refresh skipped — bearer unavailable", "warn")
        except Exception as e:
            _deploy_log(f"Token refresh failed: {e}", "warn")


class EdogDevHandler(SimpleHTTPRequestHandler):
    """HTTP handler for EDOG development server."""

    def handle_one_request(self):
        # Client-side disconnects (browser navigation, Ctrl+R during in-flight
        # request, AbortController.abort) raise socket errors deep in the
        # response-write path. They're benign — the user just moved on — but
        # the default handler prints a multi-page traceback. Collapse them to
        # a single one-line warning so the console stays readable.
        try:
            super().handle_one_request()
        except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError) as e:
            sys.stderr.write(f"[client-disconnect] {self.command or '?'} {self.path or '?'} — {type(e).__name__}\n")
        except Exception:
            raise

    def do_GET(self):
        if self.path == "/api/flt/config":
            self._serve_config()
        elif self.path.startswith("/api/fabric/"):
            self._proxy_fabric("GET")
        elif self.path == "/api/edog/certs":
            self._serve_certs()
        elif self.path == "/api/edog/health":
            self._serve_health()
        elif self.path == "/api/edog/git-diff":
            self._serve_git_diff()
        elif self.path.startswith("/api/edog/git-blame"):
            self._serve_git_blame()
        elif self.path == "/api/edog/coverage":
            self._serve_coverage_get()
        elif self.path == "/api/identity":
            self._serve_identity()
        elif self.path.startswith("/api/edog/s2s-token"):
            self._serve_s2s_token()
        elif self.path.startswith("/api/edog/session-probe"):
            self._probe_capacity_sessions()
        elif self.path == "/api/edog/patch-warnings":
            self._serve_patch_warnings()
        elif self.path == "/api/edog/interceptors-status":
            self._serve_interceptors_status()
        elif self.path == "/api/edog/feature-flags/catalog":
            self._serve_feature_flags_catalog()
        elif self.path == "/api/edog/feature-flags/overrides":
            self._serve_feature_flags_overrides_get()
        elif self.path.startswith("/api/edog/feature-flags/raw/"):
            wire_key = urllib.parse.unquote(self.path[len("/api/edog/feature-flags/raw/") :])
            self._serve_feature_flags_raw(wire_key)
        elif self.path.startswith("/api/mwc/tables"):
            self._serve_mwc_tables()
        elif self.path.startswith("/api/import-dag"):
            self._serve_import_dag()
        elif self.path.startswith("/api/mwc/table-stats"):
            self._serve_table_stats()
        elif self.path.startswith("/api/onelake/table-metadata"):
            self._serve_onelake_table_metadata()
        elif self.path.startswith("/api/onelake/table-preview-rows"):
            self._serve_onelake_table_rows()
        elif self.path.startswith("/api/onelake/item-timestamps"):
            self._serve_onelake_item_timestamps()
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
        elif self.path == "/api/playground/swagger/diff":
            self._serve_swagger_diff()
        elif self.path == "/api/playground/swagger/baseline":
            self._serve_swagger_baseline_get()
        elif self.path == "/api/playground/swagger/spec":
            self._serve_swagger_spec()
        elif self.path == "/swagger" or self.path == "/swagger/" or self.path == "/swagger/index.html":
            self._serve_swagger_ui()
        elif self.path.startswith("/vendor/"):
            self._serve_vendor_asset()
        elif self.path.startswith("/api/contract/catalog/"):
            self._handle_contract_catalog_proxy()
        elif self.path == "/api/contract/capabilities":
            self._handle_contract_capabilities_proxy()
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
        elif self.path == "/api/playground/swagger/baseline":
            self._serve_swagger_baseline_delete()
        elif self.path.startswith("/api/edog/feature-flags/overrides/"):
            flag = urllib.parse.unquote(self.path[len("/api/edog/feature-flags/overrides/") :])
            self._serve_feature_flags_overrides_delete(flag)
        else:
            self._json_response(404, {"error": "not_found", "message": f"No handler for DELETE {self.path}"})

    def do_POST(self):
        if self.path == "/api/fabric/capacities":
            self._serve_create_capacity()
            return
        if self.path.startswith("/api/fabric/"):
            self._proxy_fabric("POST")
        elif self.path == "/api/edog/auth":
            self._serve_auth()
        elif self.path == "/api/edog/repo-scan":
            self._serve_repo_scan()
        elif self.path == "/api/edog/coverage/run":
            self._serve_coverage_run()
        elif self.path == "/api/edog/repo-set":
            self._serve_repo_set()
        elif self.path == "/api/edog/feature-flags/overrides":
            self._serve_feature_flags_overrides_post()
        elif self.path == "/api/edog/feature-flags/overrides/reset":
            self._serve_feature_flags_overrides_reset()
        elif self.path == "/api/edog/feature-flags/refresh":
            self._serve_feature_flags_refresh()
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
        elif self.path == "/api/playground/swagger/baseline":
            self._serve_swagger_baseline_post()
        elif self.path == "/api/ado-proxy/pr-comment":
            self._serve_ado_pr_comment()
        else:
            self._json_response(404, {"error": "not_found", "message": f"No handler for POST {self.path}"})

    def _serve_config(self):
        config = {}
        if CONFIG_PATH.exists():
            config = json.loads(CONFIG_PATH.read_text())

        bearer = _ensure_bearer()

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
        bearer = _ensure_bearer()
        if not bearer:
            self._send_json(401, {"error": "no_bearer_token", "message": "Bearer token not cached"})
            return

        # /api/fabric/workspaces/{id}/items → /workspaces/{id}/items
        fabric_path = self.path[len("/api/fabric") :]
        target_path = _map_path(fabric_path, method)
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
                # Forward LRO-relevant headers so the browser can poll long-running ops.
                # Without these, 202 responses are unusable client-side (no Location to
                # extract operation/job ID from).
                _exposed = []
                for hdr in ("Location", "Retry-After", "x-ms-operation-id"):
                    val = resp.headers.get(hdr)
                    if val:
                        self.send_header(hdr, val)
                        _exposed.append(hdr)
                if _exposed:
                    self.send_header("Access-Control-Expose-Headers", ", ".join(_exposed))
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

    def _serve_create_capacity(self):
        """POST /api/fabric/capacities — create a new Fabric capacity.

        Body in: { displayName, sku, region }
        Body sent to redirect host POST /capacities/new:
            { displayName, adminsUpns: [upn], sku, region, mode: 1 }

        UPN is resolved from edog-config.json (set during bearer auth) or
        extracted from the bearer token's `upn` JWT claim as a fallback.
        Capacity-admin headers are required on the redirect host.
        """
        bearer = _ensure_bearer()
        if not bearer:
            self._send_json(401, {"error": "no_bearer_token", "message": "Bearer token not cached"})
            return

        content_len = int(self.headers.get("Content-Length", 0))
        if content_len <= 0:
            self._send_json(400, {"error": "bad_request", "message": "Empty body"})
            return
        try:
            payload = json.loads(self.rfile.read(content_len).decode("utf-8"))
        except (ValueError, UnicodeDecodeError) as e:
            self._send_json(400, {"error": "bad_request", "message": f"Invalid JSON: {e}"})
            return

        display_name = (payload.get("displayName") or "").strip()
        sku = (payload.get("sku") or "").strip()
        region = (payload.get("region") or "").strip()
        if not display_name or not sku or not region:
            self._send_json(
                400,
                {"error": "bad_request", "message": "displayName, sku, and region are required"},
            )
            return

        upn = ""
        try:
            if CONFIG_PATH.exists():
                upn = (json.loads(CONFIG_PATH.read_text()).get("username") or "").strip()
        except (OSError, ValueError):
            upn = ""
        if not upn:
            try:
                payload_b64 = bearer.split(".")[1]
                payload_b64 += "=" * (-len(payload_b64) % 4)
                claims = json.loads(base64.b64decode(payload_b64).decode("utf-8", "replace"))
                upn = (claims.get("upn") or claims.get("preferred_username") or "").strip()
            except (IndexError, ValueError, UnicodeDecodeError):
                upn = ""
        if not upn:
            self._send_json(
                400,
                {"error": "no_upn", "message": "Could not determine user UPN for adminsUpns"},
            )
            return

        body_out = json.dumps(
            {
                "displayName": display_name,
                "adminsUpns": [upn],
                "sku": sku,
                "region": region,
                "mode": 1,
            }
        ).encode("utf-8")

        url = REDIRECT_HOST + "/capacities/new"
        headers = {
            "Authorization": f"Bearer {bearer}",
            "Content-Type": "application/json",
            "x-powerbi-hostenv": "Power BI Web App",
            "x-powerbi-user-admin": "true",
            "origin": "https://powerbi-df.analysis-df.windows.net",
            "referer": "https://powerbi-df.analysis-df.windows.net/",
        }
        print(f"  [PROXY] POST /capacities/new (sku={sku}, region={region}, admin={upn})")

        try:
            ctx = ssl.create_default_context()
            req = urllib.request.Request(url, data=body_out, headers=headers, method="POST")
            with urllib.request.urlopen(req, timeout=60, context=ctx) as resp:
                resp_body = resp.read()
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

    def _serve_identity(self):
        """GET /api/identity — local OS identity for Session Guard.

        Everyone on the team authenticates as the same Fabric service principal,
        so AAD identity is useless for disambiguation. Machine + OS user is
        what tells two engineers apart when they share a capacity.
        """
        try:
            import platform

            machine = platform.node() or ""
            try:
                os_user = os.getlogin()
            except OSError:
                # getlogin() fails when there's no controlling terminal
                # (e.g. service / detached process). Fall back to env vars.
                os_user = os.environ.get("USERNAME") or os.environ.get("USER") or ""
            self._json_response(200, {"machine": machine, "osUser": os_user})
        except Exception as e:
            sys.stderr.write(f"[EDOG] _serve_identity error: {e}\n")
            self._json_response(200, {"machine": "", "osUser": "", "error": str(e)})

    # ── S2S Token Bypass (DevMode cert expiry workaround) ──────────────────

    # Allowlisted audiences for the S2S token bypass — only these resources
    # can be minted via CBA. Keeps the endpoint from becoming an arbitrary
    # token oracle.
    _S2S_ALLOWED_AUDIENCES = frozenset(
        {
            "https://storage.azure.com",  # OneLake / TridentLake
            "https://analysis.windows.net/powerbi/api",  # PBI Shared
        }
    )

    def _serve_s2s_token(self):
        """GET /api/edog/s2s-token?resource=<audience> — Mint CBA token for S2S bypass.

        Called by EdogS2STokenBypass (C# DevMode interceptor) when the workload
        S2S certificate has expired. Mints a user-delegated CBA token for the
        requested resource audience using the valid Admin CBA cert.

        Query params:
            resource (required): Target audience URI (must be in allowlist).

        Returns:
            200 {"token": "eyJ...", "expiresOn": <unix_seconds>}
            400 if resource missing or not allowlisted.
            500 if token mint fails.
        """
        parsed = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(parsed.query)
        resource = qs.get("resource", [None])[0]

        if not resource:
            self._json_response(
                400,
                {
                    "error": "missing_param",
                    "message": "resource query parameter required",
                },
            )
            return

        if resource not in self._S2S_ALLOWED_AUDIENCES:
            self._json_response(
                400,
                {
                    "error": "audience_not_allowed",
                    "message": f"Resource '{resource}' not in S2S bypass allowlist",
                    "allowed": list(self._S2S_ALLOWED_AUDIENCES),
                },
            )
            return

        try:
            if resource == ONELAKE_RESOURCE:
                # Fast path: use the cached OneLake bearer
                token = _ensure_onelake_bearer()
                expiry = _parse_jwt_expiry(token)
            else:
                token, expiry = _mint_token_for_resource(resource)

            print(f"  [S2S Bypass] Minted CBA token for {resource} (expires in {int((expiry - time.time()) / 60)} min)")
            self._json_response(
                200,
                {
                    "token": token,
                    "expiresOn": int(expiry),
                    "tokenType": "Bearer",
                    "resource": resource,
                    "source": "cba_bypass",
                },
            )
        except Exception as e:
            print(f"  [S2S Bypass] Failed for {resource}: {e}")
            self._json_response(
                500,
                {
                    "error": "token_mint_failed",
                    "message": str(e),
                    "resource": resource,
                },
            )

    def _probe_capacity_sessions(self):
        """GET /api/edog/session-probe — Session Guard pre-deploy collision check.

        Calls /api/edog/sessions on the capacity host. Three outcomes:
          - 200 with sessions → return them so the UI can warn the engineer.
          - 404 / timeout / connection error → capacity has no DevMode (i.e.
            no one is connected): return available=true with empty list.
          - Any other error → also degrade to available=true so a probe
            failure never blocks a deploy.
        """
        try:
            # Probe via flt-proxy — goes through the capacity host with proper
            # MWC auth + moniker headers, same path as all FLT API calls.
            # Controller route: devmode/edogSessions/list
            # flt-proxy auto-prepends the workspace/lakehouse path.
            cfg = {}
            with contextlib.suppress(Exception):
                if CONFIG_PATH.exists():
                    cfg = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))

            ws_id = cfg.get("workspace_id", "")
            art_id = cfg.get("artifact_id", "")
            cap_id = cfg.get("capacity_id", "")
            if not ws_id or not art_id or not cap_id:
                self._json_response(200, {"available": True, "sessions": [], "reason": "no_config"})
                return

            bearer = _ensure_bearer()
            if not bearer:
                self._json_response(200, {"available": True, "sessions": [], "reason": "no_bearer"})
                return

            try:
                mwc_token, host = _get_mwc_token(bearer, ws_id, art_id, cap_id, workload_type="LiveTable")
            except Exception as e:
                sys.stderr.write(f"[EDOG] session-probe mwc error: {e}\n")
                self._json_response(200, {"available": True, "sessions": [], "reason": "mwc_failed"})
                return

            # Build capacity host URL with standard FLT controller path
            target_url = (
                f"{host}/webapi/capacities/{cap_id}/workloads/LiveTable"
                f"/LiveTableService/automatic"
                f"/devmode/edogSessions/list"
            )
            req = urllib.request.Request(target_url, method="GET")
            req.add_header("Authorization", f"MwcToken {mwc_token}")
            req.add_header("x-ms-workload-resource-moniker", art_id)
            req.add_header("Accept", "application/json")

            ctx = ssl.create_default_context()
            try:
                with urllib.request.urlopen(req, timeout=8.0, context=ctx) as resp:
                    body = resp.read(65536)
                    try:
                        payload = json.loads(body.decode("utf-8", errors="replace"))
                    except Exception:
                        payload = {"sessions": []}
                    sessions = payload.get("sessions") or []
                    self._json_response(
                        200,
                        {
                            "available": len(sessions) == 0,
                            "sessions": sessions,
                            "capacityId": payload.get("capacityId"),
                            "capacityName": payload.get("capacityName"),
                            "capacitySku": payload.get("capacitySku"),
                        },
                    )
                    return
            except urllib.error.HTTPError as e:
                # 404 → capacity isn't running DevMode (no one connected).
                if e.code == 404:
                    self._json_response(200, {"available": True, "sessions": [], "reason": "no_devmode"})
                    return
                # Capture error body for debugging
                err_body = ""
                try:
                    err_body = e.read(4096).decode("utf-8", errors="replace")
                except Exception:
                    pass
                sys.stderr.write(f"[EDOG] session-probe HTTP {e.code}: {e.reason} body={err_body[:500]}\n")
                self._json_response(
                    200, {"available": True, "sessions": [], "reason": f"http_{e.code}", "debug": err_body[:500]}
                )
                return
            except (urllib.error.URLError, TimeoutError) as e:
                sys.stderr.write(f"[EDOG] session-probe network: {e}\n")
                self._json_response(200, {"available": True, "sessions": [], "reason": "timeout"})
                return
        except Exception as e:
            sys.stderr.write(f"[EDOG] _probe_capacity_sessions error: {e}\n")
            self._json_response(200, {"available": True, "sessions": [], "reason": "probe_failed"})

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
            print(
                f"  [ADO] PR #{result['prId']}: {result['filesDiffed']} files diffed, "
                f"+{result['linesAdded']}/-{result['linesRemoved']}, "
                f"{len(result['diff'])} chars"
            )
            if result["skippedFiles"]:
                print(f"  [ADO] Skipped: {[s['path'] for s in result['skippedFiles']]}")
            self._json_response(200, result)
        except ValueError as e:
            self._json_response(400, {"error": "invalid_pr_url", "message": str(e)})
        except RuntimeError as e:
            self._json_response(502, {"error": "ado_api_error", "message": str(e)})
        except urllib.error.HTTPError as e:
            status = 502 if e.code >= 500 else (401 if e.code in (401, 403) else 502)
            self._json_response(
                status, {"error": f"ado_http_{e.code}", "message": f"ADO returned {e.code}: {e.reason}"}
            )
        except urllib.error.URLError as e:
            self._json_response(502, {"error": "ado_unreachable", "message": f"Cannot reach ADO: {e.reason}"})
        except subprocess.TimeoutExpired:
            self._json_response(504, {"error": "az_cli_timeout", "message": "Azure CLI timed out acquiring ADO token"})
        except TimeoutError:
            self._json_response(504, {"error": "ado_timeout", "message": "ADO API request timed out"})
        except Exception as e:
            print(f"  [ADO] Error: {e}")
            self._json_response(500, {"error": "internal_error", "message": str(e)})

    def _serve_ado_pr_comment(self):
        """POST /api/ado-proxy/pr-comment — post a markdown comment to an ADO PR.

        F27 P6 — closes step 7 of the QA Testing user journey (Results → Post
        to PR). Reuses the same Azure CLI token cache as ``_serve_ado_pr_diff``
        so it Just Works on a workstation that's already signed in to ADO.

        Request body: ``{"prUrl": "...", "markdown": "..."}``.
        Response: ``{"threadId": int, "commentId": int, "threadUrl": str}`` on
        success; standard ``{error, message}`` envelope otherwise.

        ADO has a ~150KB hard limit on thread content; the C# aggregator
        already truncates above 130KB, but we add a defensive guard here so a
        non-aggregator caller (e.g. JS-formatted comment) can't accidentally
        hit the API with an oversize payload.
        """
        try:
            content_length = int(self.headers.get("Content-Length", 0))
        except ValueError:
            self._json_response(
                400, {"error": "invalid_content_length", "message": "Content-Length must be an integer"}
            )
            return

        if content_length <= 0:
            self._json_response(400, {"error": "empty_body", "message": "Request body required"})
            return
        if content_length > 200_000:
            self._json_response(413, {"error": "payload_too_large", "message": "Comment exceeds 200KB"})
            return

        try:
            raw = self.rfile.read(content_length)
            payload = json.loads(raw)
        except json.JSONDecodeError as e:
            self._json_response(400, {"error": "invalid_json", "message": str(e)})
            return

        pr_url = (payload.get("prUrl") or "").strip()
        markdown = payload.get("markdown") or ""

        if not pr_url:
            self._json_response(400, {"error": "missing_param", "message": "prUrl required in body"})
            return
        if not markdown.strip():
            self._json_response(400, {"error": "missing_param", "message": "markdown required in body"})
            return
        if len(markdown) > 150_000:
            self._json_response(
                413,
                {
                    "error": "comment_too_large",
                    "message": "ADO PR comments are limited to ~150KB; truncate before posting",
                },
            )
            return

        try:
            parsed = _parse_ado_pr_url(pr_url)
        except ValueError as e:
            self._json_response(400, {"error": "invalid_pr_url", "message": str(e)})
            return

        org = parsed["org"]
        project = parsed["project"]
        repo = parsed["repo"]
        pr_id = parsed["prId"]

        print(f"  [ADO] Posting QA comment to PR #{pr_id} ({len(markdown)} chars)")

        try:
            token = _get_ado_token()
        except subprocess.TimeoutExpired:
            self._json_response(504, {"error": "az_cli_timeout", "message": "Azure CLI timed out acquiring ADO token"})
            return
        except RuntimeError as e:
            self._json_response(502, {"error": "ado_auth_failed", "message": str(e)})
            return

        # ADO Threads API: POST /git/repositories/{repo}/pullRequests/{prId}/threads
        # status=1 (active), commentType=1 (text), threadContext omitted → general thread.
        threads_url = (
            f"https://dev.azure.com/{org}/{project}/_apis/git/repositories/"
            f"{repo}/pullRequests/{pr_id}/threads?api-version=7.1"
        )
        body = json.dumps(
            {
                "comments": [
                    {
                        "parentCommentId": 0,
                        "content": markdown,
                        "commentType": 1,
                    }
                ],
                "status": 1,
            }
        ).encode("utf-8")

        req = urllib.request.Request(
            threads_url,
            data=body,
            method="POST",
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
        )
        try:
            ctx = ssl.create_default_context()
            with urllib.request.urlopen(req, context=ctx, timeout=30) as resp:
                resp_body = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            try:
                err_body = e.read().decode("utf-8")
            except Exception:
                err_body = ""
            status = 502 if e.code >= 500 else (401 if e.code in (401, 403) else 502)
            self._json_response(
                status,
                {
                    "error": f"ado_http_{e.code}",
                    "message": f"ADO returned {e.code}: {e.reason}",
                    "detail": err_body[:500],
                },
            )
            return
        except urllib.error.URLError as e:
            self._json_response(502, {"error": "ado_unreachable", "message": f"Cannot reach ADO: {e.reason}"})
            return
        except TimeoutError:
            self._json_response(504, {"error": "ado_timeout", "message": "ADO API request timed out"})
            return

        thread_id = resp_body.get("id")
        comments = resp_body.get("comments") or []
        comment_id = comments[0].get("id") if comments else None
        thread_url = (
            f"https://dev.azure.com/{org}/{project}/_git/{repo}/pullrequest/{pr_id}?discussionId={thread_id}"
            if thread_id
            else None
        )

        print(f"  [ADO] PR #{pr_id} comment posted: thread {thread_id}")
        self._json_response(
            200,
            {
                "threadId": thread_id,
                "commentId": comment_id,
                "threadUrl": thread_url,
                "prId": pr_id,
            },
        )

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
            self._json_response(
                503,
                {
                    "error": "openai_not_configured",
                    "message": "Azure OpenAI credentials not found in env or donna-app/.env",
                },
            )
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

        # reasoning_effort → reasoning.effort (Responses API). Reasoning
        # models like gpt-5.x consume internal reasoning tokens against the
        # same budget as visible output; without this hint the proxy can
        # silently return content="" when the prompt is large and reasoning
        # eats the whole max_output_tokens budget. Forward when present;
        # non-reasoning deployments ignore the field.
        reasoning_effort = chat_req.get("reasoning_effort")
        if reasoning_effort:
            resp_body_req["reasoning"] = {"effort": reasoning_effort}

        out_body = json.dumps(resp_body_req).encode()

        print(f"  [OpenAI] Proxying via Responses API → {cfg['endpoint']} / {cfg['deployment']}")
        req = urllib.request.Request(
            url,
            data=out_body,
            method="POST",
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
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": content_text},
                        "finish_reason": "stop",
                    }
                ],
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
            self.send_header("Access-Control-Allow-Origin", "*")
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
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
            if result.returncode == 0:
                url = result.stdout.strip()
                # Extract issue number from URL like https://github.com/.../issues/42
                issue_number = None
                if "/issues/" in url:
                    with contextlib.suppress(ValueError, IndexError):
                        issue_number = int(url.rsplit("/issues/", 1)[1])
                self._json_response(
                    200,
                    {
                        "ok": True,
                        "issueUrl": url,
                        "issueNumber": issue_number,
                    },
                )
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
                    "deployErrorKind": None,
                    "deployErrorDetail": None,
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
                    "patchWarnings": [],
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
                    "deployErrorKind": None,
                    "deployErrorDetail": None,
                    "deployLogs": [],
                    "deployTarget": None,
                    "deployStartTime": None,
                    "patchWarnings": [],
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
                err_kind = _studio_state.get("deployErrorKind")
                err_detail = _studio_state.get("deployErrorDetail")
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
                        "errorKind": err_kind,
                        "errorDetail": err_detail,
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
                        "errorKind": err_kind,
                        "errorDetail": err_detail,
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

        bearer = _ensure_bearer()
        if not bearer:
            self._json_response(401, {"error": "no_bearer", "message": "No bearer token available"})
            return

        # Strip /api/flt-proxy prefix to get the controller-relative path
        flt_path = self.path
        if flt_path.startswith("/api/flt-proxy/"):
            flt_path = flt_path[len("/api/flt-proxy") :]

        try:
            # FLT V1 authenticator validates workloadType == "LiveTable" strictly.
            # Using default "Lakehouse" causes 401 on LiveTable controller endpoints.
            mwc_token, host = _get_mwc_token(bearer, ws_id, art_id, cap_id, workload_type="LiveTable")
        except CapacityRoutingError as e:
            self._json_response(
                503,
                {
                    "error": "capacity_routing_not_ready",
                    "retryable": True,
                    "message": str(e),
                },
            )
            return
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
            req.add_header("x-ms-workload-resource-moniker", art_id)

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
            with contextlib.suppress(Exception):
                err_body = e.read().decode("utf-8", errors="replace")[:500]
            # Normalize capacity routing-lag errors to retryable 503.
            # During the first 10-60s after deploy, the capacity may return
            # 400/404 with routing-related messages while propagation completes.
            routing_lag = False
            if e.code in (400, 404):
                probe = (err_body + str(e)).lower()
                routing_lag = any(
                    s in probe for s in ("endpointnotfound", "route not found", "workload not registered", "not found")
                )

            if routing_lag:
                self._json_response(
                    503,
                    {
                        "error": "capacity_routing_not_ready",
                        "retryable": True,
                        "message": f"Capacity routing not propagated yet (upstream {e.code})",
                        "detail": err_body,
                    },
                )
            else:
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

        # SF-002: framework-endpoints.json contributes to the catalog, so its
        # mtime must factor into the cache key. Touching data/framework-endpoints.json
        # in edog-studio invalidates a previously-cached extraction.
        fw_mtime = framework_endpoints_mtime()
        if fw_mtime is not None and fw_mtime > current_mtime:
            current_mtime = fw_mtime

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

    def _resolve_swagger_baseline_path(self):
        """Resolve the baseline Swagger.json path from FLT repo config.

        Returns ``(Path, None)`` on success, or ``(None, err_dict)`` when the
        FLT repo isn't configured or the configured path is invalid. The
        error dict is shaped for direct JSON serialization.
        """
        try:
            cfg = json.loads(CONFIG_PATH.read_text()) if CONFIG_PATH.exists() else {}
        except (OSError, json.JSONDecodeError) as exc:
            return None, {
                "error": "config-read-failed",
                "message": str(exc),
            }
        baseline_path = get_configured_swagger_path(cfg)
        if baseline_path is None:
            return None, {
                "error": "flt-repo-not-configured",
                "message": (
                    "Configure the FLT repo path in EDOG Studio settings — "
                    "the baseline is read from <flt-repo>/Service/"
                    "Microsoft.LiveTable.Service/Swagger/Swagger.json."
                ),
            }
        return baseline_path, None

    def _serve_swagger_spec(self):
        """GET /api/playground/swagger/spec.

        Returns the raw runtime swagger.json fetched from the live FLT instance
        via the Fabric capacity endpoint. Used by the embedded Swagger UI page
        served at /swagger so the UI can render endpoints/schemas/responses.

        Response: 200 application/json (raw OpenAPI document)
                  4xx/5xx envelope from swagger_runtime.fetch_runtime_swagger
        """
        cfg = json.loads(CONFIG_PATH.read_text()) if CONFIG_PATH.exists() else {}
        ws_id = cfg.get("workspace_id", "")
        art_id = cfg.get("artifact_id", "")
        cap_id = cfg.get("capacity_id", "")

        bearer = _ensure_bearer()

        runtime_spec, err = _fetch_runtime_swagger(
            bearer,
            ws_id,
            art_id,
            cap_id,
            token_provider=lambda b, w, a, c: _get_mwc_token(b, w, a, c, workload_type="LiveTable"),
        )
        if err is not None:
            status = err.pop("status", 502)
            self._json_response(status, err)
            return

        body = json.dumps(runtime_spec).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _serve_vendor_asset(self):
        """GET /vendor/<path> — serve vendored static assets.

        Used to ship third-party libraries (e.g., Scalar API Reference) from
        the local dev-server instead of a public CDN, so the FLT OpenAPI
        spec stays fully air-gapped. Files live in scripts/vendor/<...>.

        Defends against path traversal by resolving the requested path under
        VENDOR_ROOT and rejecting anything that escapes it.
        """
        VENDOR_ROOT = (Path(__file__).parent / "vendor").resolve()
        # Strip the /vendor/ prefix and any query/fragment.
        rel = self.path[len("/vendor/") :].split("?", 1)[0].split("#", 1)[0]
        # Reject empty paths and obvious traversal attempts up-front.
        if not rel or ".." in rel.replace("\\", "/").split("/"):
            self._json_response(400, {"error": "bad_path", "message": "Invalid vendor path"})
            return
        try:
            target = (VENDOR_ROOT / rel).resolve()
        except (ValueError, OSError) as exc:
            self._json_response(400, {"error": "bad_path", "message": str(exc)})
            return
        # Confine to VENDOR_ROOT — path-traversal guard.
        try:
            target.relative_to(VENDOR_ROOT)
        except ValueError:
            self._json_response(403, {"error": "forbidden", "message": "Path escapes vendor root"})
            return
        if not target.is_file():
            self._json_response(404, {"error": "not_found", "message": f"No vendor asset at {rel}"})
            return

        # Minimal content-type sniffing — vendored assets are JS/CSS/fonts.
        suffix = target.suffix.lower()
        ctype = {
            ".js": "application/javascript; charset=utf-8",
            ".mjs": "application/javascript; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".map": "application/json; charset=utf-8",
            ".json": "application/json; charset=utf-8",
            ".woff": "font/woff",
            ".woff2": "font/woff2",
            ".svg": "image/svg+xml",
        }.get(suffix, "application/octet-stream")

        data = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        # Versioned filenames \u2192 immutable.
        self.send_header("Cache-Control", "public, max-age=31536000, immutable")
        self.end_headers()
        self.wfile.write(data)

    def _render_vendor_missing(self, asset: str, fix_cmd: str):
        """Render a friendly HTML page when a vendored asset hasn't been fetched.

        Hit by fresh clones before `make vendor` has been run.
        """
        html = (
            "<!doctype html><html><head><meta charset='utf-8'>"
            "<title>EDOG \u2014 vendor asset missing</title>"
            "<style>body{margin:0;background:#f4f5f7;font-family:Inter,system-ui,sans-serif;"
            "color:#1a1d23;display:grid;place-items:center;min-height:100vh}"
            ".card{background:#fff;border:1px solid rgba(0,0,0,.06);border-radius:6px;"
            "padding:32px;max-width:560px;box-shadow:0 2px 8px rgba(0,0,0,.06)}"
            "h2{margin:0 0 12px;font-size:15px;color:#d23f3f}p{font-size:13px;line-height:1.55}"
            "code{background:#f4f5f7;padding:2px 8px;border-radius:4px;"
            "font-family:'Cascadia Code',Consolas,monospace;font-size:12px;color:#6d5cff}"
            ".muted{color:#8e95a5;margin-top:16px}</style></head><body>"
            "<div class='card'>"
            f"<h2>Vendored asset missing: {asset}</h2>"
            "<p>The Swagger viewer ships third-party libraries from the local "
            f"<code>scripts/vendor/</code> folder so the FLT spec stays air-gapped. "
            f"The <strong>{asset}</strong> bundle hasn\u2019t been fetched yet.</p>"
            f"<p>Run: <code>{fix_cmd}</code></p>"
            "<p class='muted'>This is a one-time step after a fresh clone. "
            "Vendored files are gitignored.</p>"
            "</div></body></html>"
        ).encode()
        self.send_response(503)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(html)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(html)

    def _serve_swagger_ui(self):
        """GET /swagger — Swagger UI HTML wrapper.

        Loads the vendored Scalar API Reference bundle from /vendor/scalar/
        and configures it to fetch the OpenAPI spec from our local
        /api/playground/swagger/spec endpoint, which proxies the live FLT
        swagger.json. This works around FLT's own Swagger UI being unreachable
        in DevMode (binds to a random Workload-SDK localhost port that no
        browser tab can reach), and keeps the spec fully air-gapped — no CDN
        beacons, no third-party telemetry.

        Supports two view modes via a banner toggle:
          - UI mode (default): Scalar API Reference (modern, beautiful)
          - JSON mode: pretty-printed spec with copy + download
        Deep-link friendly: ?mode=json switches to JSON on load.
        """
        # Pre-flight: if the vendored Scalar bundle is missing, render a
        # helpful page instead of letting the browser fail with a cryptic
        # 404 on the <script> tag. Fresh clones hit this first.
        scalar_bundle = Path(__file__).parent / "vendor" / "scalar" / "api-reference-1.57.2.js"
        if not scalar_bundle.is_file():
            self._render_vendor_missing("scalar", "make vendor-scalar")
            return
        html = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>FLT API \u2014 Reference</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Ctext y='14' font-size='14' fill='%236d5cff'%3E%E2%97%86%3C/text%3E%3C/svg%3E">
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: #f4f5f7;
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    color: #1a1d23;
  }
  .edog-banner {
    height: 44px; padding: 0 16px;
    background: #ffffff;
    border-bottom: 1px solid rgba(0,0,0,0.06);
    display: flex; align-items: center; gap: 12px;
    font-size: 13px; color: #1a1d23;
    position: sticky; top: 0; z-index: 50;
  }
  .edog-banner .mark { color: #6d5cff; font-size: 14px; line-height: 1; }
  .edog-banner .title { font-weight: 600; letter-spacing: -0.01em; }
  .edog-banner .sep { width: 1px; height: 14px; background: rgba(0,0,0,0.08); }
  .edog-banner .meta { color: #8e95a5; font-size: 12px; }
  .edog-banner .spacer { flex: 1; }
  .edog-banner a.back {
    color: #6d5cff; text-decoration: none;
    font-size: 12px; font-weight: 500;
    padding: 4px 8px; border-radius: 4px;
    transition: background 80ms ease-out;
  }
  .edog-banner a.back:hover { background: rgba(109,92,255,0.07); }

  /* Segmented toggle (UI / JSON) */
  .mode-toggle {
    display: inline-flex; gap: 0;
    background: #f4f5f7;
    border: 1px solid rgba(0,0,0,0.06);
    border-radius: 6px;
    padding: 2px;
  }
  .mode-toggle button {
    appearance: none; border: none; background: transparent;
    font: inherit; font-size: 12px; font-weight: 500;
    color: #5a6070;
    padding: 4px 12px;
    border-radius: 4px; cursor: pointer;
    transition: all 80ms ease-out;
  }
  .mode-toggle button:hover { color: #1a1d23; }
  .mode-toggle button.active {
    background: #ffffff;
    color: #1a1d23;
    box-shadow: 0 1px 2px rgba(0,0,0,0.04);
  }

  .icon-btn {
    appearance: none; background: transparent;
    border: 1px solid rgba(0,0,0,0.06);
    border-radius: 4px; cursor: pointer;
    padding: 4px 10px; font: inherit; font-size: 12px;
    color: #5a6070; transition: all 80ms ease-out;
  }
  .icon-btn:hover { color: #1a1d23; background: rgba(109,92,255,0.04); border-color: rgba(0,0,0,0.12); }
  .icon-btn.primary { color: #6d5cff; border-color: rgba(109,92,255,0.25); }
  .icon-btn.primary:hover { background: rgba(109,92,255,0.07); }

  /* Mode panes */
  .pane { display: none; }
  .pane.active { display: block; }

  #ref-pane { background: #ffffff; min-height: calc(100vh - 44px); }
  #scalar-app:empty + #scalar-err:empty::before {
    content: 'Loading API reference\u2026';
    display: block;
    text-align: center;
    color: #8e95a5;
    font-size: 13px;
    padding: 80px 20px;
  }

  /* JSON mode */
  #json-pane {
    padding: 16px;
    background: #f4f5f7;
    min-height: calc(100vh - 44px);
  }
  .json-toolbar {
    display: flex; gap: 8px; margin-bottom: 12px;
    align-items: center;
  }
  .json-toolbar .info-line { color: #8e95a5; font-size: 12px; margin-left: 8px; }
  pre.json-view {
    margin: 0; padding: 16px 20px;
    background: #ffffff;
    border: 1px solid rgba(0,0,0,0.06);
    border-radius: 6px;
    font-family: 'Cascadia Code', 'JetBrains Mono', 'Fira Code', 'Consolas', monospace;
    font-size: 12px; line-height: 1.55;
    color: #1a1d23;
    overflow: auto;
    box-shadow: 0 1px 2px rgba(0,0,0,0.04);
    max-height: calc(100vh - 100px);
    tab-size: 2;
    white-space: pre;
  }
  /* Light JSON syntax tones */
  .jk { color: #6d5cff; }           /* keys */
  .jstr { color: #2d7d2d; }         /* strings */
  .jnum { color: #c87900; }         /* numbers */
  .jbool { color: #2d7ff9; }        /* booleans */
  .jnull { color: #8e95a5; font-style: italic; } /* null */

  /* Error card (light) */
  .edog-err {
    margin: 60px auto; max-width: 560px; padding: 24px;
    background: #ffffff;
    border: 1px solid rgba(0,0,0,0.06);
    border-radius: 6px;
    color: #1a1d23;
    box-shadow: 0 2px 8px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04);
  }
  .edog-err h2 {
    margin: 0 0 12px; font-size: 15px; font-weight: 600;
    color: #d23f3f; letter-spacing: -0.01em;
  }
  .edog-err p { margin: 8px 0; font-size: 13px; line-height: 1.5; }
  .edog-err code {
    background: #f4f5f7; padding: 2px 6px; border-radius: 4px;
    font-family: 'Cascadia Code', 'JetBrains Mono', 'Consolas', monospace;
    font-size: 12px; color: #5a6070;
  }
  .edog-err .muted { color: #8e95a5; margin-top: 16px; }
</style>
</head>
<body>
<div class="edog-banner">
  <span class="mark">\u25c6</span>
  <span class="title">FLT API \u2014 Reference</span>
  <span class="sep"></span>
  <span class="meta">Served by EDOG Studio \u00b7 powered by Scalar</span>
  <span class="spacer"></span>
  <div class="mode-toggle" role="tablist">
    <button id="mode-ui" class="active" role="tab" aria-selected="true">Reference</button>
    <button id="mode-json" role="tab" aria-selected="false">JSON</button>
  </div>
  <span class="sep"></span>
  <a class="back" href="/" target="_self">\u2190 back to Studio</a>
</div>

<div id="ref-pane" class="pane active">
  <div id="scalar-app"></div>
  <div id="scalar-err"></div>
</div>

<div id="json-pane" class="pane">
  <div class="json-toolbar">
    <button class="icon-btn primary" id="json-copy">Copy</button>
    <button class="icon-btn" id="json-download">Download swagger.json</button>
    <span class="info-line" id="json-info"></span>
  </div>
  <pre class="json-view" id="json-view">Loading\u2026</pre>
</div>

<script src="/vendor/scalar/api-reference-1.57.2.js"></script>
<script>
(function() {
  var loadedSpec = null;
  var loadError = null;

  function setMode(mode) {
    var ui = document.getElementById('ref-pane');
    var js = document.getElementById('json-pane');
    var bu = document.getElementById('mode-ui');
    var bj = document.getElementById('mode-json');
    if (mode === 'json') {
      ui.classList.remove('active'); js.classList.add('active');
      bu.classList.remove('active'); bj.classList.add('active');
      bu.setAttribute('aria-selected', 'false'); bj.setAttribute('aria-selected', 'true');
      history.replaceState(null, '', '?mode=json');
    } else {
      js.classList.remove('active'); ui.classList.add('active');
      bj.classList.remove('active'); bu.classList.add('active');
      bj.setAttribute('aria-selected', 'false'); bu.setAttribute('aria-selected', 'true');
      history.replaceState(null, '', location.pathname);
    }
  }

  document.getElementById('mode-ui').addEventListener('click', function() { setMode('ui'); });
  document.getElementById('mode-json').addEventListener('click', function() { setMode('json'); });

  function escapeHtml(s) {
    return String(s).replace(/[&<>]/g, function(c) {
      return c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;';
    });
  }

  // Minimal JSON syntax tokenizer for the read-only view
  function colorizeJson(json) {
    var s = JSON.stringify(json, null, 2);
    s = escapeHtml(s);
    // Order matters: strings (incl keys) first, then numbers/booleans/null
    s = s.replace(/("(?:[^"\\\\]|\\\\.)*")(\\s*:)?/g, function(m, str, colon) {
      if (colon) return '<span class="jk">' + str + '</span>' + colon;
      return '<span class="jstr">' + str + '</span>';
    });
    s = s.replace(/\\b(true|false)\\b/g, '<span class="jbool">$1</span>');
    s = s.replace(/\\bnull\\b/g, '<span class="jnull">null</span>');
    s = s.replace(/(^|[\\s,\\[])(-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)/g, '$1<span class="jnum">$2</span>');
    return s;
  }

  function renderJsonPane() {
    var pre = document.getElementById('json-view');
    var info = document.getElementById('json-info');
    if (loadError) {
      pre.textContent = JSON.stringify(loadError, null, 2);
      info.textContent = 'spec unavailable';
      return;
    }
    if (!loadedSpec) {
      pre.textContent = 'Loading\u2026';
      info.textContent = '';
      return;
    }
    pre.innerHTML = colorizeJson(loadedSpec);
    var sz = new Blob([JSON.stringify(loadedSpec)]).size;
    var kb = (sz / 1024).toFixed(1);
    var v = (loadedSpec.info && loadedSpec.info.version) ? loadedSpec.info.version : '';
    info.textContent = kb + ' KB' + (v ? ' \u00b7 v' + v : '');
  }

  document.getElementById('json-copy').addEventListener('click', function() {
    if (!loadedSpec) return;
    navigator.clipboard.writeText(JSON.stringify(loadedSpec, null, 2));
    var btn = this; var orig = btn.textContent;
    btn.textContent = 'Copied\u2713'; setTimeout(function() { btn.textContent = orig; }, 1200);
  });
  document.getElementById('json-download').addEventListener('click', function() {
    if (!loadedSpec) return;
    var blob = new Blob([JSON.stringify(loadedSpec, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = 'swagger.json'; document.body.appendChild(a); a.click();
    document.body.removeChild(a); URL.revokeObjectURL(url);
  });

  function renderErrorCard(err) {
    document.getElementById('scalar-err').innerHTML =
      '<div class="edog-err">' +
        '<h2>Could not load FLT swagger spec</h2>' +
        '<p><strong>Error:</strong> ' + escapeHtml(err.error || 'unknown') + '</p>' +
        '<p>' + escapeHtml(err.message || JSON.stringify(err)) + '</p>' +
        '<p class="muted">' +
          'Make sure FLT is deployed and the configured workspace/artifact ' +
          'still exists. The spec is fetched via <code>/api/playground/swagger/spec</code>.' +
        '</p>' +
      '</div>';
  }

  // Honor ?mode=json deep link
  var params = new URLSearchParams(location.search);
  if (params.get('mode') === 'json') setMode('json');

  fetch('/api/playground/swagger/spec', { headers: { 'Accept': 'application/json' } })
    .then(function(r) {
      if (!r.ok) return r.json().then(function(j) { throw j; });
      return r.json();
    })
    .then(function(spec) {
      loadedSpec = spec;
      // Hand the in-memory spec straight to Scalar so we don't double-fetch
      // (and so the spec endpoint's auth/error envelope is honored once).
      if (window.Scalar && typeof Scalar.createApiReference === 'function') {
        // Sidebar polish: replace each operation summary with the last
        // non-parameter path segment (e.g. "/getLatestDag" instead of the
        // full "/v1/workspaces/{wsId}/...") so the sidebar is scannable.
        // Mutates a deep clone — loadedSpec (used by JSON pane + Download)
        // remains the untouched original.
        var sidebarSpec = JSON.parse(JSON.stringify(spec));
        var METHODS = ['get','post','put','patch','delete','head','options','trace'];
        function shortLabel(path) {
          var parts = String(path || '').split('/').filter(Boolean);
          for (var i = parts.length - 1; i >= 0; i--) {
            var seg = parts[i];
            if (!(seg.charAt(0) === '{' && seg.charAt(seg.length - 1) === '}')) {
              return '/' + seg;
            }
          }
          return path || '/';
        }
        if (sidebarSpec && sidebarSpec.paths) {
          Object.keys(sidebarSpec.paths).forEach(function(p) {
            var item = sidebarSpec.paths[p];
            if (!item) return;
            METHODS.forEach(function(m) {
              if (item[m] && typeof item[m] === 'object') {
                item[m].summary = shortLabel(p);
              }
            });
          });
        }
        Scalar.createApiReference('#scalar-app', {
          content: sidebarSpec,
          theme: 'default',
          layout: 'modern',
          documentDownloadType: 'none',
          hideClientButton: false,
          showSidebar: true,
          // Privacy lock-down: the FLT spec is internal-only.
          // - agent.disabled: kills the AI chat that would upload the
          //   OpenAPI doc to Scalar's servers on first message
          //   (otherwise enabled by default on localhost).
          // - withDefaultFonts: don't pull fonts from fonts.scalar.com.
          // - telemetry: opt out of any analytics plugin that may load.
          agent: { disabled: true },
          withDefaultFonts: false,
          telemetry: false,
          showDeveloperTools: 'never',
          metaData: {
            title: 'FLT API Reference',
            description: 'Microsoft Fabric LiveTable workload \u2014 served by EDOG Studio'
          },
          defaultHttpClient: { targetKey: 'shell', clientKey: 'curl' }
        });
      } else {
        renderErrorCard({
          error: 'scalar-not-loaded',
          message: 'Scalar reference library failed to load from CDN'
        });
      }
      renderJsonPane();
    })
    .catch(function(err) {
      loadError = err;
      renderErrorCard(err);
      renderJsonPane();
    });
})();
</script>
</body>
</html>
"""
        body = html.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    # ── P10: Contract proxy routes ────────────────────────────────────

    def _handle_contract_catalog_proxy(self) -> None:
        """P10 M22.1: GET /api/contract/catalog/{zoneId}

        Proxies the contract catalog request to the FLT backend's
        /devmode/qa/catalog/{zoneId} endpoint. Returns the CatalogSnapshot
        envelope with provider statuses and slot descriptors.
        """
        import urllib.parse

        zone_id = self.path[len("/api/contract/catalog/") :]
        zone_id = urllib.parse.unquote(zone_id).strip("/")

        if not zone_id:
            self._json_response(400, {"error": "missing_zone_id", "message": "zoneId is required"})
            return

        # Stub response — in connected mode this would proxy to FLT
        self._json_response(
            200,
            {
                "snapshotId": "stub-snapshot",
                "zoneId": zone_id,
                "fltBuildSha": "unknown",
                "edogRepoSha": "unknown",
                "schemaCapVersion": "1.0",
                "assembledAtUtc": "2026-01-01T00:00:00Z",
                "providerStatus": {"http": "ok", "signalr": "ok", "di": "ok"},
                "slots": [],
                "topicFieldHashes": {},
                "contentHash": "0000000000000000",
            },
        )

    def _handle_contract_capabilities_proxy(self) -> None:
        """P10 M22.2: GET /api/contract/capabilities

        Returns FLT contract capabilities including contractVersion,
        supportedKinds, fltBuildSha, schemaCapVersion.
        """
        self._json_response(
            200,
            {
                "contractVersion": "1.0",
                "supportedKinds": [
                    "HttpRequest",
                    "SignalRBroadcast",
                    "DagTrigger",
                    "FileEvent",
                    "TimerTick",
                    "DiInvocation",
                ],
                "fltBuildSha": "unknown",
                "schemaCapVersion": "1.0",
            },
        )

    def _serve_swagger_diff(self):
        """F09 SF-010: GET /api/playground/swagger/diff.

        Fetches the live swagger.json from the running FLT instance,
        loads the FLT repo's committed ``Swagger/Swagger.json`` baseline,
        and returns the typed diff alongside the raw runtime spec.

        Response shapes:
          200 {runtime, baselineExists, baselineSavedAt, baselineError,
               baselinePath, baselineSource, diff}
              ``diff`` is null when no baseline is present (frontend
              should render a "Sync repo Swagger.json" CTA).
          4xx/5xx envelope when the runtime fetch fails — the same error
              taxonomy as swagger_runtime.fetch_runtime_swagger.
        """
        cfg = json.loads(CONFIG_PATH.read_text()) if CONFIG_PATH.exists() else {}
        ws_id = cfg.get("workspace_id", "")
        art_id = cfg.get("artifact_id", "")
        cap_id = cfg.get("capacity_id", "")

        bearer = _ensure_bearer()

        runtime_spec, err = _fetch_runtime_swagger(
            bearer,
            ws_id,
            art_id,
            cap_id,
            token_provider=lambda b, w, a, c: _get_mwc_token(b, w, a, c, workload_type="LiveTable"),
        )
        if err is not None:
            status = err.pop("status", 502)
            err["runtime"] = None
            self._json_response(status, err)
            return

        baseline_path, path_err = self._resolve_swagger_baseline_path()
        if baseline_path is None:
            # Repo not configured: surface a soft "no baseline" state so
            # the frontend renders the configure-CTA, not a hard error.
            self._json_response(
                200,
                {
                    "runtime": runtime_spec,
                    "baselineExists": False,
                    "baselineSavedAt": None,
                    "baselineError": path_err.get("error"),
                    "baselinePath": None,
                    "baselineSource": "flt-repo",
                    "diff": None,
                },
            )
            return

        baseline_spec, baseline_meta = _load_swagger_baseline(baseline_path)

        diff_payload = None
        if baseline_spec is not None:
            try:
                baseline_norm = _normalize_swagger(baseline_spec)
                runtime_norm = _normalize_swagger(runtime_spec)
                diff_payload = _build_swagger_diff_payload(baseline_norm, runtime_norm)
            except (ValueError, KeyError, TypeError) as exc:
                self._json_response(
                    500,
                    {
                        "error": "diff-failed",
                        "message": f"normalize/diff raised: {exc}",
                        "runtime": runtime_spec,
                        "baselineExists": True,
                        "baselineSavedAt": baseline_meta.get("savedAt"),
                        "baselinePath": str(baseline_path),
                        "baselineSource": "flt-repo",
                    },
                )
                return

        self._json_response(
            200,
            {
                "runtime": runtime_spec,
                "baselineExists": baseline_meta.get("exists", False),
                "baselineSavedAt": baseline_meta.get("savedAt"),
                "baselineError": baseline_meta.get("error"),
                "baselinePath": str(baseline_path),
                "baselineSource": "flt-repo",
                "diff": diff_payload,
            },
        )

    def _serve_swagger_baseline_get(self):
        """F09 SF-011: GET /api/playground/swagger/baseline.

        Returns metadata about the FLT repo's committed Swagger.json.
        The spec body is not returned — callers that need it should use
        the diff endpoint.
        """
        baseline_path, path_err = self._resolve_swagger_baseline_path()
        if baseline_path is None:
            self._json_response(
                200,
                {
                    "exists": False,
                    "savedAt": None,
                    "size": None,
                    "error": path_err.get("error"),
                    "path": None,
                    "source": "flt-repo",
                },
            )
            return
        _, meta = _load_swagger_baseline(baseline_path)
        meta["path"] = str(baseline_path)
        meta["source"] = "flt-repo"
        self._json_response(200, meta)

    def _serve_swagger_baseline_post(self):
        """F09 SF-011: POST /api/playground/swagger/baseline.

        Fetches the live runtime spec and writes it to the FLT repo's
        committed Swagger.json — the developer then reviews the diff
        and commits the change via git. Body is ignored; the source of
        truth is whatever FLT is currently serving.
        """
        baseline_path, path_err = self._resolve_swagger_baseline_path()
        if baseline_path is None:
            self._json_response(400, path_err)
            return

        cfg = json.loads(CONFIG_PATH.read_text()) if CONFIG_PATH.exists() else {}
        ws_id = cfg.get("workspace_id", "")
        art_id = cfg.get("artifact_id", "")
        cap_id = cfg.get("capacity_id", "")
        bearer = _ensure_bearer()

        spec, err = _fetch_runtime_swagger(
            bearer,
            ws_id,
            art_id,
            cap_id,
            token_provider=lambda b, w, a, c: _get_mwc_token(b, w, a, c, workload_type="LiveTable"),
        )
        if err is not None:
            status = err.pop("status", 502)
            self._json_response(status, err)
            return

        try:
            meta = _save_swagger_baseline(baseline_path, spec)
        except (OSError, TypeError) as exc:
            self._json_response(
                500,
                {
                    "error": "baseline-save-failed",
                    "message": str(exc),
                },
            )
            return

        meta["path"] = str(baseline_path)
        meta["source"] = "flt-repo"
        self._json_response(200, meta)

    def _serve_swagger_baseline_delete(self):
        """F09 SF-011: DELETE /api/playground/swagger/baseline.

        Removes the FLT repo's committed Swagger.json. This is a
        destructive write to the user's working tree but recoverable
        via ``git checkout`` — the frontend confirms before calling.
        """
        baseline_path, path_err = self._resolve_swagger_baseline_path()
        if baseline_path is None:
            self._json_response(400, path_err)
            return
        try:
            removed = _remove_swagger_baseline(baseline_path)
        except OSError as exc:
            self._json_response(
                500,
                {
                    "error": "baseline-delete-failed",
                    "message": str(exc),
                },
            )
            return
        self._json_response(
            200,
            {
                "removed": removed,
                "path": str(baseline_path),
                "source": "flt-repo",
            },
        )

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
        bearer = _ensure_bearer()
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
                mwc_token, host = _get_mwc_token(bearer, ws_id, art_id, cap_id, workload_type="LiveTable")
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
        print(
            f"[PLAYGROUND] {token_type} {method} {path} -> {upstream_status} ({duration_ms}ms, {len(upstream_body)}B)"
        )
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

    def _serve_patch_warnings(self):
        """Return the list of pattern_not_found warnings from the last edog.py deploy.

        EDOG patches FLT source via regex anchors. If FLT renames/removes an anchor line,
        the patch returns 'pattern not found' and the deploy proceeds without that patch.
        This endpoint surfaces those warnings so the frontend can show a red banner —
        otherwise the deploy looks green even though interceptors are silently inactive.
        """
        with _studio_lock:
            warnings_list = list(_studio_state.get("patchWarnings") or [])
            phase = _studio_state.get("phase", "idle")
        self._json_response(
            200,
            {
                "warnings": warnings_list,
                "count": len(warnings_list),
                "deployPhase": phase,
            },
        )

    def _serve_interceptors_status(self):
        """Proxy to FLT's EdogLogServer interceptor status endpoint.

        Returns a uniform shape whether FLT is running or not, so the frontend
        chip can render a sensible "unknown" state pre-deploy without special-casing.
        """
        with _studio_lock:
            flt_port = _studio_state.get("fltPort")
            phase = _studio_state.get("phase", "idle")

        if not flt_port or phase not in ("running", "deploying"):
            self._json_response(
                200,
                {
                    "available": False,
                    "deployPhase": phase,
                    "summary": {"Total": 0, "Wrapped": 0, "Failed": 0},
                    "interceptors": [],
                },
            )
            return

        try:
            req = urllib.request.Request(
                f"http://localhost:{flt_port}/api/edog/interceptors/status",
                headers={"Accept": "application/json"},
            )
            with urllib.request.urlopen(req, timeout=3) as r:
                payload = json.loads(r.read().decode("utf-8") or "{}")
            payload["available"] = True
            payload["deployPhase"] = phase
            self._json_response(200, payload)
        except Exception as e:
            self._json_response(
                200,
                {
                    "available": False,
                    "deployPhase": phase,
                    "error": str(e)[:200],
                    "summary": {"Total": 0, "Wrapped": 0, "Failed": 0},
                    "interceptors": [],
                },
            )

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
            git_dirty_edog = repo_info.get("gitDirtyEdog", 0)
            git_dirty_total = repo_info.get("gitDirtyTotal", 0)
        else:
            flt_repo_resp = {
                "configured": repo_info is not None,
                "valid": False,
                "path": repo_info["path"] if repo_info else "",
                "reason": repo_info["reason"] if repo_info else "not_configured",
            }
            git_branch = ""
            git_dirty = 0
            git_dirty_edog = 0
            git_dirty_total = 0

        self._json_response(
            200,
            {
                "tokenHelperBuilt": helper.exists(),
                "hasBearerToken": bearer is not None,
                "bearerExpiresIn": int(bearer_exp - time.time()) if bearer_exp else 0,
                "lastUsername": session.get("lastUsername", ""),
                "gitBranch": git_branch,
                "gitDirtyFiles": git_dirty,
                "gitDirtyEdogFiles": git_dirty_edog,
                "gitDirtyTotal": git_dirty_total,
                "fltRepo": flt_repo_resp,
            },
        )

    def _serve_git_diff(self):
        """GET /api/edog/git-diff — full file list + unified diff for the FLT repo.

        Powers the topbar "+N dirty" badge modal. Returns branch, parsed
        porcelain file list, working-tree diff, and staged diff. All git
        invocations are best-effort; failures degrade to empty strings.
        """
        cfg = {}
        with contextlib.suppress(Exception):
            cfg = json.loads(CONFIG_PATH.read_text()) if CONFIG_PATH.exists() else {}
        repo_info = get_configured_repo(cfg)
        if not repo_info or not repo_info.get("valid"):
            self._json_response(
                200,
                {
                    "configured": repo_info is not None,
                    "valid": False,
                    "reason": (repo_info or {}).get("reason", "not_configured"),
                    "branch": "",
                    "files": [],
                    "diff": "",
                    "stagedDiff": "",
                },
            )
            return

        repo_path = repo_info["path"]
        branch = repo_info.get("gitBranch", "")

        def _run_git(args: list[str]) -> str:
            try:
                result = subprocess.run(
                    ["git", *args],
                    cwd=repo_path,
                    capture_output=True,
                    text=True,
                    timeout=15,
                    check=False,
                    encoding="utf-8",
                    errors="replace",
                )
                if result.returncode != 0:
                    return ""
                return result.stdout
            except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
                return ""

        # EDOG ownership detection: a file is "EDOG" if its path contains
        # /DevMode/ (newly created EDOG infra) OR its basename matches one
        # of the known FLT files that EDOG patches in place.
        edog_patched_basenames = {
            "GTSBasedSparkClient.cs",
            "Program.cs",
            "WorkloadApp.cs",
            "DagExecutionHandlerV2.cs",
            "ParametersManifest.json",
            "Test.json",
            "LiveTableController.cs",
            "LiveTableSchedulerRunController.cs",
            "CustomLiveTableTelemetryReporter.cs",
        }

        def _is_edog_path(p: str) -> bool:
            if not p:
                return False
            norm = p.replace("\\", "/")
            if "/DevMode/" in norm or norm.startswith("DevMode/"):
                return True
            base = norm.rsplit("/", 1)[-1]
            return base in edog_patched_basenames

        porcelain = _run_git(["status", "--porcelain"])
        files = []
        edog_files = []
        for raw_line in porcelain.splitlines():
            if len(raw_line) < 4:
                continue
            # Porcelain format: XY<space>path  (X = index, Y = working tree)
            xy = raw_line[:2]
            path = raw_line[3:].strip()
            # Prefer the working-tree status; fall back to index status; '?' for untracked.
            status = xy[1].strip() or xy[0].strip() or "?"
            is_edog = _is_edog_path(path)
            files.append({"status": status, "path": path, "xy": xy, "isEdog": is_edog})
            if is_edog:
                edog_files.append(path)

        diff = _run_git(["diff", "--no-color"])
        staged_diff = _run_git(["diff", "--cached", "--no-color"])

        self._json_response(
            200,
            {
                "configured": True,
                "valid": True,
                "branch": branch,
                "files": files,
                "edogFiles": edog_files,
                "diff": diff,
                "stagedDiff": staged_diff,
            },
        )

    def _serve_git_blame(self):
        """GET /api/edog/git-blame?file={path} — return per-line blame for a file.

        Caches the parsed porcelain output per (repo, file, mtime) so subsequent
        per-line hover lookups in the diff modal are free. The cache is bounded
        to ~32 files to cap memory.
        """
        parsed = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(parsed.query)
        file_path = (qs.get("file") or [""])[0].strip()
        if not file_path:
            self._json_response(400, {"error": "missing_file"})
            return
        # Reject path traversal / absolute paths / Windows drive letters.
        norm = file_path.replace("\\", "/")
        if norm.startswith("/") or norm.startswith("../") or "/../" in norm or ":" in norm:
            self._json_response(400, {"error": "invalid_path"})
            return

        cfg = {}
        with contextlib.suppress(Exception):
            cfg = json.loads(CONFIG_PATH.read_text()) if CONFIG_PATH.exists() else {}
        repo_info = get_configured_repo(cfg)
        if not repo_info or not repo_info.get("valid"):
            self._json_response(200, {"valid": False, "lines": {}})
            return

        repo_path = repo_info["path"]
        full = Path(repo_path) / norm
        try:
            mtime = full.stat().st_mtime
        except OSError:
            self._json_response(200, {"valid": True, "lines": {}, "reason": "file_missing"})
            return

        cache_key = (str(repo_path), norm)
        cache = getattr(self.__class__, "_BLAME_CACHE", None)
        if cache is None:
            cache = {}
            self.__class__._BLAME_CACHE = cache
        entry = cache.get(cache_key)
        if entry and entry.get("mtime") == mtime:
            self._json_response(200, {"valid": True, "lines": entry["lines"]})
            return

        try:
            result = subprocess.run(
                ["git", "blame", "--porcelain", "--", norm],
                cwd=repo_path,
                capture_output=True,
                text=True,
                timeout=20,
                check=False,
                encoding="utf-8",
                errors="replace",
            )
        except (subprocess.TimeoutExpired, FileNotFoundError, OSError) as e:
            self._json_response(200, {"valid": True, "lines": {}, "reason": f"git_failed:{e}"})
            return
        if result.returncode != 0:
            self._json_response(200, {"valid": True, "lines": {}, "reason": "blame_failed"})
            return

        lines = self._parse_blame_porcelain(result.stdout)

        # LRU-ish: cap to 32 entries.
        if len(cache) >= 32:
            try:
                cache.pop(next(iter(cache)))
            except StopIteration:
                pass
        cache[cache_key] = {"mtime": mtime, "lines": lines}

        self._json_response(200, {"valid": True, "lines": lines})

    @staticmethod
    def _parse_blame_porcelain(text: str) -> dict:
        """Parse `git blame --porcelain` output into {line_no_str: {...}}."""
        if not text:
            return {}
        out: dict[str, dict] = {}
        commits: dict[str, dict] = {}
        i = 0
        lines = text.split("\n")
        current_commit = ""
        current_final_line = 0
        meta: dict = {}
        while i < len(lines):
            raw = lines[i]
            if not raw:
                i += 1
                continue
            # Block header: "<sha> <orig> <final> [num_lines]"
            parts = raw.split(" ")
            if len(parts) >= 3 and len(parts[0]) == 40 and all(c in "0123456789abcdef" for c in parts[0]):
                current_commit = parts[0]
                try:
                    current_final_line = int(parts[2])
                except ValueError:
                    current_final_line = 0
                meta = commits.setdefault(current_commit, {})
                i += 1
                # Read sub-headers until tab-prefixed content line.
                while i < len(lines) and not lines[i].startswith("\t"):
                    sub = lines[i]
                    if sub.startswith("author "):
                        meta["author"] = sub[len("author ") :]
                    elif sub.startswith("author-time "):
                        try:
                            meta["authorTime"] = int(sub[len("author-time ") :])
                        except ValueError:
                            pass
                    elif sub.startswith("summary "):
                        meta["summary"] = sub[len("summary ") :]
                    i += 1
                # Skip the tab-prefixed content line itself.
                if i < len(lines) and lines[i].startswith("\t"):
                    i += 1
                # Record this line.
                if current_final_line > 0:
                    out[str(current_final_line)] = {
                        "hash": current_commit[:7],
                        "author": meta.get("author", ""),
                        "authorTime": meta.get("authorTime", 0),
                        "summary": meta.get("summary", ""),
                        "timeAgo": _time_ago(meta.get("authorTime", 0)),
                    }
            else:
                # Out-of-band line; advance.
                i += 1
        return out

    # ── Test coverage ────────────────────────────────────────────

    def _find_latest_cobertura(self, repo_root: Path) -> Path | None:
        results_dir = repo_root / "TestResults"
        if not results_dir.is_dir():
            return None
        latest = None
        latest_mtime = -1.0
        for p in results_dir.rglob("coverage.cobertura.xml"):
            try:
                m = p.stat().st_mtime
            except OSError:
                continue
            if m > latest_mtime:
                latest_mtime = m
                latest = p
        return latest

    @staticmethod
    def _parse_cobertura(xml_path: Path, repo_root: Path) -> dict:
        """Parse a cobertura XML into the diff-modal coverage shape."""
        import xml.etree.ElementTree as ET

        tree = ET.parse(xml_path)
        root = tree.getroot()

        # <sources><source>...</source></sources> — strip these to get repo-relative paths.
        sources = []
        for src in root.findall(".//sources/source"):
            if src.text:
                s = src.text.replace("\\", "/").rstrip("/")
                sources.append(s)
        repo_norm = str(repo_root).replace("\\", "/").rstrip("/")
        if repo_norm not in sources:
            sources.append(repo_norm)

        def _to_repo_rel(fname: str) -> str:
            if not fname:
                return ""
            n = fname.replace("\\", "/")
            for s in sources:
                if n.lower().startswith(s.lower() + "/"):
                    return n[len(s) + 1 :]
            # Already relative? Return as-is.
            if not (len(n) > 1 and n[1] == ":") and not n.startswith("/"):
                return n
            return n.rsplit("/", 1)[-1]

        files: dict[str, dict] = {}
        for cls in root.findall(".//class"):
            fname = cls.get("filename") or ""
            rel = _to_repo_rel(fname)
            if not rel:
                continue
            entry = files.setdefault(rel, {"lines": {}, "covered": 0, "total": 0, "pct": 0.0})
            for line in cls.findall("./lines/line"):
                num = line.get("number")
                hits_attr = line.get("hits") or "0"
                if not num:
                    continue
                try:
                    hits = int(hits_attr)
                except ValueError:
                    hits = 0
                covered = hits > 0
                prev = entry["lines"].get(num)
                # If the same line is reported by multiple classes (partials),
                # collapse to covered if any hits it.
                if prev is None:
                    entry["lines"][num] = covered
                    entry["total"] += 1
                    if covered:
                        entry["covered"] += 1
                elif covered and not prev:
                    entry["lines"][num] = True
                    entry["covered"] += 1

        total_covered = 0
        total_lines = 0
        for f in files.values():
            f["pct"] = round((f["covered"] / f["total"]) * 100.0, 1) if f["total"] else 0.0
            total_covered += f["covered"]
            total_lines += f["total"]
        summary = {
            "covered": total_covered,
            "total": total_lines,
            "pct": round((total_covered / total_lines) * 100.0, 1) if total_lines else 0.0,
        }

        # Index by basename too as a fallback for paths that don't share a sources prefix.
        basenames: dict[str, str] = {}
        for path in files:
            bn = path.rsplit("/", 1)[-1]
            # Only record unambiguous basenames.
            if bn in basenames:
                basenames[bn] = ""
            else:
                basenames[bn] = path
        basenames = {k: v for k, v in basenames.items() if v}

        return {"files": files, "summary": summary, "basenameIndex": basenames}

    def _serve_coverage_get(self):
        """GET /api/edog/coverage — return latest parsed cobertura coverage (cached)."""
        cfg = {}
        with contextlib.suppress(Exception):
            cfg = json.loads(CONFIG_PATH.read_text()) if CONFIG_PATH.exists() else {}
        repo_info = get_configured_repo(cfg)
        if not repo_info or not repo_info.get("valid"):
            self._json_response(200, {"valid": False, "reason": "no_repo"})
            return
        repo_root = Path(repo_info["path"])
        cobertura = self._find_latest_cobertura(repo_root)
        if not cobertura:
            self._json_response(200, {"valid": True, "available": False, "reason": "no_results"})
            return
        try:
            mtime = cobertura.stat().st_mtime
        except OSError:
            self._json_response(200, {"valid": True, "available": False, "reason": "stat_failed"})
            return
        cache = getattr(self.__class__, "_COV_CACHE", None)
        if cache is None:
            cache = {}
            self.__class__._COV_CACHE = cache
        key = (str(repo_root), str(cobertura))
        entry = cache.get(key)
        if entry and entry.get("mtime") == mtime:
            data = entry["data"]
        else:
            try:
                data = self._parse_cobertura(cobertura, repo_root)
            except Exception as e:
                self._json_response(200, {"valid": True, "available": False, "reason": f"parse_failed:{e}"})
                return
            cache[key] = {"mtime": mtime, "data": data}
        self._json_response(
            200,
            {
                "valid": True,
                "available": True,
                "source": str(cobertura.relative_to(repo_root))
                if cobertura.is_relative_to(repo_root)
                else str(cobertura),
                "generatedAt": int(mtime),
                "files": data["files"],
                "summary": data["summary"],
                "basenameIndex": data.get("basenameIndex", {}),
            },
        )

    def _serve_coverage_run(self):
        """POST /api/edog/coverage/run — synchronously run `dotnet test` with coverage."""
        cfg = {}
        with contextlib.suppress(Exception):
            cfg = json.loads(CONFIG_PATH.read_text()) if CONFIG_PATH.exists() else {}
        repo_info = get_configured_repo(cfg)
        if not repo_info or not repo_info.get("valid"):
            self._json_response(200, {"ok": False, "reason": "no_repo"})
            return
        repo_root = Path(repo_info["path"])
        test_proj = repo_root / "test" / "Microsoft.LiveTable.Service.UnitTests"
        if not test_proj.is_dir():
            self._json_response(200, {"ok": False, "reason": "test_project_missing", "path": str(test_proj)})
            return
        results_dir = repo_root / "TestResults"
        results_dir.mkdir(exist_ok=True)
        started = time.time()
        try:
            proc = subprocess.run(
                [
                    "dotnet",
                    "test",
                    str(test_proj),
                    "--collect:XPlat Code Coverage",
                    "--results-directory",
                    str(results_dir),
                    "--no-build",
                    "-q",
                ],
                cwd=str(repo_root),
                capture_output=True,
                text=True,
                timeout=600,
                check=False,
                encoding="utf-8",
                errors="replace",
            )
        except subprocess.TimeoutExpired:
            self._json_response(200, {"ok": False, "reason": "timeout", "elapsedSec": round(time.time() - started, 1)})
            return
        except (FileNotFoundError, OSError) as e:
            self._json_response(200, {"ok": False, "reason": f"dotnet_unavailable:{e}"})
            return
        elapsed = round(time.time() - started, 1)
        if proc.returncode != 0:
            self._json_response(
                200,
                {
                    "ok": False,
                    "reason": "test_failed",
                    "exitCode": proc.returncode,
                    "elapsedSec": elapsed,
                    "stderr": (proc.stderr or "")[-2000:],
                    "stdout": (proc.stdout or "")[-2000:],
                },
            )
            return
        # Invalidate cache so the next GET re-parses.
        cache = getattr(self.__class__, "_COV_CACHE", None)
        if cache is not None:
            cache.clear()
        self._json_response(200, {"ok": True, "elapsedSec": elapsed})

    def _serve_repo_scan(self):
        """POST /api/edog/repo-scan — auto-detect FLT repos on disk."""
        result = find_flt_repos(max_depth=4, limit=10, timeout_sec=5.0)
        self._json_response(200, result)

    # ── Feature-flag overrides (F11-C03) ──────────────────────────────────

    def _push_overrides_to_flt(self, snapshot, revision):
        """Push the snapshot to FLT (synchronous). Records the result and
        returns a UI-friendly fltSync dict for inclusion in the response.
        """
        result = feature_overrides.push_snapshot_to_flt(
            snapshot,
            revision,
            flt_port=FLT_INTERNAL_PORT,
            control_token=EDOG_CONTROL_TOKEN,
        )
        feature_overrides.record_push(result)
        return {
            "fltSync": result.flt_sync,
            "revision": result.revision,
            "hash": result.local_hash,
            "fltHash": result.flt_hash,
            "fltRevision": result.flt_revision,
            "statusCode": result.status_code,
            "error": result.error,
            "durationMs": round(result.duration_ms, 2),
        }

    def _serve_feature_flags_catalog(self):
        """GET /api/edog/feature-flags/catalog — declared FLT flags + FM enrichment."""
        try:
            cfg = json.loads(CONFIG_PATH.read_text()) if CONFIG_PATH.exists() else {}
        except (OSError, json.JSONDecodeError) as e:
            self._json_response(500, {"error": "config_read_failed", "detail": str(e)})
            return
        flt_repo_path = cfg.get("flt_repo_path", "")
        if not flt_repo_path or not Path(flt_repo_path).is_dir():
            self._json_response(
                500,
                {"error": "flt_repo_not_configured", "detail": "flt_repo_path missing or invalid"},
            )
            return

        overrides_snapshot, _, _ = feature_overrides.get_snapshot()
        # Seed the FM cache with the wire keys declared by FLT before the
        # background sync runs. This caps indexing to ~30-50 files instead
        # of the full ~13K FM repo. parse_feature_names is cheap (one .cs
        # file read + regex) so calling it here in addition to inside
        # build_catalog is acceptable.
        try:
            declared = feature_flags_catalog.parse_feature_names(Path(flt_repo_path))
            _FM_CACHE.set_declared_keys(e["wireKey"] for e in declared)
        except FileNotFoundError as e:
            self._json_response(500, {"error": "feature_names_missing", "detail": str(e)})
            return
        except Exception:
            traceback.print_exc()
        # Non-blocking: ensure a background sync is in flight when we're cold
        # or past TTL. UI gets stale=true in the response and re-polls.
        try:
            _FM_CACHE.ensure_synced()
        except Exception:
            traceback.print_exc()
        try:
            payload = feature_flags_catalog.build_catalog(
                Path(flt_repo_path),
                workspace_id=cfg.get("workspace_id") or None,
                capacity_id=cfg.get("capacity_id") or None,
                tenant_id=cfg.get("tenant_id") or None,
                fm_cache=_FM_CACHE,
                overrides_snapshot=overrides_snapshot,
                home_env=cfg.get("edog_env") or None,
            )
        except FileNotFoundError as e:
            self._json_response(500, {"error": "feature_names_missing", "detail": str(e)})
            return
        except Exception as e:
            traceback.print_exc()
            self._json_response(500, {"error": "catalog_build_failed", "detail": str(e)})
            return
        self._json_response(200, payload)

    def _serve_feature_flags_overrides_get(self):
        """GET /api/edog/feature-flags/overrides — current map + last push status."""
        snap, rev, hsh = feature_overrides.get_snapshot()
        last_push = feature_overrides.get_last_push()
        self._json_response(
            200,
            {
                "overrides": snap,
                "revision": rev,
                "hash": hsh,
                "count": len(snap),
                "lastPush": last_push,
            },
        )

    def _serve_feature_flags_raw(self, wire_key):
        """GET /api/edog/feature-flags/raw/{wireKey} — raw FM definition.

        Returns the JSON document indexed by ``Id == wireKey``. 404 if the
        wire key is unknown to the FM cache (either the cache hasn't synced
        or the flag is missing in FM).
        """
        if not wire_key:
            self._json_response(400, {"error": "wire_key_required"})
            return
        try:
            doc = _FM_CACHE.get(wire_key)
        except Exception as e:
            traceback.print_exc()
            self._json_response(500, {"error": "fm_cache_unavailable", "detail": str(e)})
            return
        if doc is None:
            self._json_response(
                404,
                {"error": "not_found", "wireKey": wire_key, "detail": "Flag not in FM cache"},
            )
            return
        # FM repo URL pattern: Features/<area>/<file>.json. We can synthesize
        # an "open in repo" URL by looking at the cache's known repo metadata.
        status = _FM_CACHE.status()
        self._json_response(
            200,
            {
                "wireKey": wire_key,
                "definition": doc,
                "fmRepoUrl": status.get("repoUrl"),
                "fmBranch": status.get("branch"),
            },
        )

    def _serve_feature_flags_overrides_post(self):
        """POST /api/edog/feature-flags/overrides — body {flag, value:true}.

        Sets a single force-ON override, then pushes the full map to FLT.
        Returns the new snapshot and ``fltSync`` outcome (per architecture §3.6).
        """
        try:
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length)) if length else {}
        except (json.JSONDecodeError, ValueError):
            self._json_response(400, {"error": "invalid_json"})
            return

        flag = body.get("flag")
        value = body.get("value")
        if not isinstance(flag, str) or not flag:
            self._json_response(400, {"error": "missing_flag"})
            return
        if value is not True:
            self._json_response(
                400,
                {"error": "force_off_not_supported", "message": "Only value=true is allowed in V1"},
            )
            return

        try:
            snap, rev = feature_overrides.set_override(flag, value)
        except ValueError as e:
            self._json_response(400, {"error": "validation_failed", "detail": str(e)})
            return

        sync = self._push_overrides_to_flt(snap, rev)
        self._json_response(
            200,
            {
                "overrides": snap,
                "revision": rev,
                "hash": feature_overrides.compute_hash(snap),
                "count": len(snap),
                "fltSync": sync,
            },
        )

    def _serve_feature_flags_overrides_delete(self, flag):
        """DELETE /api/edog/feature-flags/overrides/{flag} — remove one entry."""
        if not flag:
            self._json_response(400, {"error": "missing_flag"})
            return
        try:
            snap, rev, existed = feature_overrides.delete_override(flag)
        except ValueError as e:
            self._json_response(400, {"error": "validation_failed", "detail": str(e)})
            return
        if not existed:
            self._json_response(404, {"error": "no_such_override", "flag": flag})
            return
        sync = self._push_overrides_to_flt(snap, rev)
        self._json_response(
            200,
            {
                "overrides": snap,
                "revision": rev,
                "hash": feature_overrides.compute_hash(snap),
                "count": len(snap),
                "fltSync": sync,
            },
        )

    def _serve_feature_flags_overrides_reset(self):
        """POST /api/edog/feature-flags/overrides/reset — clear all entries."""
        snap, rev = feature_overrides.reset_overrides()
        sync = self._push_overrides_to_flt(snap, rev)
        self._json_response(
            200,
            {
                "overrides": snap,
                "revision": rev,
                "hash": feature_overrides.compute_hash(snap),
                "count": 0,
                "fltSync": sync,
            },
        )

    def _serve_feature_flags_refresh(self):
        """POST /api/edog/feature-flags/refresh — force-refetch the FM cache.

        Kicks off a sync regardless of TTL; returns immediately with the
        current status (the background thread populates the index).
        """
        started = _FM_CACHE.ensure_synced(force=True)
        self._json_response(
            200,
            {
                "syncStarted": started,
                "fm": _FM_CACHE.status(),
            },
        )

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

    def _serve_import_dag(self):
        """GET /api/import-dag — fetch getLatestDag for an arbitrary lakehouse.

        Acquires a LiveTable MWC token on demand for the target ws/lh/cap and
        proxies a single GET to the FLT controller's getLatestDag endpoint.
        Used by the wizard's "Import from Lakehouse" flow to replicate an
        existing lakehouse's DAG topology without requiring connected mode.

        Query params: wsId, lhId, capId (all required).
        Returns: 200 with DAG JSON on success; 404 when lakehouse has no FLT
                 service / never had MLVs defined; structured error otherwise.
        """
        parsed = urllib.parse.urlparse(self.path)
        params = urllib.parse.parse_qs(parsed.query)
        ws_id = params.get("wsId", [None])[0]
        lh_id = params.get("lhId", [None])[0]
        cap_id = params.get("capId", [None])[0]
        if not all([ws_id, lh_id, cap_id]):
            self._json_response(
                400,
                {"error": "missing_params", "message": "wsId, lhId, and capId are required"},
            )
            return

        bearer = _ensure_bearer()
        if not bearer:
            self._json_response(401, {"error": "no_bearer", "message": "No bearer token available"})
            return

        try:
            mwc_token, host = _get_mwc_token(bearer, ws_id, lh_id, cap_id, workload_type="LiveTable")
        except urllib.error.HTTPError as e:
            body = ""
            with contextlib.suppress(Exception):
                body = e.read().decode("utf-8", "replace")[:500]
            self._json_response(e.code, {"error": "mwc_token_error", "message": body or str(e)})
            return
        except Exception as e:
            self._json_response(502, {"error": "mwc_token_error", "message": str(e)})
            return

        target_url = (
            f"{host}/webapi/capacities/{cap_id}/workloads/LiveTable"
            f"/LiveTableService/automatic"
            f"/v1/workspaces/{ws_id}/lakehouses/{lh_id}"
            f"/liveTable/getLatestDag?showExtendedLineage=true"
        )

        try:
            req = urllib.request.Request(target_url, method="GET")
            req.add_header("Authorization", f"MwcToken {mwc_token}")
            req.add_header("Content-Type", "application/json")
            ctx = ssl.create_default_context()
            with urllib.request.urlopen(req, timeout=30, context=ctx) as resp:
                resp_body = resp.read()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(resp_body)))
            self.end_headers()
            self.wfile.write(resp_body)
        except urllib.error.HTTPError as e:
            err_body = ""
            with contextlib.suppress(Exception):
                err_body = e.read().decode("utf-8", "replace")[:500]
            self._json_response(
                e.code,
                {"error": "flt_import_error", "message": str(e), "detail": err_body},
            )
        except Exception as e:
            self._json_response(502, {"error": "flt_import_error", "message": str(e)})

    def _serve_mwc_tables(self):
        """GET /api/mwc/tables — list lakehouse tables across all schemas.

        Schemas-enabled lakehouses partition tables under `/schemas/{name}/tables`. The
        legacy public REST endpoint returns 400 `UnsupportedOperationForSchemasEnabledLakehouse`
        for these. We:
          1. Enumerate schemas via OneLake DFS (each directory under `Tables/` is a schema).
          2. Fan out a MWC `/schemas/{name}/tables` call per schema in parallel.
          3. Merge results with `schemaName` annotated on each table row.

        Envelope: `{tables: [...], schemas: [{name, isShortcut, tableCount}]}` plus a
        per-schema `errors` array for partial failures (one bad shortcut schema
        shouldn't kill the whole listing).
        """
        parsed = urllib.parse.urlparse(self.path)
        params = urllib.parse.parse_qs(parsed.query)
        ws_id = params.get("wsId", [None])[0]
        lh_id = params.get("lhId", [None])[0]
        cap_id = params.get("capId", [None])[0]

        if not all([ws_id, lh_id, cap_id]):
            self._json_response(400, {"error": "missing_params", "message": "wsId, lhId, and capId are required"})
            return

        bearer = _ensure_bearer()
        if not bearer:
            self._json_response(401, {"error": "no_bearer_token", "message": "Bearer token not cached"})
            return

        # Step 1 — enumerate schemas via OneLake DFS.
        try:
            schemas = _list_lakehouse_schemas(ws_id, lh_id)
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", "replace")[:500]
            self._json_response(
                e.code,
                {"error": "schema_listing_failed", "message": body, "detail": "OneLake DFS request failed"},
            )
            return
        except RuntimeError as e:
            self._json_response(401, {"error": "onelake_bearer_unavailable", "message": str(e)})
            return
        except Exception as e:
            traceback.print_exc()
            self._json_response(502, {"error": "schema_listing_failed", "message": str(e)})
            return

        if not schemas:
            # Lakehouse exists but has no schemas yet — return empty envelope.
            self._json_response(200, {"data": [], "schemas": [], "continuationToken": None})
            return

        # Step 2 — acquire an MWC token (one token serves all per-schema calls).
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
        mwc_headers = {
            "Authorization": f"MwcToken {token}",
            "x-ms-workload-resource-moniker": lh_id,
            "Content-Type": "application/json",
        }
        ctx = ssl.create_default_context()

        def fetch_schema(schema: dict) -> tuple[dict, list[dict] | None, str | None]:
            """Fetch tables for a single schema. Returns (schema, tables, error_msg)."""
            sname = schema["name"]
            url = f"{host}{base}/artifacts/DataArtifact/{lh_id}/schemas/{sname}/tables"
            try:
                req = urllib.request.Request(url, headers=mwc_headers, method="GET")
                with urllib.request.urlopen(req, timeout=30, context=ctx) as resp:
                    payload = json.loads(resp.read())
                rows = payload.get("data") or payload.get("value") or []
                for row in rows:
                    row["schemaName"] = sname
                return schema, rows, None
            except urllib.error.HTTPError as exc:
                msg = exc.read().decode("utf-8", "replace")[:200]
                return schema, None, f"HTTP {exc.code}: {msg}"
            except Exception as exc:
                return schema, None, f"{type(exc).__name__}: {exc}"

        # Step 3 — fan out per-schema calls. Cap at 6 workers — schemas usually 1-4,
        # but we don't want a runaway lakehouse with 50 schemas to DoS the upstream.
        merged_tables: list[dict] = []
        schema_results: list[dict] = []
        errors: list[dict] = []
        print(f"  [MWC] Fetching tables across {len(schemas)} schema(s): {[s['name'] for s in schemas]}")
        with ThreadPoolExecutor(max_workers=min(6, len(schemas))) as pool:
            futures = [pool.submit(fetch_schema, s) for s in schemas]
            for fut in as_completed(futures):
                schema, rows, err = fut.result()
                if err is not None:
                    errors.append({"schema": schema["name"], "error": err})
                    schema_results.append(
                        {
                            "name": schema["name"],
                            "isShortcut": schema.get("isShortcut", False),
                            "tableCount": 0,
                            "error": err,
                        }
                    )
                    continue
                merged_tables.extend(rows)
                schema_results.append(
                    {
                        "name": schema["name"],
                        "isShortcut": schema.get("isShortcut", False),
                        "tableCount": len(rows),
                    }
                )

        # Preserve the directory-order schema sequence (parallel futures complete in
        # any order; restore by sorting against the original schemas list).
        order = {s["name"]: i for i, s in enumerate(schemas)}
        schema_results.sort(key=lambda r: order.get(r["name"], 999))

        print(
            f"  [MWC] Merged {len(merged_tables)} table(s) across {len(schema_results)} schema(s)"
            + (f"; {len(errors)} schema error(s)" if errors else "")
        )

        self._json_response(
            200,
            {
                "data": merged_tables,
                "schemas": schema_results,
                "continuationToken": None,
                **({"errors": errors} if errors else {}),
            },
        )

    def _serve_mwc_table_details(self):
        """POST /api/mwc/table-details — batch get table details, grouped per schema.

        Request body accepts either shape:
          - New: `tables: [{name, schema}, ...]` (schemas-aware)
          - Legacy: `tables: ["name1", ...]` (assumes "dbo" — kept for backwards compat
            but will hit the same MWC 400 the legacy callers used to hit on schemas-
            enabled lakehouses; new callers should always send the new shape).

        Tables are grouped by schema → one `/schemas/{name}/batchGetTableDetails` call
        per schema. Each call may return an `operationId` requiring polling — we poll
        each operation in parallel after kickoff. Final response merges all per-schema
        results into a single `tables` array, with `schemaName` annotated on every row.
        """
        content_len = int(self.headers.get("Content-Length", 0))
        if content_len == 0:
            self._json_response(400, {"error": "empty_body", "message": "Request body required"})
            return

        body = json.loads(self.rfile.read(content_len))
        ws_id = body.get("wsId")
        lh_id = body.get("lhId")
        cap_id = body.get("capId")
        tables_raw = body.get("tables", [])

        if not all([ws_id, lh_id, cap_id, tables_raw]):
            self._json_response(
                400,
                {
                    "error": "missing_params",
                    "message": "wsId, lhId, capId, and tables are required",
                },
            )
            return

        # Group requested tables by schema. Legacy string entries fall back to "dbo".
        by_schema: dict[str, list[str]] = {}
        for entry in tables_raw:
            if isinstance(entry, str):
                by_schema.setdefault("dbo", []).append(entry)
            elif isinstance(entry, dict) and entry.get("name"):
                sname = entry.get("schema") or entry.get("schemaName") or "dbo"
                by_schema.setdefault(sname, []).append(entry["name"])
            # Silently skip malformed entries — frontend shouldn't be sending those.

        if not by_schema:
            self._json_response(400, {"error": "no_valid_tables", "message": "No valid table entries in request"})
            return

        bearer = _ensure_bearer()
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
        mwc_headers = {
            "Authorization": f"MwcToken {token}",
            "x-ms-workload-resource-moniker": lh_id,
            "Content-Type": "application/json",
        }
        ctx = ssl.create_default_context()
        print(
            f"  [MWC] POST batchGetTableDetails across {len(by_schema)} schema(s): "
            + ", ".join(f"{s}({len(t)})" for s, t in by_schema.items())
        )

        def fetch_schema_details(schema_name: str, names: list[str]) -> tuple[str, dict | None, str | None]:
            """Submit + poll batchGetTableDetails for one schema. Returns (schema, payload, error)."""
            url = f"{host}{base}/artifacts/DataArtifact/{lh_id}/schemas/{schema_name}/batchGetTableDetails"
            try:
                req_body = json.dumps({"tables": names}).encode()
                req = urllib.request.Request(url, data=req_body, headers=mwc_headers, method="POST")
                with urllib.request.urlopen(req, timeout=30, context=ctx) as resp:
                    resp_data = json.loads(resp.read())

                operation_id = resp_data.get("operationId")
                if not operation_id:
                    return schema_name, resp_data, None

                # Poll until the operation completes (max 20s per schema).
                poll_url = f"{url}/operationResults/{operation_id}"
                for attempt in range(20):
                    time.sleep(1)
                    poll_req = urllib.request.Request(poll_url, headers=mwc_headers, method="GET")
                    with urllib.request.urlopen(poll_req, timeout=30, context=ctx) as poll_resp:
                        poll_data = json.loads(poll_resp.read())

                    status = (poll_data.get("status") or "").lower()
                    if status in ("succeeded", "completed"):
                        print(f"  [MWC] {schema_name} batch completed after {attempt + 1}s")
                        return schema_name, poll_data, None
                    if status in ("failed", "cancelled"):
                        return schema_name, None, f"operation_{status}"

                return schema_name, None, f"poll_timeout (operation {operation_id})"
            except urllib.error.HTTPError as exc:
                msg = exc.read().decode("utf-8", "replace")[:200]
                return schema_name, None, f"HTTP {exc.code}: {msg}"
            except Exception as exc:
                return schema_name, None, f"{type(exc).__name__}: {exc}"

        merged_tables: list[dict] = []
        errors: list[dict] = []
        with ThreadPoolExecutor(max_workers=min(6, len(by_schema))) as pool:
            futures = {pool.submit(fetch_schema_details, sname, names): sname for sname, names in by_schema.items()}
            for fut in as_completed(futures):
                sname, payload, err = fut.result()
                if err is not None:
                    errors.append({"schema": sname, "error": err})
                    continue
                # LRO response shape from MWC is `{ result: { value: [...] }, id, status }`.
                # We also accept the rarer flat shapes for defensive forward-compat.
                inner_result = payload.get("result") if isinstance(payload.get("result"), dict) else {}
                rows = (
                    inner_result.get("value")
                    or payload.get("tables")
                    or payload.get("data")
                    or payload.get("value")
                    or []
                )
                for row in rows:
                    if isinstance(row, dict):
                        row["schemaName"] = sname
                        merged_tables.append(row)

        # Partial-success semantics: 200 with results + an `errors` array if any schema failed.
        # The frontend can decide whether to surface per-row failures.
        status = 200 if merged_tables or not errors else 502
        self._json_response(
            status,
            {
                "tables": merged_tables,
                **({"errors": errors} if errors else {}),
            },
        )

    def _serve_table_stats(self):
        """GET /api/mwc/table-stats — read row count and size from OneLake delta log.

        Query params:
          - wsId, lhId, tableName (required)
          - schema (optional; defaults to "dbo" for backwards compat with non-schemas
            lakehouses, but new callers should always pass the schema discovered via
            /api/mwc/tables)

        Returns: `{ tableName, rowCount, sizeBytes, fileCount }`. Returns
        `{rowCount: null, error: "delta_log_not_found"}` on 404 (table not materialized
        yet, e.g. a freshly-created MLV).
        """
        parsed = urllib.parse.urlparse(self.path)
        params = urllib.parse.parse_qs(parsed.query)
        ws_id = params.get("wsId", [None])[0]
        lh_id = params.get("lhId", [None])[0]
        table_name = params.get("tableName", [None])[0]
        schema = params.get("schema", ["dbo"])[0] or "dbo"

        if not all([ws_id, lh_id, table_name]):
            self._json_response(400, {"error": "missing_params", "message": "wsId, lhId, and tableName required"})
            return

        # OneLake DFS requires a storage-scoped bearer (different audience from the
        # cached Power BI bearer). The previous version of this endpoint used the wrong
        # bearer and silently returned 404/401 on every call.
        try:
            onelake_bearer = _ensure_onelake_bearer()
        except RuntimeError as e:
            self._json_response(401, {"error": "onelake_bearer_unavailable", "message": str(e)})
            return

        log_path = f"/{ws_id}/{lh_id}/Tables/{schema}/{table_name}/_delta_log"
        ctx = ssl.create_default_context()

        try:
            # List delta log files
            list_url = f"{ONELAKE_HOST}{log_path}?resource=filesystem&recursive=false"
            req = urllib.request.Request(
                list_url,
                headers={"Authorization": f"Bearer {onelake_bearer}"},
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
                file_url = f"{ONELAKE_HOST}/{ws_id}/{jf}"
                req = urllib.request.Request(
                    file_url,
                    headers={"Authorization": f"Bearer {onelake_bearer}"},
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
                    "schemaName": schema,
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
                        "schemaName": schema,
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

    def _serve_onelake_table_metadata(self):
        """GET /api/onelake/table-metadata — read FLT/Spark catalog metadata for a single table.

        Query params (all required): wsId, lhId, schema, table.

        Fetches `{lh}/Tables/{schema}/{table}/_metadata/table.json.gz` from OneLake DFS
        and zlib-decompresses it (note: the file uses raw zlib despite the `.gz` suffix —
        FLT writes it with `ZlibStream`, not GZipStream; see workload-fabriclivetable's
        LakeHouseMetastoreClientWithShortcutSupport.GetIfTableAsync).

        For MATERIALIZED_LAKE_VIEW tables, the returned JSON includes `viewText`
        (the SELECT statement) and `sourceEntities` (the upstream tables it reads).
        For regular MANAGED tables, it includes `allColumns`, `partitionColumnNames`,
        `storage`, and Delta `properties`. No deployed FLT service is required —
        the file is written by Spark/Lakehouse at table creation time.

        Returns:
            200 + parsed JSON body on success.
            404 + `{error: "metadata_not_found"}` when the `_metadata/` directory does
                not exist (auto-discovered Delta tables without FLT-managed metadata).
            401 if the OneLake bearer cannot be minted.
            502 on parse/decompression errors.
        """
        parsed = urllib.parse.urlparse(self.path)
        params = urllib.parse.parse_qs(parsed.query)
        ws_id = params.get("wsId", [None])[0]
        lh_id = params.get("lhId", [None])[0]
        schema = params.get("schema", [None])[0]
        table = params.get("table", [None])[0]

        if not all([ws_id, lh_id, schema, table]):
            self._json_response(
                400,
                {
                    "error": "missing_params",
                    "message": "wsId, lhId, schema, and table are required",
                },
            )
            return

        try:
            onelake_bearer = _ensure_onelake_bearer()
        except RuntimeError as e:
            self._json_response(401, {"error": "onelake_bearer_unavailable", "message": str(e)})
            return

        # Canonical FLT path. Constants.DefaultTableMetadataFilePath = "_metadata/table.json.gz".
        path = f"/{ws_id}/{lh_id}/Tables/{schema}/{table}/_metadata/table.json.gz"
        url = f"{ONELAKE_HOST}{path}"
        ctx = ssl.create_default_context()

        try:
            req = urllib.request.Request(
                url,
                headers={"Authorization": f"Bearer {onelake_bearer}"},
            )
            with urllib.request.urlopen(req, timeout=15, context=ctx) as resp:
                raw = resp.read()
        except urllib.error.HTTPError as e:
            if e.code == 404:
                self._json_response(
                    404,
                    {
                        "error": "metadata_not_found",
                        "message": (
                            "No FLT-managed metadata for this table. "
                            "Auto-discovered Delta tables don't have a _metadata/table.json.gz."
                        ),
                        "schemaName": schema,
                        "tableName": table,
                    },
                )
                return
            body = e.read().decode("utf-8", "replace")[:200]
            self._json_response(e.code, {"error": "onelake_error", "message": body})
            return
        except Exception as e:
            self._json_response(502, {"error": "fetch_error", "message": str(e)})
            return

        # FLT uses ZlibStream (RFC 1950) — first 2 bytes are 78 9C / 78 DA. Some
        # writers may use gzip (1F 8B); handle both defensively.
        try:
            if len(raw) >= 2 and raw[0] == 0x1F and raw[1] == 0x8B:
                # gzip
                decompressed = zlib.decompress(raw, wbits=zlib.MAX_WBITS | 16)
            else:
                # raw zlib (FLT default)
                decompressed = zlib.decompress(raw)
            metadata = json.loads(decompressed)
        except (zlib.error, json.JSONDecodeError) as e:
            self._json_response(
                502,
                {
                    "error": "decode_error",
                    "message": f"Failed to decompress/parse table.json.gz: {e}",
                },
            )
            return

        # Echo identifiers so the client doesn't have to track them across the round-trip.
        # `name` in the JSON itself is not always populated (FLT sets it at runtime).
        metadata.setdefault("schemaName", schema)
        metadata.setdefault("tableName", table)
        self._json_response(200, metadata)

    def _serve_onelake_table_rows(self):
        """GET /api/onelake/table-preview-rows — read first N rows of a Lakehouse Delta table.

        Query params (required): wsId, lhId, schema, table.
        Query params (optional): limit (default 10, max 100).

        Approach: replay `_delta_log/*.json` via `_enumerate_delta_active_files_full`
        to find the current snapshot's active parquet files, deterministically pick
        the first one (sorted by path), download it via OneLake DFS, and read up
        to `limit` rows via pyarrow. Partition columns (which Delta stores in the
        log, not in parquet) are injected as a separate group of trailing columns
        and marked `isPartition: true`.

        Returns 200 with:
            {
              schemaName, tableName,
              columns: [{name, type, isPartition?}],
              rows: [{colName: value, ...}],
              rowsReturned, truncated, fileCount, sourceFile, warnings: []
            }

        Returns 404 with `error: "delta_log_not_found"` if the table has no
        `_delta_log/` directory (not a Delta table or never materialized).
        Returns 502 on parquet fetch/parse failures.

        v1 caveats (surfaced via the `warnings` array):
          - Deletion vectors are not honored — deleted rows may appear.
          - Tables with > 200 commits replay only the most recent 200.
          - Tables with checkpoint parquet files: state in the checkpoint is
            skipped (only commit JSONs are read).
          - Struct/list/map columns render as JSON; binary as hex (<=64B) or
            "<binary, N bytes>" placeholder.
        """
        parsed = urllib.parse.urlparse(self.path)
        params = urllib.parse.parse_qs(parsed.query)
        ws_id = params.get("wsId", [None])[0]
        lh_id = params.get("lhId", [None])[0]
        schema = params.get("schema", [None])[0]
        table = params.get("table", [None])[0]
        try:
            limit = max(1, min(100, int(params.get("limit", ["10"])[0])))
        except (TypeError, ValueError):
            limit = 10

        if not all([ws_id, lh_id, schema, table]):
            self._json_response(
                400,
                {
                    "error": "missing_params",
                    "message": "wsId, lhId, schema, and table are required",
                },
            )
            return

        try:
            active, warnings = _enumerate_delta_active_files_full(ws_id, lh_id, schema, table)
        except urllib.error.HTTPError as e:
            if e.code == 404:
                self._json_response(
                    404,
                    {
                        "error": "delta_log_not_found",
                        "message": (
                            "Table has no _delta_log/ directory. "
                            "Either it is not a Delta table or it has never been materialized."
                        ),
                        "schemaName": schema,
                        "tableName": table,
                    },
                )
                return
            body = e.read().decode("utf-8", "replace")[:200]
            self._json_response(e.code, {"error": "onelake_error", "message": body})
            return
        except RuntimeError as e:
            self._json_response(401, {"error": "onelake_bearer_unavailable", "message": str(e)})
            return
        except Exception as e:
            self._json_response(502, {"error": "delta_log_replay_failed", "message": str(e)})
            return

        if not active:
            self._json_response(
                200,
                {
                    "schemaName": schema,
                    "tableName": table,
                    "columns": [],
                    "rows": [],
                    "rowsReturned": 0,
                    "truncated": False,
                    "fileCount": 0,
                    "warnings": [
                        *warnings,
                        "No active data files in Delta log — table is empty.",
                    ],
                },
            )
            return

        # Read rows across ALL active parquet files (sorted by path) until we
        # reach `limit` rows. The previous version only read the first file,
        # which missed rows in tables split across multiple small files.
        try:
            onelake_bearer = _ensure_onelake_bearer()
        except RuntimeError as e:
            self._json_response(401, {"error": "onelake_bearer_unavailable", "message": str(e)})
            return

        import io

        import pyarrow as pa
        import pyarrow.parquet as pq

        ctx = ssl.create_default_context()
        all_rows: list[dict] = []
        arrow_schema = None
        merged_partition_values: dict = {}
        files_read = 0

        for fpath in sorted(active.keys()):
            if len(all_rows) >= limit:
                break
            add = active[fpath]
            partition_values = add.get("partitionValues") or {}
            if not merged_partition_values:
                merged_partition_values = partition_values

            file_url = f"{ONELAKE_HOST}/{ws_id}/{lh_id}/Tables/{schema}/{table}/{fpath}"
            try:
                req = urllib.request.Request(file_url, headers={"Authorization": f"Bearer {onelake_bearer}"})
                with urllib.request.urlopen(req, timeout=30, context=ctx) as resp:
                    raw_parquet = resp.read()
            except Exception:
                # Skip unreadable files — partial results are better than none
                continue

            try:
                pf = pq.ParquetFile(io.BytesIO(raw_parquet))
                remaining = limit - len(all_rows)
                first = next(pf.iter_batches(batch_size=remaining), None)
                if first is None:
                    continue
                tbl = pa.Table.from_batches([first])
                if tbl.num_rows > remaining:
                    tbl = tbl.slice(0, remaining)
                if arrow_schema is None:
                    arrow_schema = tbl.schema
                py_rows = tbl.to_pylist()

                coerced_part = {k: _coerce_partition_value(v) for k, v in partition_values.items()}
                for r in py_rows:
                    out = {k: _coerce_parquet_value(v) for k, v in r.items()}
                    for pcol, pval in coerced_part.items():
                        out.setdefault(pcol, pval)
                    all_rows.append(out)
                files_read += 1
            except Exception:
                continue

        if arrow_schema is None:
            self._json_response(
                200,
                {
                    "schemaName": schema,
                    "tableName": table,
                    "columns": [],
                    "rows": [],
                    "rowsReturned": 0,
                    "truncated": False,
                    "fileCount": len(active),
                    "warnings": [*warnings, "Could not read any parquet files."],
                },
            )
            return

        columns: list[dict] = [{"name": f.name, "type": _arrow_type_label(f.type)} for f in arrow_schema]
        existing_names = {c["name"] for c in columns}
        for pcol in merged_partition_values:
            if pcol not in existing_names:
                columns.append({"name": pcol, "type": "string", "isPartition": True})

        self._json_response(
            200,
            {
                "schemaName": schema,
                "tableName": table,
                "columns": columns,
                "rows": all_rows,
                "rowsReturned": len(all_rows),
                "truncated": len(all_rows) >= limit,
                "fileCount": len(active),
                "filesRead": files_read,
                "warnings": warnings,
            },
        )

    def _serve_onelake_item_timestamps(self):
        """GET /api/onelake/item-timestamps — surface OneLake DFS filesystem timestamps.

        Query params:
            wsId (required): Workspace object ID.
            lhId (optional): Lakehouse object ID. When supplied, the lakehouse's
                creation time (Windows FILETIME on the first child under the
                lakehouse directory — typically ``Tables/``) is included.

        Returns (200):
            {
                "workspaceCreatedAt":   ISO8601 UTC string (earliest artifact lastModified) or null,
                "workspaceLastActivity": ISO8601 UTC string (latest artifact lastModified) or null,
                "lakehouseCreatedAt":   ISO8601 UTC string or null  // only when lhId given
            }

        Notes:
            - OneLake DFS returns ``lastModified`` as an HTTP-date string
              (RFC 7231, e.g. ``"Tue, 19 May 2026 16:53:35 GMT"``).
            - ``creationTime`` is a Windows FILETIME — 100-ns ticks since
              1601-01-01 UTC; we convert to unix seconds with
              ``ticks / 10_000_000 - 11_644_473_600``.
        """
        parsed = urllib.parse.urlparse(self.path)
        params = urllib.parse.parse_qs(parsed.query)
        ws_id = params.get("wsId", [None])[0]
        lh_id = params.get("lhId", [None])[0]

        if not ws_id:
            self._json_response(400, {"error": "missing_params", "message": "wsId is required"})
            return

        try:
            token = _ensure_onelake_bearer()
        except RuntimeError as e:
            self._json_response(401, {"error": "onelake_bearer_unavailable", "message": str(e)})
            return

        ctx = ssl.create_default_context()
        result: dict = {
            "workspaceCreatedAt": None,
            "workspaceLastActivity": None,
            "lakehouseCreatedAt": None,
        }

        # Workspace: list root artifacts and extract earliest/latest lastModified.
        try:
            ws_url = f"{ONELAKE_HOST}/{ws_id}?resource=filesystem&recursive=false"
            req = urllib.request.Request(ws_url, headers={"Authorization": f"Bearer {token}"})
            with urllib.request.urlopen(req, timeout=15, context=ctx) as resp:
                ws_payload = json.loads(resp.read())
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", "replace")[:200]
            self._json_response(e.code, {"error": "onelake_error", "message": body})
            return
        except Exception as e:
            self._json_response(502, {"error": "fetch_error", "message": str(e)})
            return

        earliest: datetime | None = None
        latest: datetime | None = None
        for entry in ws_payload.get("paths", []):
            lm = entry.get("lastModified")
            if not lm:
                continue
            try:
                # HTTP-date is always GMT; strptime treats trailing "GMT" as a literal.
                dt = datetime.strptime(lm, "%a, %d %b %Y %H:%M:%S GMT").replace(tzinfo=timezone.utc)
            except ValueError:
                continue
            if earliest is None or dt < earliest:
                earliest = dt
            if latest is None or dt > latest:
                latest = dt

        if earliest is not None:
            result["workspaceCreatedAt"] = earliest.isoformat()
        if latest is not None:
            result["workspaceLastActivity"] = latest.isoformat()

        # Lakehouse: read children of the lakehouse directory to pull the
        # FILETIME creationTime from the first folder (Tables/).
        if lh_id:
            try:
                qs = urllib.parse.urlencode(
                    {
                        "directory": lh_id,
                        "recursive": "false",
                        "resource": "filesystem",
                    }
                )
                lh_url = f"{ONELAKE_HOST}/{ws_id}?{qs}"
                req2 = urllib.request.Request(lh_url, headers={"Authorization": f"Bearer {token}"})
                with urllib.request.urlopen(req2, timeout=15, context=ctx) as resp2:
                    lh_payload = json.loads(resp2.read())
            except urllib.error.HTTPError as e:
                if e.code != 404:
                    body = e.read().decode("utf-8", "replace")[:200]
                    self._json_response(e.code, {"error": "onelake_error", "message": body})
                    return
                lh_payload = {"paths": []}
            except Exception as e:
                self._json_response(502, {"error": "fetch_error", "message": str(e)})
                return

            for entry in lh_payload.get("paths", []):
                ct = entry.get("creationTime")
                if not ct:
                    continue
                try:
                    ticks = int(ct)
                except (TypeError, ValueError):
                    continue
                unix_seconds = ticks / 10_000_000 - 11_644_473_600
                try:
                    created = datetime.fromtimestamp(unix_seconds, tz=timezone.utc)
                except (OverflowError, OSError, ValueError):
                    continue
                result["lakehouseCreatedAt"] = created.isoformat()
                break

        self._json_response(200, result)

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

        bearer = _ensure_bearer()
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

        bearer = _ensure_bearer()
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

        bearer = _ensure_bearer()
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

        bearer = _ensure_bearer()
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

        bearer = _ensure_bearer()
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

        bearer = _ensure_bearer()
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


if __name__ == "__main__":
    # Console may be cp1252 on Windows when stdout is piped to a non-terminal
    # consumer (e.g., a launcher subprocess). Existing log lines use Unicode
    # symbols (checkmarks, arrows, warnings); reconfigure to UTF-8 so they
    # don't UnicodeEncodeError at startup.
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, OSError):
        pass

    class ThreadedHTTPServer(ThreadingMixIn, HTTPServer):
        """Handle each request in a new thread to avoid blocking on slow MWC calls."""

        daemon_threads = True

    # Port-guard: kill any prior dev-server instance still holding :5555 so the
    # OS doesn't load-balance requests between stale and fresh code (the
    # "ghost 404" failure mode where two processes share the same listener).
    _stale = _kill_port_listeners(5555)
    if _stale:
        print(f"  [port-guard] Reclaimed port 5555 from {len(_stale)} stale process(es): {_stale}")

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

    # ── Feature-flag override control plane bootstrap ─────────────────
    # 1. Cold-start: clear any stale overrides FLT may have retained from a
    #    prior dev-server process. Architecture §3.6 §2.b. Best-effort —
    #    if FLT isn't running yet (the common case), this no-ops.
    # 2. Drift detection: every 30s, GET FLT's snapshot and re-push if its
    #    hash diverges from ours. Architecture §3.8.
    def _coldstart_clear_flt_overrides():
        try:
            feature_overrides._internal_force_reset()
            snap, rev, _ = feature_overrides.get_snapshot()
            result = feature_overrides.push_snapshot_to_flt(
                snap, rev, flt_port=FLT_INTERNAL_PORT, control_token=EDOG_CONTROL_TOKEN
            )
            if result.flt_sync == "applied":
                print("  ✓ FLT override map cleared on cold-start.")
        except Exception as e:
            print(f"  ⚠ Cold-start FLT clear failed (non-fatal): {e}")

    def _drift_detection_loop():
        import urllib.error
        import urllib.request

        while True:
            time.sleep(30)
            try:
                snap, rev, local_hash = feature_overrides.get_snapshot()
                req = urllib.request.Request(
                    f"http://localhost:{FLT_INTERNAL_PORT}/api/edog/feature-flags/overrides",
                    method="GET",
                )
                with urllib.request.urlopen(req, timeout=5) as resp:
                    body = json.loads(resp.read().decode("utf-8"))
                flt_hash = body.get("hash")
                if flt_hash and flt_hash != local_hash:
                    print(f"  ⚠ Drift detected (FLT hash={flt_hash[:8]} vs local={local_hash[:8]}); re-pushing.")
                    feature_overrides.push_snapshot_to_flt(
                        snap, rev, flt_port=FLT_INTERNAL_PORT, control_token=EDOG_CONTROL_TOKEN
                    )
            except (urllib.error.URLError, OSError, TimeoutError):
                # FLT not running or unreachable — silently retry next tick.
                pass
            except Exception as e:
                print(f"  ⚠ Drift detection tick failed: {e}")

    # Cold-start clear runs once in a daemon thread (defers ConnectionRefused
    # latency away from the main listen path).
    threading.Thread(target=_coldstart_clear_flt_overrides, daemon=True, name="edog-coldstart").start()
    threading.Thread(target=_drift_detection_loop, daemon=True, name="edog-drift").start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down EDOG Studio...")

        # 1. Stop the FLT process tree we launched in this session (if any).
        # _flt_process is `dotnet run --no-build` — the actual FLT EntryPoint
        # runs as its CHILD. .terminate() only kills the dotnet wrapper and
        # leaves the EntryPoint orphaned. Use taskkill /T on Windows so the
        # whole tree dies in one shot. POSIX falls back to SIGTERM + reap.
        if _flt_process and _flt_process.poll() is None:
            pid = _flt_process.pid
            print(f"  Stopping FLT process tree (root PID: {pid})...")
            try:
                if sys.platform == "win32":
                    subprocess.run(
                        ["taskkill", "/F", "/T", "/PID", str(pid)],
                        capture_output=True,
                        timeout=10,
                    )
                else:
                    _flt_process.terminate()
                    try:
                        _flt_process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        _flt_process.kill()
            except Exception as e:
                print(f"  ⚠ Tree kill failed: {e}; falling back to terminate().")
                with contextlib.suppress(Exception):
                    _flt_process.terminate()
                    _flt_process.wait(timeout=5)
            print("  ✓ FLT process tree terminated.")

        # 2. Sweep any orphan FLT processes from prior sessions OR any that
        # escaped the tree-kill above (image-name-based, defensive).
        orphans = _kill_stale_flt_processes()
        if orphans:
            print(f"  ✓ Killed {len(orphans)} orphan FLT process(es) by image name.")

        # 3. Clean up injected DevMode token.
        with contextlib.suppress(Exception):
            _cleanup_devmode_token()

        # 4. Always run python edog.py --revert on shutdown. It is idempotent
        # — when nothing is applied, it returns 0 quickly. The `.edog-changes.patch`
        # artefact gets unlinked at the END of revert, so its presence is NOT a
        # reliable "patches applied" indicator. Better to pay ~1-3s on every
        # shutdown than leave a stale patched tree on disk.
        edog_py = PROJECT_DIR / "edog.py"
        if edog_py.exists():
            print("  Reverting EDOG patches (this may take ~10s)...")
            try:
                result = subprocess.run(
                    [sys.executable, str(edog_py), "--revert"],
                    capture_output=True,
                    text=True,
                    timeout=30,
                    encoding="utf-8",
                    errors="replace",
                )
                if result.returncode == 0:
                    print("  ✓ Patches reverted (or already clean).")
                else:
                    print("  ⚠ Revert returned non-zero — run manually: python edog.py --revert")
                    if result.stderr:
                        print(f"     stderr: {result.stderr.strip()[:200]}")
            except subprocess.TimeoutExpired:
                print("  ⚠ Revert timed out after 30s — run manually: python edog.py --revert")
            except Exception as e:
                print(f"  ⚠ Revert failed: {e} — run manually: python edog.py --revert")

        server.server_close()
        print("Server stopped.")
