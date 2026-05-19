"""F27 P8 — Execution-engine wiring contract.

For the entire pre-P8 history of F27 the hub's run loop was a lie: every
scenario passed through a ``Task.Delay(10)`` + hardcoded ``verdict = "passed"``
sequence regardless of the real ``EdogQaExecutionEngine`` sitting next to it.
P8 wires the engine in. This module pins the wiring as a contract so the lie
can't return through a careless refactor.

Pure source-grep — no FLT bin, no dotnet, no SignalR — so it runs in
sub-second time alongside the rest of the QA shape suite.
"""

from __future__ import annotations

from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
HUB = REPO / "src" / "backend" / "DevMode" / "EdogPlaygroundHub.cs"
ENGINE = REPO / "src" / "backend" / "DevMode" / "EdogQaExecutionEngine.cs"


def _hub() -> str:
    return HUB.read_text(encoding="utf-8")


def _engine() -> str:
    return ENGINE.read_text(encoding="utf-8")


# ─── Engine call site ─────────────────────────────────────────────────────


def test_hub_calls_execution_engine_run_async() -> None:
    """The run loop MUST drive the real engine. The whole P8 contract."""
    src = _hub()
    assert "EdogQaServiceLocator.ExecutionEngine" in src, (
        "Hub no longer references the static execution engine locator — the engine wiring has been broken."
    )
    assert ".ExecuteRunAsync(runId, engineScenarios" in src, (
        "Hub must call EdogQaServiceLocator.ExecutionEngine.ExecuteRunAsync "
        "with the converted engine scenarios. If you renamed the engine "
        "method, update this test AND the engine signature in tandem."
    )


def test_hub_honesty_gate_on_missing_engine() -> None:
    """If the engine is unregistered the run MUST fail loud, not silent."""
    src = _hub()
    assert "ENGINE_NOT_REGISTERED" in src, (
        "Hub is missing the ENGINE_NOT_REGISTERED honesty gate. A null "
        "execution engine must produce a QaError with this code, not a "
        "silent green run."
    )
    # Guarded by an actual if-block, not just present in a comment.
    assert "if (engine == null)" in src, (
        "Hub must guard on `engine == null` and broadcast QaError before "
        "calling ExecuteRunAsync. Pre-P8 code path silently fake-passed "
        "scenarios when the engine was missing."
    )


def test_hub_publishes_qa_error_for_engine_failure() -> None:
    """Engine throws → fatal QaError. No silent partial-result swallowing."""
    src = _hub()
    assert "ENGINE_EXECUTION_FAILED" in src, (
        "Hub must wrap ExecuteRunAsync in a try/catch that emits the "
        "ENGINE_EXECUTION_FAILED QaError on unexpected engine failure."
    )


# ─── The stub run loop must be gone ───────────────────────────────────────


def test_hub_does_not_hardcode_passed_verdict() -> None:
    """The fake `verdict = "passed";` line is the canary for the stub loop."""
    src = _hub()
    assert 'verdict = "passed"' not in src, (
        'Hub contains the hardcoded `verdict = "passed"` literal from the '
        "pre-P8 stub run loop. Every scenario was silently green regardless "
        "of the assertion engine. Remove the literal and route through the "
        "real EdogQaExecutionEngine."
    )


def test_hub_does_not_simulate_phases_with_task_delay() -> None:
    """The fake phase loop spun on Task.Delay(10, ct). Gone forever."""
    src = _hub()
    assert "Task.Delay(10, ct)" not in src, (
        "Hub still uses `Task.Delay(10, ct)` — the pre-P8 fake phase loop. "
        "The 8-phase execution is owned by EdogQaExecutionEngine now."
    )


def test_hub_does_not_emit_fake_phase_change_events() -> None:
    """QaScenarioPhaseChanged was emitted from inside the fake loop. The
    engine does not surface per-phase hooks yet, so the broadcast must
    not be present on the hub. JS handlers stay (PLANNED_FUTURE_EVENTS)."""
    src = _hub()
    assert '"QaScenarioPhaseChanged"' not in src, (
        "Hub still broadcasts QaScenarioPhaseChanged. The real engine does "
        "not emit per-phase notifications yet — re-introducing this from "
        "the hub would be fake phase telemetry (precisely what P8 killed)."
    )


# ─── Engine surface used by the bridge ────────────────────────────────────


def test_engine_progress_payload_carries_full_result() -> None:
    """The hub bridges progress callbacks to QaScenarioCompleted, which
    needs the real ``ScenarioResult`` (expectations, duration, error).
    The engine MUST populate ``QaExecutionProgress.Result``."""
    src = _engine()
    # Field exists on the model.
    assert "public ScenarioResult Result { get; set; }" in src, (
        "QaExecutionProgress.Result field is missing — without it the hub "
        "cannot bridge a real per-scenario completion event."
    )
    # And the engine sets it on the completion invoke.
    assert "Result = result," in src, (
        "Engine no longer sets `Result = result` on the completion "
        "progress callback. The hub bridge would have no payload."
    )


def test_engine_fires_started_callback_before_execute_scenario() -> None:
    """The hub broadcasts QaScenarioStarted from the engine's Isolate-phase
    progress event. If that callback disappears, the UI never sees a card
    until after the scenario finishes (worst possible UX)."""
    src = _engine()
    assert "Phase = ExecutionPhase.Isolate," in src, (
        "Engine does not emit a Phase=Isolate progress callback before "
        "ExecuteScenarioAsync. The hub uses that signal to broadcast "
        "QaScenarioStarted with the scenario's metadata."
    )


# ─── Hub conversion bridge ────────────────────────────────────────────────


def test_hub_has_scenario_conversion_helper() -> None:
    """Wire-format QaSubmittedScenario → engine-format Scenario conversion
    must exist; the engine doesn't accept string-typed enums or boxed
    JSON elements."""
    src = _hub()
    assert "ConvertSubmittedToEngineScenario" in src, (
        "Hub is missing ConvertSubmittedToEngineScenario — without it "
        "the engine cannot consume scenarios submitted from the JS "
        "curation UI."
    )
    assert "ParseScenarioCategory" in src and "ParseExpectationType" in src, (
        "Hub is missing the typed enum parsers. The engine's Scenario model uses enums; the wire payload is strings."
    )
