from scripts import qa_invariants as inv


def test_no_5xx():
    assert inv.check_no_5xx({"status": 200, "evidenceId": "evt#1"}).ok
    assert not inv.check_no_5xx({"status": 503, "evidenceId": "evt#9"}).ok


def test_no_secret_in_logs():
    f = inv.check_no_secret_in_logs([{"id": "log#2", "text": "Authorization: Bearer eyJabc.def.ghi"}])
    assert not f.ok and f.evidence == ["log#2"]


def test_dag_terminates():
    assert inv.check_dag_terminates({"state": "Completed", "evidenceId": "e"}).ok
    assert not inv.check_dag_terminates({"state": "Running", "timedOut": True, "evidenceId": "e"}).ok


def test_perf_bound():
    assert inv.check_perf_bound(elapsed=4.2, bound=30, source="x", evidence_id="e").ok
    f = inv.check_perf_bound(elapsed=4.2, bound=None, source=None, evidence_id="e")
    assert f.ok and f.report_only
