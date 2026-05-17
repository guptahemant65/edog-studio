// <copyright file="EdogQaExecutionEngine.cs" company="Microsoft">
// Copyright (c) Microsoft Corporation. All rights reserved.
// </copyright>

#nullable disable
#pragma warning disable // DevMode-only file — suppress all warnings

namespace Microsoft.LiveTable.Service.DevMode
{
    using System;
    using System.Collections.Generic;
    using System.Diagnostics;
    using System.IO;
    using System.Linq;
    using System.Text.Json;
    using System.Threading;
    using System.Threading.Tasks;

    using Microsoft.Extensions.DependencyInjection;
    using Microsoft.Extensions.Logging;

    // ═══════════════════════════════════════════════════════════════════
    // EdogQaExecutionEngine — 8-phase orchestrator (C03)
    //
    // Lifecycle per scenario:
    //   Phase 1 (ISOLATE):   session = recording.Create(topics)
    //   Phase 2 (SETUP):     apply chaos rules + flag overrides + state seeds
    //   Phase 3 (MARK):      T0 = now
    //   Phase 4 (STIMULATE): stimResult = dispatcher.Execute(stimulus)
    //   Phase 5 (CAPTURE):   poll events until all expectations met or timeout
    //   Phase 6 (EVALUATE):  verdict = assertion.Evaluate(events, expectations, T0)
    //   Phase 7 (TEARDOWN):  remove chaos, restore flags, dispose session (ALWAYS)
    //   Phase 8 (REPORT):    build ScenarioResult
    //
    // Safety: never crashes the host. Every error path recovers or degrades.
    // Performance: orchestration overhead < 50ms per scenario (excl stimulus+capture).
    // ═══════════════════════════════════════════════════════════════════

    /// <summary>
    /// Sequential scenario execution engine. Runs inside the FLT process.
    /// Executes a list of <see cref="Scenario"/> objects through the 8-phase state machine,
    /// coordinating <see cref="EdogQaStimulusDispatcher"/>, <see cref="EdogQaAssertionEngine"/>,
    /// <see cref="EdogQaRecordingSession"/>, and <see cref="EdogQaResultAggregator"/>.
    ///
    /// Thread-safety: single run at a time (enforced by <c>_runLock</c>).
    /// The engine is reusable across runs — state is per-invocation.
    ///
    /// Performance contract:
    ///   - Orchestration overhead per scenario: less than 50ms (excluding stimulus + capture)
    ///   - Inter-scenario gap: 500ms (configurable)
    ///   - Max run duration: 30 minutes (hard ceiling)
    ///   - Memory per scenario: less than 100MB (recording buffer limit)
    /// </summary>
    public sealed class EdogQaExecutionEngine
    {
        private readonly EdogQaStimulusDispatcher _stimulusDispatcher;
        private readonly EdogQaResultAggregator _resultAggregator;
        private readonly EdogQaCodeAnalyzer _codeAnalyzer;
        private readonly ChaosIntegration _chaos;
        private readonly FlagOverrideStore _flagStore;
        private readonly ExecutionStateManager _stateManager;
        private readonly ILogger<EdogQaExecutionEngine> _logger;
        private readonly IServiceProvider _serviceProvider;

        // Current run state — guarded by _runLock
        private readonly object _runLock = new();
        private CancellationTokenSource _killSwitch;
        private volatile ExecutionPhase _currentPhase;
        private volatile string _currentScenarioId;
        private volatile int _completedCount;
        private volatile int _totalCount;
        private volatile bool _isRunning;

        private const int InterScenarioGapMs = 500;
        private const int MaxRunDurationMs = 30 * 60 * 1000; // 30 minutes
        private const int MaxEventsPerScenario = 50_000;
        private const int CapturePollingIntervalMs = 100;
        private const int AbsenceGracePeriodMs = 2_000;
        private const int SafetyCheckRetries = 3;
        private const int SafetyCheckDelayMs = 200;

        /// <summary>
        /// Initializes a new instance of the <see cref="EdogQaExecutionEngine"/> class.
        /// </summary>
        /// <param name="stimulusDispatcher">Routes stimulus execution to type-specific handlers.</param>
        /// <param name="resultAggregator">Collects per-scenario results into aggregated run result.</param>
        /// <param name="codeAnalyzer">Roslyn-based code analysis for impact zones.</param>
        /// <param name="logger">Logger instance.</param>
        /// <param name="serviceProvider">DI container for resolving optional dependencies.</param>
        public EdogQaExecutionEngine(
            EdogQaStimulusDispatcher stimulusDispatcher,
            EdogQaResultAggregator resultAggregator,
            EdogQaCodeAnalyzer codeAnalyzer,
            ILogger<EdogQaExecutionEngine> logger,
            IServiceProvider serviceProvider)
        {
            _stimulusDispatcher = stimulusDispatcher ?? throw new ArgumentNullException(nameof(stimulusDispatcher));
            _resultAggregator = resultAggregator;
            _codeAnalyzer = codeAnalyzer;
            _logger = logger ?? throw new ArgumentNullException(nameof(logger));
            _serviceProvider = serviceProvider ?? throw new ArgumentNullException(nameof(serviceProvider));

            _chaos = new ChaosIntegration(logger);
            _flagStore = new FlagOverrideStore(logger);
            _stateManager = new ExecutionStateManager(logger);
        }

        // ─── Public API ─────────────────────────────────────────────

        /// <summary>
        /// Execute a full QA run: iterate scenarios sequentially through the 8-phase loop.
        /// Called by EdogPlaygroundHub.ExecuteRun().
        /// </summary>
        /// <param name="runId">Unique run identifier, e.g. "run-20250615-143022".</param>
        /// <param name="scenarios">Ordered list of scenarios to execute.</param>
        /// <param name="onProgress">Progress callback invoked after each scenario completes.</param>
        /// <param name="ct">External cancellation token (e.g. from client disconnect).</param>
        /// <returns>Aggregated run result with per-scenario verdicts.</returns>
        public async Task<RunResult> ExecuteRunAsync(
            string runId,
            List<Scenario> scenarios,
            Action<QaExecutionProgress> onProgress,
            CancellationToken ct)
        {
            if (string.IsNullOrEmpty(runId))
                throw new ArgumentException("RunId is required.", nameof(runId));
            if (scenarios == null || scenarios.Count == 0)
                throw new ArgumentException("At least one scenario is required.", nameof(scenarios));

            lock (_runLock)
            {
                if (_isRunning)
                    throw new InvalidOperationException("A run is already in progress. Call KillRun() first.");
                _isRunning = true;
            }

            // Linked CTS: external cancellation OR 30-minute hard ceiling OR manual kill
            _killSwitch = CancellationTokenSource.CreateLinkedTokenSource(ct);
            _killSwitch.CancelAfter(MaxRunDurationMs);

            var linkedCt = _killSwitch.Token;
            var runStarted = DateTimeOffset.UtcNow;
            var scenarioResults = new List<ScenarioResult>();

            _totalCount = scenarios.Count;
            _completedCount = 0;

            _logger.LogInformation("[QA] Run {RunId} starting with {Count} scenarios", runId, scenarios.Count);

            try
            {
                // Check for crash recovery — resume interrupted run
                var interrupted = _stateManager.CheckForInterruptedRun();
                if (interrupted != null && interrupted.RunId == runId)
                {
                    _logger.LogWarning("[QA] Resuming interrupted run {RunId}", runId);
                    var resumeInfo = FilterResumedScenarios(scenarios, interrupted);
                    scenarios = resumeInfo.Remaining;
                    scenarioResults.AddRange(resumeInfo.AlreadyCompleted);
                    _completedCount = scenarioResults.Count;
                }

                string previousScenarioId = null;

                foreach (var scenario in scenarios)
                {
                    linkedCt.ThrowIfCancellationRequested();

                    // Persist state for crash recovery
                    await _stateManager.PersistStateAsync(new ExecutionState
                    {
                        RunId = runId,
                        StartedAt = runStarted,
                        TotalScenarios = _totalCount,
                        CurrentScenario = scenario.Id,
                        CurrentPhase = ExecutionPhase.Isolate,
                        CompletedScenarios = scenarioResults.Select(r => new CompletedScenarioRef
                        {
                            Id = r.ScenarioId,
                            Result = r.Verdict.ToString().ToUpperInvariant(),
                            CompletedAt = r.CompletedAt,
                        }).ToList(),
                        PendingScenarios = scenarios
                            .Skip(scenarios.IndexOf(scenario) + 1)
                            .Select(s => s.Id)
                            .ToList(),
                    }).ConfigureAwait(false);

                    // Notify subscribers that the scenario is starting. Carries
                    // Phase=Isolate and Result=null so the hub can broadcast
                    // QaScenarioStarted without inventing data. The completion
                    // callback below runs with Phase=Report once the scenario
                    // finishes through all 8 phases.
                    try
                    {
                        onProgress?.Invoke(new QaExecutionProgress
                        {
                            ScenarioId = scenario.Id,
                            CompletedCount = _completedCount,
                            TotalCount = _totalCount,
                            Phase = ExecutionPhase.Isolate,
                            Result = null,
                        });
                    }
                    catch (Exception ex)
                    {
                        _logger.LogWarning(ex, "[QA] Start-callback threw for {Id}", scenario.Id);
                    }

                    // Execute the scenario through 8 phases
                    ScenarioResult result;
                    try
                    {
                        result = await ExecuteScenarioAsync(scenario, runId, linkedCt).ConfigureAwait(false);
                    }
                    catch (OperationCanceledException) when (_killSwitch.IsCancellationRequested && !ct.IsCancellationRequested)
                    {
                        // Kill switch or 30-min ceiling — mark remaining as skipped
                        result = BuildCrashedResult(scenario, "Run aborted via kill switch or time ceiling");
                        scenarioResults.Add(result);
                        _completedCount++;
                        _logger.LogWarning("[QA] Run aborted at scenario {Id}", scenario.Id);
                        break;
                    }
                    catch (OperationCanceledException)
                    {
                        // External cancellation — propagate
                        throw;
                    }
                    catch (Exception ex)
                    {
                        _logger.LogError(ex, "[QA] Scenario {Id} crashed unexpectedly", scenario.Id);
                        result = BuildCrashedResult(scenario, ex.Message);
                    }

                    scenarioResults.Add(result);
                    _resultAggregator?.AddScenarioResult(result);
                    _completedCount++;

                    // Report progress
                    try
                    {
                        onProgress?.Invoke(new QaExecutionProgress
                        {
                            ScenarioId = scenario.Id,
                            Verdict = result.Verdict,
                            CompletedCount = _completedCount,
                            TotalCount = _totalCount,
                            Phase = ExecutionPhase.Report,
                            Result = result,
                        });
                    }
                    catch (Exception ex)
                    {
                        _logger.LogWarning(ex, "[QA] Progress callback threw for {Id}", scenario.Id);
                    }

                    // Inter-scenario gap + safety checks
                    if (previousScenarioId != null)
                    {
                        await RunInterScenarioSafetyAsync(previousScenarioId, linkedCt).ConfigureAwait(false);
                    }

                    previousScenarioId = scenario.Id;
                }

                // Build aggregated result
                var runResult = BuildRunResult(runId, runStarted, scenarioResults);

                // Clean up state file on successful completion
                _stateManager.DeleteState();

                _logger.LogInformation(
                    "[QA] Run {RunId} completed: {Passed}/{Total} passed in {Duration}ms",
                    runId, runResult.Summary.Passed, runResult.Summary.Total, runResult.TotalDurationMs);

                return runResult;
            }
            catch (OperationCanceledException)
            {
                // Build partial result for what completed
                var partialResult = BuildRunResult(runId, runStarted, scenarioResults);
                _stateManager.DeleteState();
                _logger.LogWarning("[QA] Run {RunId} cancelled with {Count} completed", runId, scenarioResults.Count);
                return partialResult;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "[QA] Run {RunId} failed catastrophically", runId);
                _stateManager.DeleteState();
                return BuildRunResult(runId, runStarted, scenarioResults);
            }
            finally
            {
                lock (_runLock)
                {
                    _isRunning = false;
                }

                _killSwitch?.Dispose();
                _killSwitch = null;
                _currentScenarioId = null;

                PublishQaEvent("RunCompleted", new { runId, completedScenarios = scenarioResults.Count });
            }
        }

        /// <summary>
        /// Abort the current run immediately via the kill switch CTS.
        /// Safe to call from any thread. Idempotent.
        /// </summary>
        public void KillRun()
        {
            _logger.LogWarning("[QA] Kill switch activated");
            try
            {
                _killSwitch?.Cancel();
            }
            catch (ObjectDisposedException)
            {
                // Already disposed — run completed before kill arrived
            }
        }

        /// <summary>
        /// Returns a snapshot of current execution state for the UI progress panel.
        /// Thread-safe — reads volatile fields.
        /// </summary>
        /// <returns>Current execution state or null if no run is active.</returns>
        public QaExecutionState GetCurrentState()
        {
            if (!_isRunning) return null;

            return new QaExecutionState
            {
                IsRunning = _isRunning,
                CurrentScenarioId = _currentScenarioId,
                CurrentPhase = _currentPhase,
                CompletedCount = _completedCount,
                TotalCount = _totalCount,
            };
        }

        // ─── Private: 8-Phase Scenario Execution ────────────────────

        /// <summary>
        /// Execute a single scenario through all 8 phases.
        /// Teardown ALWAYS runs via finally block.
        /// Only <see cref="OperationCanceledException"/> escapes for kill switch propagation.
        /// </summary>
        private async Task<ScenarioResult> ExecuteScenarioAsync(
            Scenario scenario,
            string runId,
            CancellationToken ct)
        {
            _currentScenarioId = scenario.Id;
            var sw = Stopwatch.StartNew();
            EdogQaRecordingSession session = null;
            EdogQaAssertionEngine assertionEngine = null;

            var result = new ScenarioResult
            {
                ScenarioId = scenario.Id,
                Title = scenario.Title,
                Category = scenario.Category.ToString(),
                StartedAt = DateTimeOffset.UtcNow,
            };

            try
            {
                // ── Phase 1: ISOLATE ──
                _currentPhase = ExecutionPhase.Isolate;
                _logger.LogDebug("[QA] {Id} Phase 1: ISOLATE", scenario.Id);

                var topics = scenario.Expectations
                    .Select(e => e.Topic)
                    .Where(t => !string.IsNullOrEmpty(t))
                    .Distinct()
                    .ToArray();

                if (topics.Length == 0)
                {
                    result.Verdict = ScenarioVerdict.Skipped;
                    result.ErrorMessage = "No valid topics in expectations";
                    result.FailedAtPhase = ExecutionPhase.Isolate;
                    return result;
                }

                session = EdogQaRecordingSession.Create(
                    scenario.Id, topics, runId, MaxEventsPerScenario);

                // ── Phase 2: SETUP ──
                _currentPhase = ExecutionPhase.Setup;
                _logger.LogDebug("[QA] {Id} Phase 2: SETUP ({StepCount} steps)", scenario.Id, scenario.Setup?.Count ?? 0);

                if (scenario.Setup != null)
                {
                    foreach (var step in scenario.Setup)
                    {
                        ct.ThrowIfCancellationRequested();
                        try
                        {
                            await ExecuteSetupStepAsync(step, scenario.Id, ct).ConfigureAwait(false);
                        }
                        catch (OperationCanceledException) { throw; }
                        catch (ChaosUnavailableException ex)
                        {
                            // P5: a chaos rule was refused because the host
                            // does not support the requested fault. Mark the
                            // scenario skipped with the capability error code
                            // so the studio UI can render an explicit badge.
                            _logger.LogWarning(
                                "[QA] {Id} Setup chaos refused: {Reason}", scenario.Id, ex.Message);
                            EdogQaTelemetry.IncrementScenariosSkippedForCapability();
                            result.Verdict = ScenarioVerdict.Skipped;
                            result.ErrorMessage =
                                $"{EdogQaCapabilityRegistry.ErrorCodeChaosUnavailable}: {ex.Message}";
                            result.FailedAtPhase = ExecutionPhase.Setup;
                            return result;
                        }
                        catch (FlagOverrideUnavailableException ex)
                        {
                            // P5: a flag override was refused because the
                            // requested value is not supported (e.g. force-OFF).
                            _logger.LogWarning(
                                "[QA] {Id} Setup flag override refused: {Reason}", scenario.Id, ex.Message);
                            EdogQaTelemetry.IncrementScenariosSkippedForCapability();
                            result.Verdict = ScenarioVerdict.Skipped;
                            result.ErrorMessage =
                                $"{EdogQaCapabilityRegistry.ErrorCodeFlagOverrideUnavailable}: {ex.Message}";
                            result.FailedAtPhase = ExecutionPhase.Setup;
                            return result;
                        }
                        catch (Exception ex)
                        {
                            _logger.LogWarning(ex, "[QA] {Id} Setup step {Type} failed", scenario.Id, step.Type);
                            result.Verdict = ScenarioVerdict.Skipped;
                            result.ErrorMessage = $"Setup failed at {step.Type}: {ex.Message}";
                            result.FailedAtPhase = ExecutionPhase.Setup;
                            return result;
                        }
                    }
                }

                // ── Phase 3: MARK ──
                _currentPhase = ExecutionPhase.Mark;
                var t0 = DateTimeOffset.UtcNow;
                _logger.LogDebug("[QA] {Id} Phase 3: MARK T0={T0:O}", scenario.Id, t0);

                // ── Phase 4: STIMULATE ──
                _currentPhase = ExecutionPhase.Stimulate;
                _logger.LogDebug("[QA] {Id} Phase 4: STIMULATE ({Type})", scenario.Id, scenario.Stimulus?.Type);

                StimulusResult stimResult;
                try
                {
                    stimResult = await _stimulusDispatcher.ExecuteAsync(
                        scenario.Stimulus, scenario.TimeoutMs, ct).ConfigureAwait(false);
                }
                catch (OperationCanceledException) { throw; }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "[QA] {Id} Stimulus threw", scenario.Id);
                    result.Verdict = ScenarioVerdict.Failed;
                    result.ErrorMessage = $"Stimulus exception: {ex.Message}";
                    result.FailedAtPhase = ExecutionPhase.Stimulate;
                    return result;
                }

                if (!stimResult.Success)
                {
                    _logger.LogWarning("[QA] {Id} Stimulus returned error: {Error}", scenario.Id, stimResult.Error);
                    result.Verdict = ScenarioVerdict.Failed;
                    result.ErrorMessage = $"Stimulus error: {stimResult.Error}";
                    result.FailedAtPhase = ExecutionPhase.Stimulate;
                    return result;
                }

                // ── Phase 5: CAPTURE ──
                _currentPhase = ExecutionPhase.Capture;
                _logger.LogDebug("[QA] {Id} Phase 5: CAPTURE (timeout={Timeout}ms)", scenario.Id, scenario.TimeoutMs);

                // Create streaming assertion engine for capture polling
                assertionEngine = new EdogQaAssertionEngine(scenario, t0, (scenId, expId, passed) =>
                {
                    _logger.LogDebug("[QA] {ScenarioId} expectation {ExpId} resolved: {Passed}", scenId, expId, passed);
                });

                var captureOutcome = await RunCapturePhaseAsync(
                    session, assertionEngine, scenario, ct).ConfigureAwait(false);

                // ── Phase 6: EVALUATE ──
                _currentPhase = ExecutionPhase.Evaluate;
                _logger.LogDebug("[QA] {Id} Phase 6: EVALUATE", scenario.Id);

                var verdict = assertionEngine.ComputeVerdict();
                var expectationResults = verdict.ExpectationResults;
                var allEvents = session.GetAllCapturedEvents();

                result.Expectations = expectationResults;
                result.CapturedEvents = allEvents.ToList();
                result.EventsCaptured = allEvents.Count;

                // Determine scenario verdict
                if (verdict.Passed)
                {
                    result.Verdict = ScenarioVerdict.Passed;
                }
                else if (captureOutcome == CaptureOutcome.TimedOut && verdict.OnlyTimingFailures)
                {
                    result.Verdict = ScenarioVerdict.Partial;
                }
                else if (captureOutcome == CaptureOutcome.TimedOut)
                {
                    // Check if some expectations passed
                    bool anyPassed = expectationResults.Any(e => e.Status == ExpectationStatus.Passed);
                    bool anyFailed = expectationResults.Any(e => e.Status != ExpectationStatus.Passed);
                    result.Verdict = anyPassed && anyFailed ? ScenarioVerdict.Partial : ScenarioVerdict.TimedOut;
                }
                else
                {
                    bool anyPassed = expectationResults.Any(e => e.Status == ExpectationStatus.Passed);
                    bool anyFailed = expectationResults.Any(e => e.Status != ExpectationStatus.Passed);
                    result.Verdict = anyPassed && anyFailed ? ScenarioVerdict.Partial : ScenarioVerdict.Failed;
                }

                return result;
            }
            catch (OperationCanceledException)
            {
                // Propagate kill switch / external cancellation
                throw;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "[QA] {Id} Unexpected crash", scenario.Id);
                result.Verdict = ScenarioVerdict.Crashed;
                result.ErrorMessage = ex.ToString();
                result.FailedAtPhase = _currentPhase;
                return result;
            }
            finally
            {
                // ── Phase 7: TEARDOWN (ALWAYS runs) ──
                _currentPhase = ExecutionPhase.Teardown;
                _logger.LogDebug("[QA] {Id} Phase 7: TEARDOWN", scenario.Id);

                await RunTeardownSafeAsync(scenario).ConfigureAwait(false);
                session?.Dispose();

                // ── Phase 8: REPORT ──
                _currentPhase = ExecutionPhase.Report;
                sw.Stop();
                result.CompletedAt = DateTimeOffset.UtcNow;
                result.DurationMs = sw.ElapsedMilliseconds;

                PublishQaEvent("ScenarioCompleted", new
                {
                    scenarioId = scenario.Id,
                    verdict = result.Verdict.ToString(),
                    durationMs = result.DurationMs,
                    eventsCaptured = result.EventsCaptured,
                });

                _logger.LogInformation(
                    "[QA] {Id} completed: {Verdict} in {Duration}ms ({Events} events)",
                    scenario.Id, result.Verdict, result.DurationMs, result.EventsCaptured);
            }
        }

        // ─── Phase 5: Capture Loop ──────────────────────────────────

        /// <summary>
        /// Polls captured events at 100ms intervals, feeding them to the streaming
        /// assertion engine. Exits when all positive expectations are met (then waits
        /// the absence grace period) or when the scenario timeout expires.
        ///
        /// Absence assertions wait the full timeout + 2s grace before concluding absence.
        /// Performance: polling overhead less than 1ms per tick for less than 50 expectations.
        /// </summary>
        private async Task<CaptureOutcome> RunCapturePhaseAsync(
            EdogQaRecordingSession session,
            EdogQaAssertionEngine assertionEngine,
            Scenario scenario,
            CancellationToken ct)
        {
            using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeoutCts.CancelAfter(scenario.TimeoutMs);

            bool hasAbsenceExpectations = scenario.Expectations
                .Any(e => e.Type == ExpectationType.EventAbsent);

            try
            {
                while (!timeoutCts.Token.IsCancellationRequested)
                {
                    // Feed all captured events to the assertion engine
                    var events = session.GetAllCapturedEvents();
                    foreach (var evt in events)
                    {
                        assertionEngine.EvaluateEvent(evt);
                    }

                    // Check if all positive expectations are satisfied
                    if (assertionEngine.AllPositiveExpectationsSatisfied())
                    {
                        if (hasAbsenceExpectations)
                        {
                            // Wait grace period for absence checks to confirm no violations
                            _logger.LogDebug("[QA] {Id} All positive expectations met, waiting {Grace}ms absence grace",
                                scenario.Id, AbsenceGracePeriodMs);
                            try
                            {
                                await Task.Delay(AbsenceGracePeriodMs, timeoutCts.Token).ConfigureAwait(false);

                                // Re-evaluate after grace period
                                var finalEvents = session.GetAllCapturedEvents();
                                foreach (var evt in finalEvents)
                                {
                                    assertionEngine.EvaluateEvent(evt);
                                }
                            }
                            catch (OperationCanceledException) when (!ct.IsCancellationRequested)
                            {
                                // Scenario timeout during grace — that's fine, absence still holds
                            }
                        }

                        return CaptureOutcome.AllMet;
                    }

                    await Task.Delay(CapturePollingIntervalMs, timeoutCts.Token).ConfigureAwait(false);
                }
            }
            catch (OperationCanceledException) when (!ct.IsCancellationRequested)
            {
                // Scenario timeout (not external cancel) — feed final events
                var finalEvents = session.GetAllCapturedEvents();
                foreach (var evt in finalEvents)
                {
                    assertionEngine.EvaluateEvent(evt);
                }
            }

            return CaptureOutcome.TimedOut;
        }

        // ─── Setup / Teardown ───────────────────────────────────────

        /// <summary>
        /// Execute a single setup step based on its type discriminator.
        /// </summary>
        private async Task ExecuteSetupStepAsync(SetupStep step, string scenarioId, CancellationToken ct)
        {
            switch (step.Type)
            {
                case SetupStepType.ChaosRule:
                    await _chaos.ApplyChaosRuleAsync(step.ChaosRule, scenarioId, ct).ConfigureAwait(false);
                    break;

                case SetupStepType.FlagOverride:
                    await _flagStore.ApplyOverrideAsync(step.FlagOverride, scenarioId, ct).ConfigureAwait(false);
                    break;

                case SetupStepType.StateSeed:
                    await ExecuteStateSeedAsync(step.StateSeed, ct).ConfigureAwait(false);
                    break;

                case SetupStepType.Wait:
                    if (step.Wait != null && step.Wait.DurationMs > 0)
                    {
                        await Task.Delay(
                            Math.Min(step.Wait.DurationMs, 10_000), ct).ConfigureAwait(false);
                    }
                    break;

                default:
                    _logger.LogWarning("[QA] Unknown setup step type: {Type}", step.Type);
                    break;
            }
        }

        /// <summary>
        /// Execute a state seed step by issuing an HTTP request to pre-populate system state.
        /// </summary>
        private async Task ExecuteStateSeedAsync(StateSeedSpec seed, CancellationToken ct)
        {
            if (seed == null) return;

            _logger.LogDebug("[QA] StateSeed: {Method} {Url}", seed.Method, seed.Url);

            // State seeds use the stimulus dispatcher's HTTP infrastructure
            var seedStimulus = new Stimulus
            {
                Type = StimulusType.HttpRequest,
                HttpRequest = new HttpRequestSpec
                {
                    Method = seed.Method ?? "POST",
                    Path = seed.Url,
                    Body = seed.Body,
                },
            };

            var result = await _stimulusDispatcher.ExecuteAsync(seedStimulus, 10_000, ct).ConfigureAwait(false);
            if (!result.Success)
            {
                throw new InvalidOperationException($"State seed failed: {result.Error}");
            }
        }

        /// <summary>
        /// Teardown with full error suppression — never propagates exceptions.
        /// Removes chaos rules, clears flag overrides, executes explicit teardown steps.
        /// </summary>
        private async Task RunTeardownSafeAsync(Scenario scenario)
        {
            try
            {
                // Execute explicit teardown steps
                if (scenario.Teardown != null)
                {
                    foreach (var step in scenario.Teardown)
                    {
                        try
                        {
                            await ExecuteTeardownStepAsync(step, scenario.Id).ConfigureAwait(false);
                        }
                        catch (Exception ex)
                        {
                            _logger.LogWarning(ex, "[QA] Teardown step {Type} failed for {Id}", step.Type, scenario.Id);
                        }
                    }
                }

                // Always clean up chaos rules and flag overrides
                await _chaos.RemoveRulesForScenarioAsync(scenario.Id).ConfigureAwait(false);
                await _flagStore.ClearOverridesForScenarioAsync(scenario.Id).ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "[QA] Teardown cleanup failed for {Id}", scenario.Id);
            }
        }

        /// <summary>
        /// Execute a single teardown step. Errors are caught by the caller.
        /// </summary>
        private Task ExecuteTeardownStepAsync(TeardownStep step, string scenarioId)
        {
            switch (step.Type)
            {
                case TeardownStepType.RemoveChaosRule:
                    _logger.LogDebug("[QA] Teardown: removing chaos rules for {Id}", scenarioId);
                    return _chaos.RemoveRulesForScenarioAsync(scenarioId);

                case TeardownStepType.RestoreFlag:
                    _logger.LogDebug("[QA] Teardown: restoring flags for {Id}", scenarioId);
                    return _flagStore.ClearOverridesForScenarioAsync(scenarioId);

                case TeardownStepType.CleanupState:
                    _logger.LogDebug("[QA] Teardown: cleanup state for {Id}", scenarioId);
                    return Task.CompletedTask;

                default:
                    _logger.LogWarning("[QA] Unknown teardown step type: {Type}", step.Type);
                    return Task.CompletedTask;
            }
        }

        // ─── Inter-Scenario Safety ──────────────────────────────────

        /// <summary>
        /// Inter-scenario gap: 500ms wait + safety checks for orphan chaos/flag state.
        /// Retries up to 3 times before force-clearing orphan state.
        /// </summary>
        private async Task RunInterScenarioSafetyAsync(string previousScenarioId, CancellationToken ct)
        {
            try
            {
                await Task.Delay(InterScenarioGapMs, ct).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                return; // Run cancelled — skip safety checks
            }

            for (int attempt = 0; attempt < SafetyCheckRetries; attempt++)
            {
                var orphanChaos = _chaos.HasActiveRulesForScenario(previousScenarioId);
                var orphanFlags = _flagStore.HasActiveOverridesForScenario(previousScenarioId);

                if (!orphanChaos && !orphanFlags)
                    return; // Clean state

                if (attempt < SafetyCheckRetries - 1)
                {
                    _logger.LogDebug("[QA] Orphan state detected for {Id}, retry {Attempt}",
                        previousScenarioId, attempt + 1);
                    try
                    {
                        await Task.Delay(SafetyCheckDelayMs, ct).ConfigureAwait(false);
                    }
                    catch (OperationCanceledException)
                    {
                        return;
                    }
                }
                else
                {
                    // Force-clear on final attempt
                    _logger.LogWarning("[QA] Force-clearing orphan state for {Id}", previousScenarioId);
                    await _chaos.RemoveRulesForScenarioAsync(previousScenarioId).ConfigureAwait(false);
                    await _flagStore.ClearOverridesForScenarioAsync(previousScenarioId).ConfigureAwait(false);

                    PublishQaEvent("OrphanStateForceCleared", new { scenarioId = previousScenarioId });
                }
            }
        }

        // ─── Crash Recovery Helpers ─────────────────────────────────

        /// <summary>
        /// Filter scenarios for a resumed run: skip already-completed scenarios,
        /// mark the interrupted scenario as crashed.
        /// </summary>
        private ResumeInfo FilterResumedScenarios(List<Scenario> allScenarios, ExecutionState interrupted)
        {
            var completedIds = new HashSet<string>(
                interrupted.CompletedScenarios?.Select(c => c.Id) ?? Enumerable.Empty<string>());

            var alreadyCompleted = new List<ScenarioResult>();
            foreach (var comp in interrupted.CompletedScenarios ?? new List<CompletedScenarioRef>())
            {
                alreadyCompleted.Add(new ScenarioResult
                {
                    ScenarioId = comp.Id,
                    Verdict = ParseVerdict(comp.Result),
                    CompletedAt = comp.CompletedAt,
                    StartedAt = comp.CompletedAt, // approximate
                });
            }

            // Mark the scenario that was executing when crash occurred
            if (!string.IsNullOrEmpty(interrupted.CurrentScenario))
            {
                var crashedScenario = allScenarios.FirstOrDefault(s => s.Id == interrupted.CurrentScenario);
                if (crashedScenario != null && !completedIds.Contains(crashedScenario.Id))
                {
                    alreadyCompleted.Add(BuildCrashedResult(crashedScenario, "Interrupted by previous crash"));
                    completedIds.Add(crashedScenario.Id);
                }
            }

            var remaining = allScenarios.Where(s => !completedIds.Contains(s.Id)).ToList();

            return new ResumeInfo
            {
                AlreadyCompleted = alreadyCompleted,
                Remaining = remaining,
            };
        }

        private static ScenarioVerdict ParseVerdict(string result)
        {
            return result?.ToUpperInvariant() switch
            {
                "PASS" or "PASSED" => ScenarioVerdict.Passed,
                "FAIL" or "FAILED" => ScenarioVerdict.Failed,
                "TIMED_OUT" or "TIMEDOUT" => ScenarioVerdict.TimedOut,
                "PARTIAL" => ScenarioVerdict.Partial,
                "CRASHED" => ScenarioVerdict.Crashed,
                "SKIPPED" => ScenarioVerdict.Skipped,
                _ => ScenarioVerdict.Crashed,
            };
        }

        // ─── Result Builders ────────────────────────────────────────

        private static ScenarioResult BuildCrashedResult(Scenario scenario, string error)
        {
            return new ScenarioResult
            {
                ScenarioId = scenario.Id,
                Title = scenario.Title,
                Category = scenario.Category.ToString(),
                Verdict = ScenarioVerdict.Crashed,
                ErrorMessage = error,
                StartedAt = DateTimeOffset.UtcNow,
                CompletedAt = DateTimeOffset.UtcNow,
                DurationMs = 0,
            };
        }

        private static RunResult BuildRunResult(
            string runId,
            DateTimeOffset startedAt,
            List<ScenarioResult> scenarioResults)
        {
            var completedAt = DateTimeOffset.UtcNow;
            var totalMs = (long)(completedAt - startedAt).TotalMilliseconds;

            var summary = new RunSummary
            {
                Total = scenarioResults.Count,
                Passed = scenarioResults.Count(r => r.Verdict == ScenarioVerdict.Passed),
                Failed = scenarioResults.Count(r => r.Verdict == ScenarioVerdict.Failed),
                TimedOut = scenarioResults.Count(r => r.Verdict == ScenarioVerdict.TimedOut),
                Partial = scenarioResults.Count(r => r.Verdict == ScenarioVerdict.Partial),
                Crashed = scenarioResults.Count(r => r.Verdict == ScenarioVerdict.Crashed),
                Skipped = scenarioResults.Count(r => r.Verdict == ScenarioVerdict.Skipped),
            };

            var slowest = scenarioResults.OrderByDescending(r => r.DurationMs).FirstOrDefault();
            var performance = new PerformanceReport
            {
                SlowestScenarioMs = slowest?.DurationMs ?? 0,
                SlowestScenarioId = slowest?.ScenarioId,
                AverageScenarioMs = scenarioResults.Count > 0
                    ? (long)scenarioResults.Average(r => r.DurationMs)
                    : 0,
                TotalExecutionMs = scenarioResults.Sum(r => r.DurationMs),
                OverheadMs = totalMs - scenarioResults.Sum(r => r.DurationMs),
            };

            return new RunResult
            {
                RunId = runId,
                StartedAt = startedAt,
                CompletedAt = completedAt,
                TotalDurationMs = totalMs,
                Summary = summary,
                Scenarios = scenarioResults,
                Performance = performance,
            };
        }

        // ─── Topic Event Publishing ─────────────────────────────────

        /// <summary>
        /// Publish a QA event to the "qa" topic for UI consumption.
        /// Never throws — failures are silently swallowed.
        /// </summary>
        private static void PublishQaEvent(string eventName, object data)
        {
            try
            {
                EdogTopicRouter.Publish("qa", new
                {
                    @event = eventName,
                    timestamp = DateTimeOffset.UtcNow,
                    detail = data,
                });
            }
            catch
            {
                // Never propagate topic publishing failures
            }
        }

        // ─── Private Types ──────────────────────────────────────────

        private enum CaptureOutcome
        {
            AllMet,
            TimedOut,
        }

        private sealed class ResumeInfo
        {
            public List<ScenarioResult> AlreadyCompleted { get; set; } = new();
            public List<Scenario> Remaining { get; set; } = new();
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // QaExecutionProgress — progress callback payload
    // ═══════════════════════════════════════════════════════════════════

    /// <summary>
    /// Progress update emitted after each scenario completes.
    /// Used by the hub to push real-time updates to the QA Testing Panel.
    /// </summary>
    public sealed class QaExecutionProgress
    {
        /// <summary>ID of the scenario this progress event describes.</summary>
        public string ScenarioId { get; set; }

        /// <summary>Verdict of the completed scenario (Passed/Failed/etc).
        /// Meaningful only when <see cref="Phase"/> is <see cref="ExecutionPhase.Report"/>.</summary>
        public ScenarioVerdict Verdict { get; set; }

        /// <summary>Number of scenarios completed so far.</summary>
        public int CompletedCount { get; set; }

        /// <summary>Total number of scenarios in the run.</summary>
        public int TotalCount { get; set; }

        /// <summary>
        /// Lifecycle marker for the callback:
        /// <list type="bullet">
        ///   <item><see cref="ExecutionPhase.Isolate"/> — engine is about to start this scenario
        ///     (subscribers should emit a "scenario started" event).</item>
        ///   <item><see cref="ExecutionPhase.Report"/> — scenario has finished and
        ///     <see cref="Result"/> is populated.</item>
        /// </list>
        /// </summary>
        public ExecutionPhase Phase { get; set; }

        /// <summary>
        /// Full per-scenario result. Populated only when <see cref="Phase"/> is
        /// <see cref="ExecutionPhase.Report"/>; <c>null</c> on the Isolate (started)
        /// notification. Subscribers use this to emit <c>QaScenarioCompleted</c> with
        /// real verdicts, durations, and expectation outcomes.
        /// </summary>
        public ScenarioResult Result { get; set; }
    }

    // ═══════════════════════════════════════════════════════════════════
    // QaExecutionState — UI state snapshot
    // ═══════════════════════════════════════════════════════════════════

    /// <summary>
    /// Snapshot of current execution state for the QA Testing Panel UI.
    /// Returned by <see cref="EdogQaExecutionEngine.GetCurrentState"/>.
    /// </summary>
    public sealed class QaExecutionState
    {
        /// <summary>Whether a run is currently active.</summary>
        public bool IsRunning { get; set; }

        /// <summary>ID of the currently executing scenario.</summary>
        public string CurrentScenarioId { get; set; }

        /// <summary>Current phase of the active scenario.</summary>
        public ExecutionPhase CurrentPhase { get; set; }

        /// <summary>Number of scenarios completed so far.</summary>
        public int CompletedCount { get; set; }

        /// <summary>Total number of scenarios in the run.</summary>
        public int TotalCount { get; set; }
    }

    // ═══════════════════════════════════════════════════════════════════
    // ExecutionStateManager — crash recovery persistence
    //
    // Persists execution state to a JSON file after each scenario completes,
    // enabling run resumption if the FLT process crashes mid-run.
    // ═══════════════════════════════════════════════════════════════════

    /// <summary>
    /// Manages persistent execution state for crash recovery.
    /// Writes state to a JSON file in the current directory's .edog-qa/ folder.
    /// On restart, <see cref="CheckForInterruptedRun"/> detects incomplete runs
    /// and returns state for resumption.
    ///
    /// File format: <c>.edog-qa/execution-state.json</c>
    /// Uses <see cref="System.Text.Json"/> for serialization.
    /// </summary>
    internal sealed class ExecutionStateManager
    {
        private static readonly string StateDirectory = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "edog-studio", "qa-state");

        private static readonly string StateFilePath = Path.Combine(StateDirectory, "execution-state.json");

        private static readonly JsonSerializerOptions JsonOptions = new()
        {
            WriteIndented = true,
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        };

        private readonly ILogger _logger;

        /// <summary>
        /// Initializes a new instance of the <see cref="ExecutionStateManager"/> class.
        /// </summary>
        /// <param name="logger">Logger instance.</param>
        public ExecutionStateManager(ILogger logger)
        {
            _logger = logger;
        }

        /// <summary>
        /// Persists the current execution state to disk for crash recovery.
        /// Called after each scenario completes.
        /// </summary>
        /// <param name="state">Current execution state to persist.</param>
        public async Task PersistStateAsync(ExecutionState state)
        {
            try
            {
                Directory.CreateDirectory(StateDirectory);
                var json = JsonSerializer.Serialize(state, JsonOptions);
                await File.WriteAllTextAsync(StateFilePath, json).ConfigureAwait(false);
                _logger.LogDebug("[QA] State persisted: scenario={Id} phase={Phase}",
                    state.CurrentScenario, state.CurrentPhase);
            }
            catch (Exception ex)
            {
                // State persistence is best-effort — don't fail the run
                _logger.LogWarning(ex, "[QA] Failed to persist execution state");
            }
        }

        /// <summary>
        /// Check for an interrupted run from a previous crash.
        /// Returns the persisted state if found, null otherwise.
        /// </summary>
        /// <returns>Persisted execution state or null if no interrupted run exists.</returns>
        public ExecutionState CheckForInterruptedRun()
        {
            try
            {
                if (!File.Exists(StateFilePath))
                    return null;

                var json = File.ReadAllText(StateFilePath);
                var state = JsonSerializer.Deserialize<ExecutionState>(json, JsonOptions);

                if (state == null)
                {
                    DeleteState();
                    return null;
                }

                // Stale state check: if state is older than 1 hour, discard it
                if ((DateTimeOffset.UtcNow - state.StartedAt).TotalHours > 1)
                {
                    _logger.LogInformation("[QA] Discarding stale execution state from {Time}", state.StartedAt);
                    DeleteState();
                    return null;
                }

                _logger.LogInformation(
                    "[QA] Found interrupted run {RunId} at scenario {Id} phase {Phase}",
                    state.RunId, state.CurrentScenario, state.CurrentPhase);
                return state;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "[QA] Failed to read execution state, starting fresh");
                DeleteState();
                return null;
            }
        }

        /// <summary>
        /// Delete the persisted state file. Called on successful run completion.
        /// </summary>
        public void DeleteState()
        {
            try
            {
                if (File.Exists(StateFilePath))
                {
                    File.Delete(StateFilePath);
                    _logger.LogDebug("[QA] Execution state file deleted");
                }
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "[QA] Failed to delete execution state file");
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // ChaosIntegration — fault-injection bridge (F27 P5)
    //
    // Before P5 this class was a functional stub: it logged the request,
    // incremented a "NoOp" counter, and returned. A scenario that depended
    // on chaos to expose a failure path would therefore pass its assertions
    // silently. That is a lie. P5 fixes it.
    //
    // Stage 1 behaviour (this file): every chaos request is REFUSED via
    // <see cref="ChaosUnavailableException"/>. The execution engine catches
    // the exception, marks the scenario <see cref="ScenarioVerdict.Skipped"/>,
    // and surfaces the capability reason in the result. The legacy
    // ChaosNoOp counter still fires so existing telemetry test source-grep
    // assertions remain green — it now records refusals rather than lies.
    //
    // Stage 2 behaviour (follow-on commit): when the HTTP-chaos backend is
    // enabled (EDOG_QA_CHAOS_HTTP=1 + EdogHttpFaultStore wired), supported
    // fault types ("http_error", "latency", "timeout") flow into the store
    // and the HTTP pipeline synthesizes the configured fault. Unsupported
    // fault types (e.g. "partial_response") continue to throw.
    // ═══════════════════════════════════════════════════════════════════

    /// <summary>
    /// Bridges chaos fault injection into QA scenario setup/teardown.
    /// Tracks active rules per scenario for cleanup and orphan detection.
    /// Consults <see cref="EdogQaCapabilityRegistry"/> before applying each
    /// rule — unsupported faults raise <see cref="ChaosUnavailableException"/>
    /// rather than silently succeeding.
    /// </summary>
    internal sealed class ChaosIntegration
    {
        private readonly object _lock = new();
        private readonly Dictionary<string, List<ChaosRuleSpec>> _activeRules = new();
        private readonly ILogger _logger;

        /// <summary>
        /// Initializes a new instance of the <see cref="ChaosIntegration"/> class.
        /// </summary>
        /// <param name="logger">Logger instance.</param>
        public ChaosIntegration(ILogger logger)
        {
            _logger = logger;
        }

        /// <summary>
        /// Apply a chaos fault injection rule for a scenario.
        /// Refuses the rule with <see cref="ChaosUnavailableException"/> when
        /// the capability registry reports the fault as unsupported.
        /// </summary>
        /// <param name="rule">Chaos rule specification.</param>
        /// <param name="scenarioId">Owning scenario ID for cleanup tracking.</param>
        /// <param name="ct">Cancellation token.</param>
        public Task ApplyChaosRuleAsync(ChaosRuleSpec rule, string scenarioId, CancellationToken ct)
        {
            if (rule == null) return Task.CompletedTask;

            if (!EdogQaCapabilityRegistry.IsChaosFaultSupported(rule))
            {
                // Telemetry: record both legacy NoOp (the path is still a
                // no-op from the caller's POV — no fault is injected) and
                // the new Unavailable counter so the studio UI can show
                // "scenario skipped due to missing capability".
                EdogQaTelemetry.IncrementChaosNoOp();
                EdogQaTelemetry.IncrementChaosUnavailable();

                var reason = EdogQaCapabilityRegistry.GetChaosUnavailableReason(rule);
                _logger.LogWarning(
                    "[QA/Chaos] Refused chaos rule for {Scenario}: target={Target} fault={Fault} reason={Reason}",
                    scenarioId, rule.Target, rule.Fault, reason);

                throw new ChaosUnavailableException(
                    $"Chaos fault '{rule.Fault}' on target '{rule.Target}' is unavailable: {reason}");
            }

            // Stage 1 invariant: IsChaosFaultSupported returns false unless
            // EDOG_QA_CHAOS_HTTP=1 AND EdogHttpFaultStore is wired. Stage 2
            // will satisfy both. Reaching this branch implies the backend
            // accepted the rule, which is the truthful behaviour.
            lock (_lock)
            {
                if (!_activeRules.TryGetValue(scenarioId, out var rules))
                {
                    rules = new List<ChaosRuleSpec>();
                    _activeRules[scenarioId] = rules;
                }
                rules.Add(rule);
            }

            // Stage 2 wires this to EdogHttpFaultStore.AddRule. Until then,
            // this branch is unreachable by construction.
            EdogHttpFaultStore.AddRule(scenarioId, rule);
            EdogQaTelemetry.IncrementChaosApplied();
            _logger.LogInformation(
                "[QA/Chaos] Applied rule for {Scenario}: target={Target} fault={Fault}",
                scenarioId, rule.Target, rule.Fault);

            return Task.CompletedTask;
        }

        /// <summary>
        /// Remove all chaos rules for a scenario. Called during teardown.
        /// </summary>
        /// <param name="scenarioId">Scenario ID whose rules should be removed.</param>
        public Task RemoveRulesForScenarioAsync(string scenarioId)
        {
            List<ChaosRuleSpec> removed;
            lock (_lock)
            {
                _activeRules.TryGetValue(scenarioId, out removed);
                _activeRules.Remove(scenarioId);
            }

            if (removed != null && removed.Count > 0)
            {
                EdogHttpFaultStore.RemoveRulesForScenario(scenarioId);
                _logger.LogInformation(
                    "[QA/Chaos] Removed {Count} rules for {Scenario}",
                    removed.Count, scenarioId);
            }

            return Task.CompletedTask;
        }

        /// <summary>
        /// Check if any chaos rules are still active for a scenario.
        /// Used by inter-scenario safety checks.
        /// </summary>
        /// <param name="scenarioId">Scenario ID to check.</param>
        /// <returns>True if any rules are active.</returns>
        public bool HasActiveRulesForScenario(string scenarioId)
        {
            lock (_lock)
            {
                return _activeRules.TryGetValue(scenarioId, out var rules) && rules.Count > 0;
            }
        }

        /// <summary>
        /// Get count of active chaos rules across all scenarios. Diagnostic use.
        /// </summary>
        public int TotalActiveRuleCount
        {
            get
            {
                lock (_lock)
                {
                    return _activeRules.Values.Sum(r => r.Count);
                }
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // FlagOverrideStore — feature flag override management (F27 P5)
    //
    // Before P5 this class was a functional stub: it logged the request,
    // incremented a "NoOp" counter, and proceeded. Scenarios that depended
    // on a flag being on/off would PASS silently because the flag was
    // never actually overridden. P5 fixes it.
    //
    // P5 wires this directly to <see cref="EdogFeatureOverrideStore"/>:
    //   - Apply: validate via capability registry, MergeOverrides into the
    //     process-wide snapshot, track per-scenario keys for revert.
    //   - Clear: RemoveOverrides for this scenario's tracked keys only.
    //     Pre-existing overrides set via the dev-server HTTP control plane
    //     survive intact.
    //
    // Force-OFF (Value=false) is refused with
    // <see cref="FlagOverrideUnavailableException"/> because the override
    // store is force-ON only in V1. The legacy FlagOverrideNoOp counter
    // still fires on this refusal path so existing telemetry source-grep
    // tests stay green — it now records refusals rather than lies.
    // ═══════════════════════════════════════════════════════════════════

    /// <summary>
    /// Per-scenario tracker for feature-flag overrides. Pushes accepted
    /// overrides into the process-wide <see cref="EdogFeatureOverrideStore"/>
    /// at apply time and removes them at teardown.
    /// </summary>
    internal sealed class FlagOverrideStore
    {
        private readonly object _lock = new();
        private readonly Dictionary<string, List<FlagOverrideEntry>> _overrides = new();
        private readonly ILogger _logger;

        /// <summary>
        /// Initializes a new instance of the <see cref="FlagOverrideStore"/> class.
        /// </summary>
        /// <param name="logger">Logger instance.</param>
        public FlagOverrideStore(ILogger logger)
        {
            _logger = logger;
        }

        /// <summary>
        /// Apply a feature flag override for a scenario. Refuses with
        /// <see cref="FlagOverrideUnavailableException"/> when the capability
        /// registry cannot satisfy the request (e.g. force-OFF in V1).
        /// </summary>
        /// <param name="spec">Flag override specification.</param>
        /// <param name="scenarioId">Owning scenario ID for cleanup tracking.</param>
        /// <param name="ct">Cancellation token.</param>
        public Task ApplyOverrideAsync(FlagOverrideSpec spec, string scenarioId, CancellationToken ct)
        {
            if (spec == null) return Task.CompletedTask;

            if (!EdogQaCapabilityRegistry.IsFlagOverrideSupported(spec))
            {
                // Telemetry: legacy counter still fires (the call was a no-op
                // from the caller's POV); new counter records the refusal so
                // the studio UI can surface "scenario skipped due to missing
                // capability".
                EdogQaTelemetry.IncrementFlagOverrideNoOp();
                EdogQaTelemetry.IncrementFlagOverrideUnavailable();

                var reason = EdogQaCapabilityRegistry.GetFlagOverrideUnavailableReason(spec);
                _logger.LogWarning(
                    "[QA/Flags] Refused override for {Scenario}: {Flag}={Value} reason={Reason}",
                    scenarioId, spec?.FlagName, spec?.Value, reason);

                throw new FlagOverrideUnavailableException(
                    $"Flag override for '{spec?.FlagName}' is unavailable: {reason}");
            }

            // Snapshot any pre-existing override for this key BEFORE we
            // merge our own. If the dev-server HTTP control plane (or a
            // prior scenario) already set this flag, we record that fact
            // so teardown can leave the key intact instead of clobbering
            // an externally-owned override. Force-ON only ⇒ the prior
            // value (if any) can only be true.
            var hadPriorOverride = EdogFeatureOverrideStore.TryGet(spec.FlagName, out var priorValue);

            // Push into the process-wide override store. MergeOverrides is
            // atomic (write lock); readers in EdogFeatureFlighterWrapper see
            // either the pre- or post-merge snapshot, never a partial one.
            var additions = new Dictionary<string, bool>(StringComparer.Ordinal)
            {
                { spec.FlagName, spec.Value },
            };

            try
            {
                EdogFeatureOverrideStore.MergeOverrides(additions);
            }
            catch (ArgumentException ex)
            {
                // Defense in depth: should never trip because the capability
                // probe above already rejected force-OFF. Surface as the
                // same unavailable exception so the engine path is uniform.
                EdogQaTelemetry.IncrementFlagOverrideNoOp();
                EdogQaTelemetry.IncrementFlagOverrideUnavailable();
                _logger.LogWarning(ex,
                    "[QA/Flags] EdogFeatureOverrideStore rejected merge for {Scenario}: {Flag}",
                    scenarioId, spec.FlagName);
                throw new FlagOverrideUnavailableException(
                    $"Flag override for '{spec.FlagName}' was rejected by EdogFeatureOverrideStore: {ex.Message}",
                    ex);
            }

            lock (_lock)
            {
                if (!_overrides.TryGetValue(scenarioId, out var entries))
                {
                    entries = new List<FlagOverrideEntry>();
                    _overrides[scenarioId] = entries;
                }

                entries.Add(new FlagOverrideEntry
                {
                    FlagName = spec.FlagName,
                    OverrideValue = spec.Value,
                    OriginalValue = hadPriorOverride ? priorValue : (bool?)null,
                });
            }

            EdogQaTelemetry.IncrementFlagOverrideApplied();
            _logger.LogInformation(
                "[QA/Flags] Applied override for {Scenario}: {Flag}={Value}",
                scenarioId, spec.FlagName, spec.Value);

            return Task.CompletedTask;
        }

        /// <summary>
        /// Clear all flag overrides for a scenario by removing only this
        /// scenario's keys from the process-wide override store. Other
        /// overrides (from other scenarios or the dev-server control plane)
        /// are preserved.
        /// </summary>
        /// <param name="scenarioId">Scenario ID whose overrides should be cleared.</param>
        public Task ClearOverridesForScenarioAsync(string scenarioId)
        {
            List<FlagOverrideEntry> removed;
            lock (_lock)
            {
                _overrides.TryGetValue(scenarioId, out removed);
                _overrides.Remove(scenarioId);
            }

            if (removed != null && removed.Count > 0)
            {
                // Only remove keys that this scenario INTRODUCED. Keys that
                // already had an override before the scenario ran are owned
                // by someone else (dev-server control plane or a prior
                // scenario in the same run) — leaving them intact preserves
                // external intent and avoids the "QA teardown wipes a
                // developer-set flag" footgun.
                var keys = new List<string>(removed.Count);
                var preserved = 0;
                foreach (var entry in removed)
                {
                    if (string.IsNullOrEmpty(entry.FlagName)) continue;
                    if (entry.OriginalValue.HasValue)
                    {
                        preserved++;
                        continue;
                    }
                    keys.Add(entry.FlagName);
                }

                if (keys.Count > 0)
                {
                    EdogFeatureOverrideStore.RemoveOverrides(keys);
                    EdogQaTelemetry.IncrementFlagOverrideRestored();
                }

                _logger.LogInformation(
                    "[QA/Flags] Cleared {Removed} overrides for {Scenario} (preserved {Preserved} pre-existing)",
                    keys.Count, scenarioId, preserved);
            }

            return Task.CompletedTask;
        }

        /// <summary>
        /// Check if any flag overrides are still active for a scenario.
        /// Used by inter-scenario safety checks.
        /// </summary>
        /// <param name="scenarioId">Scenario ID to check.</param>
        /// <returns>True if any overrides are active.</returns>
        public bool HasActiveOverridesForScenario(string scenarioId)
        {
            lock (_lock)
            {
                return _overrides.TryGetValue(scenarioId, out var entries) && entries.Count > 0;
            }
        }

        /// <summary>
        /// Get count of active flag overrides across all scenarios. Diagnostic use.
        /// </summary>
        public int TotalActiveOverrideCount
        {
            get
            {
                lock (_lock)
                {
                    return _overrides.Values.Sum(e => e.Count);
                }
            }
        }

        /// <summary>
        /// Internal tracking entry for a single flag override.
        /// </summary>
        private sealed class FlagOverrideEntry
        {
            public string FlagName { get; set; }
            public bool OverrideValue { get; set; }
            public bool? OriginalValue { get; set; }
        }
    }
}
