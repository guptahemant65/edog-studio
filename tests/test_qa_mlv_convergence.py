from scripts import qa_mlv_convergence as cv


def _rows(*pairs):
    return [{"id": i, "amount": a} for i, a in pairs]


def test_exact_match_converges():
    mat = _rows((1, 100), (2, 200), (3, 300))
    rec = _rows((3, 300), (1, 100), (2, 200))  # same multiset, different order
    r = cv.converge(mat, rec)
    assert r.converged is True and r.mode == "exact" and r.missing == 0 and r.extra == 0


def test_missing_row_is_drift():
    mat = _rows((1, 100), (2, 200))
    rec = _rows((1, 100), (2, 200), (3, 300))  # recompute has a row the output lacks
    r = cv.converge(mat, rec)
    assert r.converged is False and r.missing == 1 and r.extra == 0


def test_extra_row_is_drift():
    mat = _rows((1, 100), (2, 200), (9, 999))  # output has a row the recompute lacks
    rec = _rows((1, 100), (2, 200))
    r = cv.converge(mat, rec)
    assert r.converged is False and r.extra == 1 and r.missing == 0


def test_duplicate_counts_matter():
    mat = _rows((1, 100), (1, 100))  # two copies
    rec = _rows((1, 100))  # one copy
    r = cv.converge(mat, rec)
    assert r.converged is False and r.extra == 1


def test_wrong_value_is_drift():
    mat = _rows((1, 100), (2, 999))  # amount corrupted
    rec = _rows((1, 100), (2, 200))
    r = cv.converge(mat, rec)
    assert r.converged is False and r.missing == 1 and r.extra == 1


def test_nondeterministic_degrades_to_schema_and_count():
    mat = _rows((1, 100), (2, 200))
    rec = _rows((1, 111), (2, 222))  # values differ but it's non-deterministic SQL
    r = cv.converge(mat, rec, deterministic=False)
    assert r.converged is None and r.mode == "degraded"
    assert "row count only" in r.detail


def test_evidence_is_carried():
    r = cv.converge(_rows((1, 1)), _rows((1, 1)), evidence_ids=["onelake#1", "spark#2"])
    assert r.evidence == ["onelake#1", "spark#2"]
