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
        names = [p["name"] for p in dag["queryParams"]]
        assert "showExtendedLineage" in names

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
        # 4 LiveTable + 1 Maintenance + 1 Insights = 6 controller endpoints,
        # plus 2 framework endpoints (swagger spec + swagger UI) = 8 total.
        assert result["stats"]["endpoints_found"] == 8
        assert result["stats"]["framework_endpoints"] == 2

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


# ════════════════════════════════════════════════════════════════
# §12 Query Param Enrichment
# ════════════════════════════════════════════════════════════════


from flt_catalog import (  # noqa: E402
    _classify_type,
    _collect_enum_values,
    _extract_consts,
    _extract_param_descriptions,
    _parse_query_params,
    _resolve_default,
)

# ── _extract_consts ──────────────────────────────────────────────


class TestExtractConsts:
    def test_int_const(self):
        text = "private const int DefaultDateRangeDays = 30;"
        assert _extract_consts(text) == {"DefaultDateRangeDays": 30}

    def test_string_const(self):
        text = 'private const string DefaultGroupBy = "day";'
        assert _extract_consts(text) == {"DefaultGroupBy": "day"}

    def test_static_readonly_int(self):
        text = "public static readonly int DefaultPageSize = 50;"
        assert _extract_consts(text) == {"DefaultPageSize": 50}

    def test_multiple_consts(self):
        text = textwrap.dedent("""
            public class Foo {
                private const int A = 1;
                private const string B = "x";
                public const bool C = true;
            }
        """)
        out = _extract_consts(text)
        assert out["A"] == 1
        assert out["B"] == "x"
        assert out["C"] is True

    def test_no_consts(self):
        assert _extract_consts("public class Foo { public int X { get; set; } }") == {}

    def test_negative_int(self):
        text = "private const int X = -5;"
        assert _extract_consts(text) == {"X": -5}


# ── _resolve_default ─────────────────────────────────────────────


class TestResolveDefault:
    def test_literal_int(self):
        assert _resolve_default("100", {}) == (100, "100", True)

    def test_literal_negative_int(self):
        assert _resolve_default("-5", {}) == (-5, "-5", True)

    def test_literal_string(self):
        assert _resolve_default('"sys_dq_metrics"', {}) == ("sys_dq_metrics", '"sys_dq_metrics"', True)

    def test_literal_bool_true(self):
        assert _resolve_default("true", {}) == (True, "true", True)

    def test_literal_bool_false(self):
        assert _resolve_default("false", {}) == (False, "false", True)

    def test_literal_null(self):
        assert _resolve_default("null", {}) == (None, "null", True)

    def test_const_resolved(self):
        consts = {"DefaultDateRangeDays": 30}
        assert _resolve_default("DefaultDateRangeDays", consts) == (30, "DefaultDateRangeDays", True)

    def test_const_unresolved(self):
        # Returns None as value, the literal symbol, resolved=False
        assert _resolve_default("UnknownConst", {}) == (None, "UnknownConst", False)

    def test_qualified_const_unresolved(self):
        # Constants.Foo style — keep literal, mark unresolved
        v, lit, ok = _resolve_default("Constants.Foo", {})
        assert v is None
        assert lit == "Constants.Foo"
        assert ok is False


# ── _classify_type ───────────────────────────────────────────────


class TestClassifyType:
    def test_int_scalar(self):
        kind, nullable = _classify_type("int", set())
        assert kind == "scalar"
        assert nullable is False

    def test_nullable_int(self):
        kind, nullable = _classify_type("int?", set())
        assert kind == "scalar"
        assert nullable is True

    def test_string_scalar(self):
        # In C#, string is implicitly nullable but we don't treat it as nullable
        # for "required" purposes since absence of a default still means required.
        kind, nullable = _classify_type("string", set())
        assert kind == "scalar"
        assert nullable is False

    def test_guid_nullable(self):
        kind, nullable = _classify_type("Guid?", set())
        assert kind == "scalar"
        assert nullable is True

    def test_datetime_nullable(self):
        kind, nullable = _classify_type("DateTime?", set())
        assert kind == "scalar"
        assert nullable is True

    def test_list_of_guid(self):
        kind, nullable = _classify_type("List<Guid>", set())
        assert kind == "list"
        assert nullable is False

    def test_list_of_enum(self):
        kind, nullable = _classify_type("List<DagExecutionStatus>", {"DagExecutionStatus"})
        assert kind == "enum-list"
        assert nullable is False

    def test_enum_scalar(self):
        kind, nullable = _classify_type("DagExecutionStatus", {"DagExecutionStatus"})
        assert kind == "enum"
        assert nullable is False

    def test_nullable_enum(self):
        kind, nullable = _classify_type("DagExecutionStatus?", {"DagExecutionStatus"})
        assert kind == "enum"
        assert nullable is True

    def test_unknown_type_falls_back_to_scalar(self):
        kind, nullable = _classify_type("CustomType", set())
        assert kind == "scalar"
        assert nullable is False


# ── _extract_param_descriptions ──────────────────────────────────


class TestExtractParamDescriptions:
    def test_single_param(self):
        block = '/// <param name="historyCount">Number of past runs.</param>'
        assert _extract_param_descriptions(block) == {"historyCount": "Number of past runs."}

    def test_multiple_params(self):
        block = textwrap.dedent('''
            /// <param name="startTime">Start of window.</param>
            /// <param name="endTime">End of window.</param>
        ''')
        out = _extract_param_descriptions(block)
        assert out == {"startTime": "Start of window.", "endTime": "End of window."}

    def test_multi_line_description(self):
        block = textwrap.dedent('''
            /// <param name="x">First line.
            /// Second line.</param>
        ''')
        out = _extract_param_descriptions(block)
        assert "First line." in out["x"]
        assert "Second line." in out["x"]

    def test_no_params(self):
        assert _extract_param_descriptions("/// <summary>foo</summary>") == {}

    def test_param_without_description(self):
        # Self-closing param tag — no description body
        block = '/// <param name="x"></param>'
        out = _extract_param_descriptions(block)
        assert out.get("x", "") == ""


# ── _parse_query_params ──────────────────────────────────────────


class TestParseQueryParams:
    def test_simple_bool_with_default(self):
        params_text = "([FromQuery] bool showExtendedLineage = false)"
        out = _parse_query_params(params_text, {}, set(), {})
        assert len(out) == 1
        p = out[0]
        assert p["name"] == "showExtendedLineage"
        assert p["type"] == "bool"
        assert p["kind"] == "scalar"
        assert p["default"] is False
        assert p["defaultLiteral"] == "false"
        assert p["required"] is False

    def test_nullable_int_with_null_default(self):
        params_text = "([FromQuery] int? historyCount = null)"
        out = _parse_query_params(params_text, {}, set(), {})
        p = out[0]
        assert p["type"] == "int?"
        assert p["default"] is None
        assert p["defaultLiteral"] == "null"
        assert p["required"] is False  # nullable AND has default

    def test_string_with_literal_default(self):
        params_text = '([FromQuery] string tableName = "sys_dq_metrics")'
        out = _parse_query_params(params_text, {}, set(), {})
        p = out[0]
        assert p["default"] == "sys_dq_metrics"
        assert p["required"] is False

    def test_int_with_const_default_resolved(self):
        params_text = "([FromQuery] int dateRange = DefaultDateRangeDays)"
        consts = {"DefaultDateRangeDays": 30}
        out = _parse_query_params(params_text, consts, set(), {})
        p = out[0]
        assert p["default"] == 30
        assert p["defaultLiteral"] == "DefaultDateRangeDays"
        assert p["required"] is False

    def test_int_with_const_default_unresolved(self):
        params_text = "([FromQuery] int dateRange = SomeUnknownConst)"
        out = _parse_query_params(params_text, {}, set(), {})
        p = out[0]
        assert p["default"] is None
        assert p["defaultLiteral"] == "SomeUnknownConst"

    def test_required_when_no_default_non_nullable(self):
        params_text = "([FromQuery] string status)"
        out = _parse_query_params(params_text, {}, set(), {})
        p = out[0]
        assert p["required"] is True
        assert p["default"] is None

    def test_optional_when_nullable_no_default(self):
        params_text = "([FromQuery] Guid? iterationId)"
        out = _parse_query_params(params_text, {}, set(), {})
        p = out[0]
        assert p["required"] is False
        assert p["type"] == "Guid?"

    def test_list_of_guid(self):
        params_text = "([FromQuery] List<Guid> mlvExecutionDefinitionIds = null)"
        out = _parse_query_params(params_text, {}, set(), {})
        p = out[0]
        assert p["kind"] == "list"
        assert p["type"] == "List<Guid>"
        assert p["required"] is False

    def test_list_of_enum_with_lookup(self):
        params_text = "([FromQuery] List<DagExecutionStatus> statuses = null)"
        enums = {"DagExecutionStatus"}
        out = _parse_query_params(params_text, {}, enums, {})
        p = out[0]
        assert p["kind"] == "enum-list"

    def test_alias_from_named_attribute(self):
        params_text = '([FromQuery(Name = "_top")] int top = 100)'
        out = _parse_query_params(params_text, {}, set(), {})
        p = out[0]
        assert p["name"] == "top"
        assert p["alias"] == "_top"

    def test_no_alias(self):
        params_text = "([FromQuery] int top = 100)"
        out = _parse_query_params(params_text, {}, set(), {})
        p = out[0]
        assert p["alias"] is None

    def test_description_from_param_docs(self):
        params_text = "([FromQuery] int historyCount = 10)"
        param_docs = {"historyCount": "Number of past runs to return."}
        out = _parse_query_params(params_text, {}, set(), param_docs)
        p = out[0]
        assert p["description"] == "Number of past runs to return."

    def test_no_description_when_not_documented(self):
        params_text = "([FromQuery] int x = 1)"
        out = _parse_query_params(params_text, {}, set(), {})
        p = out[0]
        assert p["description"] == ""

    def test_multiple_query_params(self):
        params_text = textwrap.dedent("""
            (
                [FromRoute] Guid workspaceId,
                [FromQuery] int? historyCount = null,
                [FromQuery] DateTime? startTime = null,
                [FromQuery] string continuationToken = null
            )
        """)
        out = _parse_query_params(params_text, {}, set(), {})
        names = [p["name"] for p in out]
        assert names == ["historyCount", "startTime", "continuationToken"]

    def test_ignores_from_route_and_from_body(self):
        params_text = textwrap.dedent("""
            (
                [FromRoute] Guid workspaceId,
                [FromBody] Settings settings,
                [FromQuery] bool flag = false
            )
        """)
        out = _parse_query_params(params_text, {}, set(), {})
        assert len(out) == 1
        assert out[0]["name"] == "flag"


# ── _collect_enum_values ─────────────────────────────────────────


class TestCollectEnumValues:
    def test_finds_enum(self, tmp_path):
        repo = tmp_path
        svc = repo / "Service" / "Microsoft.LiveTable.Service" / "DataModel"
        svc.mkdir(parents=True)
        (svc / "DagExecutionStatus.cs").write_text(
            textwrap.dedent("""
                namespace Foo
                {
                    public enum DagExecutionStatus
                    {
                        Pending,
                        Running,
                        Completed,
                        Failed,
                    }
                }
            """),
            encoding="utf-8",
        )
        out = _collect_enum_values(repo)
        assert out["DagExecutionStatus"] == ["Pending", "Running", "Completed", "Failed"]

    def test_ignores_enum_with_explicit_values(self, tmp_path):
        # Should still collect just the names, not the values
        repo = tmp_path
        svc = repo / "Service" / "Microsoft.LiveTable.Service" / "DataModel"
        svc.mkdir(parents=True)
        (svc / "Status.cs").write_text(
            textwrap.dedent("""
                public enum Status
                {
                    Active = 1,
                    Inactive = 2,
                }
            """),
            encoding="utf-8",
        )
        out = _collect_enum_values(repo)
        assert out["Status"] == ["Active", "Inactive"]

    def test_missing_dir_returns_empty(self, tmp_path):
        assert _collect_enum_values(tmp_path) == {}

    def test_multiple_enums_in_file(self, tmp_path):
        repo = tmp_path
        svc = repo / "Service" / "Microsoft.LiveTable.Service" / "DataModel"
        svc.mkdir(parents=True)
        (svc / "Multi.cs").write_text(
            textwrap.dedent("""
                public enum A { X, Y }
                public enum B { P, Q, R }
            """),
            encoding="utf-8",
        )
        out = _collect_enum_values(repo)
        assert out["A"] == ["X", "Y"]
        assert out["B"] == ["P", "Q", "R"]


# ── End-to-end: extract_catalog with enriched queryParams ───────


class TestEnrichedQueryParamsEndToEnd:
    def test_query_params_are_objects_not_strings(self, tmp_path):
        repo = _make_fake_repo(tmp_path, {"LiveTableController.cs": SAMPLE_LIVETABLE_CTRL})
        result = extract_catalog(str(repo))
        eps = [e for e in result["endpoints"] if "getlatestdag" in e["id"]]
        assert eps
        qp = eps[0]["queryParams"]
        assert qp and isinstance(qp[0], dict)
        assert qp[0]["name"] == "showExtendedLineage"
        assert qp[0]["type"] == "bool"
        assert qp[0]["default"] is False

    def test_required_param_marked(self, tmp_path):
        ctrl = textwrap.dedent('''
            namespace X {
                [Route("v1/workspaces/{workspaceId}/lakehouses/{artifactId}/liveTable")]
                public class LiveTableController : BaseApiController {
                    /// <summary>foo</summary>
                    [HttpGet("required")]
                    public async Task<IActionResult> Foo(
                        [FromRoute] Guid workspaceId,
                        [FromQuery] string mustHave) => Ok();
                }
            }
        ''')
        repo = _make_fake_repo(tmp_path, {"LiveTableController.cs": ctrl})
        result = extract_catalog(str(repo))
        ep = result["endpoints"][0]
        qp = ep["queryParams"][0]
        assert qp["required"] is True

    def test_const_resolution_in_endpoint(self, tmp_path):
        ctrl = textwrap.dedent('''
            namespace X {
                [Route("v1/workspaces/{workspaceId}/lakehouses/{artifactId}/liveTable")]
                public class LiveTableController : BaseApiController {
                    private const int DefaultDateRangeDays = 30;

                    /// <summary>foo</summary>
                    [HttpGet("insights")]
                    public async Task<IActionResult> Foo(
                        [FromRoute] Guid workspaceId,
                        [FromQuery] int dateRange = DefaultDateRangeDays) => Ok();
                }
            }
        ''')
        repo = _make_fake_repo(tmp_path, {"LiveTableController.cs": ctrl})
        result = extract_catalog(str(repo))
        ep = result["endpoints"][0]
        qp = ep["queryParams"][0]
        assert qp["default"] == 30
        assert qp["defaultLiteral"] == "DefaultDateRangeDays"

    def test_param_description_attached(self, tmp_path):
        ctrl = textwrap.dedent('''
            namespace X {
                [Route("v1/workspaces/{workspaceId}/lakehouses/{artifactId}/liveTable")]
                public class LiveTableController : BaseApiController {
                    /// <summary>foo</summary>
                    /// <param name="historyCount">Number of past runs to return.</param>
                    [HttpGet("history")]
                    public async Task<IActionResult> Foo(
                        [FromRoute] Guid workspaceId,
                        [FromQuery] int historyCount = 10) => Ok();
                }
            }
        ''')
        repo = _make_fake_repo(tmp_path, {"LiveTableController.cs": ctrl})
        result = extract_catalog(str(repo))
        ep = result["endpoints"][0]
        qp = ep["queryParams"][0]
        assert qp["description"] == "Number of past runs to return."

    def test_enum_values_attached_when_known(self, tmp_path):
        ctrl = textwrap.dedent('''
            namespace X {
                [Route("v1/workspaces/{workspaceId}/lakehouses/{artifactId}/liveTable")]
                public class LiveTableController : BaseApiController {
                    /// <summary>foo</summary>
                    [HttpGet("history")]
                    public async Task<IActionResult> Foo(
                        [FromRoute] Guid workspaceId,
                        [FromQuery] List<DagExecutionStatus> statuses = null) => Ok();
                }
            }
        ''')
        # Create the enum file too
        repo = tmp_path
        ctrl_dir = repo / "Service" / "Microsoft.LiveTable.Service" / "Controllers"
        ctrl_dir.mkdir(parents=True)
        (ctrl_dir / "LiveTableController.cs").write_text(ctrl, encoding="utf-8")
        dm = repo / "Service" / "Microsoft.LiveTable.Service" / "DataModel"
        dm.mkdir(parents=True)
        (dm / "DagExecutionStatus.cs").write_text(
            "public enum DagExecutionStatus { Pending, Running, Completed, Failed }",
            encoding="utf-8",
        )
        result = extract_catalog(str(repo))
        ep = result["endpoints"][0]
        qp = ep["queryParams"][0]
        assert qp["kind"] == "enum-list"
        assert qp["enumValues"] == ["Pending", "Running", "Completed", "Failed"]
