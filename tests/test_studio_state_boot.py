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

import json
import os
import shutil
import subprocess

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
  location: { hash: __hash },
  history: { replaceState: () => {} },
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
const tab = window.studioState.get().activeTab;
console.log(JSON.stringify({ activeTab: tab }));
"""


@pytest.fixture(scope="module")
def studio_state_source() -> str:
    with open(STUDIO_STATE_JS, encoding="utf-8") as f:
        return f.read()


def _run_node(source: str, hash_value: str) -> dict:
    """Run studio-state.js under Node with the given location.hash, return parsed JSON."""
    if not NODE:
        pytest.skip("node not available on PATH")
    harness = SHIM_PREFIX + "\n" + source + "\n" + SHIM_SUFFIX
    env = os.environ.copy()
    env["STUDIO_TEST_HASH"] = hash_value
    result = subprocess.run(
        [NODE, "-e", harness],
        capture_output=True,
        text=True,
        timeout=15,
        env=env,
    )
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
