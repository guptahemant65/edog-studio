"""
#5 — V/M/W/E level filter buttons respect the user's click verbatim.

Bug history (the thing this test guards against):

Prior to the fix, ``Renderer.passesFilter`` in ``src/frontend/js/renderer.js``
contained a Verbose-override block at lines 887-899:

    if (!this.state.activeLevels.has(level)) {
      // If Verbose is off but preset is FLT, still show Verbose from
      // included components
      if (level !== 'Verbose' || this.state.activePreset !== 'flt') return false;
      if (this.state.excludedComponents.has(component)) return false;
      const fltPreset = FilterManager.COMPONENT_PRESETS.flt;
      if (fltPreset.include && !fltPreset.include.some(p => p.test(component))) return false;
      // Falls through — this is a Verbose log from an FLT-relevant component
    }

In plain English: when the user clicked V off while on the FLT preset, the
override silently kept Verbose logs from FLT-relevant components visible.
Since the dominant Verbose noise *is* from FLT components, clicking V off
looked broken — the user's click had no visible effect.

The fix deletes the override. ``passesFilter`` now respects the user's
``activeLevels`` set verbatim:

    if (!this.state.activeLevels.has(level)) return false;

This test asserts two things:

  1. **Behavioral**: passesFilter returns False for a Verbose entry from an
     FLT-relevant component when V is off. (Pre-fix this returned True.)
     The test mutation-checks itself by also asserting V-on still returns
     True for the same entry.

  2. **Mutation guard (source-level)**: scans renderer.js for the override
     marker comment. Re-introducing the override block would re-introduce
     the bug; a source-level guard is the cheapest way to catch a future
     refactor or revert from silently undoing the fix.

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

NODE = shutil.which("node")


# Browser shim. Renderer's constructor instantiates RowPool(80), which calls
# document.createElement('div'/'span') eighty times. We stub document with a
# minimal createElement that returns a plain object with appendChild as a
# no-op so the constructor completes without a real DOM.
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
};
globalThis.localStorage = window.localStorage;
globalThis.document = {
  createElement: (_tag) => {
    return {
      classList: { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false },
      style: {},
      dataset: {},
      appendChild: (child) => child,
      addEventListener: () => {},
    };
  },
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
if (!window.studioState) { console.error('NO_STUDIO_STATE'); process.exit(2); }
if (typeof LogViewerState !== 'function') { console.error('NO_STATE_CLASS'); process.exit(3); }
if (typeof FilterManager !== 'function') { console.error('NO_FILTER_CLASS'); process.exit(4); }
if (typeof Renderer !== 'function') { console.error('NO_RENDERER_CLASS'); process.exit(5); }

const state = new LogViewerState();
const renderer = new Renderer(state);

let result = {};
try {
  if (process.env.STUDIO_TEST_SCRIPT) {
    result = new Function(
      'state', 'renderer', 'FilterManager', 'studioState', 'window',
      process.env.STUDIO_TEST_SCRIPT
    )(state, renderer, FilterManager, window.studioState, window) || {};
  }
} catch (e) {
  console.error('SCRIPT_THREW: ' + e.message + '\n' + e.stack);
  process.exit(6);
}
setImmediate(() => {
  console.log(JSON.stringify(result));
});
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
        f"level-filter harness failed:\nstderr:\n{result.stderr}\nstdout:\n{result.stdout}"
    )
    return json.loads(result.stdout.strip().splitlines()[-1])


# ── Fixture entries ─────────────────────────────────────────────────────────
# An FLT-relevant component is one that matches any regex in
# FilterManager.COMPONENT_PRESETS.flt.include — e.g. anything starting with
# 'LiveTable...'. The choice of 'LiveTableController-Get' is deliberate:
# it is the most prolific Verbose emitter in real DAG runs (see lifecycle
# doc §7.6 — IncomingRequest=454, LiveTableController-* dominates).
FLT_VERBOSE_ENTRY_SCRIPT = """
const entry = {
  level: 'Verbose',
  component: 'LiveTableController-Get',
  message: 'Sample verbose log from an FLT component',
  rootActivityId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  timestamp: new Date().toISOString(),
};
"""


# ── 1. Behavioral tests ─────────────────────────────────────────────────────


class TestLevelFilterRespectsUser:
    """V/M/W/E click toggles produce verbatim filter behavior."""

    def test_verbose_off_filters_out_flt_verbose_entry(self, harness_source):
        """The mutation test: V off + FLT-relevant component → must return False.

        Pre-fix: the override re-admitted this entry and returned True.
        Post-fix: this returns False because the user said "no Verbose".
        """
        script = (
            FLT_VERBOSE_ENTRY_SCRIPT
            + "state.activeLevels.delete('Verbose');"
            + "return { passes: renderer.passesFilter(entry), "
            + "         hasV: state.activeLevels.has('Verbose') };"
        )
        data = _run(script, harness_source)
        assert data["hasV"] is False, "precondition: V was supposed to be toggled off"
        assert data["passes"] is False, (
            "Verbose entry from an FLT-relevant component must NOT pass when V is off. "
            "If this fails, the Verbose-override block has been re-introduced at "
            "renderer.js:passesFilter."
        )

    def test_verbose_on_passes_flt_verbose_entry(self, harness_source):
        """Sanity: V on → Verbose still flows through. Catches over-restriction."""
        script = (
            FLT_VERBOSE_ENTRY_SCRIPT
            + "return { passes: renderer.passesFilter(entry), "
            + "         hasV: state.activeLevels.has('Verbose') };"
        )
        data = _run(script, harness_source)
        assert data["hasV"] is True, "precondition: V should default to on"
        assert data["passes"] is True, (
            "Verbose entry from an FLT-relevant component must pass when V is on."
        )

    @pytest.mark.parametrize(
        "level,letter",
        [("Message", "M"), ("Warning", "W"), ("Error", "E")],
    )
    def test_non_verbose_level_off_filters_out_entry(self, harness_source, level, letter):
        """M/W/E click toggles already worked. Lock that in as a regression guard."""
        script = (
            f"const entry = {{ level: '{level}', "
            f"  component: 'LiveTableController-Get',"
            f"  message: 'sample',"
            f"  rootActivityId: 'r1',"
            f"  timestamp: new Date().toISOString() }};"
            f"state.activeLevels.delete('{level}');"
            f"return {{ passes: renderer.passesFilter(entry), "
            f"          has_: state.activeLevels.has('{level}') }};"
        )
        data = _run(script, harness_source)
        assert data["has_"] is False
        assert data["passes"] is False, (
            f"{letter} button off must filter out {level} entries."
        )


# ── 2. Source-level mutation guard ──────────────────────────────────────────


class TestPassesFilterSourceGuard:
    """Source-level guard against accidental re-introduction of the override."""

    def test_renderer_source_has_no_verbose_override(self):
        """Reject any source pattern that looks like the old override."""
        with open(RENDERER_JS, encoding="utf-8") as f:
            src = f.read()

        # Marker phrases from the original override block. Any one of these
        # surviving in source means the override (or a near-copy) is back.
        forbidden_phrases = (
            "If Verbose is off but preset is FLT, still show Verbose",
            "Falls through \u2014 this is a Verbose log from an FLT-relevant component",
        )
        for phrase in forbidden_phrases:
            assert phrase not in src, (
                f"Found Verbose-override marker in renderer.js: {phrase!r}. "
                f"This override silently fought the user's V click. Delete it."
            )

        # Stricter structural check: the override pattern was
        #   if (level !== 'Verbose' || this.state.activePreset !== 'flt') return false;
        # If that exact predicate re-appears, the override is back regardless
        # of the comments.
        forbidden_predicate = (
            "level !== 'Verbose' || this.state.activePreset !== 'flt'"
        )
        assert forbidden_predicate not in src, (
            "Found the Verbose-override predicate in renderer.js. "
            "passesFilter must treat the level filter verbatim — delete the override."
        )
