"""Tests for scripts/flt_catalog.py extractor."""

from __future__ import annotations

import sys
import textwrap
from pathlib import Path

# Add scripts/ to sys.path so we can import flt_catalog directly.
_SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

from flt_catalog import (  # noqa: E402
    _compose_path,
    _danger_level,
    _derive_groups,
    _extract_class_route,
    _extract_last_summary,
    _humanize_method_name,
    _make_id,
    _parse_controller,
    _slice_param_list,
    controllers_dir_mtime,
    extract_catalog,
)


def _make_fake_repo(tmp_path: Path, controllers: dict[str, str]) -> Path:
    """Build a fake FLT repo layout under tmp_path with given controllers."""
    ctrl_dir = tmp_path / "Service" / "Microsoft.LiveTable.Service" / "Controllers"
    ctrl_dir.mkdir(parents=True)
    for name, content in controllers.items():
        (ctrl_dir / name).write_text(content, encoding="utf-8")
    return tmp_path


SAMPLE_LIVETABLE_CTRL = '''
namespace Microsoft.LiveTable.Service.Controllers
{
    [Route("v1/workspaces/{workspaceId}/lakehouses/{artifactId}/liveTable")]
    public class LiveTableController : BaseApiController
    {
        /// <summary>
        /// Gets the latest Dag for given lakehouse.
        /// </summary>
        /// <param name="workspaceId">workspace Id.</param>
        [HttpGet]
        [Route("getLatestDag")]
        public async Task<IActionResult> GetLatestDagAsync(
            [FromRoute] Guid workspaceId,
            [FromQuery] bool showExtendedLineage = false,
            CancellationToken cancellationToken = default)
        {
            return Ok();
        }

        /// <summary>
        /// Lists DAG execution iteration IDs.
        /// </summary>
        [HttpGet("listDAGExecutionIterationIds")]
        public async Task<IActionResult> ListAsync(
            [FromRoute] Guid workspaceId,
            [FromQuery] int? historyCount = null,
            CancellationToken cancellationToken = default)
        {
            return Ok();
        }

        /// <summary>
        /// Update settings.
        /// </summary>
        [HttpPatch]
        [Route("settings")]
        public async Task<IActionResult> UpdateSettingsAsync(
            [FromRoute] Guid workspaceId,
            [FromBody] DagSettings settings,
            CancellationToken cancellationToken)
        {
            return Ok();
        }

        /// <summary>
        /// Delete an MLV definition.
        /// </summary>
        [HttpDelete]
        [Route("mlvExecutionDefinitions/{mlvDefinitionId}")]
        public async Task<IActionResult> DeleteMlvAsync(
            [FromRoute] Guid workspaceId,
            [FromRoute] Guid mlvDefinitionId,
            CancellationToken cancellationToken)
        {
            return NoContent();
        }
    }
}
'''


SAMPLE_MAINTENANCE_CTRL = '''
namespace Microsoft.LiveTable.Service.Controllers
{
    [Route("v1/workspaces/{workspaceId}/lakehouses/{artifactId}/liveTableMaintanance")]
    public class LiveTableMaintenanceController : BaseApiController
    {
        /// <summary>
        /// Forces the Dag to be unlocked.
        /// </summary>
        [HttpPost]
        [Route("forceUnlockDAGExecution/{lockedIterationId}")]
        public async Task<IActionResult> ForceUnlockDAGExecutionAsync(
            [FromRoute] Guid workspaceId,
            [FromRoute] Guid lockedIterationId,
            CancellationToken cancellationToken)
        {
            return Ok();
        }
    }
}
'''


SAMPLE_INSIGHTS_CTRL = '''
namespace Microsoft.LiveTable.Service.Controllers
{
    [Route("v1/workspaces/{workspaceId}/lakehouses/{artifactId}/liveTable/insights")]
    public class LiveTableInsightsController : BaseApiController
    {
        /// <summary>
        /// Get summary.
        /// </summary>
        [HttpGet("summary")]
        public async Task<IActionResult> GetSummaryAsync(
            [FromRoute] Guid workspaceId,
            CancellationToken cancellationToken)
        {
            return Ok();
        }
    }
}
'''


SAMPLE_INTERNAL_CTRL = '''
namespace Microsoft.LiveTable.Service.Controllers
{
    [Route("internal")]
    public class InternalServiceController : BaseApiController
    {
        [HttpGet("healthcheck")]
        public IActionResult Health() => Ok();
    }
}
'''


SAMPLE_DYNAMIC_ROUTE_CTRL = '''
namespace Microsoft.LiveTable.Service.Controllers
{
    [Route("v1/workspaces/{workspaceId}/lakehouses/{artifactId}/liveTable")]
    public class DynamicController : BaseApiController
    {
        /// <summary>Has dynamic route.</summary>
        [HttpGet]
        [Route(SomeConstant.Foo)]
        public async Task<IActionResult> Foo() => Ok();

        /// <summary>Has static route.</summary>
        [HttpGet]
        [Route("bar")]
        public async Task<IActionResult> Bar() => Ok();
    }
}
'''


# ════════════════════════════════════════════════════════════════
# §1 _humanize_method_name
# ════════════════════════════════════════════════════════════════

class TestHumanizeMethodName:
    def test_strips_async_suffix(self):
        assert _humanize_method_name("GetLatestDagAsync") == "Get Latest Dag"

    def test_splits_camelcase(self):
        assert _humanize_method_name("GetSettings") == "Get Settings"

    def test_handles_acronym_runs(self):
        assert _humanize_method_name("ListDAGExecutionIds") == "List DAG Execution Ids"

    def test_handles_trailing_acronym(self):
        assert _humanize_method_name("UpdateDAG") == "Update DAG"

    def test_single_word(self):
        assert _humanize_method_name("Health") == "Health"

    def test_only_async(self):
        # "Async" alone strips to empty — caller should fall back to method name.
        assert _humanize_method_name("Async") == ""


# ════════════════════════════════════════════════════════════════
# §2 _danger_level
# ════════════════════════════════════════════════════════════════

class TestDangerLevel:
    def test_get_is_safe(self):
        assert _danger_level("GET", "GetFoo") == "safe"

    def test_post_is_caution(self):
        assert _danger_level("POST", "CreateFoo") == "caution"

    def test_put_is_caution(self):
        assert _danger_level("PUT", "UpdateFoo") == "caution"

    def test_patch_is_caution(self):
        assert _danger_level("PATCH", "PatchFoo") == "caution"

    def test_delete_is_destructive(self):
        assert _danger_level("DELETE", "DeleteFoo") == "destructive"

    def test_force_keyword_escalates_post(self):
        assert _danger_level("POST", "ForceUnlockAsync") == "destructive"

    def test_purge_keyword_escalates(self):
        assert _danger_level("POST", "PurgeStaleEntries") == "destructive"

    def test_case_insensitive_keyword(self):
        assert _danger_level("POST", "REMOVEAll") == "destructive"


# ════════════════════════════════════════════════════════════════
# §3 _make_id
# ════════════════════════════════════════════════════════════════

class TestMakeId:
    def test_simple_path(self):
        assert _make_id("GET", "/liveTable/getLatestDag") == "get-livetable-getlatestdag"

    def test_strips_placeholders(self):
        assert (
            _make_id("DELETE", "/liveTable/mlv/{id}")
            == "delete-livetable-mlv-id"
        )

    def test_no_path(self):
        assert _make_id("GET", "/") == "get"

    def test_special_chars_collapsed(self):
        assert _make_id("GET", "/foo//bar?baz") == "get-foo-bar-baz"


# ════════════════════════════════════════════════════════════════
# §4 _compose_path
# ════════════════════════════════════════════════════════════════

class TestComposePath:
    def test_simple(self):
        assert _compose_path("liveTable", "getLatestDag") == "liveTable/getLatestDag"

    def test_strips_trailing_left_slash(self):
        assert _compose_path("liveTable/", "getLatestDag") == "liveTable/getLatestDag"

    def test_strips_leading_right_slash(self):
        assert _compose_path("liveTable", "/getLatestDag") == "liveTable/getLatestDag"

    def test_empty_right(self):
        assert _compose_path("liveTable", "") == "liveTable"

    def test_both_slashes(self):
        assert _compose_path("liveTable/", "/getLatestDag") == "liveTable/getLatestDag"


# ════════════════════════════════════════════════════════════════
# §5 _slice_param_list
# ════════════════════════════════════════════════════════════════

class TestSliceParamList:
    def test_simple(self):
        text = "Foo(a, b)"
        assert _slice_param_list(text) == "(a, b)"

    def test_nested(self):
        text = "Foo(a, Bar(c, d), e) { ... }"
        assert _slice_param_list(text) == "(a, Bar(c, d), e)"

    def test_unmatched_returns_input(self):
        text = "Foo(a, b"
        assert _slice_param_list(text) == "Foo(a, b"


# ════════════════════════════════════════════════════════════════
# §6 _extract_class_route
# ════════════════════════════════════════════════════════════════

class TestExtractClassRoute:
    def test_finds_route(self):
        text = textwrap.dedent('''
            [Route("v1/workspaces/{workspaceId}/lakehouses/{artifactId}/liveTable")]
            public class FooController { }
        ''')
        assert _extract_class_route(text) == (
            "v1/workspaces/{workspaceId}/lakehouses/{artifactId}/liveTable"
        )

    def test_no_class(self):
        assert _extract_class_route("// just a comment") is None

    def test_no_route(self):
        text = "public class FooController { }"
        assert _extract_class_route(text) is None

    def test_picks_class_route_not_method(self):
        # Multiple [Route(...)] occurrences — the LAST one before the class
        # declaration wins (it's the class-level Route).
        text = textwrap.dedent('''
            // method-level Route in a comment example: [Route("getFoo")]
            [Route("v1/workspaces/{workspaceId}/lakehouses/{artifactId}/liveTable")]
            public class LiveTableController { }
        ''')
        assert _extract_class_route(text) == (
            "v1/workspaces/{workspaceId}/lakehouses/{artifactId}/liveTable"
        )


# ════════════════════════════════════════════════════════════════
# §7 _extract_last_summary
# ════════════════════════════════════════════════════════════════

class TestExtractLastSummary:
    def test_single_line(self):
        text = "/// <summary>\n/// One line.\n/// </summary>"
        assert _extract_last_summary(text) == "One line."

    def test_multi_line(self):
        text = (
            "/// <summary>\n"
            "/// First line.\n"
            "/// Second line.\n"
            "/// </summary>"
        )
        assert _extract_last_summary(text) == "First line. Second line."

    def test_no_summary(self):
        assert _extract_last_summary("// regular comment") == ""

    def test_picks_last_when_multiple(self):
        text = (
            "/// <summary>\n/// First.\n/// </summary>\n"
            "void Skip();\n"
            "/// <summary>\n/// Second.\n/// </summary>"
        )
        assert _extract_last_summary(text) == "Second."


# ════════════════════════════════════════════════════════════════
# §8 _parse_controller — full integration on synthetic C# text
# ════════════════════════════════════════════════════════════════

class TestParseController:
    def test_livetable_extracts_four_endpoints(self):
        endpoints, warnings = _parse_controller(SAMPLE_LIVETABLE_CTRL, "LiveTableController.cs")
        assert endpoints is not None
        assert warnings == []
        assert len(endpoints) == 4

    def test_combined_http_route(self):
        endpoints, _ = _parse_controller(SAMPLE_LIVETABLE_CTRL, "LiveTableController.cs")
        # listDAGExecutionIterationIds uses combined [HttpGet("...")] form.
        match = [e for e in endpoints if e["urlTemplate"].endswith("listDAGExecutionIterationIds")]
        assert len(match) == 1
        assert match[0]["method"] == "GET"

    def test_query_params_extracted(self):
        endpoints, _ = _parse_controller(SAMPLE_LIVETABLE_CTRL, "LiveTableController.cs")
        dag = next(e for e in endpoints if e["urlTemplate"] == "/liveTable/getLatestDag")
        assert "showExtendedLineage" in dag["queryParams"]

    def test_body_template_for_post_with_frombody(self):
        endpoints, _ = _parse_controller(SAMPLE_LIVETABLE_CTRL, "LiveTableController.cs")
        update = next(e for e in endpoints if e["urlTemplate"] == "/liveTable/settings")
        assert update["bodyTemplate"] == {}

    def test_no_body_template_for_get(self):
        endpoints, _ = _parse_controller(SAMPLE_LIVETABLE_CTRL, "LiveTableController.cs")
        get = next(e for e in endpoints if e["urlTemplate"] == "/liveTable/getLatestDag")
        assert get["bodyTemplate"] is None

    def test_delete_is_destructive(self):
        endpoints, _ = _parse_controller(SAMPLE_LIVETABLE_CTRL, "LiveTableController.cs")
        delete = next(e for e in endpoints if e["method"] == "DELETE")
        assert delete["dangerLevel"] == "destructive"

    def test_post_with_force_is_destructive(self):
        endpoints, _ = _parse_controller(SAMPLE_MAINTENANCE_CTRL, "LiveTableMaintenanceController.cs")
        force = next(e for e in endpoints if "forceUnlock" in e["urlTemplate"])
        assert force["dangerLevel"] == "destructive"

    def test_full_path_includes_workspace_lakehouse_placeholders(self):
        endpoints, _ = _parse_controller(SAMPLE_LIVETABLE_CTRL, "LiveTableController.cs")
        dag = next(e for e in endpoints if e["urlTemplate"] == "/liveTable/getLatestDag")
        assert dag["fullPath"] == (
            "/v1/workspaces/{workspaceId}/lakehouses/{artifactId}/liveTable/getLatestDag"
        )

    def test_token_type_is_always_mwc(self):
        endpoints, _ = _parse_controller(SAMPLE_LIVETABLE_CTRL, "LiveTableController.cs")
        assert all(e["tokenType"] == "mwc" for e in endpoints)

    def test_group_is_class_suffix(self):
        endpoints, _ = _parse_controller(SAMPLE_LIVETABLE_CTRL, "LiveTableController.cs")
        assert all(e["group"] == "liveTable" for e in endpoints)

    def test_insights_group_is_separate(self):
        endpoints, _ = _parse_controller(SAMPLE_INSIGHTS_CTRL, "LiveTableInsightsController.cs")
        assert endpoints is not None
        assert all(e["group"] == "liveTable/insights" for e in endpoints)

    def test_internal_controller_filtered_silently(self):
        endpoints, warnings = _parse_controller(SAMPLE_INTERNAL_CTRL, "InternalServiceController.cs")
        # Returns None because class route doesn't start with the inclusion prefix.
        assert endpoints is None
        assert warnings == []

    def test_dynamic_route_skipped_with_warning(self):
        endpoints, warnings = _parse_controller(SAMPLE_DYNAMIC_ROUTE_CTRL, "DynamicController.cs")
        assert endpoints is not None
        assert len(endpoints) == 1  # only bar (static), foo skipped
        assert endpoints[0]["urlTemplate"] == "/liveTable/bar"
        assert any("dynamic" in w.lower() for w in warnings)

    def test_description_extracted(self):
        endpoints, _ = _parse_controller(SAMPLE_LIVETABLE_CTRL, "LiveTableController.cs")
        dag = next(e for e in endpoints if e["urlTemplate"] == "/liveTable/getLatestDag")
        assert "latest Dag" in dag["description"]

    def test_unique_ids_for_same_path_different_verbs(self):
        endpoints, _ = _parse_controller(SAMPLE_LIVETABLE_CTRL, "LiveTableController.cs")
        ids = [e["id"] for e in endpoints]
        assert len(set(ids)) == len(ids)


# ════════════════════════════════════════════════════════════════
# §9 extract_catalog — end-to-end with fake repo
# ════════════════════════════════════════════════════════════════

class TestExtractCatalog:
    def test_missing_controllers_dir_returns_empty_with_warning(self, tmp_path):
        result = extract_catalog(str(tmp_path))
        assert result["endpoints"] == []
        assert result["stats"]["controllers_scanned"] == 0
        assert any("Controllers directory not found" in w for w in result["warnings"])

    def test_full_extraction_from_fake_repo(self, tmp_path):
        repo = _make_fake_repo(
            tmp_path,
            {
                "LiveTableController.cs": SAMPLE_LIVETABLE_CTRL,
                "LiveTableMaintenanceController.cs": SAMPLE_MAINTENANCE_CTRL,
                "LiveTableInsightsController.cs": SAMPLE_INSIGHTS_CTRL,
                "InternalServiceController.cs": SAMPLE_INTERNAL_CTRL,
            },
        )
        result = extract_catalog(str(repo))
        assert result["stats"]["controllers_scanned"] == 3
        # 4 LiveTable + 1 Maintenance + 1 Insights = 6 endpoints
        assert result["stats"]["endpoints_found"] == 6

    def test_groups_have_friendly_labels(self, tmp_path):
        repo = _make_fake_repo(
            tmp_path,
            {
                "LiveTableController.cs": SAMPLE_LIVETABLE_CTRL,
                "LiveTableMaintenanceController.cs": SAMPLE_MAINTENANCE_CTRL,
                "LiveTableInsightsController.cs": SAMPLE_INSIGHTS_CTRL,
            },
        )
        result = extract_catalog(str(repo))
        labels = {g["id"]: g["label"] for g in result["groups"]}
        assert labels["liveTable"] == "LiveTable"
        assert labels["liveTable/insights"] == "Insights"
        assert labels["liveTableMaintanance"] == "Maintenance"

    def test_publicapi_excluded_with_warning(self, tmp_path):
        ctrl_dir = tmp_path / "Service" / "Microsoft.LiveTable.Service" / "Controllers" / "PublicAPI"
        ctrl_dir.mkdir(parents=True)
        (ctrl_dir / "LiveTablePublicController.cs").write_text(SAMPLE_LIVETABLE_CTRL)
        # also add a normal one
        normal_dir = ctrl_dir.parent
        (normal_dir / "LiveTableController.cs").write_text(SAMPLE_LIVETABLE_CTRL)

        result = extract_catalog(str(tmp_path))
        assert result["stats"]["controllers_scanned"] == 1  # only the normal one
        assert any("PublicAPI" in w for w in result["warnings"])

    def test_excluded_base_controller(self, tmp_path):
        repo = _make_fake_repo(
            tmp_path,
            {
                "BaseApiController.cs": "public abstract class BaseApiController { }",
                "LiveTableController.cs": SAMPLE_LIVETABLE_CTRL,
            },
        )
        result = extract_catalog(str(repo))
        assert result["stats"]["controllers_scanned"] == 1

    def test_extracted_at_is_iso8601_z(self, tmp_path):
        repo = _make_fake_repo(tmp_path, {"LiveTableController.cs": SAMPLE_LIVETABLE_CTRL})
        result = extract_catalog(str(repo))
        assert result["extractedAt"].endswith("Z")
        # parseable as ISO 8601 (without the Z)
        from datetime import datetime
        datetime.fromisoformat(result["extractedAt"].rstrip("Z"))


# ════════════════════════════════════════════════════════════════
# §10 controllers_dir_mtime
# ════════════════════════════════════════════════════════════════

class TestControllersDirMtime:
    def test_returns_none_for_missing(self, tmp_path):
        assert controllers_dir_mtime(str(tmp_path)) is None

    def test_returns_mtime_for_existing(self, tmp_path):
        repo = _make_fake_repo(tmp_path, {"LiveTableController.cs": SAMPLE_LIVETABLE_CTRL})
        m = controllers_dir_mtime(str(repo))
        assert m is not None
        assert m > 0

    def test_mtime_changes_when_file_added(self, tmp_path):
        repo = _make_fake_repo(tmp_path, {"LiveTableController.cs": SAMPLE_LIVETABLE_CTRL})
        m1 = controllers_dir_mtime(str(repo))
        # Wait a tick and add a file with a newer mtime.
        import time
        time.sleep(0.05)
        ctrl_dir = repo / "Service" / "Microsoft.LiveTable.Service" / "Controllers"
        new_file = ctrl_dir / "LiveTableMaintenanceController.cs"
        new_file.write_text(SAMPLE_MAINTENANCE_CTRL)
        # Force a fresh mtime on the new file in case the FS resolution is coarse.
        import os
        now = time.time()
        os.utime(new_file, (now, now))
        m2 = controllers_dir_mtime(str(repo))
        assert m2 >= m1


# ════════════════════════════════════════════════════════════════
# §11 _derive_groups
# ════════════════════════════════════════════════════════════════

class TestDeriveGroups:
    def test_empty(self):
        assert _derive_groups([]) == []

    def test_stable_order(self):
        eps = [
            {"group": "b"},
            {"group": "a"},
            {"group": "b"},
            {"group": "c"},
        ]
        groups = _derive_groups(eps)
        assert [g["id"] for g in groups] == ["b", "a", "c"]

    def test_assigns_orders(self):
        groups = _derive_groups([{"group": "x"}, {"group": "y"}])
        assert groups[0]["order"] == 0
        assert groups[1]["order"] == 1
