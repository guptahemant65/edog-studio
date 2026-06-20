import pytest

from scripts import qa_teardown_ledger as ledger


@pytest.fixture
def run(tmp_path, monkeypatch):
    monkeypatch.setattr(ledger, "QA_ROOT", tmp_path / ".edog-qa")
    return "run-1"


def test_record_then_pending_lists_entry(run):
    ledger.record(run, "flag_override", {"flag": "FLTFoo"}, reverse={"op": "flag_clear", "flag": "FLTFoo"})
    pending = ledger.pending(run)
    assert len(pending) == 1
    assert pending[0]["action"] == "flag_override"
    assert pending[0]["reversed"] is False


def test_reverse_all_runs_lifo_and_marks_reversed(run):
    calls = []
    ledger.record(run, "a", {}, reverse={"op": "undo_a"})
    ledger.record(run, "b", {}, reverse={"op": "undo_b"})

    def handler(rev):
        calls.append(rev["op"])
        return True

    result = ledger.reverse_all(run, handler)
    assert calls == ["undo_b", "undo_a"]  # LIFO
    assert result["reversed"] == 2 and result["failed"] == 0
    assert ledger.pending(run) == []  # nothing left pending


def test_reverse_tolerates_handler_failure(run):
    ledger.record(run, "a", {}, reverse={"op": "undo_a"})
    ledger.record(run, "b", {}, reverse={"op": "undo_b"})

    def handler(rev):
        return rev["op"] != "undo_b"  # undo_b fails

    result = ledger.reverse_all(run, handler)
    assert result["reversed"] == 1 and result["failed"] == 1
    # the failed one remains pending for a later cleanup retry
    assert [p["reverse"]["op"] for p in ledger.pending(run)] == ["undo_b"]


def test_ledger_survives_reload(run):
    ledger.record(run, "a", {}, reverse={"op": "undo_a"})
    # simulate a fresh process: nothing cached, read from disk
    assert len(ledger.pending(run)) == 1


def test_reverse_all_on_missing_run_is_noop(run, tmp_path):
    # A run that was never recorded has no ledger dir/file. reverse_all must
    # not crash trying to rewrite a non-existent path, and must not create one.
    result = ledger.reverse_all("never-existed", lambda rev: True)
    assert result == {"reversed": 0, "failed": 0}
    assert not (tmp_path / ".edog-qa" / "runs" / "never-existed").exists()
