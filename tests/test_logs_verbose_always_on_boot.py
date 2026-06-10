"""Verbose level is always-on at boot unless the URL hash explicitly sets levels.

Bug history (the thing this test guards against):

The live FLT service emits ~70% of its log volume at Verbose. A single
in-session "V off" click is snapshotted to localStorage (edog-filters-logs)
by studio-state.js's persistence subscriber. Because the boot merge precedence
is ``defaults -> localStorage -> URL`` (readInitialState), that persisted
``levels`` array then overrides the all-four default on EVERY subsequent boot —
even when the URL is clean. Result: the viewer boots with Verbose hidden and no
visible cue, so it looks like it is silently dropping logs (the real-world
symptom: backend /api/stats reported 3,319 logs / 2,318 Verbose while the
viewer showed ~1,001).

The fix (studio-state.js readInitialState): re-admit 'Verbose' into the merged
``logs.levels`` at boot UNLESS the URL hash explicitly carried a ``levels`` key.
An explicit deep-link (a shared ``#tab=logs&levels=Warning,Error``) is an
intentional verbatim filter and is still honored.

This test asserts three things:

  1. localStorage with V removed + clean URL  -> boot levels include Verbose.
  2. Explicit URL ``levels=Warning,Error``    -> honored verbatim (no Verbose).
  3. Mutation guard (source-level): the re-admit logic is present in
     studio-state.js. Deleting it re-introduces the bug.

The localStorage-seeding harness is bespoke here because the shared boot harness
in test_studio_state_boot.py cannot pre-populate localStorage before the IIFE
runs (the IIFE calls readInitialState at module-load time).
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

NODE = shutil.which("node")

# Browser shim that pre-seeds localStorage BEFORE the studio-state.js IIFE runs.
# STUDIO_TEST_LS_LOGS is a JSON string stored under the edog-filters-logs key,
# exactly as the real persistence subscriber would have written it.
SHIM_PREFIX = r"""
const __hash = process.env.STUDIO_TEST_HASH || '';
const __lsLogs = process.env.STUDIO_TEST_LS_LOGS || '';
const window = {
  location: { hash: __hash, pathname: '/', search: '' },
  history: { replaceState() {} },
  localStorage: {
    _kv: {},
    getItem(k) { return this._kv[k] !== undefined ? this._kv[k] : null; },
    setItem(k, v) { this._kv[k] = String(v); },
  },
  addEventListener: () => {},
};
if (__lsLogs) { window.localStorage._kv['edog-filters-logs'] = __lsLogs; }
"""

SHIM_SUFFIX = r"""
if (!window.studioState) { console.error('NO_STUDIO_STATE'); process.exit(2); }
const s = window.studioState.get();
console.log(JSON.stringify({ levels: s.filters.logs.levels }));
"""


@pytest.fixture(scope="module")
def studio_state_source() -> str:
    with open(STUDIO_STATE_JS, encoding="utf-8") as f:
        return f.read()


def _run_node(source: str, hash_value: str, ls_logs: str | None = None) -> dict:
    if not NODE:
        pytest.skip("node not available on PATH")
    harness = SHIM_PREFIX + "\n" + source + "\n" + SHIM_SUFFIX
    env = os.environ.copy()
    env["STUDIO_TEST_HASH"] = hash_value
    if ls_logs is not None:
        env["STUDIO_TEST_LS_LOGS"] = ls_logs
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
        f"studio-state.js boot harness failed:\nstderr:\n{result.stderr}\nstdout:\n{result.stdout}"
    )
    return json.loads(result.stdout.strip().splitlines()[-1])


class TestVerboseAlwaysOnAtBoot:
    def test_localstorage_v_off_clean_url_readmits_verbose(self, studio_state_source):
        """The core bug: stale localStorage with V removed + clean URL -> V is back."""
        ls = json.dumps({"levels": ["Message", "Warning", "Error"]})
        data = _run_node(studio_state_source, "", ls_logs=ls)
        assert "Verbose" in data["levels"], (
            "Verbose must be re-admitted at boot when only localStorage (not the URL) "
            "dropped it. If this fails, the always-on re-admit in readInitialState is gone."
        )
        # The other persisted levels must survive — we re-admit Verbose, not reset.
        for lvl in ("Message", "Warning", "Error"):
            assert lvl in data["levels"]

    def test_localstorage_only_verbose_is_preserved(self, studio_state_source):
        """A localStorage snapshot that already has Verbose is left untouched (no dup)."""
        ls = json.dumps({"levels": ["Verbose", "Error"]})
        data = _run_node(studio_state_source, "", ls_logs=ls)
        assert data["levels"].count("Verbose") == 1
        assert sorted(data["levels"]) == sorted(["Verbose", "Error"])

    def test_explicit_url_levels_without_verbose_honored_verbatim(self, studio_state_source):
        """A deep-link is intentional: #levels=Warning,Error must NOT get Verbose forced in."""
        data = _run_node(studio_state_source, "#tab=logs&levels=Warning,Error")
        assert sorted(data["levels"]) == sorted(["Warning", "Error"]), (
            "Explicit URL levels must hydrate verbatim — the always-on re-admit must be "
            "skipped when the hash carries a `levels` key."
        )

    def test_clean_boot_has_all_four_levels(self, studio_state_source):
        """No hash, no localStorage -> all four levels (Verbose on)."""
        data = _run_node(studio_state_source, "", ls_logs=None)
        assert sorted(data["levels"]) == sorted(["Verbose", "Message", "Warning", "Error"])


class TestVerboseReadmitSourceGuard:
    def test_readmit_logic_present_in_source(self):
        """Mutation guard: the boot re-admit must stay in studio-state.js."""
        with open(STUDIO_STATE_JS, encoding="utf-8") as f:
            src = f.read()
        assert "urlSpecifiedLevels" in src, (
            "The Verbose always-on boot re-admit (keyed on urlSpecifiedLevels) is missing "
            "from studio-state.js::readInitialState. Removing it re-introduces the "
            "stale-localStorage V-off bug."
        )
        assert "concat(['Verbose'])" in src
