import json

import pytest

from scripts import qa_evidence as ev


@pytest.fixture
def run(tmp_path, monkeypatch):
    monkeypatch.setattr(ev, "QA_ROOT", tmp_path / ".edog-qa")
    return "run-1"


def test_save_then_show_returns_the_block(run):
    block = "GET …/insights/summary?filter=\n← 200 OK\n  ✓ inner status is 200"
    ev.save(run, "request #1455", block, kind="api")
    assert ev.show(run, "request #1455") == block


def test_show_accepts_any_form_of_the_citation(run):
    # the verdict cites "request #1455"; the user types "show #1455" or "1455".
    ev.save(run, "request #1455", "BODY", kind="api")
    assert ev.show(run, "#1455") == "BODY"
    assert ev.show(run, "1455") == "BODY"
    assert ev.show(run, "request #1455") == "BODY"


def test_normalize_ref_strips_labels_and_hash():
    assert ev.normalize_ref("request #1455") == "1455"
    assert ev.normalize_ref("#1455") == "1455"
    assert ev.normalize_ref("1455") == "1455"
    assert ev.normalize_ref("run #1402") == "1402"
    assert ev.normalize_ref("token #1203") == "1203"
    assert ev.normalize_ref("contract") == "contract"


def test_load_returns_record_with_kind_and_summary(run):
    ev.save(run, "run #1402", "NODE STATES…", kind="dag", summary="chain ends Completed")
    rec = ev.load(run, "1402")
    assert rec["kind"] == "dag"
    assert rec["summary"] == "chain ends Completed"
    assert rec["block"] == "NODE STATES…"
    assert rec["ref"] == "run #1402"


def test_record_on_disk_is_valid_json(run):
    ev.save(run, "request #1455", "BODY", kind="api")
    path = ev.path(run, "1455")
    assert path.suffix == ".json"
    rec = json.loads(path.read_text(encoding="utf-8"))
    assert rec["block"] == "BODY"


def test_show_on_missing_ref_is_honest_not_fabricated(run):
    # a case the run never reached has no saved block.
    assert ev.show(run, "9999") == ev.NO_OUTPUT_MSG


def test_list_refs_returns_saved_entries(run):
    ev.save(run, "request #1455", "A", kind="api", summary="200 ok")
    ev.save(run, "run #1402", "B", kind="dag", summary="completed")
    refs = ev.list_refs(run)
    keys = {r["key"] for r in refs}
    assert keys == {"1455", "1402"}
    assert all("kind" in r and "summary" in r for r in refs)


def test_runs_are_isolated(run, tmp_path, monkeypatch):
    ev.save(run, "request #1455", "A", kind="api")
    assert ev.show("other-run", "1455") == ev.NO_OUTPUT_MSG


def test_save_survives_a_fresh_process(run):
    # file-backed, so a later turn (no in-memory state) still finds it.
    ev.save(run, "request #1455", "PERSISTED", kind="api")
    assert ev.load(run, "1455") is not None
    assert ev.show(run, "1455") == "PERSISTED"


def test_resave_overwrites_same_ref(run):
    ev.save(run, "request #1455", "first", kind="api")
    ev.save(run, "request #1455", "second", kind="api")
    assert ev.show(run, "1455") == "second"
    assert len(ev.list_refs(run)) == 1
