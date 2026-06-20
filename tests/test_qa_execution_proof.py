from scripts import qa_execution_proof as ep


def test_marker_fired_is_proven():
    symbols = [{"name": "FetchFilesByIterationIdsAsync", "kind": "method", "marker": "ListDAGExecutionIterationIds"}]
    trace = [{"id": "log#1", "codeMarker": "ListDAGExecutionIterationIds", "text": "entered"}]
    out = ep.prove(symbols, trace)
    assert out[0].status == "proven" and out[0].via == "code_marker" and out[0].evidence == ["log#1"]


def test_marker_not_fired_is_not_exercised():
    symbols = [{"name": "X", "kind": "method", "marker": "SomeMarker"}]
    trace = [{"id": "log#1", "codeMarker": "OtherMarker", "text": "nope"}]
    out = ep.prove(symbols, trace)
    assert out[0].status == "not_exercised" and out[0].evidence == []


def test_marker_mentioned_in_log_is_proven_via_log():
    symbols = [{"name": "X", "kind": "method", "marker": "RunDAG"}]
    trace = [{"id": "log#7", "codeMarker": None, "text": "scope RunDAG completed"}]
    out = ep.prove(symbols, trace)
    assert out[0].status == "proven" and out[0].via == "log" and out[0].evidence == ["log#7"]


def test_no_marker_but_name_in_trace_is_proven():
    symbols = [{"name": "ComputeFilterHash", "kind": "method", "marker": None}]
    trace = [{"id": "t#3", "surface": "log", "text": "ComputeFilterHash returned"}]
    out = ep.prove(symbols, trace)
    assert out[0].status == "proven" and out[0].evidence == ["t#3"]


def test_no_surface_pure_helper_is_honest_unknown():
    symbols = [{"name": "ComputeJitter", "kind": "method", "marker": None}]
    trace = [{"id": "t#1", "text": "unrelated"}]
    out = ep.prove(symbols, trace)
    assert out[0].status == "no_surface" and out[0].evidence == []


def test_summary_counts():
    proofs = [
        ep.Proof("a", "proven"),
        ep.Proof("b", "proven"),
        ep.Proof("c", "not_exercised"),
        ep.Proof("d", "no_surface"),
    ]
    assert ep.summary(proofs) == {"proven": 2, "not_exercised": 1, "no_surface": 1}
