"""
PR-A regression — studioState must survive malformed URL hash on boot.

Every JS module is concatenated into one <script> by build-html.py. An
uncaught throw in studio-state.js's IIFE (e.g. decodeURIComponent on a
truncated percent-encoding like '#tab=%E0%A4%A') would terminate the
entire script tag — state.js, runtime-view.js, main.js, and 70+ other
modules never execute. Result: white screen, no tabs, no console.

This test spawns Node with a minimal browser-globals shim, loads
studio-state.js with a malformed hash, and asserts the IIFE completes
cleanly with `activeTab === 'logs'`.

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

NODE = shutil.which("node")

# Minimal browser-globals shim — covers what studio-state.js touches at boot:
# window.{location,history,localStorage,addEventListener}, queueMicrotask
# (Node ≥11 provides this natively).
SHIM_PREFIX = r"""
const __hash = process.env.STUDIO_TEST_HASH || '';
const window = {
  location: {
    hash: __hash,
    pathname: '/',
    search: '',
  },
  history: {
    replaceState(_state, _title, url) {
      // Mirror real browser: url that starts with '#' replaces only the hash;
      // anything else is treated as a full path (we then clear the hash).
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
"""

SHIM_SUFFIX = r"""
if (!window.studioState) { console.error('NO_STUDIO_STATE'); process.exit(2); }
const s = window.studioState.get();
const out = {
  activeTab: s.activeTab,
  filters: s.filters || null,
  // expose setFilter availability for round-trip tests
  hasSetFilter: typeof window.studioSetFilter === 'function',
};
// Allow tests to nudge state then re-emit, via STUDIO_TEST_AFTER env hook.
if (process.env.STUDIO_TEST_AFTER) {
  try {
    // Eval the AFTER script with window in scope; it can mutate via
    // window.studioSetFilter and read window.location.hash for serialization.
    new Function('window', process.env.STUDIO_TEST_AFTER)(window);
    // queueMicrotask runs the persistence subscriber synchronously after this
    // tick in Node — flush by awaiting a setImmediate.
    setImmediate(() => {
      const s2 = window.studioState.get();
      out.afterTab = s2.activeTab;
      out.afterFilters = s2.filters || null;
      out.afterHash = window.location.hash;
      console.log(JSON.stringify(out));
    });
  } catch (e) {
    console.error('AFTER_SCRIPT_THREW: ' + e.message);
    process.exit(3);
  }
} else {
  console.log(JSON.stringify(out));
}
"""


@pytest.fixture(scope="module")
def studio_state_source() -> str:
    with open(STUDIO_STATE_JS, encoding="utf-8") as f:
        return f.read()


def _run_node(source: str, hash_value: str, env_extra: dict | None = None) -> dict:
    """Run studio-state.js under Node with the given location.hash, return parsed JSON."""
    if not NODE:
        pytest.skip("node not available on PATH")
    harness = SHIM_PREFIX + "\n" + source + "\n" + SHIM_SUFFIX
    env = os.environ.copy()
    env["STUDIO_TEST_HASH"] = hash_value
    if env_extra:
        env.update(env_extra)
    # Temp file instead of `node -e`: Windows CreateProcess caps the command
    # line at ~32 KB; once studio-state.js grew with PR-B's filter URL parser
    # the `-e` form would throw "WinError 206" on Windows. POSIX-equivalent.
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
        f"studio-state.js IIFE threw at boot (this would white-screen the app):\n"
        f"stderr:\n{result.stderr}\nstdout:\n{result.stdout}"
    )
    return json.loads(result.stdout.strip().splitlines()[-1])


class TestStudioStateBootSafety:
    """Boot-time safety — IIFE must not throw on any URL hash."""

    @pytest.mark.parametrize(
        "bad_hash",
        [
            "#tab=%E0%A4%A",  # Truncated UTF-8 percent-encoding
            "#tab=%",  # Bare percent
            "#tab=%FF%FF%FF",  # Invalid UTF-8
            "#%ZZ=logs",  # Malformed key
            "#foo=bar&%XX=baz",  # Malformed pair past a non-match
        ],
    )
    def test_malformed_hash_does_not_throw(self, studio_state_source, bad_hash):
        """A malformed hash must fall back to the default tab, not crash."""
        data = _run_node(studio_state_source, bad_hash)
        assert data["activeTab"] == "logs", (
            f"Expected fallback to 'logs' on malformed hash {bad_hash!r}, got {data['activeTab']!r}"
        )

    def test_well_formed_hash_round_trips(self, studio_state_source):
        """Sanity: a valid hash IS honored (proves the test harness isn't masking bugs)."""
        data = _run_node(studio_state_source, "#tab=spark")
        assert data["activeTab"] == "spark"

    def test_no_hash_falls_through_to_default(self, studio_state_source):
        """No hash + no localStorage seed → 'logs'."""
        data = _run_node(studio_state_source, "")
        assert data["activeTab"] == "logs"


class TestPrBFilterStore:
    """PR-B — filters.{logs,telemetry} schema, URL parse, defaults, set helper."""

    def test_default_filters_present_when_no_hash(self, studio_state_source):
        data = _run_node(studio_state_source, "")
        f = data["filters"]
        assert f is not None and "logs" in f and "telemetry" in f
        # Logs defaults
        assert f["logs"]["q"] == ""
        assert f["logs"]["preset"] == "flt"
        assert f["logs"]["since"] == 0
        assert f["logs"]["corr"] is None
        assert f["logs"]["ep"] == "" and f["logs"]["comp"] == "" and f["logs"]["raid"] == ""
        assert sorted(f["logs"]["levels"]) == sorted(["Verbose", "Message", "Warning", "Error"])
        assert f["logs"]["excl"] == []
        # Telemetry defaults
        assert f["telemetry"]["q"] == ""
        assert f["telemetry"]["status"] == "all"
        assert f["telemetry"]["dmin"] == 0
        assert f["telemetry"]["dmax"] == 5000

    def test_logs_filter_url_hydrates(self, studio_state_source):
        """#tab=logs&q=error&levels=Warning,Error&preset=dag&since=15&corr=abc → state."""
        data = _run_node(
            studio_state_source,
            "#tab=logs&q=error&levels=Warning,Error&preset=dag&since=15&corr=abc&excl=Foo,Bar&ep=spark&comp=Live&raid=run-1",
        )
        assert data["activeTab"] == "logs"
        L = data["filters"]["logs"]
        assert L["q"] == "error"
        assert sorted(L["levels"]) == sorted(["Warning", "Error"])
        assert L["preset"] == "dag"
        assert L["since"] == 15
        assert L["corr"] == "abc"
        assert sorted(L["excl"]) == sorted(["Foo", "Bar"])
        assert L["ep"] == "spark" and L["comp"] == "Live" and L["raid"] == "run-1"

    def test_telemetry_filter_url_hydrates(self, studio_state_source):
        """#tab=telemetry&tq=foo&tstatus=failed&dmin=5&dmax=60 → state."""
        data = _run_node(
            studio_state_source,
            "#tab=telemetry&tq=foo&tstatus=failed&dmin=5&dmax=60",
        )
        assert data["activeTab"] == "telemetry"
        T = data["filters"]["telemetry"]
        assert T["q"] == "foo"
        assert T["status"] == "failed"
        assert T["dmin"] == 5
        assert T["dmax"] == 60

    def test_malformed_filter_url_does_not_throw(self, studio_state_source):
        """One bad filter must NOT brick the whole bundle (B1 lesson applied to filters)."""
        data = _run_node(
            studio_state_source,
            "#tab=logs&q=ok&dmin=notanumber&levels=%E0%A4%A,Error&since=NaN",
        )
        # App must boot
        assert data["activeTab"] == "logs"
        # Good fields survive
        assert data["filters"]["logs"]["q"] == "ok"
        # Bad single number → key omitted, default preserved by initial merge
        assert data["filters"]["telemetry"]["dmin"] == 0
        # Bad element inside an array → dropped, good elements survive
        assert data["filters"]["logs"]["levels"] == ["Error"]
        # NaN number → omitted, default preserved
        assert data["filters"]["logs"]["since"] == 0

    def test_setfilter_writes_back_to_url(self, studio_state_source):
        """window.studioSetFilter mutates state AND updates location.hash."""
        after = "window.studioSetFilter('logs', { q: 'spark error', since: 30 });"
        data = _run_node(studio_state_source, "", env_extra={"STUDIO_TEST_AFTER": after})
        assert data["afterFilters"]["logs"]["q"] == "spark error"
        assert data["afterFilters"]["logs"]["since"] == 30
        # Default tab + non-default filters appear in URL; defaults omitted.
        h = data["afterHash"]
        assert "tab=logs" in h
        assert "q=spark%20error" in h or "q=spark+error" in h or "q=spark%20error" in h
        assert "since=30" in h
        # Untouched defaults must NOT bloat the URL.
        assert "preset=" not in h  # default 'flt' omitted
        assert "levels=" not in h  # default all-4 omitted

    def test_telemetry_filter_change_uses_t_prefixed_url_keys(self, studio_state_source):
        after = "window.studioSetFilter('telemetry', { q: 'span', status: 'failed', dmin: 2 });"
        data = _run_node(studio_state_source, "", env_extra={"STUDIO_TEST_AFTER": after})
        h = data["afterHash"]
        assert "tq=span" in h
        assert "tstatus=failed" in h
        assert "dmin=2" in h
        # Default dmax=5000 must be omitted.
        assert "dmax=" not in h

    def test_setfilter_omits_defaults_on_round_trip(self, studio_state_source):
        """Clearing back to defaults produces a clean (or empty) URL."""
        after = (
            "window.studioSetFilter('logs', { q: 'temp' });"
            "window.studioSetFilter('logs', { q: '' });"  # back to default
        )
        data = _run_node(studio_state_source, "", env_extra={"STUDIO_TEST_AFTER": after})
        h = data["afterHash"]
        # q is back to default → must be omitted. activeTab still 'logs' (default) → may be omitted too.
        assert "q=" not in h


class TestPrBFilterShallowEqual:
    """Nested mutations must produce new top-level `filters` so subscribers fire."""

    def test_setfilter_replaces_filters_reference(self, studio_state_source):
        """The whole `filters` object must be a NEW reference after setFilter,
        otherwise shallowEqual short-circuits the notification and subscribers
        never run."""
        after = (
            "window.__before = window.studioState.get().filters;"
            "window.studioSetFilter('logs', { q: 'x' });"
            "window.__after = window.studioState.get().filters;"
            "window.__same = (window.__before === window.__after);"
            # Stash result somewhere the SHIM_SUFFIX dump can see.
            "window.studioSetFilter('logs', { __probe: window.__same });"
        )
        data = _run_node(studio_state_source, "", env_extra={"STUDIO_TEST_AFTER": after})
        # __probe gets stored verbatim under filters.logs
        assert data["afterFilters"]["logs"]["__probe"] is False, (
            "filters reference did not change after setFilter — shallowEqual will eat the notification"
        )
