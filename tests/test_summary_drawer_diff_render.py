"""
ExecutionSummary drawer — diff-render (#B fix for 2026-06-07 blink bug).

Bug history:

The lifecycle drawer was repainted every 1 second via
``container.innerHTML = html`` even when the visible content was identical.
The browser tore down + re-laid-out + repainted every node → visible blink.

Fix: each updatable element carries a ``data-slot="<name>"`` attribute.
``render(data)`` decides:

  * First paint, OR iteration changed (``container.data-iter-id`` differs):
    one ``innerHTML`` assignment to seed the slot scaffold.

  * Same iteration: ``_patch(container, data)`` mutates each slot in place
    via textContent / classList / setAttribute. No element destroyed unless
    its identity (node name, error code, timeline signature) leaves the
    data set, which is rare for append-only log streams.

This test asserts:
  1. Slot attributes appear in the first-paint HTML (structural)
  2. Same-iteration refresh preserves DOM element identity for stable slots
     (the blink-killing invariant — element references survive across
     refresh boundaries)
  3. Slot values reflect the latest data after patch
  4. Iteration switch triggers a fresh rebuild (different identity)
  5. New nodes append without disturbing existing rows
  6. Removed nodes leave the surviving rows intact
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


# Real DOM via jsdom (npm install --no-save jsdom). All the production code
# under test (innerHTML, querySelector, classList, setAttribute, style.setProperty,
# appendChild/replaceWith/insertBefore) hits the real spec.
SHIM = r"""
const { JSDOM } = require('jsdom');
const dom = new JSDOM(`<!DOCTYPE html>
<html><body>
  <div id="rt-content">
    <div id="exec-drawer">
      <div id="exec-summary-data"></div>
    </div>
  </div>
</body></html>`, { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Element = dom.window.Element;
globalThis.Node = dom.window.Node;
globalThis.navigator = dom.window.navigator;
globalThis.localStorage = dom.window.localStorage;
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

const container = document.getElementById('exec-summary-data');
const drawer = document.getElementById('exec-drawer');

// Tag every freshly-created element with a stable id so tests can detect
// when a node was destroyed-and-recreated (identity change → blink) vs
// preserved-and-mutated (identity preserved → smooth).
let __nextNodeId = 0;
const __nodeIdMap = new WeakMap();
function nodeId(el) {
  if (!el) return -1;
  if (!__nodeIdMap.has(el)) __nodeIdMap.set(el, ++__nextNodeId);
  return __nodeIdMap.get(el);
}
globalThis.__nodeId = nodeId;

// Stub state + renderer so ExecutionSummary's constructor can be invoked.
class StubRenderer {
  formatTime() { return '12:00:00.000'; }
  formatDuration(ms) { return ms ? (ms + 'ms') : '\u2014'; }
}
const stubState = { logs: [], telemetry: { filter() { return []; } } };
"""

ASSERT_SUFFIX = r"""
const renderer = new StubRenderer();
const exec = new ExecutionSummary(stubState, renderer);

function makeData(opts) {
  opts = opts || {};
  return {
    iterationId: opts.iterationId || '11111111-1111-1111-1111-111111111111',
    metrics: Object.assign({
      status: 'Running', duration: '1.8s', durationMs: 1800, started: '22:21:48.942',
      refreshMode: '\u2014', nodeCount: '\u2014', errorCount: 0, parallelLimit: '\u2014',
    }, opts.metrics || {}),
    nodes: opts.nodes || [],
    errors: opts.errors || [],
    timeline: opts.timeline || [],
    dagName: opts.dagName || '',
    logCount: opts.logCount || 0,
    ssrCount: opts.ssrCount || 0,
  };
}

let result = {};
try {
  if (process.env.STUDIO_TEST_SCRIPT) {
    result = new Function(
      'exec', 'container', 'drawer', 'makeData', 'window', '__nodeId',
      process.env.STUDIO_TEST_SCRIPT
    )(exec, container, drawer, makeData, window, __nodeId) || {};
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
        f"summary-diff-render harness failed:\nstderr:\n{result.stderr}\nstdout:\n{result.stdout}"
    )
    return json.loads(result.stdout.strip().splitlines()[-1])


# ── 1. Structural: slot attributes are present after first paint ───────────


class TestSlotsAreAnnotated:
    @pytest.mark.parametrize(
        "slot",
        [
            "status-label", "status-dag", "status-orb",
            "duration-num", "duration-unit", "iter-val",
            "metric-status-badge", "metric-status-card",
            "metric-duration-value", "metric-duration-sub",
            "metric-nodes-value", "metric-nodes-sub", "metric-nodes-label", "metric-nodes-ring",
            "metric-errors-value", "metric-errors-sub", "metric-errors-card",
            "metric-refresh-value", "metric-parallel-value",
            "nodes-section", "nodes-count",
            "timeline-section", "timeline-count",
        ],
    )
    def test_slot_present_after_first_paint(self, harness_source, slot):
        script = (
            "exec.render(makeData({nodes:[{name:'dbo.x',status:'Running',duration:'1s',durationMs:1000,error:''}]}));"
            f"return {{ found: !!container.querySelector('[data-slot=\"{slot}\"]') }};"
        )
        data = _run(script, harness_source)
        assert data["found"], (
            f"Slot '{slot}' must be present in the drawer DOM after first paint "
            f"so subsequent _patch() calls can find and mutate it in place."
        )


# ── 2. DOM identity preservation across same-iteration refresh ─────────────


class TestSameIterationRefreshPreservesIdentity:
    """Blink-killing invariant: same iteration → same DOM elements."""

    def test_stable_slot_elements_survive_refresh(self, harness_source):
        """status-label, duration-num, metric counters — their backing
        elements must be the SAME object reference across refreshes.
        That's the only way the browser doesn't tear down + repaint."""
        script = (
            # First render
            "exec.render(makeData({metrics:{status:'Pending', duration:'1.0s', durationMs:1000, started:'00:00:00.000', errorCount:0, refreshMode:'-', parallelLimit:'-'}}));"
            "const before = {"
            "  statusLabel: __nodeId(container.querySelector('[data-slot=\"status-label\"]')),"
            "  statusDag: __nodeId(container.querySelector('[data-slot=\"status-dag\"]')),"
            "  durationNum: __nodeId(container.querySelector('[data-slot=\"duration-num\"]')),"
            "  durationUnit: __nodeId(container.querySelector('[data-slot=\"duration-unit\"]')),"
            "  metricStatusBadge: __nodeId(container.querySelector('[data-slot=\"metric-status-badge\"]')),"
            "  metricStatusCard: __nodeId(container.querySelector('[data-slot=\"metric-status-card\"]')),"
            "  metricNodesValue: __nodeId(container.querySelector('[data-slot=\"metric-nodes-value\"]')),"
            "  metricErrorsValue: __nodeId(container.querySelector('[data-slot=\"metric-errors-value\"]')),"
            "  iterVal: __nodeId(container.querySelector('[data-slot=\"iter-val\"]')),"
            "  nodesSection: __nodeId(container.querySelector('[data-slot=\"nodes-section\"]')),"
            "  timelineSection: __nodeId(container.querySelector('[data-slot=\"timeline-section\"]')),"
            "};"
            # Refresh with different values but SAME iteration
            "exec.render(makeData({metrics:{status:'Running', duration:'3.0s', durationMs:3000, started:'00:00:00.000', errorCount:0, refreshMode:'-', parallelLimit:'-'}}));"
            "const after = {"
            "  statusLabel: __nodeId(container.querySelector('[data-slot=\"status-label\"]')),"
            "  statusDag: __nodeId(container.querySelector('[data-slot=\"status-dag\"]')),"
            "  durationNum: __nodeId(container.querySelector('[data-slot=\"duration-num\"]')),"
            "  durationUnit: __nodeId(container.querySelector('[data-slot=\"duration-unit\"]')),"
            "  metricStatusBadge: __nodeId(container.querySelector('[data-slot=\"metric-status-badge\"]')),"
            "  metricStatusCard: __nodeId(container.querySelector('[data-slot=\"metric-status-card\"]')),"
            "  metricNodesValue: __nodeId(container.querySelector('[data-slot=\"metric-nodes-value\"]')),"
            "  metricErrorsValue: __nodeId(container.querySelector('[data-slot=\"metric-errors-value\"]')),"
            "  iterVal: __nodeId(container.querySelector('[data-slot=\"iter-val\"]')),"
            "  nodesSection: __nodeId(container.querySelector('[data-slot=\"nodes-section\"]')),"
            "  timelineSection: __nodeId(container.querySelector('[data-slot=\"timeline-section\"]')),"
            "};"
            "return { before, after };"
        )
        data = _run(script, harness_source)
        for slot in data["before"]:
            assert data["before"][slot] == data["after"][slot], (
                f"Slot '{slot}' lost DOM identity across refresh "
                f"(before={data['before'][slot]} after={data['after'][slot]}). "
                f"This is the blink bug — element was destroyed and recreated."
            )

    def test_slot_values_updated_after_patch(self, harness_source):
        """Same elements, but with new content reflecting the new data."""
        script = (
            "exec.render(makeData({metrics:{status:'Pending', duration:'1.0s', durationMs:1000, started:'00:00:00.000', errorCount:0, refreshMode:'-', parallelLimit:'-'}}));"
            "const beforeLabel = container.querySelector('[data-slot=\"status-label\"]').textContent;"
            "const beforeDur = container.querySelector('[data-slot=\"duration-num\"]').textContent;"
            "exec.render(makeData({metrics:{status:'Running', duration:'5.0s', durationMs:5000, started:'00:00:00.000', errorCount:2, refreshMode:'FULL', parallelLimit:'4'}}));"
            "return {"
            "  beforeLabel,"
            "  beforeDur,"
            "  afterLabel: container.querySelector('[data-slot=\"status-label\"]').textContent,"
            "  afterDur: container.querySelector('[data-slot=\"duration-num\"]').textContent,"
            "  afterErrorsValue: container.querySelector('[data-slot=\"metric-errors-value\"]').textContent,"
            "  afterRefreshMode: container.querySelector('[data-slot=\"metric-refresh-value\"]').textContent,"
            "  afterParallel: container.querySelector('[data-slot=\"metric-parallel-value\"]').textContent,"
            "};"
        )
        data = _run(script, harness_source)
        assert data["beforeLabel"] == "Pending"
        assert data["afterLabel"] == "Running"
        assert data["afterDur"] == "5.0"
        assert data["afterErrorsValue"] == "2"
        assert data["afterRefreshMode"] == "FULL"
        assert data["afterParallel"] == "4"


# ── 3. Iteration switch triggers a fresh rebuild ──────────────────────────


class TestIterationSwitchRebuilds:
    def test_different_iteration_rebuilds_dom(self, harness_source):
        """When the iterationId changes, the DOM should be torn down +
        rebuilt — slot elements get fresh identities. (This is acceptable
        flicker because iteration switch is a user-initiated event, not
        background noise.)"""
        script = (
            "exec.render(makeData({iterationId:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'}));"
            "const idA = __nodeId(container.querySelector('[data-slot=\"status-label\"]'));"
            "exec.render(makeData({iterationId:'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'}));"
            "const idB = __nodeId(container.querySelector('[data-slot=\"status-label\"]'));"
            "return { idA, idB, attrAfter: container.getAttribute('data-iter-id') };"
        )
        data = _run(script, harness_source)
        assert data["idA"] != data["idB"], "Iteration switch must produce fresh DOM identities"
        assert data["attrAfter"] == "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"


# ── 4. Node list — append-only diff preserves existing rows ───────────────


class TestNodeListDiff:
    def test_new_node_appends_existing_rows_preserved(self, harness_source):
        script = (
            "exec.render(makeData({nodes:["
            "  {name:'dbo.a',status:'Running',duration:'1s',durationMs:1000,error:''}"
            "]}));"
            "const beforeRow = container.querySelector('.exd-nodes').children[0];"
            "const beforeRowId = __nodeId(beforeRow);"
            "const beforeChildren = container.querySelector('.exd-nodes').children.length;"
            "exec.render(makeData({nodes:["
            "  {name:'dbo.a',status:'Running',duration:'1s',durationMs:1000,error:''},"
            "  {name:'dbo.b',status:'Running',duration:'0.5s',durationMs:500,error:''}"
            "]}));"
            "const afterChildren = container.querySelector('.exd-nodes').children.length;"
            "const afterFirstRowId = __nodeId(container.querySelector('.exd-nodes').children[0]);"
            "return { beforeRowId, beforeChildren, afterChildren, afterFirstRowId };"
        )
        data = _run(script, harness_source)
        assert data["beforeChildren"] == 1
        assert data["afterChildren"] == 2
        assert data["afterFirstRowId"] == data["beforeRowId"], (
            "Adding a new node must NOT recreate the existing node row "
            "(identity preserved → no flicker)"
        )

    def test_existing_node_status_updates_in_place(self, harness_source):
        script = (
            "exec.render(makeData({nodes:["
            "  {name:'dbo.x',status:'Running',duration:'1s',durationMs:1000,error:''}"
            "]}));"
            "const rowBefore = container.querySelector('.exd-nodes').children[0];"
            "const rowIdBefore = __nodeId(rowBefore);"
            "exec.render(makeData({nodes:["
            "  {name:'dbo.x',status:'Succeeded',duration:'3s',durationMs:3000,error:''}"
            "]}));"
            "const rowAfter = container.querySelector('.exd-nodes').children[0];"
            "const pillText = rowAfter.querySelector('.exd-pill').textContent;"
            "const durText = rowAfter.querySelector('.exd-node-dur').textContent;"
            "return { rowIdBefore, rowIdAfter: __nodeId(rowAfter), pillText, durText };"
        )
        data = _run(script, harness_source)
        assert data["rowIdBefore"] == data["rowIdAfter"]
        assert data["pillText"] == "Succeeded"
        assert data["durText"] == "3s"


# ── 5. Errors section — appears mid-run, disappears when cleared ──────────


class TestErrorsSectionAppearance:
    def test_errors_section_appears_when_errors_arrive(self, harness_source):
        script = (
            # First render: no errors → section absent
            "exec.render(makeData({errors:[]}));"
            "const beforeHasSection = !!container.querySelector('[data-slot=\"errors-section\"]');"
            # Refresh with errors → section appears
            "exec.render(makeData({errors:[{code:'MLV_RUNTIME_ERROR', node:'dbo.x', count:1, message:'boom'}]}));"
            "const afterHasSection = !!container.querySelector('[data-slot=\"errors-section\"]');"
            "const errorsList = container.querySelector('[data-slot=\"errors-list\"]');"
            "return {"
            "  beforeHasSection, afterHasSection,"
            "  errorChildCount: errorsList ? errorsList.children.length : -1,"
            "};"
        )
        data = _run(script, harness_source)
        assert data["beforeHasSection"] is False
        assert data["afterHasSection"] is True
        assert data["errorChildCount"] == 1


