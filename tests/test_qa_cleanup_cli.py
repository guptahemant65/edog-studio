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


def test_server_stop_kills_recorded_pid(monkeypatch):
    killed = []
    monkeypatch.setattr(qa_cleanup.os, "kill", lambda pid, sig: killed.append(pid))
    assert qa_cleanup._server_stop({"pid": 4321}) is True
    assert killed == [4321]


def test_server_stop_already_gone_is_success(monkeypatch):
    def _gone(pid, sig):
        raise ProcessLookupError

    monkeypatch.setattr(qa_cleanup.os, "kill", _gone)
    # a process that already exited is a successful (idempotent) stop
    assert qa_cleanup._server_stop({"pid": 4321}) is True


def test_server_stop_no_pid_is_failure():
    assert qa_cleanup._server_stop({}) is False

