"""F27 P9 T1f-a — deterministic scorer tests.

Pins the matcher invariants the rubber-duck review (Sentinel,
2026-05-18) blocked T1f-a on:

- Match key is ``(category, verb, changed-line overlap > 0)``. Same-file-
  different-line is NOT a match.
- Tiebreaker is max changed-line overlap count.
- ``expected.json`` schema v1.0 (T0/T1a scaffold) still parses as
  ``curator_state='PENDING_HUMAN_GRADING'`` without errors.
- ``expected.json`` schema v2.0 (graded) validates category + verb +
  criticality + discovered_by against the allow-lists.
- Floor enforcement: absolute violations → FAIL; missing floors file →
  ``report_only``.
- Precision is reported separately per stage ``{emitted, validated, projected}``.
- Aggregate macro vs micro arithmetic.

All tests are pure-Python; no live LLM calls, no harness invocation.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
QA_EVAL = REPO_ROOT / "tests" / "qa-eval"

sys.path.insert(0, str(QA_EVAL))

# isort:skip_file
import score_eval  # noqa: E402  -- after sys.path injection


# ─── Helpers ──────────────────────────────────────────────────────────────


def _grounding(path: str, lines: list[int], side: str = "right") -> dict:
    return {"path": path, "side": side, "lines": lines}


def _expected_blob(
    *,
    sid: str = "exp-001",
    behavior_key: str = "demo",
    category: str = "HappyPath",
    verb: str = "EventPresent",
    title: str = "demo",
    grounding: list[dict] | None = None,
    criticality: str = "P0",
    discovered_by: str = "diff_inspection",
    rationale: str = "demo",
) -> dict:
    if grounding is None:
        grounding = [_grounding("a.cs", [10])]
    return {
        "id": sid,
        "behavior_key": behavior_key,
        "category": category,
        "verb": verb,
        "title": title,
        "grounding_changed_lines": grounding,
        "criticality": criticality,
        "discovered_by": discovered_by,
        "rationale": rationale,
    }


def _actual_blob(
    *,
    sid: str = "act-001",
    topic: str = "demo",
    category: str = "HappyPath",
    verb: str = "EventPresent",
    grounding: list[dict] | None = None,
    stage: str = "validated",
) -> dict:
    if grounding is None:
        grounding = [_grounding("a.cs", [10])]
    return {
        "id": sid,
        "topic": topic,
        "category": category,
        "verb": verb,
        "grounding_changed_lines": grounding,
        "stage": stage,
    }


def _write_pr(
    tmp_path: Path,
    pr_number: str,
    expected: dict,
    actual: dict | None = None,
) -> Path:
    pr_dir = tmp_path / f"PR-{pr_number}"
    pr_dir.mkdir(parents=True)
    (pr_dir / "expected.json").write_text(
        json.dumps(expected, indent=2), encoding="utf-8"
    )
    if actual is not None:
        (pr_dir / "actual.json").write_text(
            json.dumps(actual, indent=2), encoding="utf-8"
        )
    return pr_dir


# ─── ChangedLineSet ───────────────────────────────────────────────────────


def test_changed_line_set_overlap_basic() -> None:
    a = score_eval.ChangedLineSet(path="src/A.cs", side="right", lines=frozenset({1, 2, 3}))
    b = score_eval.ChangedLineSet(path="src/A.cs", side="right", lines=frozenset({2, 3, 4}))
    assert a.overlap(b) == 2


def test_changed_line_set_path_mismatch_zero() -> None:
    a = score_eval.ChangedLineSet(path="src/A.cs", side="right", lines=frozenset({1, 2, 3}))
    b = score_eval.ChangedLineSet(path="src/B.cs", side="right", lines=frozenset({1, 2, 3}))
    assert a.overlap(b) == 0


def test_changed_line_set_path_is_case_insensitive() -> None:
    """Diff producers emit different casings on Windows clones; we must
    not punish that as a grounding miss."""
    a = score_eval.ChangedLineSet(path="src/A.cs", side="right", lines=frozenset({10}))
    b = score_eval.ChangedLineSet(path="SRC/a.cs", side="right", lines=frozenset({10}))
    assert a.overlap(b) == 1


def test_changed_line_set_side_mismatch_zero() -> None:
    a = score_eval.ChangedLineSet(path="src/A.cs", side="right", lines=frozenset({1, 2}))
    b = score_eval.ChangedLineSet(path="src/A.cs", side="left", lines=frozenset({1, 2}))
    assert a.overlap(b) == 0


def test_changed_line_set_same_file_different_lines_zero() -> None:
    """The B5 blind-grading rubber-duck pin: same file, no shared changed
    line → grounding miss. Path-only overlap would over-credit."""
    a = score_eval.ChangedLineSet(path="src/A.cs", side="right", lines=frozenset({10, 11}))
    b = score_eval.ChangedLineSet(path="src/A.cs", side="right", lines=frozenset({500, 501}))
    assert a.overlap(b) == 0


# ─── ExpectedScenario / ActualScenario validation ────────────────────────


def test_expected_scenario_validates_category_against_allow_list() -> None:
    blob = _expected_blob(category="NotARealCategory")
    s = score_eval.ExpectedScenario.from_json(blob)
    errors = s.validate(prefix="t")
    assert any("category" in e for e in errors)


def test_expected_scenario_validates_verb_against_allow_list() -> None:
    blob = _expected_blob(verb="VerifyZzzNotReal")
    s = score_eval.ExpectedScenario.from_json(blob)
    errors = s.validate(prefix="t")
    assert any("verb" in e for e in errors)


def test_expected_scenario_validates_criticality_against_allow_list() -> None:
    blob = _expected_blob(criticality="P9")
    s = score_eval.ExpectedScenario.from_json(blob)
    errors = s.validate(prefix="t")
    assert any("criticality" in e for e in errors)


def test_expected_scenario_validates_discovered_by_against_allow_list() -> None:
    blob = _expected_blob(discovered_by="my_intuition")
    s = score_eval.ExpectedScenario.from_json(blob)
    errors = s.validate(prefix="t")
    assert any("discovered_by" in e for e in errors)


def test_expected_scenario_rejects_empty_grounding() -> None:
    blob = _expected_blob(grounding=[])
    s = score_eval.ExpectedScenario.from_json(blob)
    errors = s.validate(prefix="t")
    assert any("grounding_changed_lines" in e for e in errors)


def test_expected_scenario_rejects_grounding_with_invalid_side() -> None:
    blob = _expected_blob(grounding=[{"path": "a.cs", "side": "middle", "lines": [1]}])
    s = score_eval.ExpectedScenario.from_json(blob)
    errors = s.validate(prefix="t")
    assert any("side" in e for e in errors)


def test_expected_scenario_rejects_grounding_with_no_lines() -> None:
    blob = _expected_blob(grounding=[{"path": "a.cs", "side": "right", "lines": []}])
    s = score_eval.ExpectedScenario.from_json(blob)
    errors = s.validate(prefix="t")
    assert any("lines is empty" in e for e in errors)


def test_categories_match_csharp_enum_set() -> None:
    """If the C# ScenarioCategory enum gains/loses a value this guard
    fires until VALID_CATEGORIES is updated."""
    csharp = (
        REPO_ROOT / "src" / "backend" / "DevMode" / "EdogQaModels.cs"
    ).read_text(encoding="utf-8")
    for cat in score_eval.VALID_CATEGORIES:
        assert cat in csharp, f"VALID_CATEGORIES has {cat!r} but EdogQaModels.cs does not"


# ─── Matcher: positive cases ─────────────────────────────────────────────


def test_match_exact_pair() -> None:
    e = score_eval.ExpectedScenario.from_json(_expected_blob(sid="exp-1"))
    a = score_eval.ActualScenario.from_json(_actual_blob(sid="act-1"))
    matched, missed, unmatched = score_eval.match_scenarios([e], [a])
    assert len(matched) == 1
    assert matched[0].expected.id == "exp-1"
    assert matched[0].actual.id == "act-1"
    assert matched[0].overlap_count == 1
    assert missed == []
    assert unmatched == []


def test_match_prefers_higher_overlap_actual_as_tiebreaker() -> None:
    """When two actuals share (category, verb), the one with greater
    changed-line overlap wins — that's the secondary tiebreaker."""
    e = score_eval.ExpectedScenario.from_json(
        _expected_blob(grounding=[_grounding("a.cs", [10, 11, 12, 13])])
    )
    a_weak = score_eval.ActualScenario.from_json(
        _actual_blob(sid="act-weak", grounding=[_grounding("a.cs", [10])])
    )
    a_strong = score_eval.ActualScenario.from_json(
        _actual_blob(sid="act-strong", grounding=[_grounding("a.cs", [10, 11, 12])])
    )
    matched, _, unmatched = score_eval.match_scenarios([e], [a_weak, a_strong])
    assert len(matched) == 1
    assert matched[0].actual.id == "act-strong"
    assert matched[0].overlap_count == 3
    assert len(unmatched) == 1
    assert unmatched[0].id == "act-weak"


# ─── Matcher: negative cases ──────────────────────────────────────────────


def test_match_category_mismatch_no_pair() -> None:
    e = score_eval.ExpectedScenario.from_json(_expected_blob(category="HappyPath"))
    a = score_eval.ActualScenario.from_json(_actual_blob(category="EdgeCase"))
    matched, missed, unmatched = score_eval.match_scenarios([e], [a])
    assert matched == []
    assert len(missed) == 1
    assert len(unmatched) == 1


def test_match_verb_mismatch_no_pair() -> None:
    e = score_eval.ExpectedScenario.from_json(_expected_blob(verb="EventPresent"))
    a = score_eval.ActualScenario.from_json(_actual_blob(verb="EventAbsent"))
    matched, missed, _unmatched = score_eval.match_scenarios([e], [a])
    assert matched == []
    assert len(missed) == 1


def test_match_zero_overlap_no_pair_even_when_same_file() -> None:
    """The decisive B5 pin: same path + same (category, verb) but no
    changed-line overlap → MUST be a miss, not a credit. The whole point
    of grounding is that the scenario lands on the modified code."""
    e = score_eval.ExpectedScenario.from_json(
        _expected_blob(grounding=[_grounding("a.cs", [10, 11])])
    )
    a = score_eval.ActualScenario.from_json(
        _actual_blob(grounding=[_grounding("a.cs", [500, 501])])
    )
    matched, missed, unmatched = score_eval.match_scenarios([e], [a])
    assert matched == []
    assert len(missed) == 1
    assert len(unmatched) == 1


def test_match_greedy_first_expected_wins_actual() -> None:
    """Two expected scenarios compete for one actual; the first declared
    wins. This makes the algorithm deterministic across runs."""
    e1 = score_eval.ExpectedScenario.from_json(_expected_blob(sid="exp-1"))
    e2 = score_eval.ExpectedScenario.from_json(_expected_blob(sid="exp-2"))
    a = score_eval.ActualScenario.from_json(_actual_blob(sid="act-1"))
    matched, missed, _ = score_eval.match_scenarios([e1, e2], [a])
    assert len(matched) == 1
    assert matched[0].expected.id == "exp-1"
    assert len(missed) == 1
    assert missed[0].id == "exp-2"


# ─── Scoring ──────────────────────────────────────────────────────────────


def test_score_pr_recall_precision_when_perfect_match() -> None:
    e1 = score_eval.ExpectedScenario.from_json(_expected_blob(sid="exp-1"))
    e2 = score_eval.ExpectedScenario.from_json(
        _expected_blob(sid="exp-2", verb="EventAbsent", grounding=[_grounding("b.cs", [5])])
    )
    a1 = score_eval.ActualScenario.from_json(_actual_blob(sid="act-1"))
    a2 = score_eval.ActualScenario.from_json(
        _actual_blob(sid="act-2", verb="EventAbsent", grounding=[_grounding("b.cs", [5])])
    )
    score = score_eval.score_pr("test", [e1, e2], [a1, a2])
    assert score.recall == 1.0
    assert score.precision_by_stage["validated"] == 1.0
    assert score.f1_validated == 1.0


def test_score_pr_precision_drops_on_extra_validated_actuals() -> None:
    """Pipeline emits more than expected → precision_validated < 1.0."""
    e = score_eval.ExpectedScenario.from_json(_expected_blob(sid="exp-1"))
    a_match = score_eval.ActualScenario.from_json(_actual_blob(sid="act-match"))
    a_false = score_eval.ActualScenario.from_json(
        _actual_blob(sid="act-false", grounding=[_grounding("a.cs", [10]), _grounding("c.cs", [99])])
    )
    score = score_eval.score_pr("test", [e], [a_match, a_false])
    # 1 expected matched out of 2 emitted actuals at validated stage.
    assert score.recall == 1.0
    assert score.precision_by_stage["validated"] == 0.5


def test_score_pr_recall_drops_on_missed_expected() -> None:
    e1 = score_eval.ExpectedScenario.from_json(_expected_blob(sid="exp-1"))
    e2 = score_eval.ExpectedScenario.from_json(
        _expected_blob(sid="exp-2", grounding=[_grounding("b.cs", [99])])
    )
    a = score_eval.ActualScenario.from_json(_actual_blob(sid="act-1"))
    score = score_eval.score_pr("test", [e1, e2], [a])
    assert score.recall == 0.5
    assert len(score.missed_expected) == 1
    assert score.missed_expected[0].id == "exp-2"


def test_score_pr_precision_per_stage_independent() -> None:
    """When an actual is tagged stage='emitted' the validated precision
    denominator excludes it. This catches the Validator letting through
    too much OR too little."""
    e = score_eval.ExpectedScenario.from_json(_expected_blob(sid="exp-1"))
    a_validated = score_eval.ActualScenario.from_json(
        _actual_blob(sid="act-val", stage="validated")
    )
    a_emitted_only = score_eval.ActualScenario.from_json(
        _actual_blob(sid="act-emit", stage="emitted", grounding=[_grounding("c.cs", [99])])
    )
    score = score_eval.score_pr("test", [e], [a_validated, a_emitted_only])
    assert score.actual_total_by_stage == {"emitted": 1, "validated": 1, "projected": 0}
    assert score.precision_by_stage["validated"] == 1.0
    assert score.precision_by_stage["emitted"] == 0.0


def test_score_pr_p0_p1_recall_excludes_p2_from_denominator() -> None:
    p0 = score_eval.ExpectedScenario.from_json(
        _expected_blob(sid="exp-p0", criticality="P0")
    )
    p2 = score_eval.ExpectedScenario.from_json(
        _expected_blob(
            sid="exp-p2",
            criticality="P2",
            grounding=[_grounding("b.cs", [5])],
        )
    )
    a_p0_match = score_eval.ActualScenario.from_json(_actual_blob(sid="act-p0"))
    score = score_eval.score_pr("test", [p0, p2], [a_p0_match])
    assert score.recall == 0.5
    # P0 matched, P2 missed — P0+P1 bucket has only the P0 expected so
    # recall on that bucket is 1.0 (not 0.5).
    assert score.p0_p1_recall == 1.0


# ─── Aggregate ────────────────────────────────────────────────────────────


def test_aggregate_macro_weights_prs_equally() -> None:
    """A PR with recall=0.0 and a PR with recall=1.0 → macro=0.5
    regardless of expected_total per PR. Micro would weight by counts."""
    e = score_eval.ExpectedScenario.from_json(_expected_blob(sid="exp-1"))
    a = score_eval.ActualScenario.from_json(_actual_blob(sid="act-1"))
    s_good = score_eval.score_pr("good", [e], [a])
    s_bad = score_eval.score_pr(
        "bad",
        [score_eval.ExpectedScenario.from_json(_expected_blob(sid="exp-2", grounding=[_grounding("z.cs", [1])]))],
        [],
    )
    agg = score_eval.aggregate([s_good, s_bad])
    assert agg["macro"]["recall"] == 0.5
    assert agg["pr_count"] == 2


def test_aggregate_micro_weights_scenarios_equally() -> None:
    """A PR with 10 expected + 10 matched vs a PR with 1 expected + 0
    matched: macro = 0.5, micro = 10/11."""
    big_expected = [
        score_eval.ExpectedScenario.from_json(
            _expected_blob(sid=f"exp-big-{i}", grounding=[_grounding(f"f-{i}.cs", [10])])
        )
        for i in range(10)
    ]
    big_actual = [
        score_eval.ActualScenario.from_json(
            _actual_blob(sid=f"act-big-{i}", grounding=[_grounding(f"f-{i}.cs", [10])])
        )
        for i in range(10)
    ]
    s_big = score_eval.score_pr("big", big_expected, big_actual)
    s_small = score_eval.score_pr(
        "small",
        [
            score_eval.ExpectedScenario.from_json(
                _expected_blob(sid="exp-small", grounding=[_grounding("z.cs", [1])])
            )
        ],
        [],
    )
    agg = score_eval.aggregate([s_big, s_small])
    assert agg["macro"]["recall"] == 0.5
    # Micro: 10 matched / 11 total expected.
    assert agg["micro"]["recall"] == pytest.approx(10 / 11, abs=1e-3)


def test_aggregate_empty_pr_list() -> None:
    agg = score_eval.aggregate([])
    assert agg["pr_count"] == 0
    assert agg["macro"]["recall"] == 0.0


# ─── Loader: v1.0 ↔ v2.0 schema coexistence ───────────────────────────────


def test_load_expected_v1_scaffold_returns_pending(tmp_path: Path) -> None:
    """The T0 scaffold's v1.0 shape MUST still parse — the eval harness
    will see a half-graded corpus during the T1f rollout."""
    pr_dir = _write_pr(
        tmp_path,
        "v1",
        {
            "schema_version": "1.0",
            "pr_number": "v1",
            "curator": "PENDING_HUMAN_GRADING",
            "scenarios": [],
        },
    )
    state, scenarios, errors = score_eval.load_expected(pr_dir)
    assert state == "PENDING_HUMAN_GRADING"
    assert scenarios == []
    assert errors == []


def test_load_expected_v2_graded(tmp_path: Path) -> None:
    pr_dir = _write_pr(
        tmp_path,
        "v2",
        {
            "schema_version": "2.0",
            "pr_number": "v2",
            "curator_state": "GRADED",
            "scenarios": [_expected_blob()],
        },
    )
    state, scenarios, errors = score_eval.load_expected(pr_dir)
    assert state == "GRADED"
    assert len(scenarios) == 1
    assert errors == []


def test_load_expected_unknown_schema_version(tmp_path: Path) -> None:
    pr_dir = _write_pr(
        tmp_path,
        "v9",
        {"schema_version": "9.9", "scenarios": []},
    )
    state, scenarios, errors = score_eval.load_expected(pr_dir)
    assert state is None
    assert scenarios == []
    assert any("unsupported schema_version" in e for e in errors)


def test_load_actual_missing_is_ok(tmp_path: Path) -> None:
    pr_dir = _write_pr(
        tmp_path,
        "noact",
        {
            "schema_version": "2.0",
            "curator_state": "GRADED",
            "scenarios": [_expected_blob()],
        },
    )
    actuals, errors = score_eval.load_actual(pr_dir)
    assert actuals == []
    assert errors == []


def test_load_actual_with_invalid_stage(tmp_path: Path) -> None:
    pr_dir = _write_pr(
        tmp_path,
        "badstage",
        {"schema_version": "2.0", "curator_state": "GRADED", "scenarios": []},
        actual={"scenarios": [_actual_blob(stage="frozen")]},
    )
    _, errors = score_eval.load_actual(pr_dir)
    assert any("stage" in e for e in errors)


# ─── Floor enforcement ────────────────────────────────────────────────────


def test_floors_file_parses_and_has_required_keys() -> None:
    """The committed score_floors.json must carry the expected shape."""
    floors = score_eval.load_floors()
    assert "absolute" in floors
    assert "regression" in floors
    assert "enforcement" in floors
    for key in ("corpus_recall_min", "corpus_precision_min", "per_pr_recall_min", "p0_p1_recall_min"):
        assert key in floors["absolute"]
        assert 0.0 <= floors["absolute"][key] <= 1.0


def test_evaluate_floors_pass_when_above_absolute() -> None:
    e = score_eval.ExpectedScenario.from_json(_expected_blob(sid="exp-1"))
    a = score_eval.ActualScenario.from_json(_actual_blob(sid="act-1"))
    pr = score_eval.score_pr("test", [e], [a])
    agg = score_eval.aggregate([pr])
    floors = score_eval.load_floors()
    verdict, violations = score_eval.evaluate_floors(agg, floors, [pr])
    assert verdict == "PASS"
    assert violations == []


def test_evaluate_floors_fail_when_below_absolute() -> None:
    """An empty actuals list → recall=0 → fails the absolute floor."""
    e = score_eval.ExpectedScenario.from_json(_expected_blob(sid="exp-1"))
    pr = score_eval.score_pr("test", [e], [])
    agg = score_eval.aggregate([pr])
    floors = {
        "absolute": {"corpus_recall_min": 0.5, "corpus_precision_min": 0.0, "p0_p1_recall_min": 0.0, "per_pr_recall_min": 0.0},
        "regression": {},
        "enforcement": "report_only",
    }
    verdict, violations = score_eval.evaluate_floors(agg, floors, [pr])
    assert verdict == "FAIL"
    assert any("corpus_recall" in v for v in violations)


def test_evaluate_floors_fails_on_per_pr_floor() -> None:
    e1 = score_eval.ExpectedScenario.from_json(_expected_blob(sid="exp-1"))
    e2 = score_eval.ExpectedScenario.from_json(
        _expected_blob(sid="exp-2", grounding=[_grounding("b.cs", [5])])
    )
    a = score_eval.ActualScenario.from_json(_actual_blob(sid="act-1"))
    pr_good = score_eval.score_pr("good", [e1], [a])
    pr_bad = score_eval.score_pr("bad", [e2], [])
    agg = score_eval.aggregate([pr_good, pr_bad])
    floors = {
        "absolute": {
            "corpus_recall_min": 0.0,
            "corpus_precision_min": 0.0,
            "p0_p1_recall_min": 0.0,
            "per_pr_recall_min": 0.4,
        },
        "regression": {},
        "enforcement": "report_only",
    }
    verdict, violations = score_eval.evaluate_floors(agg, floors, [pr_good, pr_bad])
    assert verdict == "FAIL"
    assert any("PR-bad" in v for v in violations)


# ─── End-to-end report (synthetic corpus rooted at tmp_path) ──────────────


def test_build_report_round_trips_synthetic_corpus(monkeypatch, tmp_path: Path) -> None:
    ground_truth = tmp_path / "ground-truth"
    ground_truth.mkdir()

    # PR-1: graded, perfect match.
    _write_pr(
        ground_truth,
        "1",
        {
            "schema_version": "2.0",
            "curator_state": "GRADED",
            "scenarios": [_expected_blob(sid="exp-1")],
        },
        actual={"scenarios": [_actual_blob(sid="act-1")]},
    )
    # PR-2: scaffold (v1), pending.
    _write_pr(
        ground_truth,
        "2",
        {"schema_version": "1.0", "curator": "PENDING_HUMAN_GRADING", "scenarios": []},
    )

    monkeypatch.setattr(score_eval, "GROUND_TRUTH", ground_truth)
    monkeypatch.setattr(score_eval, "FLOORS_PATH", tmp_path / "no-floors.json")
    pr_dirs = score_eval.discover_pr_dirs()
    report = score_eval.build_report(pr_dirs)

    assert report["aggregate"]["pr_count"] == 1
    assert report["aggregate"]["macro"]["recall"] == 1.0
    assert "1" not in report["prs_pending_grading"]
    assert "2" in report["prs_pending_grading"]
    assert report["verdict"] == "PASS"


def test_main_strict_flag_returns_nonzero_on_fail(monkeypatch, tmp_path: Path) -> None:
    ground_truth = tmp_path / "ground-truth"
    ground_truth.mkdir()
    _write_pr(
        ground_truth,
        "fail",
        {
            "schema_version": "2.0",
            "curator_state": "GRADED",
            "scenarios": [_expected_blob(sid="exp-1")],
        },
        actual={"scenarios": []},
    )
    floors_path = tmp_path / "floors.json"
    floors_path.write_text(
        json.dumps(
            {
                "absolute": {
                    "corpus_recall_min": 0.5,
                    "corpus_precision_min": 0.0,
                    "p0_p1_recall_min": 0.0,
                    "per_pr_recall_min": 0.0,
                },
                "regression": {},
                "enforcement": "report_only",
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(score_eval, "GROUND_TRUTH", ground_truth)
    monkeypatch.setattr(score_eval, "FLOORS_PATH", floors_path)
    rc = score_eval.main(["--strict", "--json"])
    assert rc == 1


def test_main_strict_returns_zero_on_pass(monkeypatch, tmp_path: Path) -> None:
    ground_truth = tmp_path / "ground-truth"
    ground_truth.mkdir()
    _write_pr(
        ground_truth,
        "pass",
        {
            "schema_version": "2.0",
            "curator_state": "GRADED",
            "scenarios": [_expected_blob(sid="exp-1")],
        },
        actual={"scenarios": [_actual_blob(sid="act-1")]},
    )
    floors_path = tmp_path / "floors.json"
    floors_path.write_text(
        json.dumps(
            {
                "absolute": {
                    "corpus_recall_min": 0.5,
                    "corpus_precision_min": 0.5,
                    "p0_p1_recall_min": 0.5,
                    "per_pr_recall_min": 0.5,
                },
                "regression": {},
                "enforcement": "report_only",
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(score_eval, "GROUND_TRUTH", ground_truth)
    monkeypatch.setattr(score_eval, "FLOORS_PATH", floors_path)
    rc = score_eval.main(["--strict", "--json"])
    assert rc == 0


# ─── Config files exist + parse ───────────────────────────────────────────


def test_score_floors_committed_file_parses() -> None:
    """The repo-committed score_floors.json must parse and meet the
    schema we documented."""
    assert score_eval.FLOORS_PATH.exists()
    with score_eval.FLOORS_PATH.open(encoding="utf-8") as fh:
        blob = json.load(fh)
    assert blob.get("enforcement") in {"report_only", "strict"}
    assert "absolute" in blob
    assert "regression" in blob


def test_topic_aliases_committed_file_parses() -> None:
    assert score_eval.ALIASES_PATH.exists()
    with score_eval.ALIASES_PATH.open(encoding="utf-8") as fh:
        blob = json.load(fh)
    assert "aliases" in blob
    assert isinstance(blob["aliases"], dict)
