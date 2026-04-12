"""Tests for the SignalR migration (ADR-006 Phase 1).

Validates that:
  - Build output contains SignalR client library
  - Build output uses SignalRManager (not WebSocketManager)
  - Old WebSocket references are fully removed
  - SignalRManager source has subscribe/unsubscribe methods
  - EdogPlaygroundHub.cs exists with correct hub methods
  - EdogLogServer.cs uses MapHub, not raw WebSocket
"""

from __future__ import annotations

import os
import pathlib

import pytest

PROJECT_ROOT = pathlib.Path(__file__).resolve().parent.parent


@pytest.fixture()
def build_output() -> str:
    """Return the built HTML content. Rebuild if stale or missing."""
    output_path = PROJECT_ROOT / "src" / "edog-logs.html"
    if not output_path.exists():
        pytest.skip("Build output not found — run 'python scripts/build-html.py' first")
    return output_path.read_text(encoding="utf-8")


@pytest.fixture()
def signalr_manager_source() -> str:
    """Return the SignalRManager JS source."""
    path = PROJECT_ROOT / "src" / "frontend" / "js" / "signalr-manager.js"
    assert path.exists(), "signalr-manager.js not found"
    return path.read_text(encoding="utf-8")


@pytest.fixture()
def hub_source() -> str:
    """Return the EdogPlaygroundHub C# source."""
    path = PROJECT_ROOT / "src" / "backend" / "DevMode" / "EdogPlaygroundHub.cs"
    assert path.exists(), "EdogPlaygroundHub.cs not found"
    return path.read_text(encoding="utf-8")


@pytest.fixture()
def logserver_source() -> str:
    """Return the EdogLogServer C# source."""
    path = PROJECT_ROOT / "src" / "backend" / "DevMode" / "EdogLogServer.cs"
    assert path.exists(), "EdogLogServer.cs not found"
    return path.read_text(encoding="utf-8")


# ── Build output tests ──────────────────────────────────────────


class TestBuildOutputContainsSignalR:
    """Verify the built HTML has SignalR client inlined."""

    def test_contains_hub_connection_builder(self, build_output: str) -> None:
        assert "HubConnectionBuilder" in build_output

    def test_contains_signalr_manager_class(self, build_output: str) -> None:
        assert "class SignalRManager" in build_output

    def test_no_websocket_manager_instantiation(self, build_output: str) -> None:
        assert "new WebSocketManager()" not in build_output

    def test_uses_signalr_manager_instantiation(self, build_output: str) -> None:
        assert "new SignalRManager()" in build_output

    def test_no_ws_logs_endpoint(self, build_output: str) -> None:
        assert "ws://localhost" not in build_output
        assert "/ws/logs" not in build_output

    def test_hub_playground_url(self, build_output: str) -> None:
        assert "/hub/playground" in build_output


# ── SignalRManager source tests ──────────────────────────────────


class TestSignalRManagerSource:
    """Verify the SignalRManager JS module has required interface."""

    def test_has_subscribe_method(self, signalr_manager_source: str) -> None:
        assert "subscribe" in signalr_manager_source

    def test_has_unsubscribe_method(self, signalr_manager_source: str) -> None:
        assert "unsubscribe" in signalr_manager_source

    def test_has_connect_method(self, signalr_manager_source: str) -> None:
        assert "connect" in signalr_manager_source

    def test_has_disconnect_method(self, signalr_manager_source: str) -> None:
        assert "disconnect" in signalr_manager_source

    def test_has_on_status_change(self, signalr_manager_source: str) -> None:
        assert "onStatusChange" in signalr_manager_source

    def test_has_on_message(self, signalr_manager_source: str) -> None:
        assert "onMessage" in signalr_manager_source

    def test_has_set_port(self, signalr_manager_source: str) -> None:
        assert "setPort" in signalr_manager_source

    def test_uses_automatic_reconnect(self, signalr_manager_source: str) -> None:
        assert "withAutomaticReconnect" in signalr_manager_source

    def test_handles_log_entry_event(self, signalr_manager_source: str) -> None:
        assert "'LogEntry'" in signalr_manager_source

    def test_handles_telemetry_event(self, signalr_manager_source: str) -> None:
        assert "'TelemetryEvent'" in signalr_manager_source


# ── EdogPlaygroundHub tests ──────────────────────────────────────


class TestEdogPlaygroundHub:
    """Verify the SignalR hub has correct structure."""

    def test_hub_class_exists(self, hub_source: str) -> None:
        assert "class EdogPlaygroundHub : Hub" in hub_source

    def test_has_subscribe_method(self, hub_source: str) -> None:
        assert "Task Subscribe(string topic)" in hub_source

    def test_has_unsubscribe_method(self, hub_source: str) -> None:
        assert "Task Unsubscribe(string topic)" in hub_source

    def test_has_on_connected_override(self, hub_source: str) -> None:
        assert "OnConnectedAsync" in hub_source

    def test_auto_subscribes_log_group(self, hub_source: str) -> None:
        assert '"log"' in hub_source


# ── EdogLogServer migration tests ────────────────────────────────


class TestEdogLogServerMigration:
    """Verify EdogLogServer uses SignalR, not raw WebSocket."""

    def test_uses_map_hub(self, logserver_source: str) -> None:
        assert "MapHub<EdogPlaygroundHub>" in logserver_source

    def test_no_use_websockets(self, logserver_source: str) -> None:
        assert "UseWebSockets()" not in logserver_source

    def test_no_ws_logs_route(self, logserver_source: str) -> None:
        assert '"/ws/logs"' not in logserver_source

    def test_has_hub_context(self, logserver_source: str) -> None:
        assert "IHubContext<EdogPlaygroundHub>" in logserver_source

    def test_adds_signalr_services(self, logserver_source: str) -> None:
        assert "AddSignalR()" in logserver_source

    def test_uses_json_protocol(self, logserver_source: str) -> None:
        # JSON protocol is default — no AddMessagePackProtocol needed
        assert "AddMessagePackProtocol()" not in logserver_source

    def test_no_batch_flush_timer(self, logserver_source: str) -> None:
        assert "batchFlushTimer" not in logserver_source
        assert "FlushAllClients" not in logserver_source

    def test_no_client_state_class(self, logserver_source: str) -> None:
        assert "class ClientState" not in logserver_source

    def test_send_async_log_entry(self, logserver_source: str) -> None:
        assert 'EdogTopicRouter.Publish("log"' in logserver_source

    def test_send_async_telemetry_event(self, logserver_source: str) -> None:
        assert 'EdogTopicRouter.Publish("telemetry"' in logserver_source

    def test_rest_api_logs_preserved(self, logserver_source: str) -> None:
        assert '"/api/logs"' in logserver_source

    def test_rest_api_telemetry_preserved(self, logserver_source: str) -> None:
        assert '"/api/telemetry"' in logserver_source

    def test_rest_api_stats_preserved(self, logserver_source: str) -> None:
        assert '"/api/stats"' in logserver_source

    def test_rest_api_executions_preserved(self, logserver_source: str) -> None:
        assert '"/api/executions"' in logserver_source


# ── Vendor library tests ─────────────────────────────────────────


class TestVendorLibraries:
    """Verify SignalR vendor libraries exist."""

    def test_signalr_min_js_exists(self) -> None:
        path = PROJECT_ROOT / "lib" / "signalr.min.js"
        assert path.exists()
        size = path.stat().st_size
        assert size > 30000, f"signalr.min.js too small: {size} bytes"

    def test_msgpack_protocol_not_needed(self) -> None:
        # MessagePack removed due to NuGet version conflicts with FLT
        path = PROJECT_ROOT / "lib" / "signalr-protocol-msgpack.min.js"
        assert not path.exists(), "msgpack lib should be removed — using JSON protocol"

    def test_old_websocket_js_deleted(self) -> None:
        path = PROJECT_ROOT / "src" / "frontend" / "js" / "websocket.js"
        assert not path.exists(), "websocket.js should be deleted"
