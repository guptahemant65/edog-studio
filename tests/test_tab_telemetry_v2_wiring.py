"""
test_tab_telemetry_v2_wiring.py

Regression suite for TelemetryTab v2 (F04 rewrite).
Uses jsdom (via npm install --no-save jsdom) to run the real JS against a real DOM.

Covers the 10 contracts from the spec:
 1. Public API preserved
 2. Channel field consumed correctly
 3. Channel filter works
 4. Studio-state proxies write through studioSetFilter
 5. Iteration spine renders one .tt-iter per iteration
 6. Activity catalog aggregates (count / p50 / error-rate)
 7. No Math.random in production path (source guard)
 8. No state-demo code (source guard)
 9. Empty state shows on zero events, hides on first event
10. Detail panel closes via Esc
"""

from __future__ import annotations

import contextlib
import json
import os
import re
import shutil
import subprocess
import tempfile

import pytest

PROJECT_DIR  = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATE_JS     = os.path.join(PROJECT_DIR, "src", "frontend", "js", "studio-state.js")
TAB_JS       = os.path.join(PROJECT_DIR, "src", "frontend", "js", "tab-telemetry.js")
NODE         = shutil.which("node")

# ── jsdom harness ────────────────────────────────────────────────────────────

SHIM = r"""
const { JSDOM } = require('jsdom');
const dom = new JSDOM(`<!DOCTYPE html>
<html><body>
  <div id="rt-tab-telemetry"></div>
</body></html>`, { url: 'http://localhost/' });
globalThis.window    = dom.window;
globalThis.document  = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Element     = dom.window.Element;
globalThis.Node        = dom.window.Node;
globalThis.navigator   = dom.window.navigator;
globalThis.localStorage = dom.window.localStorage;
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.cancelAnimationFrame  = (id) => clearTimeout(id);
globalThis.location = dom.window.location;

// Stub edogState with empty logs buffer
globalThis.window.edogState = { logs: [] };
"""

ASSERT_SUFFIX = r"""
let result = {};
try {
  if (process.env.STUDIO_TEST_SCRIPT) {
    result = new Function(
      'window', 'document', 'TelemetryTab',
      process.env.STUDIO_TEST_SCRIPT
    )(window, document, TelemetryTab) || {};
  }
} catch (e) {
  console.error('SCRIPT_THREW: ' + e.message + '\n' + e.stack);
  process.exit(7);
}
setImmediate(() => { console.log(JSON.stringify(result)); process.exit(0); });
"""


@pytest.fixture(scope="module")
def state_src() -> str:
    with open(STATE_JS, encoding="utf-8") as f:
        return f.read()


@pytest.fixture(scope="module")
def tab_src() -> str:
    with open(TAB_JS, encoding="utf-8") as f:
        return f.read()


def _run(script: str, state_src: str, tab_src: str) -> dict:
    if not NODE:
        pytest.skip("node not available on PATH")
    harness = SHIM + "\n" + state_src + "\n" + tab_src + "\n" + ASSERT_SUFFIX
    env = os.environ.copy()
    env["STUDIO_TEST_SCRIPT"] = script
    fd, path = tempfile.mkstemp(suffix=".js", prefix=".tt-harness-", dir=os.path.dirname(__file__))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(harness)
        result = subprocess.run([NODE, path], capture_output=True, text=True, timeout=30, env=env)
    finally:
        with contextlib.suppress(OSError):
            os.unlink(path)
    assert result.returncode == 0, (
        f"TelemetryTab harness failed:\nstderr:\n{result.stderr}\nstdout:\n{result.stdout}"
    )
    lines = result.stdout.strip().splitlines()
    assert lines, f"No output from harness. stderr: {result.stderr}"
    return json.loads(lines[-1])


def _make_stub_signalr():
    return "const signalrStub = { _handlers: {}, on(t,fn){ this._handlers[t]=fn; }, off(){}, subscribeTopic(){}, unsubscribeTopic(){} };"


def _make_container():
    return "const container = document.getElementById('rt-tab-telemetry');"


def _make_tab():
    return _make_stub_signalr() + _make_container() + "const tab = new TelemetryTab(container, signalrStub);"


def _make_event(name="RunDag", status="succeeded", dur_ms=1000, ch="ssr", iter_id="iter-aaa", corr_id=None):
    c = corr_id or ("corr-" + name + "-" + ch)
    return (
        f"{{ activityName: '{name}', activityStatus: '{status}', durationMs: {dur_ms}, "
        f"channel: '{ch}', iterationId: '{iter_id}', correlationId: '{c}', "
        f"attributes: {{}}, userId: '' }}"
    )


# ── 1. Public API preserved ──────────────────────────────────────────────────

class TestPublicApiPreserved:
    def test_constructor_runs(self, state_src, tab_src):
        data = _run(
            _make_tab() + "return { ok: tab instanceof TelemetryTab };",
            state_src, tab_src,
        )
        assert data["ok"] is True

    def test_activate_does_not_throw(self, state_src, tab_src):
        data = _run(
            _make_tab() + "try { tab.activate(); return { ok: true }; } catch(e) { return { ok: false, err: e.message }; }",
            state_src, tab_src,
        )
        assert data["ok"] is True, data.get("err")

    def test_deactivate_does_not_throw(self, state_src, tab_src):
        data = _run(
            _make_tab() + "tab.activate(); try { tab.deactivate(); return { ok: true }; } catch(e) { return { ok: false, err: e.message }; }",
            state_src, tab_src,
        )
        assert data["ok"] is True, data.get("err")

    def test_signalr_subscribed_in_constructor(self, state_src, tab_src):
        """activate() must NOT be needed for topic subscription — constructor handles it."""
        data = _run(
            _make_stub_signalr() +
            "let subscribed = false; signalrStub.subscribeTopic = function(t){ if(t==='telemetry') subscribed=true; };" +
            _make_container() +
            "const tab = new TelemetryTab(container, signalrStub);" +
            "return { subscribed };",
            state_src, tab_src,
        )
        assert data["subscribed"] is True

    def test_deactivate_does_not_unsubscribe(self, state_src, tab_src):
        data = _run(
            _make_stub_signalr() +
            "let unsubCalled = false; signalrStub.unsubscribeTopic = function(){ unsubCalled=true; };" +
            _make_container() +
            "const tab = new TelemetryTab(container, signalrStub);" +
            "tab.activate(); tab.deactivate();" +
            "return { unsubCalled };",
            state_src, tab_src,
        )
        assert data["unsubCalled"] is False

    def test_add_event_is_public(self, state_src, tab_src):
        data = _run(
            _make_tab() +
            f"tab.addEvent({_make_event()});" +
            "return { count: tab._events.length };",
            state_src, tab_src,
        )
        assert data["count"] == 1


# ── 2. Channel field consumed ────────────────────────────────────────────────

class TestChannelFieldConsumed:
    def test_missing_channel_defaults_to_ssr(self, state_src, tab_src):
        """Backward compat: events without channel field → 'ssr'."""
        data = _run(
            _make_tab() +
            "tab.addEvent({ activityName: 'OldEvent', activityStatus: 'succeeded', durationMs: 100, "
            "correlationId: 'c0', iterationId: 'i0', attributes: {} });" +
            "return { ch: tab._events[0].channel };",
            state_src, tab_src,
        )
        assert data["ch"] == "ssr"

    def test_completed_status_kept_distinct_from_succeeded(self, state_src, tab_src):
        """Completed and Succeeded are distinct statuses (2026-06-07 telemetry-correctness
        fix). The Additional channel used to be backend-stamped 'Completed' which the
        frontend aliased to 'succeeded' — the alias hid that still-running RunDag
        activities were being misreported. Now the alias is gone: 'completed' stays
        'completed'. (The backend has also stopped stamping 'Completed' on Additional
        events; this test pins the frontend half of the fix.)"""
        data = _run(
            _make_tab() +
            "tab.addEvent({ activityName: 'GetLatestDAG', activityStatus: 'Completed', durationMs: 200, "
            "channel: 'ssr', correlationId: 'c1', iterationId: 'i1', attributes: {} });" +
            "return { status: tab._events[0].status };",
            state_src, tab_src,
        )
        assert data["status"] == "completed", (
            "rawStatus 'Completed' must map to 'completed' (NOT aliased to 'succeeded'). "
            "The two are semantically distinct — a workflow can complete with failures, "
            "and the backend Additional channel used to invent 'Completed' for still-"
            "running activities. Keeping them separate prevents the lie."
        )


# ── 3. SSR-only stream (channel filter removed) ──────────────────────────────

class TestSsrOnlyStream:
    """SSR-only stream — replaces the deleted channel-filter feature.

    Ground truth: every Additional (+TEL) emit is a TRUE MIRROR of an SSR emit
    (same activityName + correlationId; FLT NodeExecutor.cs:390 SSR / :417
    Additional). The tab drops +TEL at ingest and folds its unique retry-metric
    attributes into the SSR twin. There is no user-facing channel dimension any
    more — rendering +TEL as its own row was the root of the
    'unknown'-status / 'mirror' / 'older ones get redacted' bugs. These tests
    are the DOM-level twin of the B7/B8 source-scan regressions.
    """

    def test_additional_without_twin_is_dropped(self, state_src, tab_src):
        data = _run(
            _make_tab() +
            f"tab.addEvent({_make_event(ch='additional', corr_id='lonely')});" +
            "return { count: tab._events.length };",
            state_src, tab_src,
        )
        assert data["count"] == 0, (
            "An Additional (+TEL) event with no SSR twin must be dropped, not "
            "pushed as a row. Rendering it produced empty-status 'unknown' "
            "duplicates — the exact MESS the user reported."
        )

    def test_additional_merges_into_ssr_twin(self, state_src, tab_src):
        data = _run(
            _make_tab() +
            f"tab.addEvent({_make_event(name='RunDag', ch='ssr', corr_id='shared')});" +
            "tab.addEvent({ activityName: 'RunDag', activityStatus: 'succeeded', durationMs: 1000, "
            "channel: 'additional', iterationId: 'iter-aaa', correlationId: 'shared', "
            "attributes: { retryCount: '2' }, userId: '' });" +
            "return { count: tab._events.length, retry: tab._events[0].attributes.retryCount };",
            state_src, tab_src,
        )
        assert data["count"] == 1, "SSR twin + its +TEL mirror must collapse to ONE row."
        assert data["retry"] == "2", (
            "The +TEL mirror's unique attributes (retry metrics) must be merged "
            "into the SSR twin so nothing is lost when the mirror is dropped."
        )

    def test_ssr_and_additional_same_corr_render_one_card(self, state_src, tab_src):
        data = _run(
            _make_tab() +
            f"tab.addEvent({_make_event(name='RunDag', ch='ssr', corr_id='x1', iter_id='it')});" +
            f"tab.addEvent({_make_event(name='RunDag', ch='additional', corr_id='x1', iter_id='it')});" +
            "tab._render();" +
            "return { count: container.querySelectorAll('.tt-card').length };",
            state_src, tab_src,
        )
        assert data["count"] == 1, (
            "An SSR event and its +TEL mirror (same correlationId) must render "
            "as a single card — the SSR-only stream."
        )


# ── 4. Studio-state proxies write through ────────────────────────────────────

class TestStudioStateProxies:
    def test_window_proxy_writes_to_studio_state(self, state_src, tab_src):
        data = _run(
            _make_tab() +
            "tab._window = '5m';" +
            "return { v: window.studioState.get().filters.telemetry.window };",
            state_src, tab_src,
        )
        assert data["v"] == "5m"

    def test_iter_proxy_writes_to_studio_state(self, state_src, tab_src):
        data = _run(
            _make_tab() +
            "tab._iter = 'abc-iteration-id';" +
            "return { v: window.studioState.get().filters.telemetry.iter };",
            state_src, tab_src,
        )
        assert data["v"] == "abc-iteration-id"

    def test_iter_proxy_clears_to_null(self, state_src, tab_src):
        data = _run(
            _make_tab() +
            "tab._iter = 'some-id'; tab._iter = null;" +
            "return { v: window.studioState.get().filters.telemetry.iter };",
            state_src, tab_src,
        )
        assert data["v"] is None


# ── 5. Iteration spine renders one row per iteration ─────────────────────────

class TestIterationSpine:
    def test_three_iterations_produce_three_rows(self, state_src, tab_src):
        script = (
            _make_tab() +
            # 3 events for iter-A
            f"tab.addEvent({_make_event(name='RunDag', iter_id='iter-AAAA', corr_id='cA1')});" +
            f"tab.addEvent({_make_event(name='GetLatestDAG', iter_id='iter-AAAA', corr_id='cA2')});" +
            f"tab.addEvent({_make_event(name='RegisterCatalog', iter_id='iter-AAAA', corr_id='cA3')});" +
            # 3 events for iter-B
            f"tab.addEvent({_make_event(name='RunDag', iter_id='iter-BBBB', corr_id='cB1')});" +
            f"tab.addEvent({_make_event(name='GetLatestDAG', iter_id='iter-BBBB', corr_id='cB2')});" +
            f"tab.addEvent({_make_event(name='RegisterCatalog', iter_id='iter-BBBB', corr_id='cB3')});" +
            # 3 events for iter-C
            f"tab.addEvent({_make_event(name='RunDag', iter_id='iter-CCCC', corr_id='cC1')});" +
            f"tab.addEvent({_make_event(name='GetLatestDAG', iter_id='iter-CCCC', corr_id='cC2')});" +
            f"tab.addEvent({_make_event(name='RegisterCatalog', iter_id='iter-CCCC', corr_id='cC3')});" +
            "tab._render();" +
            "return { rows: container.querySelectorAll('.tt-iter').length };"
        )
        data = _run(script, state_src, tab_src)
        assert data["rows"] == 3, f"Expected 3 .tt-iter rows, got {data['rows']}"


# ── 6. Activity catalog aggregates ───────────────────────────────────────────

class TestActivityCatalogAggregates:
    def test_catalog_count_p50_and_error_rate(self, state_src, tab_src):
        """6 RunDag events: durations [100,200,300,400,500,600]ms, 1 failed.
        count=6, p50≈350ms (median), error-rate≈16.7%"""
        durs = [100, 200, 300, 400, 500, 600]
        script = _make_tab()
        for i, d in enumerate(durs):
            status = "failed" if i == 0 else "succeeded"
            script += f"tab.addEvent({{ activityName:'RunDag', activityStatus:'{status}', durationMs:{d}, channel:'ssr', iterationId:'iter1', correlationId:'c{i}', attributes:{{}} }});"
        script += (
            "const agg = tab._catMap.get('RunDag');"
            "const p50 = tab._quantile(agg.durations, 0.5);"
            "const errRate = agg.errCount / agg.count * 100;"
            "return { count: agg.count, p50: p50, errRate: parseFloat(errRate.toFixed(1)) };"
        )
        data = _run(script, state_src, tab_src)
        assert data["count"] == 6, f"count: {data['count']}"
        assert abs(data["p50"] - 350) < 1, f"p50: {data['p50']} (expected ~350)"
        assert abs(data["errRate"] - 16.7) < 0.2, f"errRate: {data['errRate']} (expected ~16.7)"


# ── 7. Source guard: no Math.random in production path ───────────────────────

class TestNoMathRandomInProductionPath:
    def test_no_math_random_in_tab_source(self, tab_src):
        """The rewritten tab-telemetry.js must contain zero Math.random() calls.
        The only allowed location would be inside _generateMockEvents (if it existed),
        but that method should NOT exist at all."""
        matches = re.findall(r'Math\.random\s*\(', tab_src)
        assert len(matches) == 0, (
            f"Found {len(matches)} Math.random() call(s) in tab-telemetry.js. "
            "Production path must not use random data. Found: " + str(matches)
        )


# ── 8. Source guard: no state-demo code ──────────────────────────────────────

class TestNoStateDemoCode:
    def test_no_state_demo_in_tab_source(self, tab_src):
        found = re.findall(r'state[-_]?[Dd]emo|stateDock|state_dock|stateDemo|StateDock', tab_src)
        assert len(found) == 0, (
            f"Found stateDemo/stateDock patterns in tab-telemetry.js: {found}"
        )

    def test_no_synthetic_data_generator(self, tab_src):
        """_generateMockEvents must not exist."""
        assert "_generateMockEvents" not in tab_src, \
            "Found _generateMockEvents in tab-telemetry.js — remove it."


# ── 9. Empty state visibility ────────────────────────────────────────────────

class TestEmptyStateVisibility:
    def test_empty_state_shows_when_no_events(self, state_src, tab_src):
        script = (
            _make_tab() +
            "tab._render();" +
            "const el = container.querySelector('#tt-empty') || container.querySelector('.tt-empty');" +
            "return { visible: el && !el.classList.contains('hidden') };"
        )
        data = _run(script, state_src, tab_src)
        assert data["visible"] is True, "Empty state should be visible when events=0"

    def test_empty_state_hides_on_first_event(self, state_src, tab_src):
        script = (
            _make_tab() +
            f"tab.addEvent({_make_event()});" +
            "tab._render();" +
            "const el = container.querySelector('#tt-empty') || container.querySelector('.tt-empty');" +
            "return { hidden: !el || el.classList.contains('hidden') };"
        )
        data = _run(script, state_src, tab_src)
        assert data["hidden"] is True, "Empty state should be hidden after first event"


# ── 10. Detail panel closes via Esc ──────────────────────────────────────────

class TestDetailPanelEsc:
    def test_esc_closes_open_detail(self, state_src, tab_src):
        script = (
            _make_tab() +
            f"tab.addEvent({_make_event()});" +
            "tab._render();" +
            # Open detail on the first event
            "const firstCard = container.querySelector('.tt-card');" +
            "if (firstCard) tab._selectCard(firstCard.dataset.id);" +
            "const openedDetail = !tab._dom.detail.hidden;" +
            # Dispatch Esc keydown
            "tab._active = true;" +
            "const ev = new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true });" +
            "tab._onKeyDown(ev);" +
            "const closedDetail = tab._dom.detail.hidden;" +
            "return { openedDetail, closedDetail, detailFlagFalse: !tab._detailOpen };"
        )
        data = _run(script, state_src, tab_src)
        assert data["openedDetail"] is True, "Detail should have opened on selectCard"
        assert data["closedDetail"] is True, "Detail should be hidden after Esc"
        assert data["detailFlagFalse"] is True, "_detailOpen should be false after close"
