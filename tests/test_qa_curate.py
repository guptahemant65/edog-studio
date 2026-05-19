"""F27 P9 T4-D — curator workbench tests.

Pins the contract of ``tests/qa-eval/curate.py``:

- ``prepare`` (blind, default): writes N empty scenario templates,
  ``pass_1_basis = "diff_inspection_blind"``, state stays PENDING.
- ``prepare --from-actual``: seeds scenarios from actual.json carrying
  category / verb / topic→title / grounding; basis becomes
  ``"actual_review_anchored"``.
- ``prepare`` writes ``expected.json.bak`` and refuses to overwrite an
  already-GRADED fixture without ``--force``.
- ``finalize``: validates required fields (behavior_key + rationale +
  criticality ∈ {P0..P3} non-template, title non-empty, non-zero
  grounding lines), flips ``curator_state`` to GRADED_PASS_1, stamps
  ``curated_at`` and ``curator``, strips the optional ``_source_llm_*``
  scaffolding fields, deletes the backup.
- ``finalize`` refuses an empty scenarios list unless ``--allow-empty``
  (for Dependabot-style no-test anchors).
- Duplicate ``behavior_key`` across scenarios is rejected.
- ``list`` filters by ``--pending`` and ``--graded`` correctly.

All tests are pure-Python; they invoke ``curate.main`` directly against
temp directories. No editor is launched (``--no-editor`` is passed).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
QA_EVAL = REPO_ROOT / "tests" / "qa-eval"
sys.path.insert(0, str(QA_EVAL))

import curate  # noqa: E402


@pytest.fixture
def fake_fixture(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Create a temp ground-truth tree with one PENDING fixture + actual.json."""
    ground_truth = tmp_path / "ground-truth"
    fx = ground_truth / "PR-999000"
    fx.mkdir(parents=True)

    (fx / "diff.patch").write_text("--- a/x.cs\n+++ b/x.cs\n@@ -1,1 +1,2 @@\n line\n+new\n", encoding="utf-8")
    (fx / "notes.md").write_text("# PR 999000 — Curator Notes\n", encoding="utf-8")
    (fx / "pr.json").write_text(json.dumps({"pr_number": "999000"}), encoding="utf-8")
    (fx / "expected.json").write_text(
        json.dumps(
            {
                "schema_version": "2.0",
                "pr_number": "999000",
                "curator_state": "PENDING_HUMAN_GRADING",
                "curated_at": None,
                "curator": None,
                "pass_1_basis": "pending_curator_review",
                "scenarios": [],
            }
        ),
        encoding="utf-8",
    )
    (fx / "actual.json").write_text(
        json.dumps(
            {
                "scenarios": [
                    {
                        "id": "sk-1",
                        "topic": "CORS policy",
                        "category": "HappyPath",
                        "verb": "FieldMatch",
                        "stage": "projected",
                        "grounding_changed_lines": [
                            {"path": "x.cs", "side": "right", "lines": [2]},
                        ],
                    },
                    {
                        "id": "sk-2",
                        "topic": "Header echoed",
                        "category": "EdgeCase",
                        "verb": "FieldMatch",
                        "stage": "emitted",
                        "grounding_changed_lines": [
                            {"path": "x.cs", "side": "right", "lines": [2]},
                        ],
                    },
                ]
            }
        ),
        encoding="utf-8",
    )

    monkeypatch.setattr(curate, "GROUND_TRUTH", ground_truth)
    return fx


def _load(fx: Path) -> dict:
    return json.loads((fx / "expected.json").read_text(encoding="utf-8"))


# ── prepare ───────────────────────────────────────────────────────


def test_prepare_blind_writes_empty_templates(fake_fixture: Path) -> None:
    rc = curate.main(["prepare", "PR-999000", "--no-editor", "--empty-rows", "2"])
    assert rc == 0
    exp = _load(fake_fixture)
    assert exp["pass_1_basis"] == "diff_inspection_blind"
    assert exp["curator_state"] == "PENDING_HUMAN_GRADING"
    assert len(exp["scenarios"]) == 2
    assert exp["scenarios"][0]["id"] == "999000-s01"
    assert exp["scenarios"][0]["behavior_key"].startswith("REPLACE_ME")
    assert (fake_fixture / "expected.json.bak").exists()


def test_prepare_from_actual_seeds_scenarios(fake_fixture: Path) -> None:
    rc = curate.main(["prepare", "PR-999000", "--no-editor", "--from-actual"])
    assert rc == 0
    exp = _load(fake_fixture)
    assert exp["pass_1_basis"] == "actual_review_anchored"
    assert len(exp["scenarios"]) == 2
    sc0 = exp["scenarios"][0]
    assert sc0["category"] == "HappyPath"
    assert sc0["verb"] == "FieldMatch"
    assert sc0["title"] == "CORS policy"
    assert sc0["grounding_changed_lines"] == [{"path": "x.cs", "side": "right", "lines": [2]}]
    # debug scaffolding for the curator
    assert sc0["_source_llm_id"] == "sk-1"
    assert sc0["_source_llm_stage"] == "projected"


def test_prepare_refuses_already_graded_without_force(fake_fixture: Path) -> None:
    # Manually flip to GRADED, then try to re-prepare.
    exp = _load(fake_fixture)
    exp["curator_state"] = "GRADED_PASS_1"
    (fake_fixture / "expected.json").write_text(json.dumps(exp), encoding="utf-8")
    with pytest.raises(SystemExit):
        curate.main(["prepare", "PR-999000", "--no-editor"])


def test_prepare_force_overwrites_graded(fake_fixture: Path) -> None:
    exp = _load(fake_fixture)
    exp["curator_state"] = "GRADED_PASS_1"
    (fake_fixture / "expected.json").write_text(json.dumps(exp), encoding="utf-8")
    rc = curate.main(["prepare", "PR-999000", "--no-editor", "--force", "--empty-rows", "1"])
    assert rc == 0
    assert _load(fake_fixture)["curator_state"] == "PENDING_HUMAN_GRADING"


# ── finalize ──────────────────────────────────────────────────────


def _well_formed_scenario(idx: int) -> dict:
    return {
        "id": f"999000-s{idx:02d}",
        "behavior_key": f"behavior_{idx}_does_thing",
        "category": "HappyPath",
        "verb": "FieldMatch",
        "title": f"Scenario {idx} asserts a thing",
        "rationale": f"This matters because of reason {idx}.",
        "criticality": "P1",
        "discovered_by": "diff_inspection",
        "grounding_changed_lines": [{"path": "x.cs", "side": "right", "lines": [2]}],
    }


def _write_scenarios(fx: Path, scenarios: list[dict]) -> None:
    exp = _load(fx)
    exp["scenarios"] = scenarios
    (fx / "expected.json").write_text(json.dumps(exp), encoding="utf-8")


def test_finalize_promotes_to_graded(fake_fixture: Path) -> None:
    _write_scenarios(fake_fixture, [_well_formed_scenario(1), _well_formed_scenario(2)])
    rc = curate.main(["finalize", "PR-999000", "--curator", "tester"])
    assert rc == 0
    exp = _load(fake_fixture)
    assert exp["curator_state"] == "GRADED_PASS_1"
    assert exp["curator"] == "tester"
    assert exp["curated_at"] is not None


def test_finalize_strips_seed_scaffolding(fake_fixture: Path) -> None:
    sc = _well_formed_scenario(1)
    sc["_source_llm_id"] = "sk-1"
    sc["_source_llm_stage"] = "projected"
    _write_scenarios(fake_fixture, [sc])
    rc = curate.main(["finalize", "PR-999000", "--curator", "t"])
    assert rc == 0
    out = _load(fake_fixture)["scenarios"][0]
    assert "_source_llm_id" not in out
    assert "_source_llm_stage" not in out


def test_finalize_rejects_placeholder_behavior_key(fake_fixture: Path) -> None:
    bad = _well_formed_scenario(1)
    bad["behavior_key"] = "REPLACE_ME_stable_snake_case"
    _write_scenarios(fake_fixture, [bad])
    rc = curate.main(["finalize", "PR-999000", "--curator", "t"])
    assert rc == 2
    assert _load(fake_fixture)["curator_state"] == "PENDING_HUMAN_GRADING"


def test_finalize_rejects_invalid_criticality(fake_fixture: Path) -> None:
    bad = _well_formed_scenario(1)
    bad["criticality"] = "high"
    _write_scenarios(fake_fixture, [bad])
    assert curate.main(["finalize", "PR-999000", "--curator", "t"]) == 2


def test_finalize_rejects_duplicate_behavior_keys(fake_fixture: Path) -> None:
    a = _well_formed_scenario(1)
    b = _well_formed_scenario(2)
    b["behavior_key"] = a["behavior_key"]
    _write_scenarios(fake_fixture, [a, b])
    assert curate.main(["finalize", "PR-999000", "--curator", "t"]) == 2


def test_finalize_rejects_zero_line_anchors(fake_fixture: Path) -> None:
    bad = _well_formed_scenario(1)
    bad["grounding_changed_lines"] = [{"path": "x.cs", "side": "right", "lines": [0]}]
    _write_scenarios(fake_fixture, [bad])
    assert curate.main(["finalize", "PR-999000", "--curator", "t"]) == 2


def test_finalize_refuses_empty_scenarios_by_default(fake_fixture: Path) -> None:
    _write_scenarios(fake_fixture, [])
    with pytest.raises(SystemExit):
        curate.main(["finalize", "PR-999000", "--curator", "t"])


def test_finalize_allow_empty_promotes_no_test_anchor(fake_fixture: Path) -> None:
    _write_scenarios(fake_fixture, [])
    rc = curate.main(["finalize", "PR-999000", "--curator", "t", "--allow-empty"])
    assert rc == 0
    assert _load(fake_fixture)["curator_state"] == "GRADED_PASS_1"


def test_finalize_deletes_backup(fake_fixture: Path) -> None:
    curate.main(["prepare", "PR-999000", "--no-editor", "--empty-rows", "1"])
    assert (fake_fixture / "expected.json.bak").exists()
    _write_scenarios(fake_fixture, [_well_formed_scenario(1)])
    curate.main(["finalize", "PR-999000", "--curator", "t"])
    assert not (fake_fixture / "expected.json.bak").exists()
