"""
#3 — FLT is the implicit baseline; no preset bar; no ALL/DAG/Spark.

Bug history:

The Logs tab toolbar shipped with four preset buttons: ALL / FLT / DAG /
Spark. Each rewrote ``state.excludedComponents`` based on regex patterns.
ALL meant "exclude nothing" → the user drowned in WCL middleware noise
(IncomingRequest, FeatureFlightProvider, WorkloadInitialization, AppInsights
"Failed to create metric" warnings). The per-log handler in main.js does
heavy work per envelope (autoDetector + anomaly + errorIntel + errorTimeline
+ extractors + cluster refresh), so ALL also overloaded the main thread.

Hemant decision (2026-06-07): "only FLT is enough. drop DAG and Spark too".
The preset bar is removed entirely. FLT becomes the always-applied baseline
— not a clickable mode. Manual escape valves remain: the component
dropdown and pill-click-to-exclude still let users narrow within FLT.

This test asserts the contract at three levels:

  1. **DOM**: index.html has no .preset-bar div and no data-preset
     attributes.
  2. **JS surface**: filters.js exposes no applyPreset method and
     COMPONENT_PRESETS contains only the ``flt`` entry.
  3. **Behavioral**: passesFilter always applies the FLT include filter
     regardless of any state field. A non-FLT component is rejected;
     an FLT-relevant component passes.

The source-level guards mutation-test themselves — re-introducing any
``data-preset="all|dag|spark"`` attribute or restoring ALL/DAG/Spark
entries to COMPONENT_PRESETS will fail this test.

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
INDEX_HTML = os.path.join(PROJECT_DIR, "src", "frontend", "index.html")
FILTERS_JS = os.path.join(PROJECT_DIR, "src", "frontend", "js", "filters.js")
RENDERER_JS = os.path.join(PROJECT_DIR, "src", "frontend", "js", "renderer.js")
STUDIO_STATE_JS = os.path.join(PROJECT_DIR, "src", "frontend", "js", "studio-state.js")
STATE_JS = os.path.join(PROJECT_DIR, "src", "frontend", "js", "state.js")

NODE = shutil.which("node")


# ── 1. DOM source guard ─────────────────────────────────────────────────────


class TestPresetBarRemoved:
    """index.html no longer ships the preset bar or any data-preset hooks."""

    def test_no_preset_bar_div(self):
        with open(INDEX_HTML, encoding="utf-8") as f:
            src = f.read()
        assert 'class="preset-bar"' not in src, (
            "index.html still contains a .preset-bar div. The preset bar was "
            "removed; FLT is now an implicit baseline. See #3."
        )

    def test_no_data_preset_attributes(self):
        with open(INDEX_HTML, encoding="utf-8") as f:
            src = f.read()
        for token in ('data-preset="all"', 'data-preset="dag"', 'data-preset="spark"'):
            assert token not in src, (
                f"index.html still has {token!r}. ALL/DAG/Spark preset buttons "
                f"have been removed. See #3."
            )


# ── 2. JS surface guard ─────────────────────────────────────────────────────


class TestFiltersJsSurface:
    """filters.js no longer exposes applyPreset or ALL/DAG/Spark presets."""

    def test_no_apply_preset_method(self):
        with open(FILTERS_JS, encoding="utf-8") as f:
            src = f.read()
        # applyPreset is removed entirely. Its callers (preset buttons,
        # clearAll, etc.) have been rewired.
        assert "applyPreset = (" not in src and "applyPreset(presetName)" not in src, (
            "filters.js still defines applyPreset. With the preset bar gone, "
            "applyPreset has no callers and must be removed."
        )

    def test_component_presets_has_only_flt(self):
        """COMPONENT_PRESETS.flt is kept (renderer reads it); the others are gone."""
        with open(FILTERS_JS, encoding="utf-8") as f:
            src = f.read()
        # FLT is the baseline include set, retained as a constant.
        assert "flt:" in src, "FLT include patterns must remain available for renderer"
        # ALL/DAG/Spark keys at the start of an indented line are the canonical
        # preset definitions. Bare key matches at non-comment column positions
        # would catch a future re-introduction.
        for forbidden_key in ("    all:", "    dag:", "    spark:"):
            assert forbidden_key not in src, (
                f"filters.js still defines a {forbidden_key.strip()} preset entry. "
                f"Only flt is allowed. See #3."
            )


# ── 3. Behavioral test — passesFilter always applies FLT baseline ──────────


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

let result = {};
try {
  if (process.env.STUDIO_TEST_SCRIPT) {
    result = new Function('state', 'renderer', 'FilterManager', 'window',
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
            [NODE, path], capture_output=True, text=True, timeout=15, env=env,
        )
    finally:
        with contextlib.suppress(OSError):
            os.unlink(path)
    assert result.returncode == 0, (
        f"preset-removal harness failed:\nstderr:\n{result.stderr}\nstdout:\n{result.stdout}"
    )
    return json.loads(result.stdout.strip().splitlines()[-1])


class TestFltBaselineAlwaysOn:
    """Regardless of any state field, only FLT-relevant components pass."""

    @pytest.mark.parametrize(
        "component",
        [
            # Top FLT noise emitters per lifecycle doc §7.6 — these are
            # NOT in the FLT include set and MUST be filtered out.
            "IncomingRequest",
            "WorkloadInitialization",
            "PbiClientRequest",
            "FabricAccessContext-WorkloadClientRequest",
            "MwcAccessInfoProvider-GetTargetAudienceS2SAccessTokenAsync",
            "OrchestratorControllerProxy-GenerateMwcToken",
        ],
    )
    def test_non_flt_component_is_filtered_out(self, harness_source, component):
        script = (
            f"const entry = {{ level: 'Message', "
            f"  component: '{component}',"
            f"  message: 'noise',"
            f"  rootActivityId: 'r1',"
            f"  timestamp: new Date().toISOString() }};"
            f"return {{ passes: renderer.passesFilter(entry) }};"
        )
        data = _run(script, harness_source)
        assert data["passes"] is False, (
            f"Component {component!r} is not in the FLT include set and must be "
            f"filtered out unconditionally. If this fails, the FLT baseline is "
            f"not being applied."
        )

    @pytest.mark.parametrize(
        "component",
        [
            # FLT include-set hits — these MUST pass.
            "LiveTableController-Get",
            "LiveTableSchedulerRunController-MVRefresh",
            "DagExecution",
            "NodeExecution",
            "OneLakeRestClient",
            "DqMetrics",
            "Insights",
        ],
    )
    def test_flt_component_passes(self, harness_source, component):
        script = (
            f"const entry = {{ level: 'Message', "
            f"  component: '{component}',"
            f"  message: 'signal',"
            f"  rootActivityId: 'r1',"
            f"  timestamp: new Date().toISOString() }};"
            f"return {{ passes: renderer.passesFilter(entry) }};"
        )
        data = _run(script, harness_source)
        assert data["passes"] is True, (
            f"Component {component!r} is in the FLT include set and must pass."
        )
