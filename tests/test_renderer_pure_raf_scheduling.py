"""
Renderer.scheduleRender — pure rAF, no time-based throttle.

Bug history (Hemant 2026-06-07 11:02):
  "Logs flow feels non-live / bursty — A: cadence"

The Renderer.scheduleRender method used a custom 100ms throttle:

  scheduleRender = () => {
    if (this.renderScheduled) return;
    const now = Date.now();
    const elapsed = now - this.lastRenderTime;
    if (elapsed >= this.renderThrottleMs) { ... }   // throttle path
    else if (!this.pendingTimer) {
      this.pendingTimer = setTimeout(..., this.renderThrottleMs - elapsed);
    }
  }

This batched arriving logs into chunks of "up to 100 ms worth of work"
which produced a visible cadence (paint → 100ms pause → paint). Visually
the stream felt batchy, not live.

Fix: pure rAF. Each scheduleRender either schedules a frame (if not
already scheduled) or no-ops. The browser paces at ~60fps; each frame's
flush coalesces whatever arrived since the last frame. Smooth motion.

This test:
  1. scheduleRender → exactly ONE requestAnimationFrame call.
  2. Multiple scheduleRender calls in the same tick → still ONE rAF.
  3. After flush runs and clears renderScheduled, the next call
     schedules a NEW rAF.
  4. NO setTimeout is registered (no time-based throttle).
  5. Source-level guard: renderer.js contains no `renderThrottleMs`,
     `lastRenderTime`, or `pendingTimer` (mutation guard against
     accidental re-introduction).
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

PROJECT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RENDERER_JS = os.path.join(PROJECT_DIR, "src", "frontend", "js", "renderer.js")
STATE_JS = os.path.join(PROJECT_DIR, "src", "frontend", "js", "state.js")
FILTERS_JS = os.path.join(PROJECT_DIR, "src", "frontend", "js", "filters.js")
STUDIO_STATE_JS = os.path.join(PROJECT_DIR, "src", "frontend", "js", "studio-state.js")

NODE = shutil.which("node")


# Controllable rAF + setTimeout spy. The shim stores the rAF callback so
# tests can deterministically advance one frame. It also counts setTimeout
# calls so we can prove no time-based throttle is in play.
SHIM = r"""
let pendingRAF = null;
let rafCallCount = 0;
let setTimeoutCallCount = 0;

const realSetTimeout = setTimeout;
const realClearTimeout = clearTimeout;

globalThis.window = {
  location: { hash: '', pathname: '/', search: '' },
  history: { replaceState() {} },
  localStorage: {
    _kv: {},
    getItem(k) { return this._kv[k] !== undefined ? this._kv[k] : null; },
    setItem(k, v) { this._kv[k] = String(v); },
  },
  addEventListener: () => {},
  matchMedia: () => ({ matches: false, addListener: () => {} }),
};
globalThis.localStorage = window.localStorage;
globalThis.document = {
  createElement: (_t) => ({
    classList: { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false },
    style: {}, dataset: {},
    appendChild: (c) => c, addEventListener: () => {},
  }),
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener: () => {},
};
globalThis.requestAnimationFrame = (fn) => {
  rafCallCount++;
  pendingRAF = fn;
  return rafCallCount;
};
globalThis.cancelAnimationFrame = (id) => { if (id === rafCallCount) pendingRAF = null; };

// Spy setTimeout — wrap globalThis.setTimeout so any throttle re-introduction
// (which would have to use setTimeout) is observable.
globalThis.setTimeout = function (fn, ms) {
  setTimeoutCallCount++;
  return realSetTimeout(fn, ms);
};
globalThis.clearTimeout = realClearTimeout;

globalThis.flushRAF = function () {
  const fn = pendingRAF;
  pendingRAF = null;
  if (fn) fn();
};
globalThis.hasPendingRAF = function () { return pendingRAF !== null; };
globalThis.getRafCallCount = function () { return rafCallCount; };
globalThis.getSetTimeoutCallCount = function () { return setTimeoutCallCount; };
globalThis.CustomEvent = class CustomEvent {
  constructor(type, init) { this.type = type; this.detail = init && init.detail; }
};
"""

ASSERT_SUFFIX = r"""
const state = new LogViewerState();
const renderer = new Renderer(state);

// Baseline counts AFTER renderer construction (in case anything in the
// ctor calls setTimeout/rAF — currently it doesn't, but be defensive).
const baselineRaf = getRafCallCount();
const baselineSetTimeout = getSetTimeoutCallCount();

let result = {};
try {
  if (process.env.STUDIO_TEST_SCRIPT) {
    result = new Function(
      'state', 'renderer',
      'flushRAF', 'hasPendingRAF',
      'getRafCallCount', 'getSetTimeoutCallCount',
      'baselineRaf', 'baselineSetTimeout',
      process.env.STUDIO_TEST_SCRIPT
    )(state, renderer, flushRAF, hasPendingRAF,
      getRafCallCount, getSetTimeoutCallCount,
      baselineRaf, baselineSetTimeout) || {};
  }
} catch (e) {
  console.error('SCRIPT_THREW: ' + e.message + '\n' + e.stack);
  process.exit(7);
}
setImmediate(() => { console.log(JSON.stringify(result)); });
"""


@pytest.fixture(scope="module")
def harness_source() -> str:
    parts = []
    for path in (STUDIO_STATE_JS, STATE_JS, FILTERS_JS, RENDERER_JS):
        with open(path, encoding="utf-8") as f:
            parts.append(f.read())
    return "\n".join(parts)


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
        f"render-scheduler-pure-raf harness failed:\nstderr:\n{result.stderr}\nstdout:\n{result.stdout}"
    )
    return json.loads(result.stdout.strip().splitlines()[-1])


# ── 1. Behavior: pure rAF, no time-based throttle ─────────────────────────


class TestSchedulerIsPureRaf:
    def test_single_schedule_registers_one_raf(self, harness_source):
        """One scheduleRender call → exactly one new rAF, no setTimeout."""
        script = (
            "renderer.scheduleRender();"
            "return {"
            "  rafDelta: getRafCallCount() - baselineRaf,"
            "  setTimeoutDelta: getSetTimeoutCallCount() - baselineSetTimeout,"
            "  hasPending: hasPendingRAF(),"
            "};"
        )
        data = _run(script, harness_source)
        assert data["rafDelta"] == 1, (
            f"scheduleRender must register exactly 1 rAF; got {data['rafDelta']}"
        )
        assert data["setTimeoutDelta"] == 0, (
            f"scheduleRender must NOT use setTimeout (time-based throttle is gone); "
            f"setTimeout was called {data['setTimeoutDelta']} times."
        )
        assert data["hasPending"] is True

    def test_burst_of_schedules_coalesces_to_one_raf(self, harness_source):
        """Many scheduleRender calls in the same tick → still one rAF."""
        script = (
            "for (let i = 0; i < 50; i++) renderer.scheduleRender();"
            "return {"
            "  rafDelta: getRafCallCount() - baselineRaf,"
            "  setTimeoutDelta: getSetTimeoutCallCount() - baselineSetTimeout,"
            "};"
        )
        data = _run(script, harness_source)
        assert data["rafDelta"] == 1, (
            f"50 scheduleRender calls must coalesce to 1 rAF; got {data['rafDelta']}"
        )
        assert data["setTimeoutDelta"] == 0

    def test_after_flush_a_new_schedule_registers_a_fresh_raf(self, harness_source):
        """scheduleRender → flush → scheduleRender → second rAF registered.

        This is the live-stream loop: rAF fires, flush runs, more logs arrive
        before the next frame, schedule again, next rAF fires, etc.
        """
        script = (
            "renderer.scheduleRender();"  # rAF #1
            "flushRAF();"                  # frame fires
            "renderer.scheduleRender();"  # rAF #2
            "return {"
            "  rafDelta: getRafCallCount() - baselineRaf,"
            "  hasPending: hasPendingRAF(),"
            "};"
        )
        data = _run(script, harness_source)
        assert data["rafDelta"] == 2, (
            f"After flush, a new scheduleRender must register a fresh rAF; "
            f"got {data['rafDelta']} total rAF calls."
        )
        assert data["hasPending"] is True


# ── 2. Source-level mutation guard ────────────────────────────────────────


class TestNoTimeBasedThrottleInSource:
    """Reject any future re-introduction of the time-based throttle."""

    def test_renderer_has_no_throttle_fields(self):
        with open(RENDERER_JS, encoding="utf-8") as f:
            src = f.read()
        # Strip comments — references inside the explanatory comments above
        # scheduleRender are allowed (and useful documentation).
        stripped = re.sub(r"//[^\n]*", "", src)
        stripped = re.sub(r"/\*.*?\*/", "", stripped, flags=re.DOTALL)
        for field in ("renderThrottleMs", "lastRenderTime", "pendingTimer"):
            assert field not in stripped, (
                f"Found `{field}` in renderer.js — the time-based render throttle "
                f"was removed in #1 (2026-06-07) because it produced a visible "
                f"100ms cadence in the log stream. Use pure-rAF scheduling instead."
            )

    def test_renderer_schedule_uses_raf_not_settimeout(self):
        with open(RENDERER_JS, encoding="utf-8") as f:
            src = f.read()
        # Locate the scheduleRender method body and verify it calls rAF
        # (not setTimeout) for scheduling.
        m = re.search(
            r"scheduleRender\s*=\s*\([^)]*\)\s*=>\s*\{(.*?)\n  \}",
            src,
            re.DOTALL,
        )
        assert m, "Could not locate scheduleRender body in renderer.js"
        body = m.group(1)
        # Allow setTimeout in OTHER methods (cluster refresh etc.) but NOT
        # inside scheduleRender's body.
        assert "setTimeout" not in body, (
            "scheduleRender body uses setTimeout — that's the throttle pattern. "
            "Use requestAnimationFrame only."
        )
        assert "requestAnimationFrame" in body, (
            "scheduleRender must call requestAnimationFrame to pace renders."
        )
