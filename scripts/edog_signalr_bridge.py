"""SignalR -> REST bridge for the EDOG topic streams.

The rich validation data (perf/code-markers = execution proof, fileop = system
files + content, spark/token/retry/di/cache/http) is exposed by FLT ONLY over a
SignalR hub (``:5557/hub/playground``). The QA skill speaks REST/curl, not
SignalR. This bridge runs inside the dev-server as a SignalR client, buffers
each topic, and lets the skill POLL the events over plain HTTP.

Design (see plan / SIGNALR_PROTOCOL.md), and the failure paths it must survive:

* **Hub not up** (Beats 1-3 are server-free; the hub exists only after deploy):
  the bridge stays dormant, reports ``connected=False``, and retries connect with
  capped backoff. It never raises into the skill.
* **Connection drops:** auto-reconnect with backoff; on reconnect every active
  topic is re-subscribed. The snapshot re-delivers history, so events are
  **deduped by (topic, sequenceId)** against a per-topic high-water mark.
* **Hub drops oldest** (its ring is bounded): a jump in ``sequenceId`` is detected
  and surfaced as ``gap=True`` — honest incompleteness, never a fake-complete
  stream.
* **Slow poller:** the Python ring is bounded drop-oldest; a poll for a sequence
  below the low-water mark returns ``gap=True, gapBefore=<lowWater>``.
* **Lifecycle:** the bridge owns the thread + socket + buffers; ``stop`` closes the
  socket and joins the thread. ``start``/``subscribe`` are idempotent.

The actual SignalR JSON framing is implemented directly on a websocket (no heavy
``signalrcore`` dependency — fewer moving parts, full control of the read loop).
"""

from __future__ import annotations

import contextlib
import json
import threading
import time
import urllib.request
from collections import deque
from dataclasses import dataclass, field

# SignalR JSON message types (the subset we use).
_MSG_INVOCATION = 1
_MSG_STREAM_ITEM = 2
_MSG_COMPLETION = 3
_MSG_STREAM_INVOCATION = 4
_MSG_PING = 6
_MSG_CLOSE = 7
_RS = "\x1e"  # SignalR record separator

# All 11 topics (SIGNALR_PROTOCOL.md). Python ring is min(C# size, cap).
_TOPIC_SIZES = {
    "log": 10000, "telemetry": 5000, "fileop": 2000, "spark": 200, "token": 500,
    "cache": 2000, "http": 2000, "retry": 500, "flag": 1000, "di": 100, "perf": 5000,
}
TOPICS = frozenset(_TOPIC_SIZES)
_RING_CAP = 5000  # hard cap per topic on the Python side

_BACKOFF = (1, 2, 4, 8, 15, 30)  # reconnect backoff seconds (capped)
_MAX_CONSECUTIVE_FAILS = 6  # after this many, connectionState -> "degraded"


@dataclass
class _TopicRing:
    """Per-topic bounded buffer keyed by the hub's monotonic sequenceId."""
    size: int
    events: deque = field(default_factory=deque)
    high_water: int = 0       # highest sequenceId ever accepted (dedup boundary)
    low_water: int = 0        # lowest sequenceId still retained (overflow boundary)
    gap: bool = False         # a hub-side drop-oldest gap was observed
    gap_before: int = 0       # events earlier than this seq were dropped (hub or local)
    subscribed: bool = False

    def add(self, evt: dict) -> None:
        seq = int(evt.get("sequenceId", 0))
        # Dedup: snapshot replay after reconnect re-sends history.
        if seq and seq <= self.high_water:
            return
        # Hub-side gap: sequence jumped past the next expected id.
        if self.high_water and seq > self.high_water + 1 and self.events:
            self.gap = True
            self.gap_before = self.high_water + 1
        self.events.append(evt)
        if seq > self.high_water:
            self.high_water = seq
        # Local overflow: drop oldest, record the new low-water as a gap boundary.
        while len(self.events) > min(self.size, _RING_CAP):
            dropped = self.events.popleft()
            self.low_water = int(dropped.get("sequenceId", 0))
            self.gap = True
            self.gap_before = max(self.gap_before, self.low_water + 1)

    def since(self, seq: int, max_n: int) -> tuple[list[dict], bool, int]:
        out = [e for e in self.events if int(e.get("sequenceId", 0)) > seq][:max_n]
        # If the caller asked from before what we still hold, coverage is incomplete.
        gap = bool(self.gap or (seq and self.low_water and seq < self.low_water))
        return out, gap, self.gap_before


class SignalRBridge:
    """Owns the SignalR client thread + per-topic rings. Singleton in the dev-server."""

    def __init__(self, hub_url_provider, *, ws_factory=None) -> None:
        # hub_url_provider() -> base hub URL (e.g. http://localhost:5557/hub/playground)
        # or None when FLT isn't running. Injected so Beat-1..3 stay server-free and
        # tests can point at a fake hub.
        self._hub_url_provider = hub_url_provider
        self._ws_factory = ws_factory  # injectable for tests; default builds websocket-client
        self._rings: dict[str, _TopicRing] = {t: _TopicRing(_TOPIC_SIZES[t]) for t in TOPICS}
        self._wanted: set[str] = set()       # topics the skill asked for
        self._lock = threading.RLock()
        self._ws = None
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._connected = False
        self._state = "idle"  # idle | connecting | connected | degraded | stopped
        self._reconnects = 0
        self._invocation_id = 0

    # ── public REST-facing API ──────────────────────────────────────────────

    def subscribe(self, topic: str) -> dict:
        """Mark a topic wanted and ensure the client is running. Idempotent."""
        topic = topic.lower()
        if topic not in TOPICS:
            return {"ok": False, "error": "unknown_topic", "valid": sorted(TOPICS)}
        with self._lock:
            self._wanted.add(topic)
            self._rings[topic].subscribed = True
        self._ensure_running()
        return {"ok": True, "topic": topic, "connected": self._connected}

    def poll(self, topic: str, since: int = 0, max_n: int = 1000) -> dict:
        """Return buffered events for `topic` after sequenceId `since`."""
        topic = topic.lower()
        if topic not in TOPICS:
            return {"ok": False, "error": "unknown_topic", "valid": sorted(TOPICS)}
        # A poll auto-subscribes (fallback) so a missed explicit subscribe doesn't
        # silently return empty forever.
        if topic not in self._wanted:
            self.subscribe(topic)
        with self._lock:
            ring = self._rings[topic]
            events, gap, gap_before = ring.since(int(since), int(max_n))
            last = ring.high_water
        return {
            "ok": True, "topic": topic, "events": events,
            "lastSequenceId": last, "gap": gap, "gapBefore": gap_before,
            "connected": self._connected, "connectionState": self._state,
        }

    def status(self) -> dict:
        with self._lock:
            topics = {
                t: {"subscribed": r.subscribed, "buffered": len(r.events),
                    "lastSeq": r.high_water, "gap": r.gap}
                for t, r in self._rings.items() if r.subscribed
            }
        return {
            "hubReachable": self._connected,
            "connectionState": self._state,
            "reconnects": self._reconnects,
            "topics": topics,
        }

    def stop(self) -> None:
        """Stop the client thread and close the socket. Idempotent."""
        self._stop.set()
        ws = self._ws
        if ws is not None:
            with contextlib.suppress(Exception):
                ws.close()
        t = self._thread
        if t is not None and t.is_alive():
            t.join(timeout=5)
        with self._lock:
            self._state = "stopped"
            self._connected = False

    # ── client thread ───────────────────────────────────────────────────────

    def _ensure_running(self) -> None:
        with self._lock:
            if self._thread is not None and self._thread.is_alive():
                return
            self._stop.clear()
            self._thread = threading.Thread(target=self._run, name="edog-signalr-bridge", daemon=True)
            self._thread.start()

    def _run(self) -> None:
        fails = 0
        while not self._stop.is_set():
            url = self._hub_url_provider()
            if not url:
                # FLT not up yet — stay dormant, retry slowly.
                self._set_state("idle", connected=False)
                if self._stop.wait(2):
                    break
                continue
            try:
                self._set_state("connecting", connected=False)
                self._connect_and_stream(url)
                fails = 0  # a clean session resets the failure count
            except Exception:
                fails += 1
                self._reconnects += 1
                self._set_state("degraded" if fails >= _MAX_CONSECUTIVE_FAILS else "connecting",
                                connected=False)
            finally:
                self._connected = False
            if self._stop.is_set():
                break
            time.sleep(_BACKOFF[min(fails, len(_BACKOFF) - 1)])
        self._set_state("stopped", connected=False)

    def _connect_and_stream(self, base_url: str) -> None:
        ws = self._open_ws(base_url)
        self._ws = ws
        try:
            ws.send('{"protocol":"json","version":1}' + _RS)
            ws.recv()  # handshake response ({} on success)
            with self._lock:
                wanted = list(self._wanted)
            for topic in wanted:
                self._send_stream_invocation(ws, topic)
            self._set_state("connected", connected=True)
            while not self._stop.is_set():
                raw = ws.recv()
                if raw == "" or raw is None:
                    raise ConnectionError("socket closed")
                for msg in _split_frames(raw):
                    self._handle_message(ws, msg)
        finally:
            with contextlib.suppress(Exception):
                ws.close()
            self._ws = None

    def _open_ws(self, base_url: str):
        """Open the websocket. An injected factory owns its own connection (tests
        / custom transports); the default does the SignalR negotiate first."""
        if self._ws_factory is not None:
            return self._ws_factory(base_url)
        return _default_ws_factory(self._negotiate(base_url))

    def _negotiate(self, base_url: str) -> str:
        # SignalR negotiate (POST) then build the ws:// URL. Best-effort: if
        # negotiate fails we still try a direct ws connect (skipNegotiation-style).
        ws_url = base_url.replace("http://", "ws://").replace("https://", "wss://")
        try:
            req = urllib.request.Request(base_url + "/negotiate?negotiateVersion=1", method="POST")
            with urllib.request.urlopen(req, timeout=5) as r:
                info = json.loads(r.read().decode("utf-8"))
            token = info.get("connectionToken") or info.get("connectionId")
            if token:
                ws_url = f"{ws_url}?id={token}"
        except Exception:
            pass  # direct connect
        return ws_url

    def _send_stream_invocation(self, ws, topic: str) -> None:
        self._invocation_id += 1
        msg = {"type": _MSG_STREAM_INVOCATION, "invocationId": str(self._invocation_id),
               "target": "SubscribeToTopic", "arguments": [topic]}
        ws.send(json.dumps(msg) + _RS)

    def _handle_message(self, ws, msg: dict) -> None:
        t = msg.get("type")
        if t == _MSG_PING:
            ws.send(json.dumps({"type": _MSG_PING}) + _RS)
            return
        if t == _MSG_CLOSE:
            raise ConnectionError(msg.get("error") or "hub closed")
        if t == _MSG_STREAM_ITEM:
            evt = msg.get("item")
            if isinstance(evt, dict):
                topic = (evt.get("topic") or "").lower()
                if topic in self._rings:
                    with self._lock:
                        self._rings[topic].add(evt)
        # Completion (3): the hub ended a topic stream; the reconnect loop or a
        # re-subscribe handles re-establishing it. Nothing to buffer.

    def _set_state(self, state: str, *, connected: bool) -> None:
        with self._lock:
            self._state = state
            self._connected = connected


def _split_frames(raw: str) -> list[dict]:
    out = []
    for part in raw.split(_RS):
        part = part.strip()
        if not part:
            continue
        try:
            out.append(json.loads(part))
        except json.JSONDecodeError:
            continue
    return out


def _default_ws_factory(ws_url: str):
    import websocket  # websocket-client; present in the environment

    return websocket.create_connection(ws_url, timeout=30)

