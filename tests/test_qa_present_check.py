"""Tests for the presentation linter (scripts/qa_present_check.py).

The strongest invariant: the renderer's OWN output must pass its own linter with
zero errors — the renderer and the contract agree. Plus targeted bad-input cases
for each rule (the leaks this exists to catch).
"""

from scripts import qa_present_check as pc
from scripts import qa_render as R


def _err_rules(text):
    return {f.rule for f in pc.errors(pc.lint(text))}


def _all_rules(text):
    return {f.rule for f in pc.lint(text)}


# ── the renderer agrees with the linter (no errors on real output) ──────────

def test_rendered_verdict_has_no_errors():
    block = R.verdict(
        meta={"pr": "#991238", "title": "CDF status card", "commit": "abc1234", "run": "#4471", "took": "24.6s"},
        reviewer={"watch": "1 new endpoint", "looks_safe": "only adds things", "your_call": "1 path never ran"},
        confidence="high (repeatable)",
        categories=[
            {"name": "Happy path", "cases": [
                {"status": "pass", "title": "GET /insights/cdf-card returns 200", "cite": "request #1455",
                 "tool": "API call", "checks": ["status 200", "body matches schema"]}]},
            {"name": "Feature flag", "cases": [
                {"status": "never", "title": "the OFF path was not reached", "tool": "flip the flag",
                 "checks": ["ON applied", "OFF not exercised"]}]},
        ],
    )
    assert pc.errors(pc.lint(block)) == []


def test_rendered_change_summary_with_needs_a_human_has_no_errors():
    block = R.change_summary({
        "files": [{"path": "ControllersConfig.cs", "added": 3, "removed": 1, "note": "auth wiring"}],
        "api_change": {"kind": "safe", "text": "only adds an endpoint"},
        "security": "this change touches who's allowed in",
    })
    # "▲ NEEDS A HUMAN" is a contract phrase, not an off-vocab status word.
    assert "status_word" not in _all_rules(block)
    assert pc.errors(pc.lint(block)) == []


# ── the leaks it must catch ─────────────────────────────────────────────────

def test_catches_raw_json():
    bad = '  {\n    "status": 200,\n    "body": "ok"\n  }'
    assert "raw_json" in _err_rules(bad)


def test_catches_traceback():
    bad = 'Traceback (most recent call last):\n  File "x.py", line 5, in <module>'
    assert "raw_traceback" in _err_rules(bad)


def test_catches_emoji():
    assert "emoji" in _err_rules("✅ done")  # check-mark emoji, not the ✓ mark


def test_catches_box_drawing():
    assert "box_drawing" in _err_rules("┌──────┐\n│ cell │\n└──────┘")


def test_warns_off_vocab_status_word():
    rules = _all_rules("  ✕ FAILED   the endpoint blew up  (request #1)")
    assert "status_word" in rules  # FAILED is not in the fixed set (BROKEN is)


def test_warns_on_jargon():
    rules = _all_rules("  The oracle confirms the blast radius is small.")
    assert "jargon" in rules


def test_warns_missing_citation_on_result_line():
    rules = _all_rules("  ✓ The chain of steps finished")
    assert "no_citation" in rules


def test_clean_block_is_clean():
    good = "\n".join([
        R.headline(2, 7, "Understand the change"),
        R.fact("FLTInsightsEngine is ON for this workspace", cite="flag"),
    ])
    assert pc.errors(pc.lint(good)) == []
