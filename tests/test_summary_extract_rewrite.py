r"""
ExecutionSummary extract* methods — data-wiring rewrite (2026-06-07).

Background:

Live-evidence inspection of the drawer (Hemant's screenshot 2026-06-07 10:35)
exposed 7 wiring bugs:

  1. Status: Pending while DAG actually Failed — extractMetrics picked
     `runDagEvents[length-1]` instead of latest-by-timestamp + with terminal
     preference.
  2. Duration showed Pending event's enqueue ms (1.8s) instead of the real
     terminal duration (~48 min from the Failed SSR).
  3. Subtitle "exists" — extractDagName regex `[Dd]ag(?:Name)?[:\s=]+`
     matched any "dag <next-word>" phrase, capturing junk.
  4. Nodes: 0/— — NodeExecution telemetry has no NodeName attribute. Logs
     DO carry the canonical [Artifact:, Iteration:, TransformationId:,
     Node name: X] shape but extractNodes never read them.
  5. Errors: 1 / "see below" with no Errors section — extractMetrics counted
     `level==Error` (30 hits, all JSON bodies); extractErrors required
     `MLV_/FLT_/SPARK_/ERR_/ERROR_` regex (0 hits). Count and list were
     independent. Now: count == extracted.length.
  6. Refresh: —, Parallel: — — both pulled from log regex that never matches
     FLT's actual log shapes. RunDag SSR attributes carry the real data:
     `attributes.RefreshMode = "Optimal"`, `attributes.MaxParallelNodes = "5"`.
  7. Key Moments showed raw JSON error body — extractTimeline did
     `msg.substring(0, 120)` even for `{"code":"X","message":"..."}` bodies.
     Now it parses JSON and shows `code: message`.

This test suite pins all 7 fixes against the live-shape data Hemant's
running FLT actually emits.
"""

from __future__ import annotations

import contextlib
import json
import os
import shutil
import subprocess
import tempfile

import pytest

PROJECT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SUMMARY_JS = os.path.join(PROJECT_DIR, "src", "frontend", "js", "summary.js")

NODE = shutil.which("node")


# Reuses the same jsdom-based shim as test_summary_drawer_diff_render.py.
SHIM = r"""
const { JSDOM } = require('jsdom');
const dom = new JSDOM(`<!DOCTYPE html><html><body></body></html>`, { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.navigator = dom.window.navigator;
globalThis.localStorage = dom.window.localStorage;
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

// Minimal renderer stub — extract* methods only call formatTime + formatDuration.
class StubRenderer {
  formatTime(iso) { return iso ? String(iso).substring(11, 23) : '\u2014'; }
  formatDuration(ms) {
    if (!ms) return '\u2014';
    if (ms < 1000) return ms + 'ms';
    if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
    return Math.floor(ms / 60000) + 'min';
  }
}

// In-memory state with both logs and telemetry arrays. ExecutionSummary
// only needs .filter() on telemetry; logs uses .filter() too.
function makeState(opts) {
  opts = opts || {};
  const logs = opts.logs || [];
  const telemetry = opts.telemetry || [];
  return {
    logs,
    telemetry: {
      filter: (fn) => telemetry.filter(fn),
      forEach: (fn) => telemetry.forEach(fn),
      get length() { return telemetry.length; },
    },
  };
}
"""

ASSERT_SUFFIX = r"""
let result = {};
try {
  if (process.env.STUDIO_TEST_SCRIPT) {
    result = new Function(
      'ExecutionSummary', 'StubRenderer', 'makeState',
      process.env.STUDIO_TEST_SCRIPT
    )(ExecutionSummary, StubRenderer, makeState) || {};
  }
} catch (e) {
  console.error('SCRIPT_THREW: ' + e.message + '\n' + e.stack);
  process.exit(7);
}
setImmediate(() => { console.log(JSON.stringify(result)); });
"""


@pytest.fixture(scope="module")
def harness_source() -> str:
    with open(SUMMARY_JS, encoding="utf-8") as f:
        return f.read()


def _run(script: str, harness_src: str) -> dict:
    if not NODE:
        pytest.skip("node not available on PATH")
    harness = SHIM + "\n" + harness_src + "\n" + ASSERT_SUFFIX
    env = os.environ.copy()
    env["STUDIO_TEST_SCRIPT"] = script
    fd, path = tempfile.mkstemp(suffix=".js", prefix=".harness-", dir=os.path.dirname(__file__))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(harness)
        result = subprocess.run(
            [NODE, path], capture_output=True, text=True, timeout=20, env=env,
        )
    finally:
        with contextlib.suppress(OSError):
            os.unlink(path)
    assert result.returncode == 0, (
        f"extract-rewrite harness failed:\nstderr:\n{result.stderr}\nstdout:\n{result.stdout}"
    )
    return json.loads(result.stdout.strip().splitlines()[-1])


ITER = "b2d0a6dc-559a-44b6-ab60-152ed2492ca4"


# ── 1. extractMetrics — status / duration / refresh / parallel ────────────


class TestMetricsFromTelemetry:
    def test_status_picks_terminal_over_pending(self, harness_source):
        """When both Pending and Failed SSRs exist, status must be Failed
        (terminal wins) regardless of array order."""
        script = (
            f"const state = makeState({{"
            f"  telemetry: ["
            f"    {{ activityName: 'RunDag', activityStatus: 'Failed',  durationMs: 2880241, timestamp: '2026-06-06T22:21:50.000Z',"
            f"      attributes: {{ IterationId: '{ITER}', RefreshMode: 'Optimal', MaxParallelNodes: '5' }} }},"
            f"    {{ activityName: 'RunDag', activityStatus: 'Pending', durationMs: 1794,"
            f"      timestamp: '2026-06-06T22:21:48.000Z',"
            f"      attributes: {{ IterationId: '{ITER}' }} }},"
            f"  ],"
            f"}});"
            f"const exec = new ExecutionSummary(state, new StubRenderer());"
            f"const data = exec.compute('{ITER}');"
            f"return {{ status: data.metrics.status, dur: data.metrics.duration,"
            f"         durMs: data.metrics.durationMs }};"
        )
        d = _run(script, harness_source)
        assert d["status"] == "Failed", "terminal SSR must win over Pending"
        assert d["durMs"] == 2880241, "duration must come from the terminal SSR"

    def test_running_when_only_pending_seen(self, harness_source):
        """When only Pending SSR exists (DAG still in progress), display
        'Running' not 'Pending' — Pending is the controller-accepted-the-
        request state, the DAG is actually executing."""
        script = (
            f"const state = makeState({{"
            f"  telemetry: ["
            f"    {{ activityName: 'RunDag', activityStatus: 'Pending', durationMs: 1794,"
            f"      timestamp: '2026-06-06T22:21:48.000Z',"
            f"      attributes: {{ IterationId: '{ITER}' }} }},"
            f"  ],"
            f"}});"
            f"const exec = new ExecutionSummary(state, new StubRenderer());"
            f"const data = exec.compute('{ITER}');"
            f"return {{ status: data.metrics.status }};"
        )
        d = _run(script, harness_source)
        assert d["status"] == "Running", (
            "Pending-only SSR should surface as 'Running' — the DAG is "
            "executing, Pending only refers to the controller queue stage"
        )

    def test_refresh_mode_from_telemetry_attributes(self, harness_source):
        """RefreshMode comes from RunDag SSR attributes, not log regex."""
        script = (
            f"const state = makeState({{"
            f"  telemetry: ["
            f"    {{ activityName: 'RunDag', activityStatus: 'Failed', durationMs: 100, timestamp: '2026-01-01T00:00:00Z',"
            f"      attributes: {{ IterationId: '{ITER}', RefreshMode: 'Optimal' }} }},"
            f"  ],"
            f"}});"
            f"const exec = new ExecutionSummary(state, new StubRenderer());"
            f"const data = exec.compute('{ITER}');"
            f"return {{ refreshMode: data.metrics.refreshMode }};"
        )
        d = _run(script, harness_source)
        assert d["refreshMode"] == "Optimal"

    def test_parallel_from_telemetry_attributes(self, harness_source):
        script = (
            f"const state = makeState({{"
            f"  telemetry: ["
            f"    {{ activityName: 'RunDag', activityStatus: 'Failed', durationMs: 100, timestamp: '2026-01-01T00:00:00Z',"
            f"      attributes: {{ IterationId: '{ITER}', MaxParallelNodes: '5' }} }},"
            f"  ],"
            f"}});"
            f"const exec = new ExecutionSummary(state, new StubRenderer());"
            f"const data = exec.compute('{ITER}');"
            f"return {{ parallel: data.metrics.parallelLimit }};"
        )
        d = _run(script, harness_source)
        assert d["parallel"] == "5"

    def test_error_count_matches_extracted_errors_length(self, harness_source):
        """extractMetrics.errorCount MUST equal extractErrors().length — the
        prior 'count from level==Error, list from MLV_ regex' mismatch
        caused the drawer to show 'Errors: N / see below' with no section."""
        script = (
            f"const state = makeState({{"
            f"  logs: ["
            f"    {{ level: 'Error', component: 'X', message: 'plain non-MLV error 1', rootActivityId: 'r', timestamp: '2026-01-01T00:00:00Z', iterationId: '{ITER}' }},"
            f"    {{ level: 'Error', component: 'X', message: 'plain non-MLV error 2', rootActivityId: 'r', timestamp: '2026-01-01T00:00:00Z', iterationId: '{ITER}' }},"
            f"  ],"
            f"  telemetry: [],"
            f"}});"
            f"const exec = new ExecutionSummary(state, new StubRenderer());"
            f"const data = exec.compute('{ITER}');"
            f"return {{ count: data.metrics.errorCount, listLen: data.errors.length }};"
        )
        d = _run(script, harness_source)
        assert d["count"] == d["listLen"], (
            f"errorCount ({d['count']}) MUST equal errors.length ({d['listLen']}) — "
            f"users see 'Errors: N / see below' and expect a list of length N"
        )


# ── 2. extractDagName — strict (no junk capture) ─────────────────────────


class TestDagNameExtraction:
    def test_dagname_extracted_from_canonical_log_shape(self, harness_source):
        """Real FLT log: '[LakehouseId = X, DagName = guid-here, ...]'"""
        script = (
            f"const state = makeState({{"
            f"  logs: [{{ level: 'Verbose', component: 'X',"
            f"    message: 'Disposed DagExecutionContext resources for [LakehouseId = abc, DagName = my-dag-guid, IterationId = xyz]',"
            f"    rootActivityId: 'r', timestamp: '2026-01-01T00:00:00Z', iterationId: '{ITER}' }}],"
            f"  telemetry: [],"
            f"}});"
            f"const exec = new ExecutionSummary(state, new StubRenderer());"
            f"const data = exec.compute('{ITER}');"
            f"return {{ dagName: data.dagName }};"
        )
        d = _run(script, harness_source)
        assert d["dagName"] == "my-dag-guid"

    def test_dagname_does_not_capture_random_next_word(self, harness_source):
        """The pre-rewrite regex `[Dd]ag(?:Name)?[:\\s=]+` matched 'DAG is'
        and captured 'is'. The tighter regex requires '=' or ':' delim."""
        script = (
            f"const state = makeState({{"
            f"  logs: [{{ level: 'Message', component: 'X',"
            f"    message: 'DAG exists for this lakehouse',"
            f"    rootActivityId: 'r', timestamp: '2026-01-01T00:00:00Z', iterationId: '{ITER}' }}],"
            f"  telemetry: [],"
            f"}});"
            f"const exec = new ExecutionSummary(state, new StubRenderer());"
            f"const data = exec.compute('{ITER}');"
            f"return {{ dagName: data.dagName }};"
        )
        d = _run(script, harness_source)
        assert d["dagName"] != "exists", (
            "'DAG exists' must NOT be parsed as DagName=exists. The bug shipped "
            "'exists' as the drawer subtitle (Hemant 2026-06-07 screenshot)."
        )


# ── 3. extractNodes — fall back to log shape when SSR attrs lack NodeName ─


class TestNodesFromLogs:
    def test_nodes_extracted_from_canonical_log_shape(self, harness_source):
        """Logs use '[Artifact: X, Iteration: Y, TransformationId: Z, Node name: dbo.foo]'.
        Telemetry NodeExecution events arrive with no NodeName attribute."""
        script = (
            f"const state = makeState({{"
            f"  logs: ["
            f"    {{ level: 'Message', component: 'X',"
            f"      message: '[Artifact: a1, Iteration: {ITER}, TransformationId: t1, Node name: _mlv_system.sys_run_metrics] starting',"
            f"      rootActivityId: 'r', timestamp: '2026-01-01T00:00:00Z', iterationId: '{ITER}' }},"
            f"    {{ level: 'Message', component: 'X',"
            f"      message: '[Artifact: a1, Iteration: {ITER}, TransformationId: t2, Node name: dbo.orders] starting',"
            f"      rootActivityId: 'r', timestamp: '2026-01-01T00:00:00Z', iterationId: '{ITER}' }},"
            f"  ],"
            f"  telemetry: ["
            f"    {{ activityName: 'NodeExecution', activityStatus: 'Failed', durationMs: 1699055,"
            f"      timestamp: '2026-01-01T00:30:00Z',"
            f"      attributes: {{ IterationId: '{ITER}', ErrorSource: 'System' }} }},"
            f"  ],"
            f"}});"
            f"const exec = new ExecutionSummary(state, new StubRenderer());"
            f"const data = exec.compute('{ITER}');"
            f"return {{ names: data.nodes.map(n => n.name).sort(), count: data.nodes.length }};"
        )
        d = _run(script, harness_source)
        assert d["count"] >= 2, "must extract both node names from log message bracket"
        assert "_mlv_system.sys_run_metrics" in d["names"]
        assert "dbo.orders" in d["names"]

    def test_node_status_picked_up_from_executed_message(self, harness_source):
        """'Executed node "dbo.foo" with final status Succeeded' updates status."""
        script = (
            f"const state = makeState({{"
            f"  logs: ["
            f"    {{ level: 'Message', component: 'X',"
            f"      message: '[Artifact: a1, Iteration: {ITER}, TransformationId: t1, Node name: dbo.foo] starting',"
            f"      rootActivityId: 'r', timestamp: '2026-01-01T00:00:00Z', iterationId: '{ITER}' }},"
            f"    {{ level: 'Message', component: 'X',"
            f"      message: 'Executed node \"dbo.foo\" with final status Succeeded',"
            f"      rootActivityId: 'r', timestamp: '2026-01-01T00:01:00Z', iterationId: '{ITER}' }},"
            f"  ],"
            f"  telemetry: [],"
            f"}});"
            f"const exec = new ExecutionSummary(state, new StubRenderer());"
            f"const data = exec.compute('{ITER}');"
            f"return {{ nodes: data.nodes }};"
        )
        d = _run(script, harness_source)
        assert len(d["nodes"]) == 1
        assert d["nodes"][0]["status"].lower() in ("succeeded", "completed")


# ── 4. extractErrors — parse JSON bodies ─────────────────────────────────


class TestErrorsFromJsonBodies:
    def test_json_body_extracted_as_error_entry(self, harness_source):
        script = (
            f"const json = JSON.stringify({{ code: 'WebRequestTimeout', subCode: 0,"
            f"  message: 'The operation was canceled.', timeStamp: '2026-06-06T23:00:42Z' }});"
            f"const state = makeState({{"
            f"  logs: ["
            f"    {{ level: 'Error', component: 'X', message: json,"
            f"      rootActivityId: 'r', timestamp: '2026-06-06T23:00:42Z', iterationId: '{ITER}' }},"
            f"  ],"
            f"  telemetry: [],"
            f"}});"
            f"const exec = new ExecutionSummary(state, new StubRenderer());"
            f"const data = exec.compute('{ITER}');"
            f"return {{ errors: data.errors, count: data.metrics.errorCount }};"
        )
        d = _run(script, harness_source)
        assert len(d["errors"]) == 1
        assert d["errors"][0]["code"] == "WebRequestTimeout"
        assert "canceled" in d["errors"][0]["message"].lower()
        assert d["count"] == 1

    def test_mlv_code_in_plain_text_still_extracted(self, harness_source):
        """Backward-compat: legacy MLV_ codes in non-JSON messages still work."""
        script = (
            f"const state = makeState({{"
            f"  logs: [{{ level: 'Error', component: 'X',"
            f"    message: 'MLV_SPARK_SESSION_ACQUISITION_FAILED: cluster unavailable',"
            f"    rootActivityId: 'r', timestamp: '2026-01-01T00:00:00Z', iterationId: '{ITER}' }}],"
            f"  telemetry: [],"
            f"}});"
            f"const exec = new ExecutionSummary(state, new StubRenderer());"
            f"const data = exec.compute('{ITER}');"
            f"return {{ errors: data.errors }};"
        )
        d = _run(script, harness_source)
        assert len(d["errors"]) == 1
        assert d["errors"][0]["code"] == "MLV_SPARK_SESSION_ACQUISITION_FAILED"

    def test_same_code_deduplicated_with_count(self, harness_source):
        script = (
            f"const json1 = JSON.stringify({{ code: 'WebRequestTimeout', message: 'x' }});"
            f"const json2 = JSON.stringify({{ code: 'WebRequestTimeout', message: 'y' }});"
            f"const state = makeState({{"
            f"  logs: ["
            f"    {{ level: 'Error', component: 'X', message: json1, rootActivityId: 'r', timestamp: '2026-01-01T00:00:00Z', iterationId: '{ITER}' }},"
            f"    {{ level: 'Error', component: 'X', message: json2, rootActivityId: 'r', timestamp: '2026-01-01T00:00:01Z', iterationId: '{ITER}' }},"
            f"  ],"
            f"  telemetry: [],"
            f"}});"
            f"const exec = new ExecutionSummary(state, new StubRenderer());"
            f"const data = exec.compute('{ITER}');"
            f"return {{ errors: data.errors }};"
        )
        d = _run(script, harness_source)
        assert len(d["errors"]) == 1
        assert d["errors"][0]["count"] == 2


# ── 5. extractTimeline — JSON-body errors rendered cleanly ───────────────


class TestTimelineJsonBodyRendered:
    def test_json_error_body_rendered_as_code_message(self, harness_source):
        script = (
            f"const json = JSON.stringify({{ code: 'WebRequestTimeout',"
            f"  message: 'The operation was canceled.', timeStamp: '2026-06-06T23:00:42Z' }});"
            f"const state = makeState({{"
            f"  logs: [{{ level: 'Error', component: 'X', message: json,"
            f"    rootActivityId: 'r', timestamp: '2026-06-06T23:00:42Z', iterationId: '{ITER}' }}],"
            f"  telemetry: [],"
            f"}});"
            f"const exec = new ExecutionSummary(state, new StubRenderer());"
            f"const data = exec.compute('{ITER}');"
            f"return {{ timeline: data.timeline }};"
        )
        d = _run(script, harness_source)
        assert len(d["timeline"]) == 1
        text = d["timeline"][0]["text"]
        # Must NOT be the raw JSON.
        assert not text.startswith("{"), (
            f"Timeline must not display raw JSON; got {text!r}. Parse the "
            f"JSON and surface code+message instead."
        )
        assert "WebRequestTimeout" in text
        assert "canceled" in text.lower()
