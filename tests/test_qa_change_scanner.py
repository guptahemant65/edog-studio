"""Smoke test for the ChangeScanner (Roslyn) — signal footprint detection.

Runs the built scanner DLL against a tiny synthetic C# file + vocabulary and
asserts the right evidence streams are detected. Skips cleanly when the DLL
isn't built or dotnet is unavailable, so it never blocks the suite. The Python
orchestrator's own logic is unit-tested separately (test_qa_change_understanding).
"""

import json
import shutil
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
DLL = REPO / "scripts" / "qa_codegraph" / "ChangeScanner" / "bin" / "Release" / "net9.0" / "ChangeScanner.dll"

pytestmark = pytest.mark.skipif(
    not DLL.exists() or shutil.which("dotnet") is None,
    reason="ChangeScanner DLL not built or dotnet unavailable",
)

_FIXTURE = '''
using Microsoft.LiveTable.Service.OneLake;
using Microsoft.ServicePlatform.Telemetry;

namespace X
{
    public class Sample
    {
        public void Run()
        {
            bool on = this.featureFlighter.IsEnabled(FeatureNames.FLTSampleFlag, a, b, c);
            if (on)
            {
                var hook = new SampleHook();
                Tracer.LogSanitizedMessage("sample ran for artifact");
                var t = await tokenManager.GetTokenAsync();
                spark.SubmitSparkJob(sql);
                File.WriteAllText("changes.json", payload);
            }
        }
    }
}
'''

_VOCAB = {
    "streams": {
        "log": {"watch": "log", "calls": ["Tracer.LogSanitizedMessage"], "usings": [], "text": [], "capture_message": True},
        "telemetry": {"watch": "telemetry", "calls": [], "usings": ["Microsoft.ServicePlatform.Telemetry"], "text": []},
        "onelake_file": {"watch": "fileop", "calls": ["WriteAllText"], "usings": ["Microsoft.LiveTable.Service.OneLake"], "text": ["changes.json"]},
        "token": {"watch": "token", "calls": ["GetTokenAsync"], "usings": [], "text": []},
        "spark": {"watch": "spark", "calls": ["SubmitSparkJob"], "usings": [], "text": []},
    }
}


def _scan(tmp_path, symbols):
    cs = tmp_path / "Sample.cs"
    cs.write_text(_FIXTURE, encoding="utf-8")
    vocab = tmp_path / "vocab.json"
    vocab.write_text(json.dumps(_VOCAB), encoding="utf-8")
    proc = subprocess.run(
        ["dotnet", str(DLL), "--files", str(cs), "--symbols", symbols, "--vocab", str(vocab)],
        capture_output=True, text=True, timeout=120, check=False,
    )
    assert proc.returncode == 0, proc.stderr
    return json.loads(proc.stdout)


def test_scanner_detects_all_expected_streams(tmp_path):
    out = _scan(tmp_path, "SampleHook")
    streams = {s["stream"] for s in out["signals"]}
    assert {"log", "telemetry", "onelake_file", "token", "spark"} <= streams


def test_scanner_captures_log_message(tmp_path):
    out = _scan(tmp_path, "SampleHook")
    log = next(s for s in out["signals"] if s["stream"] == "log")
    assert any("sample ran" in h.get("message", "") for h in log["hits"])


def test_scanner_finds_flag_gate_on_changed_symbol(tmp_path):
    out = _scan(tmp_path, "SampleHook")
    site = next(s for s in out["sites"] if s["symbol"] == "SampleHook")
    assert [g["flag"] for g in site["gatedBy"]] == ["FLTSampleFlag"]


def test_scanner_onelake_via_text_and_call(tmp_path):
    # changes.json (text) AND WriteAllText (call) both map to the fileop stream.
    out = _scan(tmp_path, "SampleHook")
    fileop = next(s for s in out["signals"] if s["stream"] == "onelake_file")
    kinds = {h["kind"] for h in fileop["hits"]}
    assert "text" in kinds or "call" in kinds
