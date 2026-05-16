"""Integration tests for F09 API Playground catalog endpoint (/api/playground/catalog).

Exercises _serve_playground_catalog by binding the unbound method to a FakeHandler
and patching the dev-server's filesystem-facing helpers.
"""

from __future__ import annotations

import importlib.util
import io
import sys
import time
from pathlib import Path
from unittest.mock import patch

import pytest

PROJECT_DIR = Path(__file__).resolve().parents[1]
DEV_SERVER = PROJECT_DIR / "scripts" / "dev-server.py"


@pytest.fixture(scope="module")
def srv():
    spec = importlib.util.spec_from_file_location("edog_dev_server", DEV_SERVER)
    mod = importlib.util.module_from_spec(spec)
    sys.path.insert(0, str(DEV_SERVER.parent))
    try:
        spec.loader.exec_module(mod)
    finally:
        sys.path.pop(0)
    return mod


class FakeHandler:
    """Minimal stand-in for EdogDevHandler — only needs _json_response."""

    def __init__(self):
        self.headers = {}
        self.rfile = io.BytesIO(b"")
        self.response_status = None
        self.response_payload = None

    def _json_response(self, status, payload):
        self.response_status = status
        self.response_payload = payload


def _call_catalog(srv):
    handler = FakeHandler()
    fn = srv.EdogDevHandler._serve_playground_catalog
    fn(handler)
    return handler


@pytest.fixture
def clear_cache(srv):
    """Reset the catalog cache between tests."""
    srv._playground_catalog_cache.clear()
    yield
    srv._playground_catalog_cache.clear()


SAMPLE_CONTROLLER = """
namespace Microsoft.LiveTable.Service.Controllers
{
    [Route("v1/workspaces/{workspaceId}/lakehouses/{artifactId}/liveTable")]
    public class LiveTableController : BaseApiController
    {
        /// <summary>
        /// Gets the latest Dag.
        /// </summary>
        [HttpGet]
        [Route("getLatestDag")]
        public async Task<IActionResult> GetLatestDagAsync(
            [FromRoute] Guid workspaceId,
            [FromQuery] bool showExtendedLineage = false,
            CancellationToken cancellationToken = default)
        {
            return Ok();
        }
    }
}
"""


def _make_fake_repo(tmp_path: Path, controllers: dict[str, str]) -> Path:
    ctrl_dir = tmp_path / "Service" / "Microsoft.LiveTable.Service" / "Controllers"
    ctrl_dir.mkdir(parents=True)
    for name, content in controllers.items():
        (ctrl_dir / name).write_text(content, encoding="utf-8")
    return tmp_path


# ════════════════════════════════════════════════════════════════
# §1 Not configured / not found
# ════════════════════════════════════════════════════════════════


class TestNotConfigured:
    def test_returns_404_when_flt_repo_path_empty(self, srv, clear_cache):
        with patch.object(srv, "_get_flt_repo_dir", return_value=""):
            handler = _call_catalog(srv)
        assert handler.response_status == 404
        assert handler.response_payload["error"] == "flt-not-configured"

    def test_returns_404_when_controllers_dir_missing(self, srv, clear_cache, tmp_path):
        # flt_repo_path points somewhere, but Controllers/ subdir doesn't exist.
        with patch.object(srv, "_get_flt_repo_dir", return_value=str(tmp_path)):
            handler = _call_catalog(srv)
        assert handler.response_status == 404
        assert handler.response_payload["error"] == "flt-controllers-not-found"


# ════════════════════════════════════════════════════════════════
# §2 Happy path
# ════════════════════════════════════════════════════════════════


class TestHappyPath:
    def test_returns_200_with_endpoints(self, srv, clear_cache, tmp_path):
        repo = _make_fake_repo(tmp_path, {"LiveTableController.cs": SAMPLE_CONTROLLER})
        with patch.object(srv, "_get_flt_repo_dir", return_value=str(repo)):
            handler = _call_catalog(srv)
        assert handler.response_status == 200
        # Catalog includes the controller endpoint plus 2 framework endpoints
        # (swagger spec + UI), filter by source to keep the test resilient.
        endpoints = handler.response_payload["endpoints"]
        controller_eps = [e for e in endpoints if e.get("source") == "controller"]
        assert len(controller_eps) == 1
        ep = controller_eps[0]
        assert ep["urlTemplate"] == "/liveTable/getLatestDag"
        assert ep["method"] == "GET"
        assert ep["tokenType"] == "mwc"

    def test_includes_groups_with_labels(self, srv, clear_cache, tmp_path):
        repo = _make_fake_repo(tmp_path, {"LiveTableController.cs": SAMPLE_CONTROLLER})
        with patch.object(srv, "_get_flt_repo_dir", return_value=str(repo)):
            handler = _call_catalog(srv)
        groups = handler.response_payload["groups"]
        assert any(g["id"] == "liveTable" and g["label"] == "LiveTable" for g in groups)

    def test_includes_stats(self, srv, clear_cache, tmp_path):
        repo = _make_fake_repo(tmp_path, {"LiveTableController.cs": SAMPLE_CONTROLLER})
        with patch.object(srv, "_get_flt_repo_dir", return_value=str(repo)):
            handler = _call_catalog(srv)
        stats = handler.response_payload["stats"]
        assert stats["controllers_scanned"] == 1
        # 1 controller endpoint + 2 framework endpoints (swagger spec + UI)
        assert stats["endpoints_found"] == 3
        assert stats["framework_endpoints"] == 2


# ════════════════════════════════════════════════════════════════
# §3 Caching
# ════════════════════════════════════════════════════════════════


class TestCaching:
    def test_cache_hit_skips_extraction(self, srv, clear_cache, tmp_path):
        repo = _make_fake_repo(tmp_path, {"LiveTableController.cs": SAMPLE_CONTROLLER})
        with patch.object(srv, "_get_flt_repo_dir", return_value=str(repo)):
            # First call populates cache.
            _call_catalog(srv)
            # Second call should hit cache and NOT call extract_catalog.
            with patch.object(srv, "extract_catalog") as mock_extract:
                handler = _call_catalog(srv)
            mock_extract.assert_not_called()
        assert handler.response_status == 200

    def test_cache_invalidates_on_new_file(self, srv, clear_cache, tmp_path):
        repo = _make_fake_repo(tmp_path, {"LiveTableController.cs": SAMPLE_CONTROLLER})
        with patch.object(srv, "_get_flt_repo_dir", return_value=str(repo)):
            _call_catalog(srv)
            assert len(srv._playground_catalog_cache) == 1
            cached_mtime = srv._playground_catalog_cache[str(repo)]["mtime"]

            # Add a new controller with a definitively newer mtime.
            time.sleep(0.05)
            ctrl_dir = repo / "Service" / "Microsoft.LiveTable.Service" / "Controllers"
            new_file = ctrl_dir / "LiveTableMaintenanceController.cs"
            new_file.write_text(
                SAMPLE_CONTROLLER.replace('liveTable"', 'liveTableMaintanance"')
                .replace("LiveTableController", "LiveTableMaintenanceController")
                .replace("getLatestDag", "getLockedDAGExecutionIteration")
            )
            import os

            os.utime(new_file, (time.time() + 1, time.time() + 1))

            handler = _call_catalog(srv)
        assert handler.response_status == 200
        # New cache mtime is newer than the old one.
        assert srv._playground_catalog_cache[str(repo)]["mtime"] > cached_mtime
        # New endpoint shows up.
        urls = [e["urlTemplate"] for e in handler.response_payload["endpoints"]]
        assert any("liveTableMaintanance" in u for u in urls)


# ════════════════════════════════════════════════════════════════
# §4 Error handling
# ════════════════════════════════════════════════════════════════


class TestErrorHandling:
    def test_mtime_probe_failure_returns_500(self, srv, clear_cache):
        with (
            patch.object(srv, "_get_flt_repo_dir", return_value="/nonexistent"),
            patch.object(srv, "controllers_dir_mtime", side_effect=RuntimeError("boom")),
        ):
            handler = _call_catalog(srv)
        assert handler.response_status == 500
        assert handler.response_payload["error"] == "extraction-failed"

    def test_extract_failure_returns_500(self, srv, clear_cache, tmp_path):
        repo = _make_fake_repo(tmp_path, {"LiveTableController.cs": SAMPLE_CONTROLLER})
        with (
            patch.object(srv, "_get_flt_repo_dir", return_value=str(repo)),
            patch.object(srv, "extract_catalog", side_effect=RuntimeError("parse failed")),
        ):
            handler = _call_catalog(srv)
        assert handler.response_status == 500
        assert handler.response_payload["error"] == "extraction-failed"
        assert "parse failed" in handler.response_payload["message"]


# ════════════════════════════════════════════════════════════════
# §5 Real FLT repo smoke test (skipped if not present)
# ════════════════════════════════════════════════════════════════


REAL_FLT_REPO = Path("C:/Users/guptahemant/newrepo/workload-fabriclivetable")


@pytest.mark.skipif(
    not (REAL_FLT_REPO / "Service" / "Microsoft.LiveTable.Service" / "Controllers").is_dir(),
    reason="Real FLT repo not available at expected path",
)
class TestRealFltRepo:
    def test_returns_real_endpoints(self, srv, clear_cache):
        with patch.object(srv, "_get_flt_repo_dir", return_value=str(REAL_FLT_REPO)):
            handler = _call_catalog(srv)
        assert handler.response_status == 200
        assert handler.response_payload["stats"]["endpoints_found"] >= 20
        # Sanity: the canonical FLT endpoint is in there.
        urls = [e["urlTemplate"] for e in handler.response_payload["endpoints"]]
        assert "/liveTable/getLatestDag" in urls
