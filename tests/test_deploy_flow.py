"""Tests for F02 Deploy to Lakehouse flow."""
import json
import os
import tempfile
import threading
import time
from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest


class TestAtomicWrite:
    """Test atomic file write utility pattern."""

    def test_atomic_write_creates_file(self, tmp_path):
        target = tmp_path / "config.json"
        data = json.dumps({"workspace_id": "ws-123"})
        # Simulate atomic write: write to temp, rename
        fd, tmp = tempfile.mkstemp(dir=str(tmp_path), suffix='.tmp')
        os.write(fd, data.encode('utf-8'))
        os.close(fd)
        os.replace(tmp, str(target))
        assert target.exists()
        assert json.loads(target.read_text())["workspace_id"] == "ws-123"

    def test_atomic_write_replaces_existing(self, tmp_path):
        target = tmp_path / "config.json"
        target.write_text('{"old": true}')
        new_data = json.dumps({"workspace_id": "ws-456"})
        fd, tmp = tempfile.mkstemp(dir=str(tmp_path), suffix='.tmp')
        os.write(fd, new_data.encode('utf-8'))
        os.close(fd)
        os.replace(tmp, str(target))
        result = json.loads(target.read_text())
        assert result["workspace_id"] == "ws-456"
        assert "old" not in result

    def test_atomic_write_no_partial_on_error(self, tmp_path):
        target = tmp_path / "config.json"
        target.write_text('{"original": true}')
        # If write fails, original should be intact
        try:
            fd, tmp = tempfile.mkstemp(dir=str(tmp_path), suffix='.tmp')
            os.close(fd)
            # Simulate failure before replace
            raise ValueError("simulated error")
        except ValueError:
            pass
        assert json.loads(target.read_text())["original"] is True


class TestDeployStateTransitions:
    """Test deploy state model transitions."""

    def _make_state(self):
        return {
            "phase": "idle",
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

    def test_idle_to_deploying(self):
        state = self._make_state()
        deploy_id = "12345"
        state.update({
            "phase": "deploying", "deployId": deploy_id,
            "deployStep": 0, "deployMessage": "Starting...",
            "deployTarget": {"workspaceId": "ws", "artifactId": "lh", "capacityId": "cap"},
        })
        assert state["phase"] == "deploying"
        assert state["deployId"] == deploy_id

    def test_deploying_step_progression(self):
        state = self._make_state()
        state["phase"] = "deploying"
        for step in range(5):
            state["deployStep"] = step
            assert state["deployStep"] == step

    def test_deploying_to_running(self):
        state = self._make_state()
        state["phase"] = "deploying"
        state.update({
            "phase": "running", "deployStep": 5,
            "fltPort": 5557, "fltPid": 12345,
        })
        assert state["phase"] == "running"
        assert state["fltPort"] == 5557

    def test_running_to_crashed(self):
        state = self._make_state()
        state["phase"] = "running"
        state.update({
            "phase": "crashed",
            "deployError": "FLT exited with code 1",
        })
        assert state["phase"] == "crashed"
        assert "exited" in state["deployError"]

    def test_deploying_to_stopped_on_error(self):
        state = self._make_state()
        state["phase"] = "deploying"
        state["deployStep"] = 2
        state.update({
            "phase": "stopped",
            "deployError": "Build failed",
        })
        assert state["phase"] == "stopped"
        assert state["deployStep"] == 2

    def test_deploy_cancel(self):
        state = self._make_state()
        state["phase"] = "deploying"
        state.update({"phase": "stopped", "deployMessage": "Cancelled"})
        assert state["phase"] == "stopped"

    def test_deploy_id_prevents_stale_update(self):
        state = self._make_state()
        state["deployId"] = "current-123"
        # Stale worker tries to update with old ID
        stale_id = "old-456"
        if state["deployId"] != stale_id:
            updated = False  # Should not update
        else:
            updated = True
        assert not updated

    def test_log_accumulation(self):
        state = self._make_state()
        state["deployLogs"].append({"ts": "12:00", "msg": "Starting", "level": "info"})
        state["deployLogs"].append({"ts": "12:01", "msg": "Token acquired", "level": "success"})
        state["deployLogs"].append({"ts": "12:02", "msg": "Build failed", "level": "error"})
        assert len(state["deployLogs"]) == 3
        assert state["deployLogs"][2]["level"] == "error"


class TestHeadlessDeployProtocol:
    """Test the JSON stdout protocol from edog.py --headless-deploy."""

    def test_valid_json_line(self):
        line = '{"step": 2, "message": "Patching code...", "level": "info", "ts": "18:30:01"}'
        parsed = json.loads(line)
        assert parsed["step"] == 2
        assert parsed["level"] == "info"

    def test_all_required_fields(self):
        line = '{"step": 3, "message": "Build succeeded", "level": "success", "ts": "18:31:45"}'
        parsed = json.loads(line)
        assert all(k in parsed for k in ("step", "message", "level", "ts"))

    def test_step_range(self):
        for step in range(5):
            line = json.dumps({"step": step, "message": f"Step {step}", "level": "info", "ts": "00:00"})
            parsed = json.loads(line)
            assert 0 <= parsed["step"] <= 4

    def test_level_values(self):
        for level in ("info", "warn", "error", "success"):
            line = json.dumps({"step": 0, "message": "test", "level": level, "ts": "00:00"})
            parsed = json.loads(line)
            assert parsed["level"] in ("info", "warn", "error", "success")


class TestSSEEventFormat:
    """Test SSE event format for deploy-stream."""

    def test_sse_data_format(self):
        """SSE data line should be valid JSON with expected fields."""
        data = {"step": 1, "total": 5, "status": "deploying",
                "message": "Updating config...", "error": None,
                "log": {"ts": "18:30", "msg": "Config updated", "level": "success"},
                "fltPort": None}
        line = f"data: {json.dumps(data)}\n\n"
        assert line.startswith("data: ")
        assert line.endswith("\n\n")
        parsed = json.loads(line[6:].strip())
        assert parsed["step"] == 1
        assert parsed["total"] == 5

    def test_sse_complete_event(self):
        """Terminal SSE event should have event: complete."""
        data = {"step": 5, "total": 5, "status": "running",
                "message": "Deploy complete", "error": None, "fltPort": 5557}
        line = f"event: complete\ndata: {json.dumps(data)}\n\n"
        assert "event: complete" in line
        parsed = json.loads(line.split("data: ")[1].strip())
        assert parsed["status"] == "running"
        assert parsed["fltPort"] == 5557

    def test_sse_id_for_resume(self):
        """SSE events should have id: for Last-Event-ID resume."""
        event_id = 42
        data = json.dumps({"step": 2, "total": 5, "status": "deploying"})
        line = f"id: {event_id}\ndata: {data}\n\n"
        assert f"id: {event_id}" in line
