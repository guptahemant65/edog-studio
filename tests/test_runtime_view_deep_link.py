"""
PR-A regression — RuntimeView.init() must honor a studioState deep-link.

The HTML hard-codes `class="rt-tab active"` on the Logs tab. Before PR-A,
init() only repositioned the indicator and never called switchTab, so a
URL hash like `#tab=spark` would land the user on the Logs panel with the
indicator floating under Spark. The user couldn't recover by clicking
Spark because switchTab early-returns when `tabId === _activeTab`.

PR-A's fix is three-fold:
  1. RuntimeView constructor seeds `_activeTab` from `studioState`.
  2. `_applyTab(tabId)` is the unguarded DOM/lifecycle primitive
     (extracted from switchTab).
  3. `init()` ends with `this._applyTab(this._activeTab)` so the seeded
     tab is reconciled to the DOM and `module.activate()` fires.

This test wires the smallest possible DOM stub in Node to exercise that
exact path. We deliberately avoid jsdom or Playwright — both would
introduce dependencies the project doesn't formalize. The stub is
hand-rolled and inlined here so the test is self-contained.

Trade-off documented: the stub covers the calls runtime-view.js makes
during init() and switchTab() — classList/dataset/querySelectorAll on
tab elements, getElementById on a fixed registry of IDs. It does NOT
exercise CSS, layout, event dispatch, or the indicator's measurements
(F1's offsetParent guard short-circuits before getBoundingClientRect is
read). If runtime-view.js grows new DOM dependencies in init(), this
stub will need to grow with it — that's the cost of avoiding jsdom.

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
RUNTIME_VIEW_JS = os.path.join(PROJECT_DIR, "src", "frontend", "js", "runtime-view.js")

NODE = shutil.which("node")

# Minimal DOM + window stub. Implements just enough surface for
# RuntimeView.init() and _applyTab() to run end-to-end without jsdom.
DOM_STUB = r"""
function makeClassList(initial) {
  const set = new Set(initial || []);
  return {
    _set: set,
    add(c) { set.add(c); },
    remove(c) { set.delete(c); },
    contains(c) { return set.has(c); },
    toString() { return Array.from(set).join(' '); },
  };
}

function makeEl(opts) {
  opts = opts || {};
  const el = {
    tagName: (opts.tag || 'DIV').toUpperCase(),
    id: opts.id || '',
    classList: makeClassList(opts.classes),
    dataset: opts.dataset || {},
    style: {},
    children: [],
    parent: null,
    // F1 guard short-circuit: offsetParent === null means the indicator
    // update bails before touching getBoundingClientRect — so the test
    // is insulated from layout/measure concerns.
    offsetParent: null,
    addEventListener() {},
    removeEventListener() {},
    getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
    closest() { return null; },
    appendChild(child) {
      child.parent = el;
      el.children.push(child);
      return child;
    },
    querySelectorAll(sel) {
      // Naive: support only single-class selectors like '.rt-tab' or '.rt-dd-item'
      if (!sel.startsWith('.')) return [];
      const wantClass = sel.slice(1);
      const out = [];
      function walk(node) {
        for (const c of node.children || []) {
          if (c.classList && c.classList.contains(wantClass)) out.push(c);
          walk(c);
        }
      }
      walk(el);
      return out;
    },
  };
  return el;
}

// Build the runtime-view DOM subset that init() reads via getElementById.
const _registry = {};
function register(id, el) { el.id = id; _registry[id] = el; return el; }

const tabBarInner = register('rt-tab-bar-inner', makeEl());
const tabBar = register('rt-tab-bar', makeEl());
tabBar.appendChild(tabBarInner);

// Top-level tabs (matching index.html data-tab values)
const TOP_TABS = ['logs', 'telemetry', 'sysfiles', 'spark', 'nexus'];
for (const id of TOP_TABS) {
  const tab = makeEl({ tag: 'div', classes: id === 'logs' ? ['rt-tab', 'active'] : ['rt-tab'], dataset: { tab: id } });
  tabBarInner.appendChild(tab);
}
// Internals tab + dropdown items
const internalsTab = register('rt-tab-internals', makeEl({ tag: 'div', classes: ['rt-tab', 'rt-tab-internals'], dataset: { tab: 'internals' } }));
tabBarInner.appendChild(internalsTab);
register('rt-internals-label', makeEl());
register('rt-internals-chevron', makeEl());
const dropdown = register('rt-internals-dropdown', makeEl());
for (const id of ['tokens', 'caches', 'http', 'retries', 'flags', 'di', 'perf']) {
  const item = makeEl({ tag: 'div', classes: ['rt-dd-item'], dataset: { sub: id } });
  dropdown.appendChild(item);
}
register('rt-tab-indicator', makeEl());

// Content panes (one per top-level tab + each internals sub)
for (const id of TOP_TABS.concat(['tokens', 'caches', 'http', 'retries', 'flags', 'di', 'perf'])) {
  register('rt-tab-' + id, makeEl({ classes: id === 'logs' ? ['rt-tab-content', 'active'] : ['rt-tab-content'] }));
}

// Optional elements init() looks up — null is fine because the code
// guards with `if (el)` everywhere.
for (const id of ['rt-phase1-overlay', 'rt-stopped-overlay', 'rt-conn-dot',
                  'rt-conn-label', 'rt-conn-throughput', 'rt-conn-port',
                  'rt-sidebar-dot', 'rt-sidebar-lock', 'rt-phase1-go-ws']) {
  _registry[id] = null;
}

const document = {
  getElementById(id) { return _registry[id] || null; },
  querySelectorAll() { return []; },
  addEventListener() {},
};

const window = {
  location: { hash: process.env.STUDIO_TEST_HASH || '' },
  history: { replaceState() {} },
  localStorage: { _kv: {}, getItem(k) { return this._kv[k] || null; }, setItem(k, v) { this._kv[k] = v; } },
  addEventListener() {},
};
// requestAnimationFrame: no-op (F1 guard prevents re-entry anyway)
globalThis.requestAnimationFrame = function () {};
globalThis.document = document;
globalThis.window = window;
"""

ASSERT_SUFFIX = r"""
// Now exercise the H1 path: studioState seeded from hash → RuntimeView
// constructor reads it → registerTab → init() → _applyTab fires module.activate.
if (!window.studioState) { console.error('IIFE_FAILED'); process.exit(2); }

const rv = new RuntimeView(null);
let activateCalls = [];
let deactivateCalls = [];
function spy(id) {
  return {
    activate() { activateCalls.push(id); },
    deactivate() { deactivateCalls.push(id); },
  };
}
// Register a module for every tab so _applyTab can fire activate on any deep-link.
for (const id of ['logs', 'telemetry', 'sysfiles', 'spark', 'nexus',
                  'tokens', 'caches', 'http', 'retries', 'flags', 'di', 'perf']) {
  rv.registerTab(id, spy(id));
}

rv.init();

// Collect observable state for the test to assert against.
function activeTabs() {
  const out = [];
  for (const t of rv._tabEls) if (t.classList.contains('active')) out.push(t.dataset.tab);
  return out;
}
function activeContents() {
  const out = [];
  for (const id of Object.keys(rv._tabs)) {
    const t = rv._tabs[id];
    if (t.el && t.el.classList.contains('active')) out.push('rt-tab-' + id);
  }
  return out;
}
console.log(JSON.stringify({
  studioActiveTab: window.studioState.get().activeTab,
  runtimeActiveTab: rv._activeTab,
  internalsActiveId: rv._internalsActiveId,
  activateCalls,
  deactivateCalls,
  activeTabs: activeTabs(),
  activeContents: activeContents(),
}));
"""


@pytest.fixture(scope="module")
def studio_state_source() -> str:
    with open(STUDIO_STATE_JS, encoding="utf-8") as f:
        return f.read()


@pytest.fixture(scope="module")
def runtime_view_source() -> str:
    with open(RUNTIME_VIEW_JS, encoding="utf-8") as f:
        return f.read()


def _run(hash_value: str, studio_src: str, runtime_src: str) -> dict:
    if not NODE:
        pytest.skip("node not available on PATH")
    harness = DOM_STUB + "\n" + studio_src + "\n" + runtime_src + "\n" + ASSERT_SUFFIX
    env = os.environ.copy()
    env["STUDIO_TEST_HASH"] = hash_value
    # Write harness to a temp file rather than passing via `node -e`. Windows
    # CreateProcess caps the combined command line at ~32 KB; once
    # studio-state.js grew past ~10 KB the `-e` form started throwing
    # "WinError 206: filename or extension is too long" for the larger
    # harnesses. A temp .js file in the repo's tests/ dir sidesteps it
    # entirely and works identically on POSIX.
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
        f"RuntimeView init harness failed:\nstderr:\n{result.stderr}\nstdout:\n{result.stdout}"
    )
    return json.loads(result.stdout.strip().splitlines()[-1])


class TestRuntimeViewDeepLink:
    """init() must reconcile a deep-linked tab to the DOM + fire activate()."""

    def test_default_no_hash_lands_on_logs(self, studio_state_source, runtime_view_source):
        data = _run("", studio_state_source, runtime_view_source)
        assert data["studioActiveTab"] == "logs"
        assert data["runtimeActiveTab"] == "logs"
        assert data["activateCalls"] == ["logs"]
        assert data["deactivateCalls"] == []
        assert data["activeTabs"] == ["logs"]
        assert data["activeContents"] == ["rt-tab-logs"]

    def test_deep_link_top_level_tab(self, studio_state_source, runtime_view_source):
        """#tab=spark must land on Spark, not Logs."""
        data = _run("#tab=spark", studio_state_source, runtime_view_source)
        assert data["studioActiveTab"] == "spark"
        assert data["runtimeActiveTab"] == "spark", (
            f"H1 regression: deep-link to spark left runtimeView on {data['runtimeActiveTab']!r}"
        )
        assert data["activateCalls"] == ["spark"], "module.activate() must fire on the deep-linked tab, not Logs"
        assert data["activeTabs"] == ["spark"]
        assert data["activeContents"] == ["rt-tab-spark"]

    def test_deep_link_internals_sub_view(self, studio_state_source, runtime_view_source):
        """#tab=tokens must activate the Internals bar tab + Tokens content pane."""
        data = _run("#tab=tokens", studio_state_source, runtime_view_source)
        assert data["studioActiveTab"] == "tokens"
        assert data["runtimeActiveTab"] == "tokens"
        assert data["internalsActiveId"] == "tokens"
        assert data["activateCalls"] == ["tokens"]
        # Internals bar tab gets the .active class, not 'tokens' itself
        assert data["activeTabs"] == ["internals"]
        assert data["activeContents"] == ["rt-tab-tokens"]

    def test_malformed_hash_falls_through_to_default(self, studio_state_source, runtime_view_source):
        """B1 + H1 compose: malformed hash boots safely AND init() lands on default."""
        data = _run("#tab=%E0%A4%A", studio_state_source, runtime_view_source)
        assert data["studioActiveTab"] == "logs"
        assert data["runtimeActiveTab"] == "logs"
        assert data["activateCalls"] == ["logs"]
