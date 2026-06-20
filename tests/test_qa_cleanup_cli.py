from scripts import qa_cleanup
from scripts import qa_teardown_ledger as ledger


def test_cleanup_reverses_pending(monkeypatch, tmp_path):
    monkeypatch.setattr(ledger, "QA_ROOT", tmp_path / ".edog-qa")
    monkeypatch.setattr(qa_cleanup.qa_run_lock, "LOCK_PATH", tmp_path / "run.lock")
    ledger.record("r1", "flag_override", {"flag": "F"}, reverse={"op": "flag_clear", "flag": "F"})
    done = []
    monkeypatch.setattr(qa_cleanup, "REVERSERS", {"flag_clear": lambda s: done.append(s["flag"]) or True})
    assert qa_cleanup.run("r1")["reversed"] == 1 and done == ["F"]


def test_unknown_op_is_failure(monkeypatch, tmp_path):
    monkeypatch.setattr(ledger, "QA_ROOT", tmp_path / ".edog-qa")
    monkeypatch.setattr(qa_cleanup.qa_run_lock, "LOCK_PATH", tmp_path / "run.lock")
    ledger.record("r1", "x", {}, reverse={"op": "nope"})
    monkeypatch.setattr(qa_cleanup, "REVERSERS", {})
    assert qa_cleanup.run("r1")["failed"] == 1
