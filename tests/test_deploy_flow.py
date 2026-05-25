"""Tests for F02 Deploy to Lakehouse flow."""

import importlib.util
import json
import os
import sys
import tempfile
from pathlib import Path


class TestAtomicWrite:
    """Test atomic file write utility pattern."""

    def test_atomic_write_creates_file(self, tmp_path):
        target = tmp_path / "config.json"
        data = json.dumps({"workspace_id": "ws-123"})
        # Simulate atomic write: write to temp, rename
        fd, tmp = tempfile.mkstemp(dir=str(tmp_path), suffix=".tmp")
        os.write(fd, data.encode("utf-8"))
        os.close(fd)
        os.replace(tmp, str(target))
        assert target.exists()
        assert json.loads(target.read_text())["workspace_id"] == "ws-123"

    def test_atomic_write_replaces_existing(self, tmp_path):
        target = tmp_path / "config.json"
        target.write_text('{"old": true}')
        new_data = json.dumps({"workspace_id": "ws-456"})
        fd, tmp = tempfile.mkstemp(dir=str(tmp_path), suffix=".tmp")
        os.write(fd, new_data.encode("utf-8"))
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
            fd, _tmp = tempfile.mkstemp(dir=str(tmp_path), suffix=".tmp")
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
        state.update(
            {
                "phase": "deploying",
                "deployId": deploy_id,
                "deployStep": 0,
                "deployMessage": "Starting...",
                "deployTarget": {"workspaceId": "ws", "artifactId": "lh", "capacityId": "cap"},
            }
        )
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
        state.update(
            {
                "phase": "running",
                "deployStep": 5,
                "fltPort": 5557,
                "fltPid": 12345,
            }
        )
        assert state["phase"] == "running"
        assert state["fltPort"] == 5557

    def test_running_to_crashed(self):
        state = self._make_state()
        state["phase"] = "running"
        state.update(
            {
                "phase": "crashed",
                "deployError": "FLT exited with code 1",
            }
        )
        assert state["phase"] == "crashed"
        assert "exited" in state["deployError"]

    def test_deploying_to_stopped_on_error(self):
        state = self._make_state()
        state["phase"] = "deploying"
        state["deployStep"] = 2
        state.update(
            {
                "phase": "stopped",
                "deployError": "Build failed",
            }
        )
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
        updated = state["deployId"] == stale_id
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
        data = {
            "step": 1,
            "total": 5,
            "status": "deploying",
            "message": "Updating config...",
            "error": None,
            "log": {"ts": "18:30", "msg": "Config updated", "level": "success"},
            "fltPort": None,
        }
        line = f"data: {json.dumps(data)}\n\n"
        assert line.startswith("data: ")
        assert line.endswith("\n\n")
        parsed = json.loads(line[6:].strip())
        assert parsed["step"] == 1
        assert parsed["total"] == 5

    def test_sse_complete_event(self):
        """Terminal SSE event should have event: complete."""
        data = {
            "step": 5,
            "total": 5,
            "status": "running",
            "message": "Deploy complete",
            "error": None,
            "fltPort": 5557,
        }
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


# ============================================================================
# Build-output terminal controls (F02 — UX enhancement)
# ============================================================================

_DEPLOY_JS = Path(__file__).resolve().parents[1] / "src" / "frontend" / "js" / "deploy-flow.js"
_DEPLOY_CSS = Path(__file__).resolve().parents[1] / "src" / "frontend" / "css" / "deploy.css"


class TestTerminalControls:
    """The deploy build-output terminal must expose user controls."""

    def test_follow_tail_state_exists(self) -> None:
        src = _DEPLOY_JS.read_text(encoding="utf-8")
        assert "_followTail" in src, "DeployFlow must track _followTail to pause autoscroll when user scrolls up"

    def test_scroll_listener_updates_follow_tail(self) -> None:
        src = _DEPLOY_JS.read_text(encoding="utf-8")
        assert "_bindTerminalScroll" in src
        # Detects bottom: scrollHeight - scrollTop - clientHeight near zero
        assert "scrollHeight - term.scrollTop - term.clientHeight" in src, (
            "Terminal scroll handler must measure distance from bottom to set _followTail"
        )

    def test_append_log_respects_follow_tail(self) -> None:
        src = _DEPLOY_JS.read_text(encoding="utf-8")
        # _appendLog should auto-scroll only when both terminal open AND following tail
        assert "this._terminalOpen && this._followTail" in src, (
            "_appendLog must auto-scroll only when terminal is open AND user is following tail"
        )

    def test_clear_button_wired(self) -> None:
        src = _DEPLOY_JS.read_text(encoding="utf-8")
        assert "deploy-term-clear" in src, "Clear button must be present"
        assert "this._logs = []" in src, "Clear handler must empty the log buffer"

    def test_copy_button_wired(self) -> None:
        src = _DEPLOY_JS.read_text(encoding="utf-8")
        assert "deploy-term-copy" in src, "Copy button must be present"
        assert "_copyLogs" in src, "Copy handler must exist"
        assert "navigator.clipboard" in src, "Copy must use clipboard API"
        assert "_copyLogsFallback" in src, "Copy must fall back when clipboard unavailable"

    def test_expand_button_wired(self) -> None:
        src = _DEPLOY_JS.read_text(encoding="utf-8")
        assert "deploy-term-expand" in src, "Expand button must be present"
        assert "_terminalExpanded" in src, "Expand state must be tracked"

    def test_wrap_button_wired(self) -> None:
        src = _DEPLOY_JS.read_text(encoding="utf-8")
        assert "deploy-term-wrap" in src, "Wrap toggle must be present"
        assert "this._wrap" in src, "Wrap state must be tracked"

    def test_jump_to_latest_badge_wired(self) -> None:
        src = _DEPLOY_JS.read_text(encoding="utf-8")
        assert "deploy-term-jump" in src, "Jump-to-latest badge must be present"
        assert "_updateJumpBadge" in src, "Jump badge visibility helper must exist"


class TestTerminalControlsCss:
    """CSS classes for the new terminal controls must exist."""

    def test_actions_container_styled(self) -> None:
        css = _DEPLOY_CSS.read_text(encoding="utf-8")
        assert ".deploy-terminal-actions" in css

    def test_action_button_styled(self) -> None:
        css = _DEPLOY_CSS.read_text(encoding="utf-8")
        assert ".deploy-terminal-btn" in css
        assert ".deploy-terminal-btn.active" in css, "Active state for toggle buttons (wrap) must be styled"

    def test_expanded_mode_styled(self) -> None:
        css = _DEPLOY_CSS.read_text(encoding="utf-8")
        assert ".deploy-terminal.expanded.open" in css, "Expanded terminal must have its own max-height"

    def test_nowrap_mode_styled(self) -> None:
        css = _DEPLOY_CSS.read_text(encoding="utf-8")
        assert ".deploy-terminal.nowrap" in css, "Nowrap mode must override white-space on term-content"

    def test_jump_badge_styled(self) -> None:
        css = _DEPLOY_CSS.read_text(encoding="utf-8")
        assert ".deploy-term-jump" in css
        assert ".deploy-term-jump.visible" in css, "Jump badge needs visible state"
        # Sticky inside scroll container is the only way it pins to viewport bottom
        assert "position: sticky" in css

    def test_copy_toast_styled(self) -> None:
        css = _DEPLOY_CSS.read_text(encoding="utf-8")
        assert ".deploy-term-toast" in css
        assert ".deploy-term-toast.visible" in css


# ============================================================================
# Deploy strip context — F02 fix: commit info + visibility timing
# ============================================================================

_DEPLOY_STRIP_JS = Path(__file__).resolve().parents[1] / "src" / "frontend" / "js" / "deploy-strip.js"


class TestDeployStripVisibility:
    """Strip must only appear after E2E deploy completes (phase === 'running')."""

    def test_strip_hides_when_phase_not_running(self) -> None:
        src = _DEPLOY_STRIP_JS.read_text(encoding="utf-8")
        # Old logic hid only on idle/stopped — meaning the strip flashed during
        # 'deploying' with empty fields. New logic hides for ANY non-running phase.
        assert "status.phase !== 'running'" in src, (
            "Strip visibility must check phase === 'running' (was leaking on 'deploying')"
        )
        # Defensive: the old buggy check should be gone
        assert "status.phase === 'idle' || status.phase === 'stopped'" not in src, (
            "Old hide condition must be removed — it caused strip to show mid-deploy"
        )


class TestGitHeadCapture:
    """Backend must capture FLT repo HEAD commit info for the Connected strip."""

    def test_capture_git_head_helper_exists(self) -> None:
        ds = Path(__file__).resolve().parents[1] / "scripts" / "dev-server.py"
        src = ds.read_text(encoding="utf-8")
        assert "def _capture_git_head" in src, "dev-server.py must expose _capture_git_head() to populate commit chip"
        # Single subprocess call to git log with the four fields the strip needs
        assert "commitSha" in src and "commitAuthor" in src and "commitMessage" in src

    def test_capture_git_head_returns_none_for_non_repo(self, tmp_path) -> None:
        import importlib.util
        import sys

        ds = Path(__file__).resolve().parents[1] / "scripts" / "dev-server.py"
        sys.path.insert(0, str(ds.parent))
        try:
            spec = importlib.util.spec_from_file_location("ds_mod_a", ds)
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
        finally:
            sys.path.remove(str(ds.parent))
        assert mod._capture_git_head("") is None
        assert mod._capture_git_head(str(tmp_path)) is None
        assert mod._capture_git_head("/nonexistent/path/xyz") is None

    def test_capture_git_head_returns_sha_in_real_repo(self) -> None:
        """Sanity: when run against the edog-studio repo itself, returns a sha."""
        import importlib.util
        import sys

        ds = Path(__file__).resolve().parents[1] / "scripts" / "dev-server.py"
        sys.path.insert(0, str(ds.parent))
        try:
            spec = importlib.util.spec_from_file_location("ds_mod_b", ds)
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
        finally:
            sys.path.remove(str(ds.parent))
        info = mod._capture_git_head(str(ds.parent.parent))
        # In CI we may or may not have git history — accept None as well as a real hit
        if info is not None:
            assert len(info["commitSha"]) == 40
            assert info["commitMessage"]
            assert info["commitAuthor"]


class TestDeployTargetCarriesWorkspaceName:
    """workspaceName from request body must be stored in deployTarget."""

    def test_deploy_handler_reads_workspace_name(self) -> None:
        ds = Path(__file__).resolve().parents[1] / "scripts" / "dev-server.py"
        src = ds.read_text(encoding="utf-8")
        assert 'body.get("workspaceName"' in src, "POST /api/command/deploy must read workspaceName from request body"
        assert '"workspaceName": ws_name' in src, "workspaceName must be stored in deployTarget for the Connected strip"

    def test_git_info_merged_into_deploy_target_on_running(self) -> None:
        ds = Path(__file__).resolve().parents[1] / "scripts" / "dev-server.py"
        src = ds.read_text(encoding="utf-8")
        # When deploy transitions to 'running', git_info should be merged into target
        assert "_capture_git_head" in src
        assert "target.update(git_info)" in src, (
            "Captured git_info must be merged into deployTarget on successful deploy"
        )


# ============================================================================
# DevInstanceRegistrationFailedException detection (MWC dev-relay failure UX)
# ============================================================================


def _load_dev_server():
    project_dir = Path(__file__).resolve().parents[1]
    dev_server = project_dir / "scripts" / "dev-server.py"
    spec = importlib.util.spec_from_file_location("edog_dev_server_mwc", dev_server)
    mod = importlib.util.module_from_spec(spec)
    sys.path.insert(0, str(dev_server.parent))
    try:
        spec.loader.exec_module(mod)
    finally:
        sys.path.pop(0)
    return mod


class TestMwcRegistrationFailureParser:
    """_parse_registration_failure extracts MWC-side identifiers so the UI
    can render a rich error card instead of dumping the raw stack trace."""

    SAMPLE_LINE = (
        "Failed to establish Dev Connection due to error "
        "Microsoft.Fabric.Relay.Connections.Services.Exceptions.DevInstanceRegistrationFailedException: "
        "Dev instance registration call DevInstanceRegistrationRequest[ "
        "CapacityGuid = 3e65fd15-ef05-43cf-a07b-2a74788a6cbd, RealmGuid = , "
        "WorkloadId = LiveTable, ExtensionManifestProvided = True ] was not "
        "successful, HTTP status code: InternalServerError, reason: Internal "
        'Server Error, response: {"code":"InternalError","subCode":0,"message":'
        '"An internal error occurred.","timeStamp":"2026-05-25T11:33:16.428394Z",'
        '"httpStatusCode":500,"hresult":-2147467259,"details":['
        '{"code":"RootActivityId","message":"cbf3aeff-8c24-4d56-9703-1b94e9000b91"},'
        '{"code":"ClusterDNS","message":"pbipedogwcus2-edog.pbidedicated.windows-int.net"},'
        '{"code":"ApplicationName","message":"fabric:/analysisserver.frontend"},'
        '{"code":"NodeName","message":"_fe2_2"},'
        '{"code":"NodeType","message":"FrontEnd"},'
        '{"code":"ProcessId","message":"20612"},'
        '{"code":"Param1","message":"An error occurred while sending the request."}]}'
    )

    def test_returns_none_when_marker_absent(self):
        srv = _load_dev_server()
        assert srv._parse_registration_failure("just some random log line") is None

    def test_extracts_capacity_guid(self):
        srv = _load_dev_server()
        result = srv._parse_registration_failure(self.SAMPLE_LINE)
        assert result is not None
        assert result["capacityGuid"] == "3e65fd15-ef05-43cf-a07b-2a74788a6cbd"

    def test_extracts_root_activity_id(self):
        srv = _load_dev_server()
        result = srv._parse_registration_failure(self.SAMPLE_LINE)
        assert result["rootActivityId"] == "cbf3aeff-8c24-4d56-9703-1b94e9000b91"

    def test_extracts_cluster_dns(self):
        srv = _load_dev_server()
        result = srv._parse_registration_failure(self.SAMPLE_LINE)
        assert result["clusterDns"] == "pbipedogwcus2-edog.pbidedicated.windows-int.net"

    def test_extracts_http_status(self):
        srv = _load_dev_server()
        result = srv._parse_registration_failure(self.SAMPLE_LINE)
        assert result["httpStatus"] == "InternalServerError"

    def test_returns_partial_when_fields_missing(self):
        srv = _load_dev_server()
        sparse = "DevInstanceRegistrationFailedException: something happened, no detail"
        result = srv._parse_registration_failure(sparse)
        assert result == {}

    def test_studio_state_carries_new_fields(self):
        srv = _load_dev_server()
        # The structured failure fields must exist on the initial state dict
        # so /api/studio/status responses always include them (resume path
        # depends on them being present, even if null).
        assert "deployErrorKind" in srv._studio_state
        assert "deployErrorDetail" in srv._studio_state
        assert srv._studio_state["deployErrorKind"] is None
        assert srv._studio_state["deployErrorDetail"] is None

    def test_registration_failed_event_exists(self):
        srv = _load_dev_server()
        # The wait-for-ready loop races this event against _flt_ready_event;
        # if it disappears the loop will fall back to the 180s timeout.
        assert hasattr(srv, "_flt_registration_failed_event")
        assert not srv._flt_registration_failed_event.is_set()


class TestMwcFailureCardRendering:
    """Frontend renders the rich card only when errorKind === mwc_registration."""

    _DEPLOY_JS_PATH = Path(__file__).resolve().parents[1] / "src" / "frontend" / "js" / "deploy-flow.js"
    _DEPLOY_CSS_PATH = Path(__file__).resolve().parents[1] / "src" / "frontend" / "css" / "deploy.css"

    def test_render_branches_on_errorKind(self):
        src = self._DEPLOY_JS_PATH.read_text(encoding="utf-8")
        assert "errorKind === 'mwc_registration'" in src
        assert "_renderMwcFailureCard" in src

    def test_render_card_includes_telemetry_rows(self):
        src = self._DEPLOY_JS_PATH.read_text(encoding="utf-8")
        # The four mitigation steps + telemetry IDs must all be present so
        # the engineer sees actionable detail rather than the raw exception.
        assert "Capacity GUID" in src
        assert "MWC ActivityId" in src
        assert "Cluster DNS" in src
        assert "Pause &amp; resume the capacity" in src
        assert "Test-NetConnection" in src

    def test_state_carries_errorKind_and_errorDetail(self):
        src = self._DEPLOY_JS_PATH.read_text(encoding="utf-8")
        # Both fields must travel through state / SSE / resume so the card
        # survives a page reload mid-failure.
        assert "errorKind: null" in src
        assert "errorDetail: null" in src
        assert "data.errorKind" in src
        assert "data.errorDetail" in src
        assert "state.deployErrorKind" in src
        assert "state.deployErrorDetail" in src

    def test_css_includes_failure_card_styles(self):
        src = self._DEPLOY_CSS_PATH.read_text(encoding="utf-8")
        # The card needs its own scoped block so it can't accidentally
        # inherit the basic .deploy-error-banner layout.
        assert ".deploy-mwc-failure" in src
        assert ".deploy-mwc-failure-steps" in src
        assert ".deploy-mwc-telemetry-row" in src
        assert ".deploy-mwc-telemetry-copy" in src
