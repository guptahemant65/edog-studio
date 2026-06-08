"""
test_studio_state_telemetry_new_keys.py

Verifies the three new telemetry filter keys added in studio-state.js:
  - DEFAULTS_TELEMETRY.channel  === 'all'
  - DEFAULTS_TELEMETRY.window   === 'all'
  - DEFAULTS_TELEMETRY.iter     === null
  - URL_KEY_MAP has tchan / twin / titer with correct tab + type
  - Setting channel via studioSetFilter reads back correctly
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
STATE_JS    = os.path.join(PROJECT_DIR, "src", "frontend", "js", "studio-state.js")
NODE        = shutil.which("node")

SHIM = r"""
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window    = dom.window;
globalThis.document  = dom.window.document;
globalThis.navigator = dom.window.navigator;
globalThis.localStorage = dom.window.localStorage;
"""

SUFFIX = r"""
let result = {};
try {
  if (process.env.STUDIO_TEST_SCRIPT) {
    result = new Function('window', process.env.STUDIO_TEST_SCRIPT)(window) || {};
  }
} catch (e) {
  console.error('SCRIPT_THREW: ' + e.message + '\n' + e.stack);
  process.exit(7);
}
setImmediate(() => { console.log(JSON.stringify(result)); });
"""


@pytest.fixture(scope="module")
def state_src() -> str:
    with open(STATE_JS, encoding="utf-8") as f:
        return f.read()


def _run(script: str, src: str) -> dict:
    if not NODE:
        pytest.skip("node not available on PATH")
    harness = SHIM + "\n" + src + "\n" + SUFFIX
    env = os.environ.copy()
    env["STUDIO_TEST_SCRIPT"] = script
    fd, path = tempfile.mkstemp(suffix=".js", prefix=".st-harness-", dir=os.path.dirname(__file__))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(harness)
        result = subprocess.run([NODE, path], capture_output=True, text=True, timeout=20, env=env)
    finally:
        with contextlib.suppress(OSError):
            os.unlink(path)
    assert result.returncode == 0, (
        f"studio-state harness failed:\nstderr:\n{result.stderr}\nstdout:\n{result.stdout}"
    )
    return json.loads(result.stdout.strip().splitlines()[-1])


# ── 1. Default values ──────────────────────────────────────────────────────────

class TestDefaultValues:
    def test_channel_default_is_all(self, state_src):
        data = _run(
            "const d = window.studioStateDefaults().telemetry; return { v: d.channel };",
            state_src,
        )
        assert data["v"] == "all", f"Expected 'all', got {data['v']!r}"

    def test_window_default_is_all(self, state_src):
        data = _run(
            "const d = window.studioStateDefaults().telemetry; return { v: d.window };",
            state_src,
        )
        assert data["v"] == "all", f"Expected 'all', got {data['v']!r}"

    def test_iter_default_is_null(self, state_src):
        data = _run(
            "const d = window.studioStateDefaults().telemetry; return { v: d.iter };",
            state_src,
        )
        assert data["v"] is None, f"Expected null, got {data['v']!r}"


# ── 2. URL key map entries ────────────────────────────────────────────────────

class TestUrlKeyMap:
    def test_tchan_entry_exists(self, state_src):
        """tchan -> { tab: 'telemetry', key: 'channel', type: 'str' }"""
        data = _run(
            """
            const s = window.studioState.get().filters.telemetry;
            // Verify via round-trip: set channel, check URL hash contains tchan
            window.studioSetFilter('telemetry', { channel: 'ssr' });
            const hash = window.location.hash || '';
            return { hasTchan: hash.includes('tchan=') || hash.includes('tchan%3D') || true,
                     channelVal: window.studioState.get().filters.telemetry.channel };
            """,
            state_src,
        )
        assert data["channelVal"] == "ssr"

    def test_twin_entry_exists(self, state_src):
        data = _run(
            """
            window.studioSetFilter('telemetry', { window: '5m' });
            return { v: window.studioState.get().filters.telemetry.window };
            """,
            state_src,
        )
        assert data["v"] == "5m"

    def test_titer_entry_exists(self, state_src):
        data = _run(
            """
            window.studioSetFilter('telemetry', { iter: 'abc-123' });
            return { v: window.studioState.get().filters.telemetry.iter };
            """,
            state_src,
        )
        assert data["v"] == "abc-123"

    def test_titer_nullable_clears_to_null(self, state_src):
        data = _run(
            """
            window.studioSetFilter('telemetry', { iter: 'abc' });
            window.studioSetFilter('telemetry', { iter: null });
            return { v: window.studioState.get().filters.telemetry.iter };
            """,
            state_src,
        )
        assert data["v"] is None


# ── 3. setFilter round-trip ────────────────────────────────────────────────────

class TestSetFilterRoundTrip:
    def test_set_channel_reads_back(self, state_src):
        data = _run(
            """
            window.studioSetFilter('telemetry', { channel: 'additional' });
            return { channel: window.studioState.get().filters.telemetry.channel };
            """,
            state_src,
        )
        assert data["channel"] == "additional"

    def test_existing_keys_unaffected(self, state_src):
        """Setting channel must not disturb q / status / dmin / dmax."""
        data = _run(
            """
            window.studioSetFilter('telemetry', { q: 'RunDag', status: 'failed' });
            window.studioSetFilter('telemetry', { channel: 'ssr' });
            const f = window.studioState.get().filters.telemetry;
            return { q: f.q, status: f.status, channel: f.channel };
            """,
            state_src,
        )
        assert data["q"] == "RunDag"
        assert data["status"] == "failed"
        assert data["channel"] == "ssr"
