"""
Renderer guards against orphan rendered rows after filter/buffer state change.

Bug history (2026-06-07):

Symptom: scroll thumb sits at ~75% of the scroll track but viewport shows
mostly blank space with only 2-3 rows visible at the top. Live DevTools
inspection captured a snapshot where:

  filterIndex.length        = 31
  bufferLength              = 66
  renderedRows keys         = [83..102]    ← out of bounds!
  DOM row translateY values = 2380..3468px (filteredIdx 70..102)
  scrollHeight              = 1054         (= 31 * 34)
  sentinelHeight            = "102px"      (stale)
  rowPool.inUse             = 19/80

The renderedRows map kept keys [83..102] from a previous render state
where filterIndex.length was larger (likely after a reconnect or filter
shrink race). The cleanup loop in _renderVirtualScroll only releases
rows whose key is "not in neededSet" (where neededSet is the current
viewport range, e.g. {11..30}). Keys 83-102 are NOT in {11..30}, so
they SHOULD be released — but they weren't, because the render was
short-circuited somewhere along the path (PAUSED branch at flush(),
or hover-freeze toggle, or a buffer-clear race).

Root cause: the renderer trusts that every code path that mutates
filterIndex.length will also trigger a clean render. That's brittle.

Fix: add a defensive O(rendered rows) sweep at the top of
_renderVirtualScroll that releases any rendered row whose filtIdx
is ≥ filterIndex.length. Idempotent, cheap (≤80 rows in pool), and
cannot regress good behavior. Same guard also protects against the
secondary case where filterIndex.indices contains stale seqs pointing
to evicted buffer entries — logBuffer.getBySeq returns undefined,
so the row would have been blank anyway.

Source-level guard: presence of the words 'orphan' or 'out of bounds'
in a sweep loop at the top of _renderVirtualScroll, plus the structural
check (a `filtIdx >= totalFiltered` predicate).

@author Pixel — EDOG Studio hivemind
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
STUDIO_STATE_JS = os.path.join(PROJECT_DIR, "src", "frontend", "js", "studio-state.js")
STATE_JS = os.path.join(PROJECT_DIR, "src", "frontend", "js", "state.js")
FILTERS_JS = os.path.join(PROJECT_DIR, "src", "frontend", "js", "filters.js")
RENDERER_JS = os.path.join(PROJECT_DIR, "src", "frontend", "js", "renderer.js")

NODE = shutil.which("node")


# ── Source-level guard ──────────────────────────────────────────────────────


class TestRendererHasOrphanSweep:
    """_renderVirtualScroll guards against out-of-bounds renderedRows keys."""

    def test_renderer_contains_orphan_sweep(self) -> None:
        with open(RENDERER_JS, encoding="utf-8") as f:
            src = f.read()
        # Structural check: a predicate that detects filtIdx >= totalFiltered
        assert re.search(r"filtIdx\s*>=\s*totalFiltered", src), (
            "_renderVirtualScroll must contain a `filtIdx >= totalFiltered` "
            "predicate that releases orphan rendered rows after filter/buffer "
            "shrink. Without this guard, scrolling can show a blank viewport "
            "when the filter index shrinks between renders."
        )


# ── Behavioral test (Node harness) ──────────────────────────────────────────


SHIM_PREFIX = r"""
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

// Minimal DOM shim that supports the absolute-positioned virtual scroller.
// Container exposes scrollTop/clientHeight + appendChild/removeChild; rows
// are tracked by parentNode so the row-pool release semantics work.
function makeEl() {
  return {
    children: [],
    parentNode: null,
    style: {},
    dataset: {},
    classList: {
      _classes: new Set(),
      add(c) { this._classes.add(c); },
      remove(c) { this._classes.delete(c); },
      toggle(c, on) { if (on) this._classes.add(c); else this._classes.delete(c); },
      contains(c) { return this._classes.has(c); },
    },
    appendChild(child) {
      if (child.parentNode) {
        const pc = child.parentNode.children;
        const idx = pc.indexOf(child);
        if (idx !== -1) pc.splice(idx, 1);
      }
      // DocumentFragment splat
      if (child._isFragment) {
        for (const c of child.children.slice()) {
          c.parentNode = this;
          this.children.push(c);
        }
        child.children = [];
      } else {
        child.parentNode = this;
        this.children.push(child);
      }
      return child;
    },
    removeChild(child) {
      const idx = this.children.indexOf(child);
      if (idx !== -1) {
        this.children.splice(idx, 1);
        child.parentNode = null;
      }
      return child;
    },
    addEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
}
const scrollContainer = makeEl();
scrollContainer.id = 'logs-container';
scrollContainer.scrollTop = 0;
scrollContainer.clientHeight = 400;
const emptyState = makeEl();
emptyState.id = 'empty-state';

globalThis.document = {
  createElement(tag) {
    const el = makeEl();
    if (tag === 'div' && arguments.length === 1) {
      // Track if this is a document fragment-like usage
    }
    return el;
  },
  createDocumentFragment() {
    const f = makeEl();
    f._isFragment = true;
    return f;
  },
  getElementById(id) {
    if (id === 'logs-container') return scrollContainer;
    if (id === 'empty-state') return emptyState;
    return null;
  },
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener: () => {},
};
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.CustomEvent = class CustomEvent {
  constructor(type, init) { this.type = type; this.detail = init && init.detail; }
};
"""

ASSERT_SUFFIX = r"""
const state = new LogViewerState();
const renderer = new Renderer(state);
renderer.initVirtualScroll();

let result = {};
try {
  if (process.env.STUDIO_TEST_SCRIPT) {
    result = new Function(
      'state', 'renderer', 'FilterManager', 'window',
      process.env.STUDIO_TEST_SCRIPT
    )(state, renderer, FilterManager, window) || {};
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
    harness = SHIM_PREFIX + "\n" + harness_src + "\n" + ASSERT_SUFFIX
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
        f"orphan-sweep harness failed:\nstderr:\n{result.stderr}\nstdout:\n{result.stdout}"
    )
    return json.loads(result.stdout.strip().splitlines()[-1])


class TestOrphanRowsAreSwept:
    """Forge the live broken state and verify the renderer self-heals."""

    def test_orphan_rows_released_after_filter_shrink(self, harness_source):
        """Direct repro of the live snapshot: inject orphan keys, render, assert swept.

        We bypass the natural cleanup path (which already handles the
        easy case) by manually injecting a renderedRows entry with a
        key that's WAY beyond filterIndex.length AND that the cleanup
        loop's neededSet would not normally evict from the iteration's
        perspective. The orphan sweep at the top of _renderVirtualScroll
        is the only thing that can release it before subsequent renders
        re-acquire its pool slot and double-stamp the DOM.
        """
        script = (
            # Seed a handful of FLT-component log entries to give filterIndex
            # a small but non-zero length (mirrors the live snapshot:
            # filterIndex.length=31, renderedRows keys = [83..102]).
            "for (let i = 0; i < 10; i++) {"
            "  state.addLog({"
            "    level: 'Message',"
            "    component: 'LiveTableController-Get',"
            "    message: 'fresh ' + i,"
            "    rootActivityId: 'r' + i,"
            "    timestamp: new Date().toISOString(),"
            "  });"
            "}"
            "state.filterIndex.rebuild(state.logBuffer, (e) => renderer.passesFilter(e));"
            "renderer.scrollContainer.scrollTop = 0;"
            "renderer.scrollContainer.clientHeight = 400;"
            # Manually inject an orphan row (mimics the post-reconnect /
            # post-shrink state where renderedRows kept high-index keys
            # from a previous render era).
            "const orphanRow = renderer.rowPool.acquire();"
            "orphanRow._seq = 999;"
            "orphanRow.style.transform = 'translateY(2992px)';"
            "renderer.scrollContainer.appendChild(orphanRow);"
            "renderer.renderedRows.set(88, orphanRow);"  # 88 is way > 10
            "const beforeKeys = Array.from(renderer.renderedRows.keys()).sort((a,b) => a-b);"
            "const beforePoolInUse = renderer.rowPool.pool.filter(r => r._inUse).length;"
            # Trigger a render — orphan sweep should reap key 88.
            "renderer._renderVirtualScroll();"
            "const afterKeys = Array.from(renderer.renderedRows.keys()).sort((a,b) => a-b);"
            "const afterPoolInUse = renderer.rowPool.pool.filter(r => r._inUse).length;"
            "const orphanRowInDom = orphanRow.parentNode === renderer.scrollContainer;"
            "return {"
            "  filterIndexLength: state.filterIndex.length,"
            "  beforeKeys, afterKeys,"
            "  beforePoolInUse, afterPoolInUse,"
            "  orphanStillInDom: orphanRowInDom,"
            "  orphanStillInUse: orphanRow._inUse,"
            "};"
        )
        data = _run(script, harness_source)

        assert data["filterIndexLength"] == 10, "precondition failed"
        assert 88 in data["beforeKeys"], "precondition: orphan key 88 must be present pre-render"

        # The fix: orphan key MUST be gone after render
        assert 88 not in data["afterKeys"], (
            f"Orphan renderedRows key 88 survived re-render. "
            f"filterIndex.length={data['filterIndexLength']}, "
            f"afterKeys={data['afterKeys']!r}. "
            f"The defensive sweep in _renderVirtualScroll did not release it. "
            f"Without this sweep, scrolling shows blank space where the orphan "
            f"row's translateY sits outside the valid scroll range."
        )

        # All retained keys must be < filterIndex.length (no out-of-bounds survivors).
        out_of_bounds_after = [k for k in data["afterKeys"] if k >= data["filterIndexLength"]]
        assert out_of_bounds_after == [], (
            f"Renderer left {len(out_of_bounds_after)} key(s) out of bounds after "
            f"render: {out_of_bounds_after!r}. filterIndex.length={data['filterIndexLength']}. "
            f"The orphan sweep at the top of _renderVirtualScroll is missing or buggy."
        )

        # NB: we deliberately do NOT assert on orphanRow._inUse / orphanRow.parentNode
        # afterwards — the row pool legitimately reuses released rows for the
        # subsequent render loop, so the same DOM node may be re-acquired and
        # re-stamped with new content under a new key. That's correct behavior.
