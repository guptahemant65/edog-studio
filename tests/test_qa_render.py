from scripts import qa_render as r


def test_headline_uses_diamond_and_step():
    assert r.headline(2, 7, "Understand the change") == "\u25c6 Step 2 of 7 \u00b7 Understand the change"


def test_action_uses_triangle_marker():
    assert r.action("Reading the diff\u2026") == "\u25b8 Reading the diff\u2026"


def test_gate_lists_options():
    assert r.gate("Run this plan?", "edit \u00b7 y to start") == "\u25b8 Run this plan?   edit \u00b7 y to start"


def test_status_row_maps_each_status_to_the_right_mark_and_word():
    # the core honesty contract: a broken case is NEVER a check mark
    assert r.status_row("pass", "ok body", cite="request #1") == "  \u2713 PASS        ok body  (request #1)"
    assert r.status_row("broken", "it failed").startswith("  \u2717 BROKEN")
    assert r.status_row("suspected", "maybe").startswith("  \u25b2 SUSPECTED")
    assert r.status_row("cant", "setup").startswith("  \u25b2 COULDN'T CHECK")
    assert r.status_row("never", "nope").startswith("  \u25cc NEVER RAN")


def test_status_row_without_cite_has_no_trailing_parens():
    assert r.status_row("pass", "ok") == "  \u2713 PASS        ok"


def test_tool_checks_line_renders_both_fields():
    line = r.tool_checks_line("API call (GET the endpoint)", ["status is 200", "body matches its schema"])
    assert line == "      tool: API call (GET the endpoint) \u00b7 checks: status is 200 \u00b7 body matches its schema"


def test_category_group_header_carries_the_count():
    block = r.plan([
        {"name": "Happy path", "cases": [
            {"title": "endpoint returns 200", "tool": "API call", "checks": ["status 200"]},
        ]},
    ])
    assert "Happy path (1)" in block
    assert "endpoint returns 200" in block
    assert "tool: API call \u00b7 checks: status 200" in block


def test_change_summary_shows_flag_direction_and_breaking_api():
    block = r.change_summary({
        "flags": {"added": [{"name": "FLTNew", "note": "turns on X"}],
                   "removed": [{"name": "FLTOld", "note": "gone"}], "used": []},
        "files": [{"path": "Controller.cs", "added": 155, "removed": 2, "note": "the endpoint"}],
        "does": [{"text": "Adds GET /insights/summary", "cite": "Controller.cs:64"}],
        "api_change": {"kind": "breaking", "text": "renames a response field"},
    })
    assert "+  New      FLTNew" in block
    assert "\u2212  Removed  FLTOld" in block
    assert "+155 / \u22122" in block
    assert "Controller.cs:64" in block
    # a breaking API change must carry the needs-attention mark, never read 'safe'
    assert "\u25b2 breaking" in block


def test_change_summary_safe_api_is_quiet():
    block = r.change_summary({
        "flags": {"added": [], "removed": [], "used": []},
        "files": [{"path": "C.cs", "added": 3, "removed": 0, "note": "x"}],
        "does": [],
        "api_change": {"kind": "safe", "text": "only adds an endpoint"},
    })
    assert "safe" in block and "\u25b2" not in block


def test_results_echo_tool_checks_and_evidence_offer_ref():
    block = r.results([
        {"name": "Happy path", "cases": [
            {"status": "pass", "title": "200 ok", "cite": "request #1455",
             "tool": "API call", "checks": ["status 200"], "evidence_ref": "request #1455"},
        ]},
    ])
    assert "\u2713 PASS" in block and "tool: API call" in block


def test_verdict_totals_across_all_cases():
    block = r.verdict(
        meta={"pr": "#1008944", "title": "T", "commit": "abc", "run": "#1", "took": "5s"},
        categories=[
            {"name": "Happy path", "cases": [
                {"status": "pass", "title": "a", "tool": "API call", "checks": ["x"]},
            ]},
            {"name": "Edge", "cases": [
                {"status": "suspected", "title": "b", "tool": "API call", "checks": ["y"]},
                {"status": "never", "title": "c", "tool": "API call", "checks": ["z"]},
            ]},
        ],
        reviewer={"watch": "token", "looks_safe": "adds only", "your_call": "1 suspected"},
        confidence="data checks high",
    )
    assert "1 passed" in block and "1 suspected" in block and "1 never ran" in block
    assert "3 cases" in block


def test_no_emoji_anywhere_in_rendered_output():
    blocks = [
        r.headline(1, 7, "x"), r.action("y"), r.gate("q", "o"),
        r.status_row("broken", "z", cite="c #1"),
        r.change_summary({"flags": {"added": [], "removed": [], "used": []}, "files": [],
                          "does": [], "api_change": {"kind": "safe", "text": "t"}}),
    ]
    def is_emoji(o):
        return (0x1F000 <= o <= 0x1FAFF or 0x2600 <= o <= 0x26FF or o == 0xFE0F
                or o in (0x2705, 0x274C, 0x2728, 0x2B50, 0x2757, 0x2753, 0x26A0, 0x1F512))
    for b in blocks:
        assert not [c for c in b if is_emoji(ord(c))], f"emoji in: {b!r}"
