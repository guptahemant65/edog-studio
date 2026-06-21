"""Tests for the SignalR->REST bridge (scripts/edog_signalr_bridge.py).

Drives the bridge with a FAKE in-process hub (a fake websocket the bridge's
``ws_factory`` returns), so every failure path — reconnect+dedup, hub drop-oldest
gap, local overflow, unknown topic, hub-down dormancy — is exercised
deterministically without a live FLT.
"""

import contextlib
import json
import threading
import time

from scripts import edog_signalr_bridge as br

_RS = "\x1e"


class FakeHub:
    """A fake SignalR websocket: scripted server frames the bridge will recv()."""

    def __init__(self, script_frames):
        # script_frames: list of server payload strings (already SignalR JSON,
        # without the handshake). The first recv() returns the handshake "{}".
        self._frames = list(script_frames)
        self._sent = []
        self._closed = False
        self._handshook = False
        self._lock = threading.Lock()
        self._cv = threading.Condition(self._lock)

    # the bridge calls these:
    def send(self, data):
        with self._lock:
            self._sent.append(data)

    def recv(self):
        with self._cv:
            if not self._handshook:
                self._handshook = True
                return "{}" + _RS  # handshake ok
            while not self._frames and not self._closed:
                self._cv.wait(timeout=2)
            if self._closed and not self._frames:
                return ""  # socket closed -> bridge raises ConnectionError
            return self._frames.pop(0)

    def close(self):
        with self._cv:
            self._closed = True
            self._cv.notify_all()

    # test helpers:
    def push(self, frame):
        with self._cv:
            self._frames.append(frame)
            self._cv.notify_all()

    def sent_targets(self):
        out = []
        for s in self._sent:
            for part in s.split(_RS):
                part = part.strip()
                if part and part != '{"protocol":"json","version":1}':
                    with contextlib.suppress(json.JSONDecodeError):
                        out.append(json.loads(part))
        return out


def _item(topic, seq, **data):
    return json.dumps({"type": 2, "item": {"sequenceId": seq, "topic": topic, "timestamp": "t", "data": data}}) + _RS


def _wait_until(pred, timeout=3):
    end = time.time() + timeout
    while time.time() < end:
        if pred():
            return True
        time.sleep(0.02)
    return False


# ── ring-level unit tests (pure, no thread) ─────────────────────────────────

def test_ring_dedup_on_replay():
    r = br._TopicRing(size=100)
    for s in (1, 2, 3):
        r.add({"sequenceId": s, "topic": "perf"})
    # snapshot replay re-sends 1..3 then a new 4
    for s in (1, 2, 3, 4):
        r.add({"sequenceId": s, "topic": "perf"})
    seqs = [e["sequenceId"] for e in r.events]
    assert seqs == [1, 2, 3, 4]  # no duplicates


def test_ring_detects_hub_gap():
    r = br._TopicRing(size=100)
    r.add({"sequenceId": 1, "topic": "perf"})
    r.add({"sequenceId": 5, "topic": "perf"})  # jumped 2,3,4
    assert r.gap is True
    assert r.gap_before == 2


def test_ring_local_overflow_marks_gap():
    r = br._TopicRing(size=3)
    for s in range(1, 7):  # 6 events into a size-3 ring
        r.add({"sequenceId": s, "topic": "perf"})
    assert len(r.events) == 3
    assert r.gap is True
    _events, gap, _ = r.since(0, 100)  # asking from the start -> incomplete
    assert gap is True


def test_ring_since_filters():
    r = br._TopicRing(size=100)
    for s in (1, 2, 3, 4, 5):
        r.add({"sequenceId": s, "topic": "perf"})
    events, gap, _ = r.since(3, 100)
    assert [e["sequenceId"] for e in events] == [4, 5]
    assert gap is False


# ── bridge-level tests with the fake hub ────────────────────────────────────

def test_unknown_topic_rejected():
    bridge = br.SignalRBridge(lambda: None)
    assert bridge.subscribe("nope")["ok"] is False
    assert bridge.poll("nope")["ok"] is False


def test_hub_down_is_dormant_not_raising():
    bridge = br.SignalRBridge(lambda: None)  # provider returns None == FLT down
    res = bridge.subscribe("perf")
    assert res["ok"] is True
    assert bridge.poll("perf")["connected"] is False  # honest, no exception
    bridge.stop()


def test_streams_events_through_to_poll():
    hub = FakeHub([_item("perf", 1, marker="RunDAG"), _item("perf", 2, marker="Hook")])
    bridge = br.SignalRBridge(lambda: "http://fake/hub", ws_factory=lambda url: hub)
    bridge.subscribe("perf")
    assert _wait_until(lambda: len(bridge.poll("perf")["events"]) >= 2)
    out = bridge.poll("perf")
    assert [e["sequenceId"] for e in out["events"]] == [1, 2]
    assert out["events"][0]["data"]["marker"] == "RunDAG"
    # the bridge sent a SubscribeToTopic stream-invocation for perf
    assert any(m.get("target") == "SubscribeToTopic" and m.get("arguments") == ["perf"]
               for m in hub.sent_targets())
    bridge.stop()


def test_poll_since_advances():
    hub = FakeHub([_item("token", 10), _item("token", 11)])
    bridge = br.SignalRBridge(lambda: "http://fake/hub", ws_factory=lambda url: hub)
    bridge.subscribe("token")
    assert _wait_until(lambda: bridge.poll("token")["lastSequenceId"] >= 11)
    after = bridge.poll("token", since=10)
    assert [e["sequenceId"] for e in after["events"]] == [11]
    bridge.stop()


def test_poll_auto_subscribes():
    hub = FakeHub([_item("spark", 1)])
    bridge = br.SignalRBridge(lambda: "http://fake/hub", ws_factory=lambda url: hub)
    out = bridge.poll("spark")  # never explicitly subscribed
    assert out["ok"] is True
    assert "spark" in bridge._wanted
    bridge.stop()


def test_reconnect_resubscribes_and_dedups():
    # First session yields 1,2 then closes; bridge reconnects, replays 1,2 + new 3.
    hub1 = FakeHub([_item("perf", 1), _item("perf", 2)])
    hub2 = FakeHub([_item("perf", 1), _item("perf", 2), _item("perf", 3)])
    hubs = [hub1, hub2]
    made = []

    def factory(url):
        h = hubs[len(made)] if len(made) < len(hubs) else hubs[-1]
        made.append(h)
        return h

    bridge = br.SignalRBridge(lambda: "http://fake/hub", ws_factory=factory)
    bridge.subscribe("perf")
    assert _wait_until(lambda: bridge.poll("perf")["lastSequenceId"] >= 2)
    hub1.close()  # force a disconnect -> reconnect to hub2
    assert _wait_until(lambda: bridge.poll("perf")["lastSequenceId"] >= 3, timeout=5)
    out = bridge.poll("perf")
    seqs = [e["sequenceId"] for e in out["events"]]
    assert seqs == [1, 2, 3]  # replayed 1,2 deduped; 3 added
    bridge.stop()


def test_status_reports_topics():
    hub = FakeHub([_item("perf", 1)])
    bridge = br.SignalRBridge(lambda: "http://fake/hub", ws_factory=lambda url: hub)
    bridge.subscribe("perf")
    assert _wait_until(lambda: bridge.status()["hubReachable"])
    st = bridge.status()
    assert "perf" in st["topics"]
    assert st["topics"]["perf"]["lastSeq"] >= 1
    bridge.stop()
