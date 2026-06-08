"""
#2 — Search jumps to first match; Enter/Shift+Enter cycle matches.

Bug history:

Typing into the Logs search box debounced 300ms then rebuilt the filter
index. The renderer's auto-scroll mode pinned scrollTop to the BOTTOM of
the (now-shrunken) filtered view. The historical match the user actually
wanted was N rows above, off-screen. The user had to scroll up manually
to find what they searched for.

Three things missing:

  1. No "jump to first match" — search just filters and pins to bottom.
  2. No match navigation (next/previous).
  3. No auto-pause while searching — new logs continued to arrive and
     could push the viewport around.

This fix wires:

  * ``Renderer.navigateMatch('first'|'next'|'prev')`` — updates
    ``_currentSearchMatchIdx`` (bounded), invalidates highlight version
    so the next render re-applies the current-row class.
  * ``Renderer.scrollToFilteredIndex(idx)`` — centers the row at
    ``filterIndex[idx]`` in the viewport.
  * ``FilterManager.setSearch(text)`` — on non-empty search, pauses
    the stream with reason 'search' and navigates to first match.
    On empty search, resumes LIVE.
  * Keyboard: Enter / Shift+Enter / Esc on the search input.

This test asserts the navigation API contract. UI wiring is verified
by source-level guards (the keydown handler must exist).

@author Pixel — EDOG Studio hivemind
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
STUDIO_STATE_JS = os.path.join(PROJECT_DIR, "src", "frontend", "js", "studio-state.js")
STATE_JS = os.path.join(PROJECT_DIR, "src", "frontend", "js", "state.js")
FILTERS_JS = os.path.join(PROJECT_DIR, "src", "frontend", "js", "filters.js")
RENDERER_JS = os.path.join(PROJECT_DIR, "src", "frontend", "js", "renderer.js")
MAIN_JS = os.path.join(PROJECT_DIR, "src", "frontend", "js", "main.js")

NODE = shutil.which("node")


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
globalThis.document = {
  createElement: (_tag) => ({
    classList: { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false },
    style: {}, dataset: {},
    appendChild: (c) => c, addEventListener: () => {},
  }),
  getElementById: () => null,
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
const filter = new FilterManager(state, renderer);

// Seed the buffer with a known mix: some FLT entries with the term 'spark',
// some without. The order is the order in which logs would have arrived.
const FIXTURES = [
  { level: 'Message', component: 'LiveTableController-Get',           message: 'starting noop',                rootActivityId: 'r0' },
  { level: 'Message', component: 'LiveTableSchedulerRun-MVRefresh',   message: 'allocating spark session #1',  rootActivityId: 'r1' },
  { level: 'Message', component: 'NodeExecution',                     message: 'PUT statement to GTS',         rootActivityId: 'r2' },
  { level: 'Message', component: 'LiveTableSchedulerRun-MVRefresh',   message: 'spark session #1 ready',       rootActivityId: 'r3' },
  { level: 'Message', component: 'NodeExecution',                     message: 'status poll Running',          rootActivityId: 'r4' },
  { level: 'Message', component: 'LiveTableSchedulerRun-MVRefresh',   message: 'spark statement Succeeded',    rootActivityId: 'r5' },
];
for (const f of FIXTURES) {
  state.addLog(Object.assign({ timestamp: new Date().toISOString() }, f));
}
// Build the initial filter index so navigation has something to walk over.
state.filterIndex.rebuild(state.logBuffer, (e) => renderer.passesFilter(e));

let result = {};
try {
  if (process.env.STUDIO_TEST_SCRIPT) {
    result = new Function(
      'state', 'renderer', 'filter', 'FilterManager', 'window',
      process.env.STUDIO_TEST_SCRIPT
    )(state, renderer, filter, FilterManager, window) || {};
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
            [NODE, path], capture_output=True, text=True, timeout=15, env=env,
        )
    finally:
        with contextlib.suppress(OSError):
            os.unlink(path)
    assert result.returncode == 0, (
        f"search-nav harness failed:\nstderr:\n{result.stderr}\nstdout:\n{result.stdout}"
    )
    return json.loads(result.stdout.strip().splitlines()[-1])


# ── 1. Renderer navigation API ──────────────────────────────────────────────


class TestRendererNavigateMatch:
    """Renderer.navigateMatch advances/retreats within the search match set."""

    def test_navigate_first_lands_on_index_zero(self, harness_source):
        script = (
            "state.searchText = 'spark';"
            "state.filterIndex.rebuild(state.logBuffer, (e) => renderer.passesFilter(e));"
            "renderer.setSearchTerm('spark');"
            "renderer.navigateMatch('first');"
            "return { idx: renderer.getCurrentSearchMatchIdx(),"
            "         total: state.filterIndex.length };"
        )
        data = _run(script, harness_source)
        # 3 of 6 fixtures match 'spark' (rows 1, 3, 5).
        assert data["total"] == 3, "filter should retain 3 entries containing 'spark'"
        assert data["idx"] == 0, "navigate('first') must land on filterIndex position 0"

    def test_navigate_next_increments(self, harness_source):
        script = (
            "state.searchText = 'spark';"
            "state.filterIndex.rebuild(state.logBuffer, (e) => renderer.passesFilter(e));"
            "renderer.setSearchTerm('spark');"
            "renderer.navigateMatch('first');"
            "renderer.navigateMatch('next');"
            "return { idx: renderer.getCurrentSearchMatchIdx() };"
        )
        data = _run(script, harness_source)
        assert data["idx"] == 1, "navigate('next') from 0 must land on 1"

    def test_navigate_next_clamps_at_end(self, harness_source):
        script = (
            "state.searchText = 'spark';"
            "state.filterIndex.rebuild(state.logBuffer, (e) => renderer.passesFilter(e));"
            "renderer.setSearchTerm('spark');"
            "renderer.navigateMatch('first');"
            "renderer.navigateMatch('next');"
            "renderer.navigateMatch('next');"
            "renderer.navigateMatch('next');"  # would overshoot
            "return { idx: renderer.getCurrentSearchMatchIdx() };"
        )
        data = _run(script, harness_source)
        assert data["idx"] == 2, "navigate('next') must clamp at last filtered index"

    def test_navigate_prev_decrements_and_clamps(self, harness_source):
        script = (
            "state.searchText = 'spark';"
            "state.filterIndex.rebuild(state.logBuffer, (e) => renderer.passesFilter(e));"
            "renderer.setSearchTerm('spark');"
            "renderer.navigateMatch('first');"
            "renderer.navigateMatch('next');"
            "renderer.navigateMatch('prev');"
            "renderer.navigateMatch('prev');"  # would overshoot at 0
            "return { idx: renderer.getCurrentSearchMatchIdx() };"
        )
        data = _run(script, harness_source)
        assert data["idx"] == 0, "navigate('prev') must clamp at 0"

    def test_navigate_with_empty_filter_index_is_noop(self, harness_source):
        script = (
            "state.searchText = 'nothing_matches_xyz';"
            "state.filterIndex.rebuild(state.logBuffer, (e) => renderer.passesFilter(e));"
            "renderer.setSearchTerm('nothing_matches_xyz');"
            "renderer.navigateMatch('first');"
            "renderer.navigateMatch('next');"
            "return { idx: renderer.getCurrentSearchMatchIdx(),"
            "         total: state.filterIndex.length };"
        )
        data = _run(script, harness_source)
        assert data["total"] == 0
        assert data["idx"] == -1, "no matches → currentSearchMatchIdx stays at -1"


# ── 2. FilterManager.setSearch behavior ─────────────────────────────────────


class TestSetSearchAutoPauseAndNav:
    """setSearch pauses on non-empty, resumes on empty, navigates to first match."""

    def test_set_search_pauses_and_lands_on_first(self, harness_source):
        script = (
            "filter.setSearchImmediate('spark');"  # bypass debounce for test
            "return { mode: state.streamMode,"
            "         reason: state.pauseReason,"
            "         idx: renderer.getCurrentSearchMatchIdx(),"
            "         total: state.filterIndex.length };"
        )
        data = _run(script, harness_source)
        assert data["mode"] == "PAUSED", "non-empty search must pause the stream"
        assert data["reason"] == "search", "pauseReason must be 'search' after search-driven pause"
        assert data["total"] == 3
        assert data["idx"] == 0, "first match must be selected"

    def test_clear_search_resumes_and_clears_current(self, harness_source):
        script = (
            "filter.setSearchImmediate('spark');"
            "filter.setSearchImmediate('');"
            "return { mode: state.streamMode,"
            "         reason: state.pauseReason,"
            "         idx: renderer.getCurrentSearchMatchIdx() };"
        )
        data = _run(script, harness_source)
        assert data["mode"] == "LIVE", "clearing search must resume LIVE"
        assert data["reason"] is None
        assert data["idx"] == -1, "clearing search must drop the current match"


# ── 3. Source-level guards: keyboard wiring exists ──────────────────────────


class TestSearchKeyboardWiring:
    """main.js wires Enter / Shift+Enter / Esc on the search input."""

    def test_enter_keydown_handler_present(self):
        with open(MAIN_JS, encoding="utf-8") as f:
            src = f.read()
        # The wiring is a keydown listener on #search-input that switches on
        # event.key. Look for the structural marker.
        assert "search-input" in src, "search-input element must be wired in main.js"
        assert "keydown" in src.lower(), "keydown listener required for Enter/Shift+Enter/Esc"
        assert "Enter" in src, "Enter key handling required for match navigation"
        assert "Escape" in src or "'Esc'" in src or '"Esc"' in src, (
            "Escape key handling required to clear search"
        )
