# EDOG Proxy Performance Overhaul

> **Date:** 2026-06-19
> **Author:** Sana (architecture), Vex (backend), Pixel (frontend)
> **Status:** Approved

## Problem

Every proxied request in dev-server.py opens a fresh TCP+TLS connection to upstream Azure INT hosts. Combined with per-request SSL context creation, disk-based config reads, and no token pre-warming, each API call pays 100-400ms in pure infrastructure overhead before any data moves. The capacity list API (`/v1/capacities`) was additionally using an untested endpoint.

## Root Causes (ranked by impact)

| # | Issue | Per-request cost | Sites affected |
|---|-------|:---:|:---:|
| 1 | No TCP/TLS connection reuse (urllib has no pooling) | +100-300ms | All proxy paths |
| 2 | `ssl.create_default_context()` per-request | +5-20ms | 28 call sites |
| 3 | `CONFIG_PATH.read_text()` + `json.loads()` per-request | +0.5-50ms | 25 call sites |
| 4 | MWC token not pre-warmed at startup | +200-600ms first call | Cold start |
| 5 | Wrong-node retry sleeps too long (100ms base) | +500-1000ms worst case | FLT proxy |
| 6 | Schema-enabled lakehouse always tries doomed listTables | +150-400ms wasted RTT | Frontend |
| 7 | Full response buffering before first byte to browser | +20-200ms TTFB | All proxy paths |

## Solution: 8 Changes, One Holistic Pass

### Change 1: Module-level SSL context

Create `_SSL_CTX = ssl.create_default_context()` once at module level. Replace all 28 per-request `ssl.create_default_context()` calls with `_SSL_CTX`.

`ssl.SSLContext` is thread-safe for reading after creation. Zero risk.

### Change 2: Config caching with TTL

Add `_get_config()` function with 10-second in-memory TTL cache. Replace all 25 `json.loads(CONFIG_PATH.read_text())` call sites. Thread-safe via `_config_cache_lock`.

Config changes are rare (explicit user action). 10s TTL is more than fast enough.

### Change 3: urllib3 connection pooling

**Dependency:** `urllib3>=2.7` (upgrade from 2.4.0, already transitive dep)

Add two module-level pools:

```python
import urllib3

# 10 keepalive connections to the redirect host (Fabric APIs, token minting)
_POOL_REDIRECT = urllib3.HTTPSConnectionPool(
    "biazure-int-edog-redirect.analysis-df.windows.net",
    port=443,
    maxsize=10,
    timeout=urllib3.Timeout(connect=10, read=30),
    retries=False,  # manual retry logic
)

# Dynamic pool manager for capacity hosts (hostname varies by capId)
_POOL_CAPACITY = urllib3.PoolManager(
    num_pools=20,
    maxsize=6,
    timeout=urllib3.Timeout(connect=10, read=30),
    retries=False,
)
```

Replace `urllib.request.urlopen` at all proxy call sites:

- `_proxy_fabric()` → `_POOL_REDIRECT.request(method, path, ...)`
- `_proxy_to_flt()` → `_POOL_CAPACITY.request(method, url, ...)`
- `_get_mwc_token()` → `_POOL_REDIRECT.request("POST", ...)`
- `_urlopen_with_mwc_retry()` → accept pool parameter
- All fan-out paths (`_serve_mwc_tables`, `_serve_mwc_table_details`, etc.)

**Key difference:** `urllib3.HTTPSConnectionPool.request()` reuses TCP connections via HTTP keep-alive. After the first request, subsequent calls skip the TCP+TLS handshake entirely. Thread-safe by design.

**Note:** Some call sites (OneLake DFS, ADO proxy, Jupyter) use one-off hosts. These stay on `_POOL_CAPACITY` (PoolManager handles dynamic hosts) or use a simple `urllib3.request()` for truly rare calls.

### Change 4: MWC token pre-warm at startup

Background thread started after server binds:

```python
def _prewarm_mwc_token():
    time.sleep(2)  # let server bind
    cfg = _get_config()
    if all([cfg.get("workspace_id"), cfg.get("artifact_id"), cfg.get("capacity_id")]):
        bearer = _ensure_bearer()
        if bearer:
            _get_mwc_token(bearer, ws, art, cap, workload_type="LiveTable")
```

First FLT request goes from 200-600ms to ~0ms.

### Change 5: Reduce wrong-node retry sleeps

In `_urlopen_with_mwc_retry`:

```python
# Before: time.sleep(0.1 * (attempt + 1))  → 100ms, 200ms, 300ms, 400ms = 1000ms total
# After:  time.sleep(0.05 * (attempt + 1)) → 50ms, 100ms, 150ms, 200ms  = 500ms total
```

The routing hint header is the fix, not the sleep. 50ms is sufficient for gateway processing.

### Change 6: Background token refresh (all phases)

Extend `_token_refresh_loop` to run regardless of deploy phase, not just when `phase == "running"`. Refresh every 40min (inside the 45min usable window). Prevents mid-session token expiry stalls.

### Change 7: Skip doomed listTables for schema-enabled lakehouses

In `workspace-explorer.js` `_loadTables()`:

```javascript
if (capId) {
  // Schema-enabled lakehouses: go straight to capacity host
  return await this._api.listTablesViaCapacity(wsId, lhId, capId);
}
// Fallback for non-capacity mode
return await this._api.listTables(wsId, lhId);
```

Eliminates 1 wasted round-trip per lakehouse expand.

### Change 8: Chunked response streaming

For proxy paths that pass through unmodified response bodies, use chunked transfer encoding to stream data to the browser as it arrives.

**Streamable paths (no body transformation):**
- `_proxy_to_flt()` — FLT API responses are forwarded as-is
- `_proxy_fabric()` — MOST paths (non-workspace-listing)

**Must stay buffered (body is transformed or inspected):**
- `_proxy_fabric()` when `is_workspace_list=True` — needs `_normalize_workspaces()`
- `_serve_create_capacity()` — cache invalidation depends on success
- Error responses — need to parse JSON for logging
- LRO 202 responses — need `Location` and `Retry-After` headers before body

**Implementation pattern:**

```python
def _stream_response(self, resp, *, extra_headers=None):
    """Stream upstream response to browser via chunked transfer encoding."""
    self.send_response(resp.status)
    self.send_header("Content-Type", resp.headers.get("Content-Type", "application/json"))
    self.send_header("Transfer-Encoding", "chunked")
    if extra_headers:
        for k, v in extra_headers.items():
            self.send_header(k, v)
    self.end_headers()
    # Stream in 64KB chunks
    while True:
        chunk = resp.read(65536)
        if not chunk:
            break
        self.wfile.write(f"{len(chunk):x}\r\n".encode())
        self.wfile.write(chunk)
        self.wfile.write(b"\r\n")
    self.wfile.write(b"0\r\n\r\n")  # final chunk
```

**Edge cases:**
- `urllib3` response objects support `read(amt)` for chunked reads (unlike `urllib.request` which buffers internally)
- Connection-level errors mid-stream: catch, log, and close — browser sees truncated response and retries
- `preload_content=False` must be set on urllib3 requests to enable streaming

## Expected Impact

| Metric | Before | After |
|--------|--------|-------|
| Warm Fabric API call | 100-350ms | 10-50ms |
| Warm FLT API call | 150-400ms | 15-80ms |
| Cold-start first FLT call | 200-600ms | ~0ms |
| Wrong-node recovery | 100-1000ms | 50-500ms |
| Schema lakehouse expand | 2x round-trips | 1x |
| Large response TTFB | 100-300ms | 20-50ms |

## Files Modified

- `scripts/dev-server.py` — changes 1-6, 8 (connection pools, config cache, SSL context, streaming, retries)
- `src/frontend/js/workspace-explorer.js` — change 7 (skip doomed listTables)
- `requirements.txt` — add `urllib3>=2.7`
- `pyproject.toml` — add `urllib3>=2.7` to dependencies

## What Stays Unchanged

- Token caching logic (well-designed)
- Fan-out `ThreadPoolExecutor` pattern (correct)
- SSE deploy stream (already persistent)
- Frontend `_fltFetchWithRetry` retry logic
- Capacity cache (just added)

## Testing

- Existing test suite passes (no behavior change, only performance)
- Manual verification: restart dev-server, observe `[POOL]` / `[CACHE]` log lines
- Compare TTFB in browser DevTools before/after

## ADR Reference

This is an implementation optimization, not an architectural change. No new ADR needed. Follows ADR-002 (vanilla JS), ADR-003 (single HTML file), and ADR-006 (SignalR+MessagePack) — none are affected.
