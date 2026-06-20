import pytest

from scripts import qa_run_lock


@pytest.fixture
def lock_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(qa_run_lock, "LOCK_PATH", tmp_path / "run.lock")
    return tmp_path


def test_acquire_when_free_returns_ok(lock_dir):
    ok, holder = qa_run_lock.acquire("run-1", "PR#1")
    assert ok is True
    assert holder["runId"] == "run-1"


def test_acquire_when_held_by_fresh_run_is_refused(lock_dir):
    qa_run_lock.acquire("run-1", "PR#1")
    ok, holder = qa_run_lock.acquire("run-2", "PR#2")
    assert ok is False
    assert holder["runId"] == "run-1"  # reports the current holder


def test_stale_lock_is_reclaimed(lock_dir):
    qa_run_lock.acquire("run-1", "PR#1")
    # force the heartbeat into the past
    qa_run_lock._write({"runId": "run-1", "pr": "PR#1", "startedAt": 0.0, "heartbeat": 0.0})
    ok, holder = qa_run_lock.acquire("run-2", "PR#2", stale_after=60)
    assert ok is True
    assert holder["runId"] == "run-2"


def test_heartbeat_keeps_lock_fresh(lock_dir):
    qa_run_lock.acquire("run-1", "PR#1")
    qa_run_lock.heartbeat("run-1")
    assert qa_run_lock.status()["runId"] == "run-1"


def test_release_frees_the_lock(lock_dir):
    qa_run_lock.acquire("run-1", "PR#1")
    qa_run_lock.release("run-1")
    assert qa_run_lock.status() is None
    ok, _ = qa_run_lock.acquire("run-2", "PR#2")
    assert ok is True


def test_release_by_non_holder_is_ignored(lock_dir):
    qa_run_lock.acquire("run-1", "PR#1")
    qa_run_lock.release("run-2")  # not the holder
    assert qa_run_lock.status()["runId"] == "run-1"
