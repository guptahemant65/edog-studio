"""Feature-flag override map (dev-server side).

Holds the durable in-memory override map and pushes it to FLT via the HTTP
control plane on EdogLogServer (per F11/architecture.md §3). Source of truth
for the dev-server session — restarts clear the map.

Threading model
---------------
A single ``RLock`` (``_lock``) guards the map, revision counter, and last-push
status. All mutation paths take the lock; the FLT push happens OUTSIDE the
lock (after the snapshot is captured) so a slow FLT can't block other
endpoints.

Revision and hash
-----------------
``_revision`` increments on every successful mutation. The hash is SHA-256 of
the canonical sorted ``"key=true\\n"`` lines, matching
``EdogFeatureOverrideStore.ComputeHash`` byte-for-byte. Round-trip mismatch
between dev-server's computed hash and FLT's echoed hash is a hard error.

Async note
----------
The push call is synchronous (urllib). The dev-server HTTP server is threaded,
so blocking on the FLT POST blocks only the calling handler. Budget is < 200 ms
p95 (architecture §7).
"""

from __future__ import annotations

import hashlib
import json
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field

# -----------------------------------------------------------------------------
# Module state.
# -----------------------------------------------------------------------------

_lock = threading.RLock()
_overrides: dict[str, bool] = {}
_revision: int = 0
_EMPTY_HASH = hashlib.sha256(b"").hexdigest()
_last_push: dict[str, object] = {
    "fltSync": "not-connected",  # applied | pending | failed | not-connected
    "revision": 0,
    "hash": _EMPTY_HASH,
    "error": None,
    "at": None,
}


@dataclass
class PushResult:
    """Outcome of a single push to FLT."""

    flt_sync: str  # applied | failed | not-connected
    revision: int
    local_hash: str
    flt_hash: str | None = None
    flt_revision: int | None = None
    status_code: int | None = None
    error: str | None = None
    duration_ms: float = 0.0
    headers_echoed: dict[str, str] = field(default_factory=dict)


# -----------------------------------------------------------------------------
# Hashing — must match EdogFeatureOverrideStore.ComputeHash byte-for-byte.
# -----------------------------------------------------------------------------


def compute_hash(snapshot: dict[str, bool]) -> str:
    """SHA-256 of sorted ``"key=true|false\\n"`` lines, lower-case hex.

    Mirrors ``EdogFeatureOverrideStore.ComputeHash`` exactly — both force-ON
    (``"key=true\\n"``) and force-OFF (``"key=false\\n"``) entries serialize
    verbatim, so the round-trip hash check holds for either direction.
    """
    if not snapshot:
        return hashlib.sha256(b"").hexdigest()
    lines = []
    for key in sorted(snapshot.keys()):
        val = "true" if snapshot[key] else "false"
        lines.append(f"{key}={val}\n")
    return hashlib.sha256("".join(lines).encode("utf-8")).hexdigest()


# -----------------------------------------------------------------------------
# Read API.
# -----------------------------------------------------------------------------


def get_snapshot() -> tuple[dict[str, bool], int, str]:
    """Return (overrides_copy, revision, hash) atomically."""
    with _lock:
        snap = dict(_overrides)
        rev = _revision
    return snap, rev, compute_hash(snap)


def get_last_push() -> dict[str, object]:
    """Return a copy of the most-recent push result for UI consumption."""
    with _lock:
        return dict(_last_push)


# -----------------------------------------------------------------------------
# Mutation API. Each returns a snapshot under the lock; caller pushes outside.
# -----------------------------------------------------------------------------


def _validate_flag_name(flag: str) -> None:
    if not isinstance(flag, str) or not flag:
        raise ValueError("flag name must be a non-empty string")
    if len(flag) > 256:
        raise ValueError("flag name exceeds 256 characters")
    # FLT wire keys are PascalCase / camelCase identifiers per FeatureNames.cs.
    # Permissive check — refuse only control chars and whitespace.
    for ch in flag:
        if ord(ch) < 0x20 or ch in (" ", "\t", "\n", "\r"):
            raise ValueError(f"flag name contains invalid character: {flag!r}")


def set_override(flag: str, value: bool) -> tuple[dict[str, bool], int]:
    """Set ``flag`` to ``value`` (True=force-ON, False=force-OFF). Returns
    (snapshot, revision). Both directions are supported on this control plane;
    clear an override entirely via :func:`delete_override`."""
    _validate_flag_name(flag)
    if not isinstance(value, bool):
        raise ValueError("override value must be a bool (True=force-ON, False=force-OFF)")
    global _revision
    with _lock:
        _overrides[flag] = value
        _revision += 1
        return dict(_overrides), _revision


def delete_override(flag: str) -> tuple[dict[str, bool], int, bool]:
    """Remove ``flag`` from the map. Returns (snapshot, revision, existed)."""
    _validate_flag_name(flag)
    global _revision
    with _lock:
        existed = flag in _overrides
        if existed:
            del _overrides[flag]
            _revision += 1
        return dict(_overrides), _revision, existed


def reset_overrides() -> tuple[dict[str, bool], int]:
    """Clear all overrides. Returns (empty_snapshot, revision)."""
    global _revision
    with _lock:
        if _overrides:
            _overrides.clear()
            _revision += 1
        return {}, _revision


# -----------------------------------------------------------------------------
# FLT push — synchronous, runs outside the lock.
# -----------------------------------------------------------------------------


def push_snapshot_to_flt(
    snapshot: dict[str, bool],
    revision: int,
    *,
    flt_port: int,
    control_token: str,
    timeout: float = 5.0,
) -> PushResult:
    """POST the snapshot to FLT's ``/api/edog/feature-flags/overrides/bulk``.

    Returns a :class:`PushResult` describing the outcome. Never raises —
    network errors map to ``flt_sync="not-connected"`` and HTTP errors to
    ``flt_sync="failed"``. The caller stores the result via
    :func:`_record_push` (lock-protected) for UI consumption.

    Args:
        snapshot: The full override map to push (force-ON only).
        revision: The dev-server revision number that produced this snapshot.
        flt_port: FLT EdogLogServer port (typically 5557).
        control_token: Per-session token; FLT validates with FixedTimeEquals.
        timeout: HTTP timeout in seconds. Default 5s; budget §7 says < 200 ms p95.
    """
    local_hash = compute_hash(snapshot)
    url = f"http://127.0.0.1:{flt_port}/api/edog/feature-flags/overrides/bulk"
    body = json.dumps({"overrides": snapshot, "revision": revision}).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        headers={
            "Content-Type": "application/json",
            "X-EDOG-Control-Token": control_token,
        },
        method="POST",
    )
    start = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            duration_ms = (time.monotonic() - start) * 1000.0
            status = resp.status
            raw = resp.read()
        try:
            parsed = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            parsed = {}

        flt_hash = parsed.get("hash")
        flt_rev = parsed.get("revision")

        if status == 200 and flt_hash == local_hash and flt_rev == revision:
            sync = "applied"
            error = None
        else:
            sync = "failed"
            if status != 200:
                error = f"FLT returned status {status}"
            elif flt_hash != local_hash:
                error = f"hash mismatch: local={local_hash[:8]}, flt={(flt_hash or '<none>')[:8]}"
            elif flt_rev != revision:
                error = f"revision mismatch: local={revision}, flt={flt_rev}"
            else:
                error = "unknown verification failure"

        return PushResult(
            flt_sync=sync,
            revision=revision,
            local_hash=local_hash,
            flt_hash=flt_hash,
            flt_revision=flt_rev,
            status_code=status,
            error=error,
            duration_ms=duration_ms,
        )
    except urllib.error.HTTPError as e:
        duration_ms = (time.monotonic() - start) * 1000.0
        try:
            err_body = e.read().decode("utf-8", errors="replace")
        except Exception:
            err_body = ""
        return PushResult(
            flt_sync="failed",
            revision=revision,
            local_hash=local_hash,
            status_code=e.code,
            error=f"FLT {e.code}: {err_body[:200]}",
            duration_ms=duration_ms,
        )
    except (TimeoutError, urllib.error.URLError, ConnectionError) as e:
        duration_ms = (time.monotonic() - start) * 1000.0
        return PushResult(
            flt_sync="not-connected",
            revision=revision,
            local_hash=local_hash,
            error=f"FLT unreachable: {e}",
            duration_ms=duration_ms,
        )
    except Exception as e:
        duration_ms = (time.monotonic() - start) * 1000.0
        return PushResult(
            flt_sync="failed",
            revision=revision,
            local_hash=local_hash,
            error=f"unexpected: {type(e).__name__}: {e}",
            duration_ms=duration_ms,
        )


def record_push(result: PushResult) -> None:
    """Update ``_last_push`` with the most-recent push outcome (lock-protected)."""
    with _lock:
        _last_push["fltSync"] = result.flt_sync
        _last_push["revision"] = result.revision
        _last_push["hash"] = result.local_hash
        _last_push["fltHash"] = result.flt_hash
        _last_push["error"] = result.error
        _last_push["durationMs"] = round(result.duration_ms, 2)
        _last_push["at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


# -----------------------------------------------------------------------------
# Internal — reset used by dev-server cold-start to discard stale state across
# explicit "I am restarting" signals. Not part of public API.
# -----------------------------------------------------------------------------


def _internal_force_reset() -> None:
    """Hard-reset module state. Test-only / cold-start helper."""
    global _revision
    with _lock:
        _overrides.clear()
        _revision = 0
        _last_push["fltSync"] = "not-connected"
        _last_push["revision"] = 0
        _last_push["hash"] = hashlib.sha256(b"").hexdigest()
        _last_push["error"] = None
        _last_push["at"] = None
