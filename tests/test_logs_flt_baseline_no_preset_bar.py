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
  2. **JS surface**: filters.js exposes no applyPreset method and no
     ALL/DAG/Spark preset entries.
  3. **Behavioral**: passesFilter does NOT apply a frontend component
     allowlist. Noise filtering is owned by the backend
     (edog-blocklist.json + EdogLogInterceptor); the frontend shows every
     log the backend forwarded, minus the user's explicit pill exclusions.

SUPERSEDED NOTE (P0, 2026-06-10): the original item 3 asserted that
passesFilter ALWAYS applied an FLT include-ALLOWLIST and rejected non-FLT
components. That allowlist was itself a bug — it re-dropped genuine FLT logs
and real platform Errors/Warnings that the backend deliberately forwarded
(the backend had already migrated allowlist->blocklist for this exact
reason). The behavioral assertions below are therefore inverted, and the
COMPONENT_PRESETS constant was removed. The preset-bar / applyPreset removal
from #3 still stands. See tests/test_logs_flt_backend_owns_filtering.py for
the full P0 contract + mutation guard.

The source-level guards mutation-test themselves — re-introducing any
``data-preset="all|dag|spark"`` attribute or an applyPreset method will fail
this test.

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

    def test_no_legacy_presets(self):
        """No ALL/DAG/Spark preset definitions remain.

        #3 removed the preset BAR. P0 (2026-06-10) additionally removed the
        FLT include-allowlist constant (COMPONENT_PRESETS) entirely — the
        backend owns noise filtering now. So filters.js must define none of the
        legacy preset keys, and need not define ``flt`` either.
        """
        with open(FILTERS_JS, encoding="utf-8") as f:
            src = f.read()
        for forbidden_key in ("    all:", "    dag:", "    spark:"):
            assert forbidden_key not in src, (
                f"filters.js still defines a {forbidden_key.strip()} preset entry. "
                f"Legacy presets must not return. See #3 / P0."
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
    """P0 (2026-06-10) inverted contract: the frontend applies NO component
    allowlist. Every log the backend forwards is shown unless the user has
    explicitly excluded its component via a pill. Backend (edog-blocklist.json)
    is the single source of truth for noise suppression — see
    test_logs_flt_backend_owns_filtering.py for the canonical P0 contract.
    """

    @pytest.mark.parametrize(
        "component",
        [
            # These six are still suppressed — but server-side, via
            # edog-blocklist.json, NOT by a frontend allowlist. At the
            # passesFilter layer (post-forward) they now PASS: the frontend
            # must not second-guess the backend's forwarding decision.
            "IncomingRequest",
            "WorkloadInitialization",
            "PbiClientRequest",
            "FabricAccessContext-WorkloadClientRequest",
            "MwcAccessInfoProvider-GetTargetAudienceS2SAccessTokenAsync",
            "OrchestratorControllerProxy-GenerateMwcToken",
        ],
    )
    def test_forwarded_component_passes_frontend(self, harness_source, component):
        script = (
            f"const entry = {{ level: 'Message', "
            f"  component: '{component}',"
            f"  message: 'noise',"
            f"  rootActivityId: 'r1',"
            f"  timestamp: new Date().toISOString() }};"
            f"return {{ passes: renderer.passesFilter(entry) }};"
        )
        data = _run(script, harness_source)
        assert data["passes"] is True, (
            f"Component {component!r} reached the frontend, so the backend chose "
            f"to forward it. passesFilter must NOT re-drop it — the frontend "
            f"allowlist was removed in P0. Noise is suppressed server-side."
        )

    @pytest.mark.parametrize(
        "component",
        [
            # Genuine FLT components — must pass (always did).
            "LiveTableController-Get",
            "LiveTableSchedulerRunController-MVRefresh",
            "DagExecution",
            "NodeExecution",
            "OneLakeRestClient",
            "DqMetrics",
            "Insights",
            # P0a: genuine FLT components the OLD allowlist missed — now pass.
            "MetastoreClient",
            "DeltaLogReader",
            # P0b: a real platform Error that the old allowlist hid — now passes.
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
            f"Component {component!r} must pass — the frontend applies no allowlist."
        )

    def test_user_excluded_component_still_drops(self, harness_source):
        """The one frontend drop that remains: explicit user pill exclusion."""
        script = (
            "state.excludedComponents.add('NodeExecution');"
            "const entry = { level: 'Message', component: 'NodeExecution',"
            "  message: 'signal', rootActivityId: 'r1',"
            "  timestamp: new Date().toISOString() };"
            "return { passes: renderer.passesFilter(entry) };"
        )
        data = _run(script, harness_source)
        assert data["passes"] is False, (
            "An explicitly excluded component must still be dropped by passesFilter."
        )
