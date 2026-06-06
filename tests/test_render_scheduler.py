"""
PR-C — render-scheduler.js contract tests.

Loads `src/frontend/js/render-scheduler.js` into Node, exercises the
scheduleRender + flushRenders surface, and asserts:

  1. Multiple scheduleRender(fn) calls in one tick → single rAF flush.
  2. Same fn scheduled twice in one frame → fires once (Set dedup).
  3. A throwing fn does not strand the batch — siblings still run, and
     dirty empties so the next schedule starts clean.
  4. flushRenders() runs the pending batch synchronously and cancels rAF.
  5. flushRenders() with nothing pending is a no-op.
  6. A fn that schedules itself during flush lands in the NEXT frame
     (snapshot-and-clear semantics).
  7. Non-function arguments are silently ignored.

Node has no requestAnimationFrame; the shim falls back to setTimeout(0).
We patch RAF inside the harness so flushes are deterministic.

@author Pixel — EDOG Studio hivemind
"""

import contextlib
import json
import os
import shutil
import subprocess
import tempfile

import pytest

PROJECT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCHEDULER_JS = os.path.join(PROJECT_DIR, "src", "frontend", "js", "render-scheduler.js")

NODE = shutil.which("node")

# Minimal window shim. We deliberately install a CONTROLLABLE RAF: it
# stores the callback in `pendingRAF` instead of running it on a timer.
# Tests can call `flushRAF()` to deterministically advance one frame.
SHIM_PREFIX = r"""
let pendingRAF = null;
let rafCounter = 0;
let rafSpyCalls = 0;
globalThis.window = {
  requestAnimationFrame(fn) {
    rafSpyCalls++;
    pendingRAF = fn;
    return ++rafCounter;
  },
  cancelAnimationFrame(id) {
    if (id === rafCounter) pendingRAF = null;
  },
};
globalThis.flushRAF = function () {
  const fn = pendingRAF;
  pendingRAF = null;
  if (fn) fn();
};
globalThis.hasPendingRAF = function () { return pendingRAF !== null; };
globalThis.getRafSpyCalls = function () { return rafSpyCalls; };
globalThis.resetRafSpy = function () { rafSpyCalls = 0; };
"""

ASSERT_SUFFIX = r"""
if (typeof window.scheduleRender !== 'function') {
  console.error('NO_SCHEDULE_RENDER'); process.exit(2);
}
if (typeof window.flushRenders !== 'function') {
  console.error('NO_FLUSH_RENDERS'); process.exit(3);
}

let result = {};
try {
  if (process.env.STUDIO_TEST_SCRIPT) {
    result = new Function(
      'scheduleRender', 'flushRenders', 'flushRAF', 'hasPendingRAF',
      'getRafSpyCalls', 'resetRafSpy',
      process.env.STUDIO_TEST_SCRIPT
    )(window.scheduleRender, window.flushRenders, flushRAF, hasPendingRAF,
      getRafSpyCalls, resetRafSpy) || {};
  }
} catch (e) {
  console.error('SCRIPT_THREW: ' + e.message + '\n' + e.stack);
  process.exit(4);
}
console.log(JSON.stringify(result));
"""


@pytest.fixture(scope="module")
def scheduler_source() -> str:
    with open(SCHEDULER_JS, encoding="utf-8") as f:
        return f.read()


def _run(script: str, scheduler_src: str) -> dict:
    if not NODE:
        pytest.skip("node not available on PATH")
    harness = SHIM_PREFIX + "\n" + scheduler_src + "\n" + ASSERT_SUFFIX
    env = os.environ.copy()
    env["STUDIO_TEST_SCRIPT"] = script
    fd, path = tempfile.mkstemp(suffix=".js", prefix=".harness-", dir=os.path.dirname(__file__))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(harness)
        result = subprocess.run(
            [NODE, path],
            capture_output=True,
            text=True,
            timeout=15,
            env=env,
        )
    finally:
        with contextlib.suppress(OSError):
            os.unlink(path)
    assert result.returncode == 0, (
        f"render-scheduler harness failed:\nstderr:\n{result.stderr}\nstdout:\n{result.stdout}"
    )
    return json.loads(result.stdout.strip().splitlines()[-1])


class TestBatching:
    """Multiple schedules collapse into one flush."""

    def test_three_distinct_fns_run_once_each_in_one_frame(self, scheduler_source):
        script = r"""
            const log = [];
            scheduleRender(() => log.push('a'));
            scheduleRender(() => log.push('b'));
            scheduleRender(() => log.push('c'));
            const before = hasPendingRAF();
            flushRAF();
            const after = hasPendingRAF();
            return { log, before, after };
        """
        data = _run(script, scheduler_source)
        assert data["before"] is True
        assert data["after"] is False
        assert sorted(data["log"]) == ["a", "b", "c"]
        assert len(data["log"]) == 3

    def test_same_fn_scheduled_twice_fires_once(self, scheduler_source):
        script = r"""
            let calls = 0;
            const fn = () => { calls++; };
            scheduleRender(fn);
            scheduleRender(fn);
            scheduleRender(fn);
            flushRAF();
            return { calls };
        """
        data = _run(script, scheduler_source)
        assert data["calls"] == 1

    def test_only_one_raf_requested_per_batch(self, scheduler_source):
        script = r"""
            resetRafSpy();
            scheduleRender(() => {});
            scheduleRender(() => {});
            scheduleRender(() => {});
            scheduleRender(() => {});
            return { rafCalls: getRafSpyCalls() };
        """
        data = _run(script, scheduler_source)
        assert data["rafCalls"] == 1


class TestErrorIsolation:
    """One throwing fn cannot strand the batch."""

    def test_throwing_fn_does_not_block_siblings(self, scheduler_source):
        script = r"""
            const log = [];
            scheduleRender(() => log.push('a'));
            scheduleRender(() => { throw new Error('boom'); });
            scheduleRender(() => log.push('c'));
            flushRAF();
            return { log };
        """
        data = _run(script, scheduler_source)
        assert "a" in data["log"]
        assert "c" in data["log"]

    def test_dirty_empties_even_when_fn_throws(self, scheduler_source):
        script = r"""
            scheduleRender(() => { throw new Error('boom'); });
            flushRAF();
            // If the throw left dirty non-empty, a new schedule wouldn't
            // re-request a frame. Verify a fresh schedule actually queues.
            let ran = false;
            scheduleRender(() => { ran = true; });
            const pending = hasPendingRAF();
            flushRAF();
            return { pending, ran };
        """
        data = _run(script, scheduler_source)
        assert data["pending"] is True
        assert data["ran"] is True


class TestFlushNow:
    """flushRenders is the deterministic escape hatch."""

    def test_flush_renders_runs_batch_synchronously(self, scheduler_source):
        script = r"""
            const log = [];
            scheduleRender(() => log.push('a'));
            scheduleRender(() => log.push('b'));
            const beforeFlush = hasPendingRAF();
            flushRenders();
            const afterFlush = hasPendingRAF();
            return { log, beforeFlush, afterFlush };
        """
        data = _run(script, scheduler_source)
        assert data["beforeFlush"] is True
        assert data["afterFlush"] is False
        assert sorted(data["log"]) == ["a", "b"]

    def test_flush_renders_with_nothing_pending_is_noop(self, scheduler_source):
        script = r"""
            // Should not throw, should not request a frame.
            flushRenders();
            flushRenders();
            return { pending: hasPendingRAF() };
        """
        data = _run(script, scheduler_source)
        assert data["pending"] is False


class TestSnapshotSemantics:
    """A fn re-scheduling itself lands in the NEXT frame, not this one."""

    def test_reentrant_schedule_defers_to_next_frame(self, scheduler_source):
        script = r"""
            const log = [];
            let depth = 0;
            const fn = () => {
                depth++;
                log.push('frame' + depth);
                if (depth < 3) scheduleRender(fn);
            };
            scheduleRender(fn);
            flushRAF();   // depth=1, fn re-scheduled
            const between = hasPendingRAF();
            flushRAF();   // depth=2, fn re-scheduled
            flushRAF();   // depth=3, no re-schedule
            const final = hasPendingRAF();
            return { log, between, final };
        """
        data = _run(script, scheduler_source)
        assert data["log"] == ["frame1", "frame2", "frame3"]
        assert data["between"] is True
        assert data["final"] is False


class TestInputValidation:
    """Non-callable inputs are silently ignored."""

    def test_non_function_arg_does_not_throw_or_schedule(self, scheduler_source):
        script = r"""
            scheduleRender(null);
            scheduleRender(undefined);
            scheduleRender(42);
            scheduleRender('hello');
            scheduleRender({});
            return { pending: hasPendingRAF() };
        """
        data = _run(script, scheduler_source)
        assert data["pending"] is False
