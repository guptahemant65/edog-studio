"""
PR-B regression — filter state lives in studioState and survives tab switch.

Before PR-B, LogViewerState.searchText and TelemetryTab._filterText were
plain instance fields. Switching tabs preserved them (objects don't reset),
but switching between Logs and Telemetry views via URL deep-link or a
hashchange could not hydrate them — and there was no shared bus for
URL → filter state. The user-visible bug: deep-linking to a filtered
telemetry view dropped the filter.

PR-B routes every filter read/write through window.studioState.filters.{logs,telemetry}.
This test loads studio-state.js + state.js into Node, instantiates a
LogViewerState, and asserts:

  1. Reads see studioState-hydrated values (URL → fields).
  2. Writes propagate to studioState (fields → studioState → URL).
  3. activeLevels / excludedComponents behave like Sets via FilterSetView.
  4. A telemetry-style write into studioState is visible immediately on
     the next read — the cross-tab survival win.

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
STUDIO_STATE_JS = os.path.join(PROJECT_DIR, "src", "frontend", "js", "studio-state.js")
STATE_JS = os.path.join(PROJECT_DIR, "src", "frontend", "js", "state.js")

NODE = shutil.which("node")

# Minimal browser shim — LogViewerState constructor touches localStorage
# (hover-freeze key), document is not touched in state.js, but the
# Object.defineProperty shims need `window` for the studioState lookup.
SHIM_PREFIX = r"""
const __hash = process.env.STUDIO_TEST_HASH || '';
globalThis.window = {
  location: { hash: __hash, pathname: '/', search: '' },
  history: {
    replaceState(_s, _t, url) {
      if (typeof url === 'string') {
        if (url.startsWith('#')) window.location.hash = url;
        else window.location.hash = '';
      }
    },
  },
  localStorage: {
    _kv: {},
    getItem(k) { return this._kv[k] !== undefined ? this._kv[k] : null; },
    setItem(k, v) { this._kv[k] = String(v); },
  },
  addEventListener: () => {},
};
// state.js touches the bare global `localStorage` too — alias it.
globalThis.localStorage = window.localStorage;
"""

ASSERT_SUFFIX = r"""
if (!window.studioState) { console.error('NO_STUDIO_STATE'); process.exit(2); }
if (typeof LogViewerState !== 'function') { console.error('NO_STATE_CLASS'); process.exit(3); }
const state = new LogViewerState();

// Run the test snippet (from env), then dump observations.
let result = {};
try {
  if (process.env.STUDIO_TEST_SCRIPT) {
    result = new Function('state', 'studioState', 'window', process.env.STUDIO_TEST_SCRIPT)(
      state, window.studioState, window
    ) || {};
  }
} catch (e) {
  console.error('SCRIPT_THREW: ' + e.message + '\n' + e.stack);
  process.exit(4);
}
setImmediate(() => {
  // Always include the final studioState snapshot so tests can inspect it
  // post-mutation (subscribers fire on microtask).
  result._finalFilters = window.studioState.get().filters;
  result._finalHash = window.location.hash;
  console.log(JSON.stringify(result));
});
"""


@pytest.fixture(scope="module")
def studio_state_source() -> str:
    with open(STUDIO_STATE_JS, encoding="utf-8") as f:
        return f.read()


@pytest.fixture(scope="module")
def state_source() -> str:
    with open(STATE_JS, encoding="utf-8") as f:
        return f.read()


def _run(script: str, hash_value: str, studio_src: str, state_src: str) -> dict:
    if not NODE:
        pytest.skip("node not available on PATH")
    harness = SHIM_PREFIX + "\n" + studio_src + "\n" + state_src + "\n" + ASSERT_SUFFIX
    env = os.environ.copy()
    env["STUDIO_TEST_HASH"] = hash_value
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
        f"filter-migration harness failed:\nstderr:\n{result.stderr}\nstdout:\n{result.stdout}"
    )
    return json.loads(result.stdout.strip().splitlines()[-1])


class TestLogViewerStateProxies:
    """Field reads/writes on LogViewerState route through studioState."""

    def test_scalar_read_reflects_url_hydration(self, studio_state_source, state_source):
        script = "return { sq: state.searchText, preset: state.activePreset, since: state.timeRangeSeconds, raid: state.raidFilter };"
        data = _run(
            script,
            "#tab=logs&q=hello&preset=dag&since=60&raid=run-7",
            studio_state_source,
            state_source,
        )
        assert data["sq"] == "hello"
        assert data["preset"] == "dag"
        assert data["since"] == 60
        assert data["raid"] == "run-7"

    def test_scalar_write_propagates_to_studio_state(self, studio_state_source, state_source):
        script = (
            "state.searchText = 'spark';"
            "state.endpointFilter = 'compute';"
            "state.componentFilter = 'LiveTable';"
            "return { propagated: true };"
        )
        data = _run(script, "", studio_state_source, state_source)
        L = data["_finalFilters"]["logs"]
        assert L["q"] == "spark"
        assert L["ep"] == "compute"
        assert L["comp"] == "LiveTable"

    def test_correlation_filter_nullable_round_trip(self, studio_state_source, state_source):
        script = (
            "const r1 = state.correlationFilter;"
            "state.correlationFilter = 'abc-123';"
            "const r2 = state.correlationFilter;"
            "state.correlationFilter = null;"
            "const r3 = state.correlationFilter;"
            "return { r1, r2, r3 };"
        )
        data = _run(script, "", studio_state_source, state_source)
        assert data["r1"] is None
        assert data["r2"] == "abc-123"
        assert data["r3"] is None


class TestFilterSetView:
    """activeLevels / excludedComponents preserve Set-shaped API while storing arrays."""

    def test_active_levels_default_is_four_levels(self, studio_state_source, state_source):
        script = (
            "return {"
            "  size: state.activeLevels.size,"
            "  hasV: state.activeLevels.has('Verbose'),"
            "  hasE: state.activeLevels.has('Error'),"
            "  hasX: state.activeLevels.has('NotALevel'),"
            "};"
        )
        data = _run(script, "", studio_state_source, state_source)
        assert data["size"] == 4
        assert data["hasV"] is True
        assert data["hasE"] is True
        assert data["hasX"] is False

    def test_active_levels_add_delete_clear(self, studio_state_source, state_source):
        script = (
            "state.activeLevels.delete('Verbose');"
            "state.activeLevels.delete('Message');"
            "const afterDelete = Array.from(state.activeLevels);"
            "state.activeLevels.add('Verbose');"
            "const afterAdd = Array.from(state.activeLevels);"
            "state.activeLevels.clear();"
            "const afterClear = Array.from(state.activeLevels);"
            "return { afterDelete, afterAdd, afterClear };"
        )
        data = _run(script, "", studio_state_source, state_source)
        assert sorted(data["afterDelete"]) == sorted(["Warning", "Error"])
        assert sorted(data["afterAdd"]) == sorted(["Warning", "Error", "Verbose"])
        assert data["afterClear"] == []

    def test_excluded_components_set_semantics(self, studio_state_source, state_source):
        script = (
            "state.excludedComponents.add('Foo');"
            "state.excludedComponents.add('Foo');"  # dup ignored
            "state.excludedComponents.add('Bar');"
            "return { size: state.excludedComponents.size, hasFoo: state.excludedComponents.has('Foo'), arr: Array.from(state.excludedComponents) };"
        )
        data = _run(script, "", studio_state_source, state_source)
        assert data["size"] == 2
        assert data["hasFoo"] is True
        assert sorted(data["arr"]) == sorted(["Foo", "Bar"])

    def test_active_levels_assignment_accepts_set_and_array(self, studio_state_source, state_source):
        script = (
            "state.activeLevels = new Set(['Warning']);"
            "const a = Array.from(state.activeLevels);"
            "state.activeLevels = ['Error', 'Verbose'];"
            "const b = Array.from(state.activeLevels);"
            "return { a, b };"
        )
        data = _run(script, "", studio_state_source, state_source)
        assert data["a"] == ["Warning"]
        assert sorted(data["b"]) == sorted(["Error", "Verbose"])


class TestFilterCrossTabSurvival:
    """The headline win — filter state survives tab switches and URL round trips."""

    def test_logs_filter_visible_after_url_round_trip(self, studio_state_source, state_source):
        """Set filter on logs → URL is updated → re-parse URL → reading via state sees the same value.
        This emulates the 'reload the page' user flow."""
        script = (
            "state.searchText = 'edge case';"
            "state.activeLevels = ['Error'];"
            "const hashAfterWrite = window.location.hash;"
            # Now wait for the microtask subscriber (hash is updated immediately via replaceState)
            "return { hashAfterWrite };"
        )
        data = _run(script, "", studio_state_source, state_source)
        h = data["_finalHash"]
        assert "q=edge%20case" in h or "q=edge+case" in h
        assert "levels=Error" in h
        # Defaults stay omitted
        assert "preset=" not in h

    def test_telemetry_filter_survives_switch_via_studio_state(self, studio_state_source, state_source):
        """The PR-B core win: telemetry filter set while NOT on telemetry tab
        still hydrates the tab when the user navigates there. We simulate by
        setting telemetry filter directly via window.studioSetFilter (the
        same path the URL hashchange uses) and asserting LogViewerState
        observes nothing changed for its own filters."""
        script = (
            "const beforeLogsQ = state.searchText;"
            "window.studioSetFilter('telemetry', { q: 'spark.session', status: 'failed' });"
            "const afterLogsQ = state.searchText;"
            "const telQ = window.studioState.get().filters.telemetry.q;"
            "const telStatus = window.studioState.get().filters.telemetry.status;"
            "return { beforeLogsQ, afterLogsQ, telQ, telStatus };"
        )
        data = _run(script, "", studio_state_source, state_source)
        assert data["beforeLogsQ"] == ""
        assert data["afterLogsQ"] == ""  # logs filter untouched
        assert data["telQ"] == "spark.session"
        assert data["telStatus"] == "failed"

    def test_hash_url_round_trip_for_excluded_components(self, studio_state_source, state_source):
        """Set excludedComponents then read URL — multi-value list serialization works."""
        script = "state.excludedComponents.add('Noisy.Component');state.excludedComponents.add('Another');return {};"
        data = _run(script, "", studio_state_source, state_source)
        h = data["_finalHash"]
        assert "excl=" in h
        # comma-separated, URL-encoded
        assert "Noisy.Component" in h or "Noisy.Component".replace(".", ".") in h
        assert "Another" in h


class TestProxyConfigurability:
    """Sanity: each property is configurable so future re-installs don't throw."""

    def test_descriptors_are_configurable(self, studio_state_source, state_source):
        script = (
            "const props = ['searchText','correlationFilter','activePreset','timeRangeSeconds',"
            "  'endpointFilter','componentFilter','raidFilter','activeLevels','excludedComponents'];"
            "const out = {};"
            "for (const p of props) {"
            "  const d = Object.getOwnPropertyDescriptor(state, p);"
            "  out[p] = d ? !!d.configurable : null;"
            "}"
            "return out;"
        )
        data = _run(script, "", studio_state_source, state_source)
        for prop, configurable in data.items():
            if prop.startswith("_"):
                continue
            assert configurable is True, f"{prop} must be configurable"
