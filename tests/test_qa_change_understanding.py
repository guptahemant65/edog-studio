"""Tests for the Beat 2 orchestrator (scripts/qa_change_understanding.py).

Covers the pure assembly: gate resolution, the signal -> watch-checklist mapping,
entry-point extraction, and the honest-notes invariant. DLL runners are I/O and
exercised by the e2e demo, not here.
"""

import json

from scripts import qa_change_understanding as cu


def _scanner(sites=None, signals=None):
    return {"available": True, "filesScanned": 1, "sites": sites or [], "signals": signals or []}


def _write_flag(tmp_path, wire_key, environments):
    d = tmp_path / "Features" / "Configuration" / "Features"
    d.mkdir(parents=True, exist_ok=True)
    (d / f"{wire_key}.json").write_text(json.dumps({"Id": wire_key, "Environments": environments}), encoding="utf-8")


def test_watch_checklist_maps_signals(tmp_path):
    scanner = _scanner(signals=[
        {"stream": "spark", "watch": "spark stream (GTS session)",
         "hits": [{"kind": "call", "evidence": "RunDAG", "file": "D.cs", "line": 40}]},
        {"stream": "onelake_file", "watch": "fileop stream + read back via OneLake",
         "hits": [{"kind": "text", "evidence": "changes.json", "file": "C.cs", "line": 88}]},
    ])
    checklist = cu.watch_checklist(scanner)
    streams = {w["stream"] for w in checklist}
    assert streams == {"spark", "onelake_file"}
    spark = next(w for w in checklist if w["stream"] == "spark")
    assert "RunDAG (D.cs:40)" in spark["anchors"]


def test_watch_checklist_prefers_log_message_as_anchor():
    scanner = _scanner(signals=[
        {"stream": "log", "watch": "log",
         "hits": [{"kind": "call", "evidence": "Tracer.LogSanitizedMessage", "file": "D.cs", "line": 5,
                   "message": "card built for artifact"}]},
    ])
    log = cu.watch_checklist(scanner)[0]
    assert "card built for artifact (D.cs:5)" in log["anchors"]


def test_gate_picture_resolves_edog_state(tmp_path):
    _write_flag(tmp_path, "FLTInsightsEngine", {"test": {"Enabled": True}})
    scanner = _scanner(sites=[
        {"symbol": "CdfHook", "kind": "construction", "file": "D.cs", "line": 429,
         "gatedBy": [{"flag": "FLTInsightsEngine", "via": "local 'x'"}]},
    ])
    gates = cu.gate_picture(scanner, {"feature_flags_added": []}, fm_cache=tmp_path)
    g = next(x for x in gates if x["flag"] == "FLTInsightsEngine")
    assert g["gatesChangedCode"] is True
    assert g["edogState"] == "on"


def test_entry_points_from_precise():
    precise = [{"symbol": "X.NodeExecutor", "callers": ["ExecuteInternalAsync", "Foo"], "referenceCount": 4,
                "references": [{"file": "D.cs", "line": 10, "caller": "ExecuteInternalAsync"}]}]
    ep = cu.entry_points(precise)
    assert ep[0]["reachedBy"] == ["ExecuteInternalAsync", "Foo"]
    assert ep[0]["references"] == [{"file": "D.cs", "line": 10, "caller": "ExecuteInternalAsync"}]


def test_assemble_includes_honest_notes_and_parts(tmp_path):
    _write_flag(tmp_path, "FLTInsightsEngine", {"test": {"Enabled": True}})
    scanner = _scanner(
        sites=[{"symbol": "CdfHook", "kind": "construction", "file": "D.cs", "line": 429,
                "gatedBy": [{"flag": "FLTInsightsEngine", "via": "local 'x'"}]}],
        signals=[{"stream": "spark", "watch": "spark", "hits": [{"kind": "call", "evidence": "RunDAG", "file": "D.cs", "line": 40}]}],
    )
    diff = {"files": [{"path": "D.cs"}], "symbols": [{"name": "CdfHook"}], "feature_flags_added": [], "feature_flags_removed": []}
    precise = [{"symbol": "X.CdfHook", "callers": ["ExecuteInternalAsync"], "referenceCount": 2}]
    out = cu.assemble(diff, scanner, precise, fm_cache=tmp_path)
    assert out["change"]["symbols"] == ["CdfHook"]
    assert any(g["edogState"] == "on" for g in out["gates"])
    assert out["watchChecklist"][0]["stream"] == "spark"
    assert out["entryPoints"][0]["reachedBy"] == ["ExecuteInternalAsync"]
    # the honesty invariant: the run is always named as the judge
    assert any("run" in n.lower() and "judge" in n.lower() for n in out["honestNotes"])


def test_render_plain_is_plain_text(tmp_path):
    _write_flag(tmp_path, "FLTInsightsEngine", {"test": {"Enabled": True}})
    scanner = _scanner(
        sites=[{"symbol": "CdfHook", "kind": "construction", "file": "D.cs", "line": 429,
                "gatedBy": [{"flag": "FLTInsightsEngine", "via": "local 'x'"}]}],
        signals=[{"stream": "log", "watch": "log stream", "hits": [{"kind": "call", "evidence": "Tracer.Log", "file": "D.cs", "line": 5}]}],
    )
    diff = {"files": [{"path": "D.cs"}], "symbols": [{"name": "CdfHook"}], "feature_flags_added": [], "feature_flags_removed": []}
    out = cu.assemble(diff, scanner, [], fm_cache=tmp_path)
    text = cu.render_plain(out)
    assert "ON for EDOG" in text
    assert "Watch these when it runs" in text
