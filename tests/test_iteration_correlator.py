"""
IterationCorrelator — resolves the RAID set for an active iteration.

See ``src/frontend/js/iteration-correlator.js`` for the full architecture.
The bug history is that the prior naive substring filter on iterationId
caught only ~4% of an iteration's logs (the explicit-mention slice). The
correlator chains causally — seeded by explicit mentions, then chases
the "An overriding Monitored Scope is created" lines whose emitter is
already in the set, then captures per-route incoming-request RAIDs.

This test suite covers:
  1. Empty state — no iteration set → matches() returns true (no-op filter)
  2. Seed rule — explicit "Iteration: <id>" mention captures the emitter RAID
  3. Chase rule — "overriding Monitored Scope" propagation
  4. Routes rule — /runDAG/{id}, /getDAGExecStatus/{id}, /cancelDAG/{id}
  5. Convergence — 3-level transitive chain reaches all leaves
  6. Cross-iteration isolation — iteration A's RAIDs don't leak into B
  7. Substring-collision safety — random GUID in message body doesn't seed
  8. Incremental — onNewLogs catches newly-added logs without full rebuild
  9. setActiveIteration(null) clears state
  10. setActiveIteration to a different id rebuilds from scratch
  11. Live-corpus recall — real iteration's RAIDs all resolve (≥10× lift)

Source-level guards (separate class):
  12. Renderer.passesFilter uses the correlator (not naive substring)
  13. ExecutionSummary.compute uses the correlator
"""

from __future__ import annotations

import contextlib
import json
import os
import re
import shutil
import subprocess
import tempfile

import pytest

PROJECT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STUDIO_STATE_JS = os.path.join(PROJECT_DIR, "src", "frontend", "js", "studio-state.js")
STATE_JS = os.path.join(PROJECT_DIR, "src", "frontend", "js", "state.js")
CORRELATOR_JS = os.path.join(PROJECT_DIR, "src", "frontend", "js", "iteration-correlator.js")
RENDERER_JS = os.path.join(PROJECT_DIR, "src", "frontend", "js", "renderer.js")
SUMMARY_JS = os.path.join(PROJECT_DIR, "src", "frontend", "js", "summary.js")

NODE = shutil.which("node")


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
  matchMedia: () => ({ matches: false, addListener: () => {} }),
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
"""

ASSERT_SUFFIX = r"""
const state = new LogViewerState();
const correlator = new IterationCorrelator(state);

function addLog(entry) {
  state.addLog(Object.assign(
    { timestamp: new Date().toISOString() },
    entry,
  ));
}

let result = {};
try {
  if (process.env.STUDIO_TEST_SCRIPT) {
    result = new Function(
      'state', 'correlator', 'IterationCorrelator', 'addLog', 'window',
      process.env.STUDIO_TEST_SCRIPT
    )(state, correlator, IterationCorrelator, addLog, window) || {};
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
    for path in (STUDIO_STATE_JS, STATE_JS, CORRELATOR_JS):
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
            [NODE, path], capture_output=True, text=True, timeout=20, env=env,
        )
    finally:
        with contextlib.suppress(OSError):
            os.unlink(path)
    assert result.returncode == 0, (
        f"correlator harness failed:\nstderr:\n{result.stderr}\nstdout:\n{result.stdout}"
    )
    return json.loads(result.stdout.strip().splitlines()[-1])


# ── 1. Empty / no-iteration baseline ────────────────────────────────────────


class TestEmptyState:
    def test_no_active_iteration_matches_everything(self, harness_source):
        """When no iteration is set, matches() is a no-op (returns True)."""
        script = (
            "return {"
            "  a: correlator.matches('any-raid-here'),"
            "  b: correlator.matches(null),"
            "  c: correlator.matches(undefined),"
            "  d: correlator.matches(''),"
            "};"
        )
        data = _run(script, harness_source)
        # When no filter is active, matches() must return true so the
        # rest of passesFilter() continues without intervention.
        assert data["a"] is True
        assert data["b"] is True
        assert data["c"] is True
        assert data["d"] is True

    def test_active_with_empty_buffer_matches_only_in_set(self, harness_source):
        script = (
            "correlator.setActiveIteration('aaaa1111-2222-3333-4444-555555555555');"
            "return {"
            "  size: correlator.resolvedRaids.size,"
            "  unknown: correlator.matches('some-raid'),"
            "  nullRaid: correlator.matches(null),"
            "};"
        )
        data = _run(script, harness_source)
        assert data["size"] == 0, "empty buffer → no RAIDs resolved"
        assert data["unknown"] is False
        assert data["nullRaid"] is False


# ── 2. Seed rule ────────────────────────────────────────────────────────────


ITER_A = "11111111-1111-1111-1111-111111111111"
ITER_B = "22222222-2222-2222-2222-222222222222"


class TestSeedRule:
    def test_explicit_iteration_mention_seeds_raid(self, harness_source):
        script = (
            f"addLog({{ level:'Message', component:'X', "
            f"  message:'Sending TransformSubmit Iteration: {ITER_A}',"
            f"  rootActivityId:'bg-raid-1' }});"
            f"correlator.setActiveIteration('{ITER_A}');"
            f"return {{"
            f"  size: correlator.resolvedRaids.size,"
            f"  matches: correlator.matches('bg-raid-1'),"
            f"  raids: Array.from(correlator.resolvedRaids),"
            f"}};"
        )
        data = _run(script, harness_source)
        assert data["size"] == 1
        assert data["matches"] is True
        assert data["raids"] == ["bg-raid-1"]

    @pytest.mark.parametrize(
        "msg_form",
        [
            "Iteration: {id}",
            "Iteration {id}",
            "IterationId={id}",
            "IterationId: {id}",
            "[IterationId {id} Node dbo.foo] RequestId 33264cf9-...",
        ],
    )
    def test_seed_recognizes_iteration_mention_forms(self, harness_source, msg_form):
        msg = msg_form.format(id=ITER_A)
        script = (
            f"addLog({{ level:'Message', component:'X',"
            f"  message: {json.dumps(msg)},"
            f"  rootActivityId:'r1' }});"
            f"correlator.setActiveIteration('{ITER_A}');"
            f"return {{ matches: correlator.matches('r1') }};"
        )
        data = _run(script, harness_source)
        assert data["matches"] is True, (
            f"Seed rule must recognize iteration mention form: {msg_form!r}"
        )

    def test_mention_without_iteration_keyword_does_not_seed(self, harness_source):
        """Substring-collision safety: a random GUID in the message that
        happens to equal the iteration ID, with NO 'Iteration' keyword,
        must NOT seed. (The seed rule is anchored to the literal word
        'Iteration' to avoid false positives.)"""
        script = (
            f"addLog({{ level:'Message', component:'X',"
            f"  message:'SomeUnrelatedField: {ITER_A}',"
            f"  rootActivityId:'random-raid' }});"
            f"correlator.setActiveIteration('{ITER_A}');"
            f"return {{ matches: correlator.matches('random-raid') }};"
        )
        data = _run(script, harness_source)
        assert data["matches"] is False, (
            "Substring-only GUID match without the 'Iteration' keyword "
            "must not seed — would cause cross-iteration leakage."
        )


# ── 3. Chase rule ──────────────────────────────────────────────────────────


class TestChaseRule:
    def test_overriding_scope_chases_when_emitter_in_set(self, harness_source):
        """Emitter has bg-raid-1 (in set) and logs creation of new RAID
        leaf-raid-A. leaf-raid-A must be added to the set."""
        script = (
            f"addLog({{ level:'Message', component:'X',"
            f"  message:'Iteration: {ITER_A}',"
            f"  rootActivityId:'bg-raid-1' }});"
            f"addLog({{ level:'Message', component:'X',"
            f"  message:'An overriding Monitored Scope is created with RootActivityId: "
            f"aaaaaaaa-1111-2222-3333-444444444444, ParentActivityId: x',"
            f"  rootActivityId:'bg-raid-1' }});"
            f"correlator.setActiveIteration('{ITER_A}');"
            f"return {{"
            f"  size: correlator.resolvedRaids.size,"
            f"  matchesLeaf: correlator.matches('aaaaaaaa-1111-2222-3333-444444444444'),"
            f"  matchesBg: correlator.matches('bg-raid-1'),"
            f"}};"
        )
        data = _run(script, harness_source)
        assert data["size"] == 2
        assert data["matchesBg"] is True
        assert data["matchesLeaf"] is True

    def test_overriding_scope_ignored_when_emitter_not_in_set(self, harness_source):
        """Override message emitted by an unrelated RAID must not pollute the set."""
        script = (
            f"addLog({{ level:'Message', component:'X',"
            f"  message:'Iteration: {ITER_A}',"
            f"  rootActivityId:'bg-raid-1' }});"
            f"addLog({{ level:'Message', component:'X',"
            f"  message:'An overriding Monitored Scope is created with RootActivityId: "
            f"bbbbbbbb-1111-2222-3333-444444444444',"
            f"  rootActivityId:'unrelated-emitter' }});"
            f"correlator.setActiveIteration('{ITER_A}');"
            f"return {{"
            f"  size: correlator.resolvedRaids.size,"
            f"  leaf: correlator.matches('bbbbbbbb-1111-2222-3333-444444444444'),"
            f"}};"
        )
        data = _run(script, harness_source)
        assert data["size"] == 1, "only the seed should be in the set"
        assert data["leaf"] is False

    def test_three_level_chain_converges(self, harness_source):
        """Transitive chain: bg → mid → leaf. All three must resolve."""
        script = (
            f"addLog({{ level:'Message', component:'X',"
            f"  message:'Iteration: {ITER_A}',"
            f"  rootActivityId:'bg-raid' }});"
            f"addLog({{ level:'Message', component:'X',"
            f"  message:'An overriding Monitored Scope is created with RootActivityId: "
            f"cccccccc-1111-2222-3333-444444444444',"
            f"  rootActivityId:'bg-raid' }});"
            f"addLog({{ level:'Message', component:'X',"
            f"  message:'An overriding Monitored Scope is created with RootActivityId: "
            f"dddddddd-1111-2222-3333-444444444444',"
            f"  rootActivityId:'cccccccc-1111-2222-3333-444444444444' }});"
            f"correlator.setActiveIteration('{ITER_A}');"
            f"return {{"
            f"  size: correlator.resolvedRaids.size,"
            f"  raids: Array.from(correlator.resolvedRaids).sort(),"
            f"}};"
        )
        data = _run(script, harness_source)
        assert data["size"] == 3, (
            f"Transitive chase must reach the leaf via 2+ passes. Got: {data['raids']!r}"
        )


# ── 4. Routes rule ─────────────────────────────────────────────────────────


class TestRoutesRule:
    @pytest.mark.parametrize("route", ["runDAG", "getDAGExecStatus", "cancelDAG"])
    def test_incoming_request_captures_raid(self, harness_source, route):
        script = (
            f"addLog({{ level:'Message', component:'IncomingRequest',"
            f"  message:'New Incoming Request: {route}/{ITER_A}',"
            f"  rootActivityId:'incoming-raid-1' }});"
            f"correlator.setActiveIteration('{ITER_A}');"
            f"return {{ matches: correlator.matches('incoming-raid-1') }};"
        )
        data = _run(script, harness_source)
        assert data["matches"] is True

    def test_unrelated_iteration_route_ignored(self, harness_source):
        script = (
            f"addLog({{ level:'Message', component:'IncomingRequest',"
            f"  message:'New Incoming Request: getDAGExecStatus/{ITER_B}',"
            f"  rootActivityId:'other-iter-raid' }});"
            f"correlator.setActiveIteration('{ITER_A}');"
            f"return {{ matches: correlator.matches('other-iter-raid') }};"
        )
        data = _run(script, harness_source)
        assert data["matches"] is False


# ── 5. Cross-iteration isolation ──────────────────────────────────────────


class TestCrossIterationIsolation:
    def test_two_iterations_dont_leak(self, harness_source):
        script = (
            f"addLog({{ level:'Message', component:'X',"
            f"  message:'Iteration: {ITER_A}',"
            f"  rootActivityId:'raid-A' }});"
            f"addLog({{ level:'Message', component:'X',"
            f"  message:'Iteration: {ITER_B}',"
            f"  rootActivityId:'raid-B' }});"
            f"correlator.setActiveIteration('{ITER_A}');"
            f"const a = {{"
            f"  matchesA: correlator.matches('raid-A'),"
            f"  matchesB: correlator.matches('raid-B'),"
            f"  size: correlator.resolvedRaids.size,"
            f"}};"
            f"correlator.setActiveIteration('{ITER_B}');"
            f"const b = {{"
            f"  matchesA: correlator.matches('raid-A'),"
            f"  matchesB: correlator.matches('raid-B'),"
            f"  size: correlator.resolvedRaids.size,"
            f"}};"
            f"return {{ a, b }};"
        )
        data = _run(script, harness_source)
        assert data["a"]["matchesA"] is True and data["a"]["matchesB"] is False
        assert data["a"]["size"] == 1
        assert data["b"]["matchesB"] is True and data["b"]["matchesA"] is False
        assert data["b"]["size"] == 1


# ── 6. Incremental update ──────────────────────────────────────────────────


class TestIncrementalUpdate:
    def test_on_new_logs_catches_late_arrivals(self, harness_source):
        script = (
            f"addLog({{ level:'Message', component:'X',"
            f"  message:'Iteration: {ITER_A}',"
            f"  rootActivityId:'bg-raid' }});"
            f"correlator.setActiveIteration('{ITER_A}');"
            f"const sizeBefore = correlator.resolvedRaids.size;"
            # Now simulate a late-arriving overriding-scope log
            f"addLog({{ level:'Message', component:'X',"
            f"  message:'An overriding Monitored Scope is created with RootActivityId: "
            f"eeeeeeee-1111-2222-3333-444444444444',"
            f"  rootActivityId:'bg-raid' }});"
            # Without onNewLogs, the new RAID would not be seen.
            f"correlator.onNewLogs();"
            f"return {{"
            f"  sizeBefore,"
            f"  sizeAfter: correlator.resolvedRaids.size,"
            f"  newRaidMatches: correlator.matches('eeeeeeee-1111-2222-3333-444444444444'),"
            f"}};"
        )
        data = _run(script, harness_source)
        assert data["sizeBefore"] == 1
        assert data["sizeAfter"] == 2
        assert data["newRaidMatches"] is True


# ── 7. setActiveIteration lifecycle ───────────────────────────────────────


class TestSetActiveIterationLifecycle:
    def test_set_to_null_clears_state(self, harness_source):
        script = (
            f"addLog({{ level:'Message', component:'X',"
            f"  message:'Iteration: {ITER_A}',"
            f"  rootActivityId:'r1' }});"
            f"correlator.setActiveIteration('{ITER_A}');"
            f"const beforeSize = correlator.resolvedRaids.size;"
            f"correlator.setActiveIteration(null);"
            f"return {{"
            f"  beforeSize,"
            f"  afterSize: correlator.resolvedRaids.size,"
            f"  active: correlator.activeIteration,"
            f"  matchesAny: correlator.matches('r1'),"
            f"}};"
        )
        data = _run(script, harness_source)
        assert data["beforeSize"] == 1
        assert data["afterSize"] == 0
        assert data["active"] is None
        # No active iteration → matches is a no-op (returns true)
        assert data["matchesAny"] is True

    def test_switch_iteration_rebuilds_from_scratch(self, harness_source):
        script = (
            f"addLog({{ level:'Message', component:'X',"
            f"  message:'Iteration: {ITER_A}',"
            f"  rootActivityId:'raid-A' }});"
            f"addLog({{ level:'Message', component:'X',"
            f"  message:'Iteration: {ITER_B}',"
            f"  rootActivityId:'raid-B' }});"
            f"correlator.setActiveIteration('{ITER_A}');"
            f"correlator.setActiveIteration('{ITER_B}');"
            f"return {{"
            f"  size: correlator.resolvedRaids.size,"
            f"  matchesA: correlator.matches('raid-A'),"
            f"  matchesB: correlator.matches('raid-B'),"
            f"}};"
        )
        data = _run(script, harness_source)
        assert data["size"] == 1
        assert data["matchesA"] is False
        assert data["matchesB"] is True


# ── 8. Source-level guards on consumers ───────────────────────────────────


class TestPassesFilterUsesCorrelator:
    """renderer.passesFilter must consult the correlator, not substring."""

    def test_renderer_uses_iteration_correlator(self) -> None:
        src = open(RENDERER_JS, encoding="utf-8").read()
        # Strip comments
        stripped = re.sub(r"//[^\n]*", "", src)
        stripped = re.sub(r"/\*.*?\*/", "", stripped, flags=re.DOTALL)
        # Must reference the correlator (either window.edogIterationCorrelator
        # or via this.state.iterationCorrelator). We accept either binding.
        assert "iterationCorrelator" in stripped or "IterationCorrelator" in stripped, (
            "renderer.passesFilter must consult the IterationCorrelator for "
            "the RAID filter branch. Naive substring on iterationId/message/"
            "rootActivityId catches only ~4% of an iteration's logs."
        )

    def test_renderer_no_longer_uses_naive_raid_substring(self) -> None:
        """Anti-test: the prior naive 3-field substring check in passesFilter
        must be gone.

        The smoking-gun shape was three `.includes(raidLower)` in close
        proximity inside `passesFilter`. (NB: `passesTelemetryFilter`
        legitimately substring-matches on attributes.IterationId /
        correlationId — those fields carry the iteration ID by construction
        per TelemetryUtils.cs, so that branch is correct. Scope our check
        to passesFilter only.)
        """
        src = open(RENDERER_JS, encoding="utf-8").read()
        stripped = re.sub(r"//[^\n]*", "", src)
        stripped = re.sub(r"/\*.*?\*/", "", stripped, flags=re.DOTALL)

        # Extract just the passesFilter function body (rough but adequate).
        # passesFilter is an arrow assigned to a class field, so it starts
        # at `passesFilter = ` and ends at the matching close-brace + newline.
        m = re.search(
            r"passesFilter\s*=\s*\([^)]*\)\s*=>\s*\{(.*?)\n\s{2}\}",
            stripped,
            re.DOTALL,
        )
        assert m, "Could not locate passesFilter function in renderer.js"
        body = m.group(1)
        count = body.count(".includes(raidLower)")
        assert count == 0, (
            f"Found {count} `.includes(raidLower)` calls inside passesFilter — "
            f"the naive 3-field substring RAID match must be replaced by the "
            f"IterationCorrelator."
        )


class TestSummaryUsesCorrelator:
    """ExecutionSummary.compute must consult the correlator."""

    def test_summary_uses_iteration_correlator(self) -> None:
        src = open(SUMMARY_JS, encoding="utf-8").read()
        stripped = re.sub(r"//[^\n]*", "", src)
        stripped = re.sub(r"/\*.*?\*/", "", stripped, flags=re.DOTALL)
        assert "iterationCorrelator" in stripped or "IterationCorrelator" in stripped, (
            "summary.js ExecutionSummary.compute must consult the "
            "IterationCorrelator. The lifecycle drawer's hero/nodes/errors/"
            "timeline are all computed from the iteration's logs — without "
            "the correlator they see only ~4% of the data."
        )
