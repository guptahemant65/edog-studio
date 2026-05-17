"""F27 P1 — SignalR contract lock.

The QA feature has four contract surfaces between the C# DevMode hub and the
JavaScript studio:

1. **Hub methods** the C# side declares as public  ``Task<…>`` methods (callable
   via ``conn.invoke``).
2. **Hub method calls** the JS makes via ``conn.invoke('QaXxx', …)``.
3. **Server-pushed events** the C# side emits via ``BroadcastQaEventAsync``.
4. **Event handlers** the JS event router declares via ``case 'QaXxx':``.

Drift in any direction is silent and devastating:
- Rename a hub method on the server → every JS call returns "method not
  registered" but the UI just hangs.
- Rename a broadcast event on the server → the JS handler never fires and
  the run silently stalls in whatever stage was waiting for it.

This module parses every contract surface with deterministic regexes and
asserts parity. Any rename, addition, or removal on one side without a
matching change on the other fails the build. The exact known surface is
also pinned as a snapshot so contract changes require an intentional test
edit, not an accidental code edit.

The tests are pure-text — no SignalR runtime, no FLT — so they run in
sub-second time on the existing pytest gate.
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HUB = ROOT / "src" / "backend" / "DevMode" / "EdogPlaygroundHub.cs"
DEVMODE_DIR = ROOT / "src" / "backend" / "DevMode"
JS_DIR = ROOT / "src" / "frontend" / "js"


# ─── Source readers ───────────────────────────────────────────────────────


def _read(path: Path) -> str:
    assert path.exists(), f"Expected file missing: {path}"
    return path.read_text(encoding="utf-8")


def _read_all_cs() -> str:
    """All DevMode C# sources concatenated — broadcast emit sites may live
    anywhere in the analyzer / execution engine, not just the hub file."""
    parts = []
    for p in sorted(DEVMODE_DIR.glob("*.cs")):
        parts.append(_read(p))
    return "\n".join(parts)


def _read_all_js() -> str:
    """All frontend JS sources concatenated."""
    parts = []
    for p in sorted(JS_DIR.glob("*.js")):
        parts.append(_read(p))
    return "\n".join(parts)


# ─── Parsers ──────────────────────────────────────────────────────────────

# ``public async Task<QaAnalysisResult> QaStartCodeAnalysis(QaAnalysisRequest request)``
# Captures the method name. Handles nested generics like
# ``Task<List<QaRunSummary>>`` via ``[^()]*`` — anything-not-paren up to
# the closing ``>`` is fine because C# method signatures never embed parens
# inside the return-type generic argument list.
_HUB_METHOD_RE = re.compile(
    r"public\s+(?:async\s+)?Task(?:<[^()]*>)?\s+(Qa[A-Z]\w*)\s*\(",
)

# ``await BroadcastQaEventAsync("QaScenarioStarted", new {…})``
# The leading ``await``/``_ = `` is optional so we don't restrict on it.
_BROADCAST_EVENT_RE = re.compile(r'BroadcastQaEventAsync\(\s*"(Qa[A-Za-z0-9_]+)"')

# ``conn.invoke('QaStartRun', request)`` or with double quotes.
_JS_INVOKE_RE = re.compile(r"""conn\.invoke\(\s*['"](Qa[A-Za-z0-9_]+)['"]""")

# ``case 'QaRunStarted':`` in the qa-panel.js event router.
_JS_EVENT_CASE_RE = re.compile(r"""case\s+['"](Qa[A-Za-z0-9_]+)['"]\s*:""")


def parse_hub_methods() -> set[str]:
    return set(_HUB_METHOD_RE.findall(_read(HUB)))


def parse_broadcast_events() -> set[str]:
    return set(_BROADCAST_EVENT_RE.findall(_read_all_cs()))


def parse_js_invokes() -> set[str]:
    return set(_JS_INVOKE_RE.findall(_read_all_js()))


def parse_js_event_cases() -> set[str]:
    return set(_JS_EVENT_CASE_RE.findall(_read_all_js()))


# ─── Pinned snapshots ─────────────────────────────────────────────────────
#
# Any change to these sets requires editing the snapshot below, which makes
# contract changes a deliberate, reviewable act. A regex-extracted superset
# that no longer matches these snapshots means either (a) you renamed
# something and the matching test will flag the side it didn't update, or
# (b) you added a real new surface and need to update the snapshot here.

EXPECTED_HUB_METHODS: set[str] = {
    "QaStartCodeAnalysis",
    "QaCancelAnalysis",
    "QaSubmitCuratedScenarios",
    "QaStartRun",
    "QaCancelRun",
    "QaGetRunHistory",
    "QaGetRunDetail",
    "QaGetTelemetry",
    "QaGetCapabilities",
    "QaCompareRuns",
}

EXPECTED_BROADCAST_EVENTS: set[str] = {
    "QaAnalysisProgress",
    "QaAnalysisWarning",
    "QaAnalysisCancelled",
    "QaScenarioGenerated",
    "QaLintFindings",
    "QaRunStarted",
    "QaScenarioStarted",
    "QaScenarioCompleted",
    "QaRunCompleted",
    "QaError",
}

EXPECTED_JS_INVOKES: set[str] = {
    "QaStartCodeAnalysis",
    "QaCancelAnalysis",
    "QaSubmitCuratedScenarios",
    "QaStartRun",
    "QaGetRunDetail",
    "QaGetRunHistory",
    "QaCompareRuns",  # F27 P7 — wired by qa-results.js compare dropdown
}

EXPECTED_JS_EVENT_CASES: set[str] = {
    "QaAnalysisProgress",
    "QaAnalysisWarning",
    "QaAnalysisCancelled",
    "QaScenarioGenerated",
    "QaLintFindings",
    "QaRunStarted",
    "QaScenarioStarted",
    "QaScenarioPhaseChanged",  # planned — see PLANNED_FUTURE_EVENTS below
    "QaExpectationMatched",  # planned — see PLANNED_FUTURE_EVENTS below
    "QaScenarioCompleted",
    "QaRunCompleted",
    "QaError",
}

# Hub methods we deliberately call only from the server side (or future JS).
# These exist for completeness on the server but the studio doesn't drive
# them yet. Removing one of these from the server requires an intentional
# decision; adding one without a JS caller is fine.
SERVER_ONLY_HUB_METHODS: set[str] = {
    "QaCancelRun",      # Cancel button planned, not yet wired in qa-execution.js
    "QaGetTelemetry",   # F27 P0 — used by tests + future telemetry banner UI
    "QaGetCapabilities",  # F27 P5 — used by tests; UI badges land with Stage 2 frontend
}

# Event handlers the JS prepares for but the C# side does not yet emit.
# When this list shrinks, delete the handler from qa-panel.js OR wire the
# emit on the server — never silently leave a dead-letter case.
PLANNED_FUTURE_EVENTS: set[str] = {
    # Per-expectation matches emitted by the assertion engine when an
    # individual expectation transitions to satisfied. Planned for F27 P3
    # (end-to-end integration) once we wire the assertion engine to stream
    # incremental results instead of returning a batch.
    "QaExpectationMatched",
    # Per-phase transitions inside the 8-phase execution loop. The stub run
    # loop used to emit these from a fake Task.Delay(10) loop; F27 P8 wired
    # the real EdogQaExecutionEngine which does NOT yet surface per-phase
    # hooks. JS handlers stay on the client so the UI can light up phase
    # progress the moment the engine starts publishing them.
    "QaScenarioPhaseChanged",
}


# ─── Snapshot tests ───────────────────────────────────────────────────────
#
# Each snapshot test prints a clear diff against the pinned set on failure
# so the engineer sees exactly which name is new / missing / renamed.


def _format_diff(label: str, actual: set[str], expected: set[str]) -> str:
    extra = sorted(actual - expected)
    missing = sorted(expected - actual)
    parts = [f"{label} drift:"]
    if extra:
        parts.append(f"  unexpected (in code, not in snapshot): {extra}")
    if missing:
        parts.append(f"  missing (in snapshot, not in code): {missing}")
    parts.append(
        "  Update EXPECTED_* in tests/test_qa_signalr_contract.py "
        "AND the matching producer/consumer if this is a real rename.",
    )
    return "\n".join(parts)


def test_hub_methods_snapshot() -> None:
    actual = parse_hub_methods()
    assert actual == EXPECTED_HUB_METHODS, _format_diff(
        "Hub methods", actual, EXPECTED_HUB_METHODS,
    )


def test_broadcast_events_snapshot() -> None:
    actual = parse_broadcast_events()
    assert actual == EXPECTED_BROADCAST_EVENTS, _format_diff(
        "Broadcast events", actual, EXPECTED_BROADCAST_EVENTS,
    )


def test_js_invokes_snapshot() -> None:
    actual = parse_js_invokes()
    assert actual == EXPECTED_JS_INVOKES, _format_diff(
        "JS invokes", actual, EXPECTED_JS_INVOKES,
    )


def test_js_event_cases_snapshot() -> None:
    actual = parse_js_event_cases()
    assert actual == EXPECTED_JS_EVENT_CASES, _format_diff(
        "JS event cases", actual, EXPECTED_JS_EVENT_CASES,
    )


# ─── Parity tests (live cross-checks) ─────────────────────────────────────


def test_every_js_invoke_targets_a_real_hub_method() -> None:
    """The JS must never call a hub method that doesn't exist — that produces
    a SignalR ``HubException: method not found`` and the UI just hangs."""
    hub = parse_hub_methods()
    invokes = parse_js_invokes()
    orphan = invokes - hub
    assert not orphan, (
        "JS calls hub methods that do not exist on the server:\n"
        f"  orphans: {sorted(orphan)}\n"
        f"  hub:     {sorted(hub)}\n"
        "Either fix the JS conn.invoke target or add the matching public "
        "Task<...> method on EdogPlaygroundHub.cs."
    )


def test_every_broadcast_event_has_a_js_handler() -> None:
    """Every event the server emits must have a JS ``case`` in the event
    router — otherwise the run silently stalls waiting on a state the UI
    never observes."""
    broadcasts = parse_broadcast_events()
    cases = parse_js_event_cases()
    silent = broadcasts - cases
    assert not silent, (
        "C# broadcasts events the JS event router does not handle:\n"
        f"  silent: {sorted(silent)}\n"
        f"  router: {sorted(cases)}\n"
        "Add a 'case' branch in qa-panel.js _handleQaEvent for each, or "
        "remove the BroadcastQaEventAsync call if the event is no longer "
        "needed."
    )


def test_unhandled_js_cases_are_explicit_planned_events() -> None:
    """JS may declare a ``case`` for an event before C# emits it — but ONLY
    if it's in the explicit PLANNED_FUTURE_EVENTS allow-list. A silent
    dead-letter case in production is worse than no case at all because it
    looks like the feature works."""
    broadcasts = parse_broadcast_events()
    cases = parse_js_event_cases()
    dead = cases - broadcasts
    unexpected_dead = dead - PLANNED_FUTURE_EVENTS
    assert not unexpected_dead, (
        "JS event router handles events the C# side never emits and they "
        "are not in PLANNED_FUTURE_EVENTS:\n"
        f"  unexpected dead-letter cases: {sorted(unexpected_dead)}\n"
        "Either wire the matching BroadcastQaEventAsync on the server OR "
        "delete the dead handler from qa-panel.js. If you genuinely need "
        "to land the handler before the emit, add the name to "
        "PLANNED_FUTURE_EVENTS with a comment explaining the plan."
    )


def test_unused_hub_methods_are_explicit_server_only() -> None:
    """Server-only hub methods (no JS caller) must be explicitly enumerated
    so we don't accumulate dead RPC surface area. Adding a method without
    wiring a JS caller is allowed, but it has to be declared intentionally."""
    hub = parse_hub_methods()
    invokes = parse_js_invokes()
    unused = hub - invokes
    unexpected_unused = unused - SERVER_ONLY_HUB_METHODS
    assert not unexpected_unused, (
        "Hub methods exist but no JS code invokes them and they are not "
        "in SERVER_ONLY_HUB_METHODS:\n"
        f"  unexpected unused: {sorted(unexpected_unused)}\n"
        "Either add the JS conn.invoke call OR add the method to "
        "SERVER_ONLY_HUB_METHODS with a comment explaining why."
    )


def test_planned_future_events_have_no_emitter() -> None:
    """Sanity: a name in PLANNED_FUTURE_EVENTS must genuinely not be emitted
    yet. If it IS emitted, remove it from the allow-list so the parity test
    starts enforcing it."""
    broadcasts = parse_broadcast_events()
    leaked = PLANNED_FUTURE_EVENTS & broadcasts
    assert not leaked, (
        "PLANNED_FUTURE_EVENTS contains events the server already emits:\n"
        f"  leaked: {sorted(leaked)}\n"
        "Remove these from PLANNED_FUTURE_EVENTS — the parity test should "
        "now enforce parity for them."
    )


def test_server_only_methods_have_no_caller() -> None:
    """Sanity: a name in SERVER_ONLY_HUB_METHODS must genuinely have no JS
    caller. If it does, remove it from the allow-list."""
    invokes = parse_js_invokes()
    leaked = SERVER_ONLY_HUB_METHODS & invokes
    assert not leaked, (
        "SERVER_ONLY_HUB_METHODS contains methods that ARE invoked by JS:\n"
        f"  leaked: {sorted(leaked)}\n"
        "Remove these from SERVER_ONLY_HUB_METHODS — they have a JS caller."
    )


# ─── Regex-health tests ───────────────────────────────────────────────────
#
# If someone reformats the hub/js source in a way that breaks the parsers,
# the snapshot tests would *pass* with an empty set. These guards make a
# silent parser failure impossible.


def test_hub_method_parser_found_something() -> None:
    assert len(parse_hub_methods()) >= 8, (
        "Hub-method regex returned fewer methods than expected — the "
        "EdogPlaygroundHub.cs format may have changed. Update _HUB_METHOD_RE."
    )


def test_broadcast_parser_found_something() -> None:
    assert len(parse_broadcast_events()) >= 10, (
        "BroadcastQaEventAsync regex returned fewer events than expected — "
        "the broadcast site format may have changed. Update _BROADCAST_EVENT_RE."
    )


def test_js_invoke_parser_found_something() -> None:
    assert len(parse_js_invokes()) >= 6, (
        "conn.invoke regex returned fewer calls than expected — the JS call "
        "format may have changed. Update _JS_INVOKE_RE."
    )


def test_js_event_case_parser_found_something() -> None:
    assert len(parse_js_event_cases()) >= 12, (
        "JS case regex returned fewer handlers than expected — the qa-panel.js "
        "switch format may have changed. Update _JS_EVENT_CASE_RE."
    )
