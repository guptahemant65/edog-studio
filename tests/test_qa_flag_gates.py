"""Tests for the Beat 2 flag tool (scripts/qa_flag_gates.py).

The bug this tool kills: the skill GUESSING a flag's state. The decisive tests
assert that EDOG state is resolved from the FM `test` environment (not prod, not
a guess) -- the exact case where the model said "disabled for edog" when the
real `test` value was enabled.
"""

import json

from scripts import qa_flag_gates as fg

# ── gating_flags: tracer sites -> flag -> proof sites ──────────────────────

def _tracer(sites):
    return {"available": True, "filesScanned": 1, "sites": sites}


def test_gating_flags_maps_flag_to_sites():
    out = _tracer([
        {"symbol": "CdfOpportunityAggregator", "kind": "construction",
         "file": r"C:\x\DagExecutionHandlerV2.cs", "line": 429,
         "gatedBy": [{"flag": "FLTInsightsEngine", "via": "local 'insightsEngineEnabled'"}]},
    ])
    gates = fg.gating_flags(out)
    assert set(gates) == {"FLTInsightsEngine"}
    site = gates["FLTInsightsEngine"][0]
    assert site["symbol"] == "CdfOpportunityAggregator"
    assert site["file"] == "DagExecutionHandlerV2.cs"  # basename, not full path
    assert site["line"] == 429


def test_gating_flags_empty_when_no_guard():
    out = _tracer([{"symbol": "X", "kind": "call", "file": "a.cs", "line": 1, "gatedBy": []}])
    assert fg.gating_flags(out) == {}


# ── new_flags_in_diff ──────────────────────────────────────────────────────

def test_new_flags_reads_added_only():
    diff = {"feature_flags_added": ["FLTNewThing"], "feature_flags_removed": ["FLTOld"]}
    assert fg.new_flags_in_diff(diff) == ["FLTNewThing"]


# ── edog_state: the decisive grounding (EDOG == test env) ──────────────────

def _write_flag(fm_cache, file_id, *, doc_id=None, environments):
    d = fm_cache / "Features" / "Configuration" / "Features"
    d.mkdir(parents=True, exist_ok=True)
    (d / f"{file_id}.json").write_text(
        json.dumps({"Id": doc_id or file_id, "Environments": environments}), encoding="utf-8"
    )


def test_edog_state_reads_test_env_on(tmp_path):
    # Mirrors the real FLTInsightsEngine shape: test enabled, prod empty.
    _write_flag(tmp_path, "FLTInsightsEngine", environments={
        "test": {"Enabled": True}, "prod": {}, "onebox": {},
    })
    st = fg.edog_state("FLTInsightsEngine", fm_cache=tmp_path)
    assert st["found"] is True
    assert st["state"] == "on"          # EDOG == test -> ON  (the un-hallucinated answer)
    assert st["perEnv"]["prod"] == "empty"   # reading prod would have said OFF -> wrong


def test_edog_state_env_selection_matters(tmp_path):
    # Same flag, opposite envs: proves we read `test`, not the first/any env.
    _write_flag(tmp_path, "FLTSomething", environments={
        "test": {"Enabled": False}, "prod": {"Enabled": True},
    })
    assert fg.edog_state("FLTSomething", fm_cache=tmp_path)["state"] == "off"


def test_edog_state_partial_defers_to_beat5(tmp_path):
    _write_flag(tmp_path, "FLTTargeted", environments={
        "test": {"Targets": [{"Name": "PowerBI.MemberOf"}]},
    })
    st = fg.edog_state("FLTTargeted", fm_cache=tmp_path)
    assert st["state"] == "partial"
    assert "Beat 5" in st["note"]


def test_edog_state_not_found_is_honest(tmp_path):
    (tmp_path / "Features").mkdir()
    st = fg.edog_state("FLTMissing", fm_cache=tmp_path)
    assert st["found"] is False
    assert st["state"] == "unknown"


def test_find_flag_json_verifies_id_field(tmp_path):
    # Fast path matches by filename==Id and VERIFIES the Id field, so it never
    # returns a wrong-Id match. A file named FLTAlias.json whose Id is FLTReal:
    #   - looking up FLTAlias -> None (the Id field doesn't match the query)
    #   - looking up FLTReal  -> None (filename!=Id is deferred to the Beat-5 catalog)
    _write_flag(tmp_path, "FLTAlias", doc_id="FLTReal", environments={"test": {"Enabled": True}})
    assert fg._find_flag_json("FLTAlias", fm_cache=tmp_path) is None
    assert fg._find_flag_json("FLTReal", fm_cache=tmp_path) is None
    # The common FLT case (filename == Id) resolves.
    _write_flag(tmp_path, "FLTInsightsEngine", environments={"test": {"Enabled": True}})
    assert fg._find_flag_json("FLTInsightsEngine", fm_cache=tmp_path) is not None


# ── build_picture: the consolidated Beat-2 output ──────────────────────────

def test_build_picture_combines_gating_new_and_state(tmp_path):
    _write_flag(tmp_path, "FLTInsightsEngine", environments={"test": {"Enabled": True}})
    _write_flag(tmp_path, "FLTBrandNew", environments={"test": {}})
    tracer = _tracer([
        {"symbol": "CdfOpportunityAggregator", "kind": "construction", "file": "D.cs", "line": 429,
         "gatedBy": [{"flag": "FLTInsightsEngine", "via": "local 'x'"}]},
    ])
    diff = {"feature_flags_added": ["FLTBrandNew"]}
    pic = fg.build_picture(tracer, diff, fm_cache=tmp_path)

    by = {f["flag"]: f for f in pic["flags"]}
    # the gating flag: gates code, not new, ON for EDOG
    assert by["FLTInsightsEngine"]["gatesChangedCode"] is True
    assert by["FLTInsightsEngine"]["newInPr"] is False
    assert by["FLTInsightsEngine"]["edogState"] == "on"
    # the new flag: new, doesn't (yet) gate any traced site, empty in test
    assert by["FLTBrandNew"]["newInPr"] is True
    assert by["FLTBrandNew"]["gatesChangedCode"] is False
    assert by["FLTBrandNew"]["edogState"] == "empty"


def test_run_tracer_degrades_when_dll_missing(tmp_path):
    out = fg.run_tracer(["a.cs"], ["X"], dll=tmp_path / "nope.dll")
    assert out["available"] is False
    assert out["sites"] == []
