"""
Runtime View ↔ FLT reconnect contract.

Guards the holistic fix for the post-mortem 2026-05-26 bug where, after a
redeploy, the top bar said "Connected" but the Runtime View stayed
"Disconnected" and the Reconnect toast button was a no-op.

Two layers of the bug were fixed:

  1. Detection failure — SignalR's built-in `withAutomaticReconnect` retry
     array exhausts in ~48 s while real redeploys take 60-180 s. Nothing in
     the codebase converged "phase=running AND signalr=disconnected → ensure
     connected". Now `ConnectionSupervisor` owns that reconciliation by
     polling `/api/studio/status`.

  2. Stale-callback corruption — the old `subscribeTopic` stored
     `connection.stream(...)` (the stream, not the subscription) in
     `_activeStreams`, then later called `.dispose()` on it. That was a silent
     no-op: the observer kept running and its `complete` callback eventually
     deleted the fresh entry registered for the same topic on a new
     connection. Same class of bug for orphaned `onclose`/`reconnected`
     callbacks. Fix: monotonic `_generation` counter, generation-guarded
     callbacks, and `{gen, subscription, connection}` records that dispose
     the subscription instead of the stream.

The tests are pure source-grep — they pin the structural invariants that
prevent the bug from regressing, without needing a browser or live FLT.

@author Sentinel + Pixel + Vex + Sana — EDOG Studio hivemind
"""

from __future__ import annotations

import pathlib

import pytest

PROJECT_ROOT = pathlib.Path(__file__).resolve().parent.parent
FRONTEND_JS = PROJECT_ROOT / "src" / "frontend" / "js"


@pytest.fixture()
def signalr_manager_source() -> str:
    path = FRONTEND_JS / "signalr-manager.js"
    assert path.exists(), "signalr-manager.js missing"
    return path.read_text(encoding="utf-8")


@pytest.fixture()
def connection_supervisor_source() -> str:
    path = FRONTEND_JS / "connection-supervisor.js"
    assert path.exists(), (
        "connection-supervisor.js missing — this module is the single source "
        "of truth for converging studio phase → SignalR connectedness."
    )
    return path.read_text(encoding="utf-8")


@pytest.fixture()
def main_source() -> str:
    return (FRONTEND_JS / "main.js").read_text(encoding="utf-8")


@pytest.fixture()
def topbar_source() -> str:
    return (FRONTEND_JS / "topbar.js").read_text(encoding="utf-8")


@pytest.fixture()
def workspace_explorer_source() -> str:
    return (FRONTEND_JS / "workspace-explorer.js").read_text(encoding="utf-8")


@pytest.fixture()
def build_html_source() -> str:
    return (PROJECT_ROOT / "scripts" / "build-html.py").read_text(encoding="utf-8")


# ── Layer 1: SignalRManager generation guards ───────────────────────────────


class TestGenerationGuards:
    """Stale async callbacks from orphaned connections must not mutate state."""

    def test_has_generation_counter(self, signalr_manager_source: str) -> None:
        """A monotonic generation counter must exist."""
        assert "_generation" in signalr_manager_source

    def test_generation_used_to_gate_callbacks(self, signalr_manager_source: str) -> None:
        """Generation guards must compare a captured `gen` to current generation."""
        # Allow either `gen !== this._generation` or `this._generation !== gen`.
        assert (
            "gen !== this._generation" in signalr_manager_source
            or "this._generation !== gen" in signalr_manager_source
        ), "Stale-callback guard pattern missing — bug will regress."

    def test_serialized_connect_promise(self, signalr_manager_source: str) -> None:
        """Concurrent connect calls must share a single in-flight promise."""
        assert "_connectPromise" in signalr_manager_source

    def test_state_machine_states_present(self, signalr_manager_source: str) -> None:
        """The lifecycle state machine identifiers must exist."""
        src = signalr_manager_source
        for state in ("idle", "connecting", "connected", "reconnecting", "stopping", "disposed"):
            assert state in src, f"Missing state machine state: {state}"


class TestSubscriptionDisposal:
    """Subscriptions, not streams, must be the disposable handle."""

    def test_stores_subscription_record(self, signalr_manager_source: str) -> None:
        """Active subscription map must store the subscription disposable."""
        assert "_subscriptions" in signalr_manager_source

    def test_does_not_store_stream_as_disposable(self, signalr_manager_source: str) -> None:
        """The dead `_activeStreams` map (root cause #2) must be gone."""
        assert "_activeStreams" not in signalr_manager_source, (
            "_activeStreams stored the stream (not the subscription) and "
            "calling .dispose() on it was a silent no-op. The orphaned "
            "observer would later delete the new subscription's record. "
            "Remove every reference to _activeStreams."
        )

    def test_unsubscribed_topics_set_present(self, signalr_manager_source: str) -> None:
        """Topics explicitly removed must not be silently restored on reconnect."""
        assert "_unsubscribedTopics" in signalr_manager_source

    def test_persistent_topics_set_present(self, signalr_manager_source: str) -> None:
        """Always-on topics (log, telemetry) must be tracked separately."""
        assert "_persistentTopics" in signalr_manager_source


class TestMultiListenerStatusPattern:
    """Status broadcasts must support multiple independent listeners."""

    def test_add_status_listener_present(self, signalr_manager_source: str) -> None:
        assert "addStatusListener" in signalr_manager_source

    def test_remove_status_listener_present(self, signalr_manager_source: str) -> None:
        assert "removeStatusListener" in signalr_manager_source


class TestRetryGate:
    """An external supervisor must be able to gate retries during deploys."""

    def test_should_retry_hook_present(self, signalr_manager_source: str) -> None:
        assert "setShouldRetryHook" in signalr_manager_source


# ── Layer 2: ConnectionSupervisor ───────────────────────────────────────────


class TestConnectionSupervisor:
    """The supervisor module converges studio.phase ↔ SignalR connectedness."""

    def test_class_exists(self, connection_supervisor_source: str) -> None:
        assert "class ConnectionSupervisor" in connection_supervisor_source

    def test_polls_studio_status_endpoint(self, connection_supervisor_source: str) -> None:
        assert "/api/studio/status" in connection_supervisor_source

    def test_has_request_reconnect(self, connection_supervisor_source: str) -> None:
        """Phase-aware reconnect entrypoint for the toast button."""
        assert "requestReconnect" in connection_supervisor_source

    def test_has_on_deploy_complete(self, connection_supervisor_source: str) -> None:
        """Deploy flow notifies supervisor when FLT is ready on a port."""
        assert "onDeployComplete" in connection_supervisor_source

    def test_phase_running_reconciles(self, connection_supervisor_source: str) -> None:
        """When phase=running, supervisor must call ensureConnected."""
        # Either 'running' string or a phase===... comparison must appear with
        # ensureConnected somewhere in the file.
        assert "ensureConnected" in connection_supervisor_source
        assert "'running'" in connection_supervisor_source or '"running"' in connection_supervisor_source

    def test_dismisses_toast_on_reconnect(self, connection_supervisor_source: str) -> None:
        """Toast must auto-dismiss when status flips to connected."""
        assert "_dismissToast" in connection_supervisor_source or "dismiss" in connection_supervisor_source


# ── Layer 3: caller cleanup ─────────────────────────────────────────────────


class TestCallerCleanup:
    """Direct setPort calls from random modules must be removed."""

    def test_main_uses_add_status_listener(self, main_source: str) -> None:
        """main.js must register via addStatusListener, not the legacy slot."""
        assert "addStatusListener" in main_source

    def test_main_does_not_assign_on_status_change_property(self, main_source: str) -> None:
        """No code path may overwrite `ws.onStatusChange = …` — fragile."""
        assert "this.ws.onStatusChange =" not in main_source
        assert "ws.onStatusChange =" not in main_source

    def test_main_resets_topic_high_water_on_connect(self, main_source: str) -> None:
        """FLT restart resets sequence IDs; high-water must reset too."""
        assert "_topicHighWater = {}" in main_source

    def test_topbar_no_direct_set_port(self, topbar_source: str) -> None:
        """Topbar must not poke the SignalR port — supervisor owns it.

        Match an actual function-call site (open paren), so doc comments that
        merely mention the API by name don't trip the guard.
        """
        assert "edogWs.setPort(" not in topbar_source

    def test_workspace_explorer_uses_supervisor_on_running(
        self, workspace_explorer_source: str
    ) -> None:
        """Deploy=running path must prefer the supervisor over raw setPort."""
        assert "edogConnectionSupervisor" in workspace_explorer_source

    def test_workspace_explorer_disconnect_toast_gone(
        self, workspace_explorer_source: str
    ) -> None:
        """Duplicate toast logic must be removed — supervisor owns the toast."""
        assert "_showDisconnectToast" not in workspace_explorer_source


# ── Build wiring ────────────────────────────────────────────────────────────


class TestBuildWiring:
    """The new module must be inlined into the single-file HTML."""

    def test_supervisor_listed_in_build_order(self, build_html_source: str) -> None:
        assert '"js/connection-supervisor.js"' in build_html_source

    def test_supervisor_loaded_after_signalr_manager(self, build_html_source: str) -> None:
        """Supervisor depends on SignalRManager — order matters in build-html.py."""
        sm_pos = build_html_source.find('"js/signalr-manager.js"')
        cs_pos = build_html_source.find('"js/connection-supervisor.js"')
        assert sm_pos > 0 and cs_pos > 0
        assert sm_pos < cs_pos, "connection-supervisor.js must load after signalr-manager.js"

    def test_supervisor_loaded_before_main(self, build_html_source: str) -> None:
        cs_pos = build_html_source.find('"js/connection-supervisor.js"')
        main_pos = build_html_source.find('"js/main.js"')
        assert cs_pos > 0 and main_pos > 0
        assert cs_pos < main_pos, "connection-supervisor.js must load before main.js"
