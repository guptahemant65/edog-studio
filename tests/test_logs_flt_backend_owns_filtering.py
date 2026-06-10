"""
P0 (2026-06-10) — the backend owns log noise filtering; the frontend does not.

Bug history (the "999 logs" / "stats say 3,319 but the list shows far fewer"
symptom):

The Logs tab's ``passesFilter`` carried a hardcoded FLT include-ALLOWLIST
(``COMPONENT_PRESETS.flt.include`` — ~27 regexes). Any log whose component did
not match one of those regexes was dropped at render time. This silently
re-introduced the exact bug the BACKEND had already fixed when it migrated its
own allowlist to a blocklist (see EdogLogInterceptor.cs:30-38): ~63% of FLT
logs are "plain" — no ``[Bracket]`` tag, no ``MonitoredScope`` — and arrive
with component "Unknown" or an un-listed component name. The frontend allowlist
hid them. It also hid real platform Errors/Warnings, which the backend ALWAYS
forwards precisely so that "failures are never hidden".

Because ``addLog`` counts every received envelope in the stats panel but
``passesFilter`` runs later at render time, dropped logs stayed in the ring
buffer (counted) yet never reached the list — producing a silent
stats-vs-list mismatch the user could not explain.

Fix: delete the frontend allowlist entirely. The backend
(edog-blocklist.json + EdogLogInterceptor) is the single source of truth for
noise suppression. The frontend shows every forwarded log, narrowing only by
the user's explicit choices: level pills, component exclusions, search, time,
correlation and iteration filters.

This test pins the inverted contract and is mutation-tested: re-introducing the
allowlist (any ``return false`` keyed on a component include-list) makes
``test_unlisted_flt_component_now_passes`` /
``test_platform_error_now_passes`` fail.

@author Donna — depth protocol, mutation-tested per rule 4
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
FILTERS_JS = os.path.join(PROJECT_DIR, "src", "frontend", "js", "filters.js")
RENDERER_JS = os.path.join(PROJECT_DIR, "src", "frontend", "js", "renderer.js")
STUDIO_STATE_JS = os.path.join(PROJECT_DIR, "src", "frontend", "js", "studio-state.js")
STATE_JS = os.path.join(PROJECT_DIR, "src", "frontend", "js", "state.js")

NODE = shutil.which("node")


# ── Source guard ────────────────────────────────────────────────────────────


class TestNoFrontendAllowlistInSource:
    """passesFilter must not reference an FLT include-allowlist any more."""

    def test_passesfilter_has_no_allowlist_symbols(self):
        with open(RENDERER_JS, encoding="utf-8") as f:
            src = f.read()
        # Check executable code only — the explanatory comment block above the
        # removed gate legitimately *names* the old symbols to warn against
        # re-adding them, so we strip comment lines before asserting.
        code_lines = [
            ln for ln in src.splitlines()
            if not ln.lstrip().startswith(("//", "*", "/*"))
        ]
        code = "\n".join(code_lines)
        # The allowlist gate read COMPONENT_PRESETS.flt.include into a local
        # `fltInclude` and `return false`d on no-match. Both symbols are gone.
        assert "fltInclude" not in code, (
            "renderer.js still references `fltInclude` in code — the FLT "
            "allowlist gate is back. The backend owns noise filtering now. P0."
        )
        assert "COMPONENT_PRESETS.flt" not in code, (
            "renderer.js still reads COMPONENT_PRESETS.flt in code — the "
            "allowlist gate is back. See P0."
        )

    def test_component_presets_constant_removed(self):
        with open(FILTERS_JS, encoding="utf-8") as f:
            src = f.read()
        assert "COMPONENT_PRESETS = {" not in src, (
            "filters.js still defines the COMPONENT_PRESETS constant. It was "
            "removed in P0 — the frontend keeps no component allowlist."
        )


# ── Behavioral harness (Node) ───────────────────────────────────────────────


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
        f"backend-owns-filtering harness failed:\nstderr:\n{result.stderr}\n"
        f"stdout:\n{result.stdout}"
    )
    return json.loads(result.stdout.strip().splitlines()[-1])


def _passes(component: str, level: str = "Message") -> str:
    return (
        f"const entry = {{ level: '{level}', component: '{component}',"
        f"  message: 'x', rootActivityId: 'r1',"
        f"  timestamp: new Date().toISOString() }};"
        f"return {{ passes: renderer.passesFilter(entry) }};"
    )


class TestBackendOwnsFiltering:
    """The frontend forwards everything; it only honors explicit user choices."""

    @pytest.mark.parametrize(
        "component",
        [
            # P0a: genuine FLT components that the old ~27-regex allowlist did
            # NOT match → were hidden even though the backend forwarded them.
            "MetastoreClient",
            "DeltaLogReader",
            # Plain untagged FLT logs surface as component "Unknown".
            "Unknown",
            # An arbitrary forwarded component the allowlist would have dropped.
            "SomeNewFltSubsystem",
        ],
    )
    def test_unlisted_flt_component_now_passes(self, harness_source, component):
        data = _run(_passes(component), harness_source)
        assert data["passes"] is True, (
            f"Component {component!r} reached the frontend (backend forwarded "
            f"it) but passesFilter dropped it. The FLT allowlist must stay "
            f"removed — backend owns noise filtering. See P0."
        )

    @pytest.mark.parametrize(
        "component",
        ["Microsoft.AspNetCore", "PlatformRuntime", "Unknown"],
    )
    def test_platform_error_now_passes(self, harness_source, component):
        # P0b: the backend ALWAYS forwards Errors/Warnings ("failures never
        # hidden"). The old allowlist dropped any non-FLT component regardless
        # of level, swallowing real platform failures in the viewer.
        data = _run(_passes(component, level="Error"), harness_source)
        assert data["passes"] is True, (
            f"A platform Error from {component!r} must surface in the viewer. "
            f"The allowlist used to hide non-FLT errors — that was P0b."
        )

    def test_level_off_still_drops(self, harness_source):
        # Guard: removing the allowlist must NOT weaken the level gate (#5).
        script = (
            "state.activeLevels.delete('Verbose');"
            "const entry = { level: 'Verbose', component: 'MetastoreClient',"
            "  message: 'x', rootActivityId: 'r1',"
            "  timestamp: new Date().toISOString() };"
            "return { passes: renderer.passesFilter(entry) };"
        )
        data = _run(script, harness_source)
        assert data["passes"] is False, (
            "Verbose-off must still drop Verbose logs via the level gate. "
            "P0 only removed the component allowlist, not the level filter."
        )

    def test_explicit_exclusion_still_drops(self, harness_source):
        # Guard: the user's pill-exclusion escape valve still works.
        script = (
            "state.excludedComponents.add('MetastoreClient');"
            "const entry = { level: 'Message', component: 'MetastoreClient',"
            "  message: 'x', rootActivityId: 'r1',"
            "  timestamp: new Date().toISOString() };"
            "return { passes: renderer.passesFilter(entry) };"
        )
        data = _run(script, harness_source)
        assert data["passes"] is False, (
            "An explicitly excluded component must still be dropped."
        )
