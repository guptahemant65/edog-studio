from scripts import qa_verdict as v

BUNDLE = {"evt#1": {}, "evt#2": {}}


def test_grounded_fact_kept():
    out = v.verify([v.Claim("retry 5x", ["evt#2"], "fact")], BUNDLE)
    assert out[0].verified


def test_missing_evidence_dropped():
    assert v.verify([v.Claim("x", ["evt#999"], "fact")], BUNDLE) == []


def test_fact_without_evidence_rejected():
    assert v.verify([v.Claim("x", [], "fact")], BUNDLE) == []


def test_inference_must_chain_to_fact():
    fact = v.Claim("retry 5x", ["evt#2"], "fact")
    good = v.Claim("regression", [], "inference", supports=["retry 5x"])
    orphan = v.Claim("vibes", [], "inference", supports=[])
    texts = {c.text for c in v.verify([fact, good, orphan], BUNDLE)}
    assert "regression" in texts and "vibes" not in texts


def test_json_round_trip():
    out = v.verify([v.Claim("200 OK", ["evt#1"], "fact")], BUNDLE)
    blob = v.Verdict("happy", "pass", out).to_json()
    assert blob["status"] == "pass" and blob["claims"][0]["verified"]
