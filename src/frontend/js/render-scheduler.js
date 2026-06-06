'use strict';

/* ═══════════════════════════════════════════════════════════════
   PR-C: rAF render scheduler

   Coalesces render functions into one animation frame. Multiple
   scheduleRender(fn) calls in the same tick → one flush. Same fn
   scheduled twice in the same frame → fires once (Set semantics).

   Snapshot-and-clear BEFORE running: a fn that re-schedules itself
   during flush lands in the *next* frame, not this one. Mirrors
   studioState's queueMicrotask snapshot pattern, so re-entrancy is
   bounded by frame, not by re-entrant call depth.

   Each fn runs inside its own try/catch so one bad render can't
   strand the batch or leak entries in the dirty Set.

   `flushRenders()` is a deterministic escape hatch for tests and
   urgent paths (teardown, snapshotting). Prefer scheduleRender().
   ═══════════════════════════════════════════════════════════════ */

(function () {
  const dirty = new Set();
  let scheduled = false;
  let rafId = 0;

  const RAF = typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function'
    ? window.requestAnimationFrame.bind(window)
    : (fn) => setTimeout(fn, 0);
  const CAF = typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function'
    ? window.cancelAnimationFrame.bind(window)
    : (id) => clearTimeout(id);

  function flush() {
    scheduled = false;
    rafId = 0;
    const batch = Array.from(dirty);
    dirty.clear();
    for (let i = 0; i < batch.length; i++) {
      try {
        batch[i]();
      } catch (err) {
        console.error('[scheduleRender] fn threw:', err);
      }
    }
  }

  function scheduleRender(fn) {
    if (typeof fn !== 'function') return;
    dirty.add(fn);
    if (!scheduled) {
      scheduled = true;
      rafId = RAF(flush);
    }
  }

  function flushRenders() {
    if (!scheduled) return;
    if (rafId) CAF(rafId);
    flush();
  }

  window.scheduleRender = scheduleRender;
  window.flushRenders = flushRenders;
})();
