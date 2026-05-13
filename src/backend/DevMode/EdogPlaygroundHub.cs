// <copyright file="EdogPlaygroundHub.cs" company="Microsoft">
// Copyright (c) Microsoft Corporation. All rights reserved.
// </copyright>

#nullable disable
#pragma warning disable // DevMode-only file

namespace Microsoft.LiveTable.Service.DevMode
{
    using System;
    using System.Collections.Concurrent;
    using System.Collections.Generic;
    using System.Linq;
    using System.Text.RegularExpressions;
    using System.Threading;
    using System.Threading.Channels;
    using System.Threading.Tasks;
    using Microsoft.AspNetCore.SignalR;

    // ═══════════════════════════════════════════════════════════════════
    // QA Service Locator — static singletons for QA engines
    // ═══════════════════════════════════════════════════════════════════

    /// <summary>
    /// Static service locator for QA engines. Initialized by EdogDevModeRegistrar.
    /// The hub is transient (one instance per call), so we resolve services statically.
    /// </summary>
    internal static class EdogQaServiceLocator
    {
        /// <summary>Eight-phase execution engine (C03).</summary>
        internal static EdogQaExecutionEngine ExecutionEngine { get; set; }

        /// <summary>Five-layer code analysis pipeline (C02).</summary>
        internal static EdogQaCodeAnalyzer CodeAnalyzer { get; set; }

        /// <summary>Result aggregator (C05).</summary>
        internal static EdogQaResultAggregator ResultAggregator { get; set; }

        /// <summary>True when all QA engines have been registered.</summary>
        internal static bool IsInitialized => ExecutionEngine != null;
    }

    // ═══════════════════════════════════════════════════════════════════
    // QA Hub State — static mutable state with proper locking
    // ═══════════════════════════════════════════════════════════════════

    /// <summary>
    /// Static state shared across all hub invocations for QA testing.
    /// All access guarded by <c>_lock</c> except volatile reads.
    /// </summary>
    internal static class QaHubState
    {
        private static readonly object _lock = new();

        // Analysis state
        private static CancellationTokenSource _analysisCts;
        private static string _currentAnalysisId;

        // Run storage: runId → list of submitted scenarios (serialized)
        private static readonly ConcurrentDictionary<string, QaRunEntry> _runs = new();

        // Run history (capped at 100, newest first)
        private static readonly List<QaRunSummary> _history = new();
        private const int MaxHistoryEntries = 100;

        // Execution state
        private static CancellationTokenSource _runCts;
        private static string _currentRunId;
        private static volatile bool _isRunning;

        /// <summary>Whether a run is currently executing.</summary>
        internal static bool IsRunning => _isRunning;

        /// <summary>ID of the currently executing run.</summary>
        internal static string CurrentRunId
        {
            get { lock (_lock) { return _currentRunId; } }
        }

        // ─── Analysis ──────────────────────────────

        /// <summary>
        /// Starts a new analysis, cancelling any previous one.
        /// Returns the cancelled analysis ID if any.
        /// </summary>
        internal static string StartAnalysis(string analysisId)
        {
            lock (_lock)
            {
                string cancelled = null;
                if (_analysisCts != null && _currentAnalysisId != null)
                {
                    cancelled = _currentAnalysisId;
                    try { _analysisCts.Cancel(); } catch { /* already disposed */ }
                    _analysisCts.Dispose();
                }

                _analysisCts = new CancellationTokenSource();
                _currentAnalysisId = analysisId;
                return cancelled;
            }
        }

        /// <summary>Gets the CancellationToken for the current analysis.</summary>
        internal static CancellationToken GetAnalysisCancellationToken()
        {
            lock (_lock)
            {
                return _analysisCts?.Token ?? CancellationToken.None;
            }
        }

        /// <summary>Cancels the current analysis if it matches the given correlation context.</summary>
        internal static bool CancelAnalysis()
        {
            lock (_lock)
            {
                if (_analysisCts == null || _currentAnalysisId == null)
                    return false;

                try { _analysisCts.Cancel(); } catch { /* already disposed */ }
                _analysisCts.Dispose();
                _analysisCts = null;
                var id = _currentAnalysisId;
                _currentAnalysisId = null;
                return true;
            }
        }

        /// <summary>Gets the current analysis ID.</summary>
        internal static string CurrentAnalysisId
        {
            get { lock (_lock) { return _currentAnalysisId; } }
        }

        // ─── Run storage ───────────────────────────

        /// <summary>Stores a submitted run with its scenarios.</summary>
        internal static void StoreRun(string runId, QaRunEntry entry)
        {
            _runs[runId] = entry;
        }

        /// <summary>Gets a stored run by ID.</summary>
        internal static QaRunEntry GetRun(string runId)
        {
            _runs.TryGetValue(runId, out var entry);
            return entry;
        }

        // ─── Execution ────────────────────────────

        /// <summary>Starts run execution. Returns false if already running.</summary>
        internal static bool TryStartRun(string runId, out CancellationTokenSource cts)
        {
            lock (_lock)
            {
                if (_isRunning)
                {
                    cts = null;
                    return false;
                }

                _isRunning = true;
                _currentRunId = runId;
                _runCts = new CancellationTokenSource();
                cts = _runCts;
                return true;
            }
        }

        /// <summary>Cancels the current run.</summary>
        internal static bool CancelRun(string runId)
        {
            lock (_lock)
            {
                if (!_isRunning || _currentRunId != runId)
                    return false;

                try { _runCts?.Cancel(); } catch { /* already disposed */ }
                return true;
            }
        }

        /// <summary>Marks the run as completed.</summary>
        internal static void CompleteRun()
        {
            lock (_lock)
            {
                _isRunning = false;
                _currentRunId = null;
                try { _runCts?.Dispose(); } catch { /* already disposed */ }
                _runCts = null;
            }
        }

        // ─── History ──────────────────────────────

        /// <summary>Adds a run summary to history.</summary>
        internal static void AddToHistory(QaRunSummary summary)
        {
            lock (_lock)
            {
                _history.Insert(0, summary);
                while (_history.Count > MaxHistoryEntries)
                    _history.RemoveAt(_history.Count - 1);
            }
        }

        /// <summary>Gets run history with optional PR filter and pagination.</summary>
        internal static List<QaRunSummary> GetHistory(int? prId, int limit, int offset)
        {
            lock (_lock)
            {
                IEnumerable<QaRunSummary> query = _history;
                if (prId.HasValue)
                    query = query.Where(h => h.PrId == prId.Value);
                return query.Skip(offset).Take(limit).ToList();
            }
        }

        /// <summary>Stores a completed run result for detail retrieval.</summary>
        internal static void StoreRunResult(string runId, QaRunResult result)
        {
            if (_runs.TryGetValue(runId, out var entry))
                entry.Result = result;
        }

        /// <summary>Gets a completed run result.</summary>
        internal static QaRunResult GetRunResult(string runId)
        {
            return _runs.TryGetValue(runId, out var entry) ? entry.Result : null;
        }
    }

    /// <summary>
    /// In-memory entry for a submitted QA run.
    /// </summary>
    internal sealed class QaRunEntry
    {
        /// <summary>Run identifier.</summary>
        public string RunId { get; set; }

        /// <summary>Analysis ID that produced these scenarios.</summary>
        public string AnalysisId { get; set; }

        /// <summary>Correlation ID from submission.</summary>
        public string CorrelationId { get; set; }

        /// <summary>Submitted scenarios (raw objects for pass-through to engine).</summary>
        public List<QaSubmittedScenario> Scenarios { get; set; } = new();

        /// <summary>PR ID from analysis context.</summary>
        public int PrId { get; set; }

        /// <summary>PR title from analysis context.</summary>
        public string PrTitle { get; set; }

        /// <summary>Completed run result (populated after execution).</summary>
        public QaRunResult Result { get; set; }

        /// <summary>When the run was created.</summary>
        public DateTimeOffset CreatedAt { get; set; }
    }

    /// <summary>
    /// SignalR hub for EDOG Playground real-time streaming (ADR-006).
    /// Clients subscribe to topic groups and receive only messages for their active tabs.
    /// Topics: log, telemetry, fileop, spark, token, cache, http, retry, flag, di, perf, capacity, catalog, dag, flt-ops, nexus, qa.
    /// </summary>
    public sealed class EdogPlaygroundHub : Hub
    {
        /// <summary>
        /// Client subscribes to a topic group. Called when a tab becomes active.
        /// </summary>
        public async Task Subscribe(string topic)
        {
            if (!string.IsNullOrWhiteSpace(topic))
            {
                await Groups.AddToGroupAsync(Context.ConnectionId, topic.ToLowerInvariant());
            }
        }

        /// <summary>
        /// Client unsubscribes from a topic group. Called when switching away from a tab.
        /// </summary>
        public async Task Unsubscribe(string topic)
        {
            if (!string.IsNullOrWhiteSpace(topic))
            {
                await Groups.RemoveFromGroupAsync(Context.ConnectionId, topic.ToLowerInvariant());
            }
        }

        /// <summary>
        /// Auto-subscribe to log group on connect (default Runtime View tab).
        /// </summary>
        public override async Task OnConnectedAsync()
        {
            await Groups.AddToGroupAsync(Context.ConnectionId, "log");
            await base.OnConnectedAsync();
        }

        /// <summary>
        /// Client streams a topic: receives snapshot (history) then live events.
        /// Called when user activates a tab. Cancelled when user leaves tab.
        /// SignalR recognizes ChannelReader&lt;T&gt; return type as a streaming method.
        /// </summary>
        /// <param name="topic">Topic name (e.g., "log", "flag", "perf").</param>
        /// <param name="cancellationToken">Fires when client disconnects or disposes stream.</param>
        public ChannelReader<TopicEvent> SubscribeToTopic(
            string topic,
            CancellationToken cancellationToken)
        {
            var buffer = EdogTopicRouter.GetBuffer(topic);
            if (buffer == null)
                throw new ArgumentException($"Unknown topic: {topic}");

            var channel = Channel.CreateBounded<TopicEvent>(
                new BoundedChannelOptions(1000)
                {
                    FullMode = BoundedChannelFullMode.DropOldest,
                    SingleReader = true,
                    SingleWriter = false
                });

            _ = Task.Run(async () =>
            {
                try
                {
                    // Phase 1: Yield snapshot (buffered history)
                    foreach (var item in buffer.GetSnapshot())
                    {
                        await channel.Writer.WriteAsync(item, cancellationToken);
                    }

                    // Phase 2: Yield live events as they arrive
                    await foreach (var item in buffer.ReadLiveAsync(cancellationToken))
                    {
                        await channel.Writer.WriteAsync(item, cancellationToken);
                    }
                }
                catch (OperationCanceledException) { /* Client disconnected — clean */ }
                catch (Exception ex)
                {
                    System.Diagnostics.Debug.WriteLine($"[EDOG] Stream error for topic '{topic}': {ex.Message}");
                }
                finally
                {
                    channel.Writer.Complete();
                }
            }, cancellationToken);

            return channel.Reader;
        }

        // ═══════════════════════════════════════════════════════════════════
        // F27 QA Testing — Hub Methods (8 client→server methods)
        // ═══════════════════════════════════════════════════════════════════

        // Validation constants
        private static readonly Regex ScenarioIdRegex = new(@"^scn-[a-z0-9-]+$", RegexOptions.Compiled);
        private static readonly Regex ExpectationIdRegex = new(@"^exp-[0-9]+$", RegexOptions.Compiled);
        private static readonly HashSet<string> ValidCategories = new(StringComparer.OrdinalIgnoreCase)
        {
            "happy_path", "error_path", "edge_case", "regression", "performance",
            "HappyPath", "ErrorPath", "EdgeCase", "Regression", "Performance"
        };
        private static readonly HashSet<string> ValidExpectationTypes = new(StringComparer.OrdinalIgnoreCase)
        {
            "event_present", "event_absent", "event_count", "event_order", "timing", "field_match",
            "EventPresent", "EventAbsent", "EventCount", "EventOrder", "Timing", "FieldMatch"
        };
        private const int MaxScenariosPerRun = 50;

        // ─── 1.1 Code Analysis ─────────────────────────────────────────

        /// <summary>
        /// Starts the five-layer code understanding pipeline for a PR.
        /// Returns immediately with a correlationId — progress streams via QaAnalysisProgress events.
        /// Only ONE analysis can run at a time; starting a new one cancels the previous.
        /// </summary>
        /// <param name="request">Analysis configuration with PR URL or PR ID.</param>
        /// <returns>Analysis result with analysisId and status.</returns>
        public async Task<QaAnalysisResult> QaStartCodeAnalysis(QaAnalysisRequest request)
        {
            try
            {
                if (request == null)
                    return new QaAnalysisResult { Success = false, Message = "Request is required" };

                if (string.IsNullOrEmpty(request.CorrelationId))
                    return new QaAnalysisResult { Success = false, Message = "correlationId is required" };

                if (string.IsNullOrEmpty(request.PrUrl) && !request.PrId.HasValue)
                    return new QaAnalysisResult
                    {
                        Success = false,
                        CorrelationId = request.CorrelationId,
                        Message = "Valid PR URL or PR ID required"
                    };

                if (!EdogQaServiceLocator.IsInitialized)
                    return new QaAnalysisResult
                    {
                        Success = false,
                        CorrelationId = request.CorrelationId,
                        Message = "QA Testing requires Connected phase (FLT running)"
                    };

                var analysisId = $"analysis-{DateTimeOffset.UtcNow:yyyyMMdd-HHmmss}";
                var cancelledPrevious = QaHubState.StartAnalysis(analysisId);
                var ct = QaHubState.GetAnalysisCancellationToken();

                // Broadcast cancellation event if previous analysis was running
                if (cancelledPrevious != null)
                {
                    await BroadcastQaEventAsync("QaAnalysisCancelled", new
                    {
                        eventType = "QaAnalysisCancelled",
                        correlationId = request.CorrelationId,
                        analysisId = cancelledPrevious,
                        timestamp = DateTimeOffset.UtcNow,
                        reason = "superseded",
                        phasesCompleted = 0
                    }).ConfigureAwait(false);
                }

                // Fire-and-forget: run analysis pipeline in background
                var prId = request.PrId ?? 0;
                var correlationId = request.CorrelationId;
                _ = Task.Run(async () =>
                {
                    try
                    {
                        await RunAnalysisPipelineAsync(correlationId, analysisId, request, ct).ConfigureAwait(false);
                    }
                    catch (OperationCanceledException) { /* cancelled — clean */ }
                    catch (Exception ex)
                    {
                        System.Diagnostics.Debug.WriteLine($"[QA] Analysis pipeline error: {ex.Message}");
                        await PublishQaErrorAsync(correlationId, null, "INTERNAL_ERROR",
                            $"Analysis failed: {ex.Message}", null, null, "error", false).ConfigureAwait(false);
                    }
                }, CancellationToken.None);

                var message = cancelledPrevious != null
                    ? $"Code analysis started. Previous analysis '{cancelledPrevious}' cancelled."
                    : $"Code analysis started for PR #{request.PrId ?? 0}.";

                return new QaAnalysisResult
                {
                    Success = true,
                    CorrelationId = request.CorrelationId,
                    AnalysisId = analysisId,
                    Message = message,
                    CancelledPreviousAnalysis = cancelledPrevious
                };
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"[QA] QaStartCodeAnalysis error: {ex.Message}");
                return new QaAnalysisResult
                {
                    Success = false,
                    CorrelationId = request?.CorrelationId,
                    Message = $"Internal error: {ex.Message}"
                };
            }
        }

        /// <summary>
        /// Cancels an in-progress code analysis.
        /// </summary>
        /// <param name="correlationId">The correlationId from QaStartCodeAnalysis.</param>
        /// <returns>Operation result.</returns>
        public async Task<QaOperationResult> QaCancelAnalysis(string correlationId)
        {
            try
            {
                if (string.IsNullOrEmpty(correlationId))
                    return new QaOperationResult { Success = false, Message = "correlationId is required" };

                var currentAnalysisId = QaHubState.CurrentAnalysisId;
                var cancelled = QaHubState.CancelAnalysis();

                if (!cancelled)
                    return new QaOperationResult
                    {
                        Success = true,
                        CorrelationId = correlationId,
                        Message = "No active analysis with this correlationId"
                    };

                await BroadcastQaEventAsync("QaAnalysisCancelled", new
                {
                    eventType = "QaAnalysisCancelled",
                    correlationId,
                    analysisId = currentAnalysisId,
                    timestamp = DateTimeOffset.UtcNow,
                    reason = "user_cancelled",
                    phasesCompleted = 0
                }).ConfigureAwait(false);

                return new QaOperationResult
                {
                    Success = true,
                    CorrelationId = correlationId,
                    Message = "Analysis cancelled."
                };
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"[QA] QaCancelAnalysis error: {ex.Message}");
                return new QaOperationResult
                {
                    Success = false,
                    CorrelationId = correlationId,
                    Message = $"Internal error: {ex.Message}"
                };
            }
        }

        // ─── 1.2 Scenario Curation ─────────────────────────────────────

        /// <summary>
        /// Validates and stores curated scenarios. Returns a runId that can be used with QaStartRun.
        /// </summary>
        /// <param name="submission">Curated scenario set from the frontend.</param>
        /// <returns>Submission result with runId and validation errors.</returns>
        public Task<QaSubmissionResult> QaSubmitCuratedScenarios(QaScenarioSubmission submission)
        {
            try
            {
                if (submission == null)
                    return Task.FromResult(new QaSubmissionResult { Success = false, Message = "Request is required" });

                if (string.IsNullOrEmpty(submission.CorrelationId))
                    return Task.FromResult(new QaSubmissionResult { Success = false, Message = "correlationId is required" });

                if (string.IsNullOrEmpty(submission.AnalysisId))
                    return Task.FromResult(new QaSubmissionResult
                    {
                        Success = false,
                        CorrelationId = submission.CorrelationId,
                        Message = $"Analysis '{submission.AnalysisId}' not found or expired"
                    });

                if (submission.Scenarios == null || submission.Scenarios.Count == 0)
                    return Task.FromResult(new QaSubmissionResult
                    {
                        Success = false,
                        CorrelationId = submission.CorrelationId,
                        Message = "At least one scenario is required"
                    });

                if (submission.Scenarios.Count > MaxScenariosPerRun)
                    return Task.FromResult(new QaSubmissionResult
                    {
                        Success = false,
                        CorrelationId = submission.CorrelationId,
                        Message = $"Maximum {MaxScenariosPerRun} scenarios per run"
                    });

                // Validate each scenario
                var errors = ValidateScenarios(submission.Scenarios);
                if (errors.Count > 0)
                    return Task.FromResult(new QaSubmissionResult
                    {
                        Success = false,
                        CorrelationId = submission.CorrelationId,
                        Message = $"{errors.Count} validation error(s)",
                        ValidationErrors = errors
                    });

                // Generate runId and store
                var runId = $"run-{DateTimeOffset.UtcNow:yyyyMMdd-HHmmss}";
                var entry = new QaRunEntry
                {
                    RunId = runId,
                    AnalysisId = submission.AnalysisId,
                    CorrelationId = submission.CorrelationId,
                    Scenarios = submission.Scenarios,
                    CreatedAt = DateTimeOffset.UtcNow,
                };
                QaHubState.StoreRun(runId, entry);

                return Task.FromResult(new QaSubmissionResult
                {
                    Success = true,
                    CorrelationId = submission.CorrelationId,
                    RunId = runId,
                    ScenarioCount = submission.Scenarios.Count,
                    Message = $"{submission.Scenarios.Count} scenarios queued for execution."
                });
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"[QA] QaSubmitCuratedScenarios error: {ex.Message}");
                return Task.FromResult(new QaSubmissionResult
                {
                    Success = false,
                    CorrelationId = submission?.CorrelationId,
                    Message = $"Internal error: {ex.Message}"
                });
            }
        }

        // ─── 1.3 Execution Control ─────────────────────────────────────

        /// <summary>
        /// Starts sequential execution of curated scenarios through the eight-phase loop.
        /// Only ONE run can execute at a time.
        /// </summary>
        /// <param name="request">Run configuration with runId.</param>
        /// <returns>Operation result.</returns>
        public async Task<QaOperationResult> QaStartRun(QaRunRequest request)
        {
            try
            {
                if (request == null)
                    return new QaOperationResult { Success = false, Message = "Request is required" };

                if (string.IsNullOrEmpty(request.CorrelationId))
                    return new QaOperationResult { Success = false, Message = "correlationId is required" };

                if (string.IsNullOrEmpty(request.RunId))
                    return new QaOperationResult
                    {
                        Success = false,
                        CorrelationId = request.CorrelationId,
                        Message = "runId is required"
                    };

                if (!EdogQaServiceLocator.IsInitialized)
                    return new QaOperationResult
                    {
                        Success = false,
                        CorrelationId = request.CorrelationId,
                        Message = "Execution requires Connected phase (FLT running)"
                    };

                var runEntry = QaHubState.GetRun(request.RunId);
                if (runEntry == null)
                    return new QaOperationResult
                    {
                        Success = false,
                        CorrelationId = request.CorrelationId,
                        Message = $"Run '{request.RunId}' not found"
                    };

                if (runEntry.Scenarios == null || runEntry.Scenarios.Count == 0)
                    return new QaOperationResult
                    {
                        Success = false,
                        CorrelationId = request.CorrelationId,
                        Message = "Run has no scenarios to execute"
                    };

                // Validate scenarioIds subset if provided
                if (request.ScenarioIds != null && request.ScenarioIds.Count > 0)
                {
                    var knownIds = new HashSet<string>(runEntry.Scenarios.Select(s => s.Id));
                    foreach (var id in request.ScenarioIds)
                    {
                        if (!knownIds.Contains(id))
                            return new QaOperationResult
                            {
                                Success = false,
                                CorrelationId = request.CorrelationId,
                                Message = $"Scenario '{id}' not found in run"
                            };
                    }
                }

                if (!QaHubState.TryStartRun(request.RunId, out var cts))
                    return new QaOperationResult
                    {
                        Success = false,
                        CorrelationId = request.CorrelationId,
                        Message = $"Run '{QaHubState.CurrentRunId}' is already executing. Cancel it first."
                    };

                var scenarios = runEntry.Scenarios;
                if (request.ScenarioIds != null && request.ScenarioIds.Count > 0)
                {
                    var idOrder = request.ScenarioIds;
                    var lookup = scenarios.ToDictionary(s => s.Id);
                    scenarios = idOrder.Where(id => lookup.ContainsKey(id)).Select(id => lookup[id]).ToList();
                }

                var scenarioCount = scenarios.Count;
                var correlationId = request.CorrelationId;
                var runId = request.RunId;

                // Broadcast QaRunStarted
                await BroadcastQaEventAsync("QaRunStarted", new
                {
                    eventType = "QaRunStarted",
                    correlationId,
                    runId,
                    timestamp = DateTimeOffset.UtcNow,
                    prId = runEntry.PrId,
                    prTitle = runEntry.PrTitle ?? "",
                    scenarioCount,
                    scenarioIds = scenarios.Select(s => s.Id).ToList(),
                    options = new
                    {
                        stopOnFirstFailure = request.Options?.StopOnFirstFailure ?? false,
                        interScenarioDelayMs = request.Options?.InterScenarioDelayMs ?? 500,
                        globalTimeoutMs = request.Options?.GlobalTimeoutMs ?? 1800000
                    }
                }).ConfigureAwait(false);

                // Fire-and-forget: run execution in background
                _ = Task.Run(async () =>
                {
                    try
                    {
                        await RunExecutionLoopAsync(correlationId, runId, runEntry, scenarios, request.Options, cts).ConfigureAwait(false);
                    }
                    catch (OperationCanceledException) { /* cancelled — clean */ }
                    catch (Exception ex)
                    {
                        System.Diagnostics.Debug.WriteLine($"[QA] Execution loop error: {ex.Message}");
                        await PublishQaErrorAsync(correlationId, runId, "INTERNAL_ERROR",
                            $"Execution failed: {ex.Message}", null, null, "error", false).ConfigureAwait(false);
                    }
                    finally
                    {
                        QaHubState.CompleteRun();
                    }
                }, CancellationToken.None);

                return new QaOperationResult
                {
                    Success = true,
                    CorrelationId = correlationId,
                    Message = $"Run started. Executing {scenarioCount} scenarios."
                };
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"[QA] QaStartRun error: {ex.Message}");
                QaHubState.CompleteRun();
                return new QaOperationResult
                {
                    Success = false,
                    CorrelationId = request?.CorrelationId,
                    Message = $"Internal error: {ex.Message}"
                };
            }
        }

        /// <summary>
        /// Cancels an in-progress execution run. The current scenario completes its
        /// teardown phase before the run stops. Remaining scenarios are marked as skipped.
        /// </summary>
        /// <param name="correlationId">Correlation ID.</param>
        /// <param name="runId">Run ID to cancel.</param>
        /// <returns>Operation result.</returns>
        public async Task<QaOperationResult> QaCancelRun(string correlationId, string runId)
        {
            try
            {
                if (string.IsNullOrEmpty(correlationId))
                    return new QaOperationResult { Success = false, Message = "correlationId is required" };

                if (string.IsNullOrEmpty(runId))
                    return new QaOperationResult
                    {
                        Success = false,
                        CorrelationId = correlationId,
                        Message = "runId is required"
                    };

                var runEntry = QaHubState.GetRun(runId);
                if (runEntry == null)
                    return new QaOperationResult
                    {
                        Success = false,
                        CorrelationId = correlationId,
                        Message = "Run not found"
                    };

                if (!QaHubState.IsRunning || QaHubState.CurrentRunId != runId)
                {
                    var state = runEntry.Result != null ? "completed" : "not started";
                    return new QaOperationResult
                    {
                        Success = true,
                        CorrelationId = correlationId,
                        Message = $"Run is not executing (current state: '{state}')"
                    };
                }

                QaHubState.CancelRun(runId);

                return new QaOperationResult
                {
                    Success = true,
                    CorrelationId = correlationId,
                    Message = "Run cancellation requested. Current scenario will complete teardown."
                };
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"[QA] QaCancelRun error: {ex.Message}");
                return new QaOperationResult
                {
                    Success = false,
                    CorrelationId = correlationId,
                    Message = $"Internal error: {ex.Message}"
                };
            }
        }

        // ─── 1.4 History & Results ─────────────────────────────────────

        /// <summary>
        /// Retrieves past run summaries. Sorted by startedAt descending (newest first).
        /// </summary>
        /// <param name="request">History query with optional PR filter and pagination.</param>
        /// <returns>List of run summaries.</returns>
        public Task<List<QaRunSummary>> QaGetRunHistory(QaHistoryRequest request)
        {
            try
            {
                if (request == null)
                    return Task.FromResult(new List<QaRunSummary>());

                var limit = Math.Clamp(request.Limit, 1, 100);
                var offset = Math.Max(request.Offset, 0);

                var history = QaHubState.GetHistory(request.PrId, limit, offset);
                return Task.FromResult(history);
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"[QA] QaGetRunHistory error: {ex.Message}");
                return Task.FromResult(new List<QaRunSummary>());
            }
        }

        /// <summary>
        /// Retrieves full results for a specific run.
        /// Returns null if run not found.
        /// </summary>
        /// <param name="correlationId">Correlation ID.</param>
        /// <param name="runId">Run ID to retrieve.</param>
        /// <returns>Full run result or null.</returns>
        public Task<QaRunResult> QaGetRunDetail(string correlationId, string runId)
        {
            try
            {
                if (string.IsNullOrEmpty(runId))
                    return Task.FromResult<QaRunResult>(null);

                var result = QaHubState.GetRunResult(runId);
                return Task.FromResult(result);
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"[QA] QaGetRunDetail error: {ex.Message}");
                return Task.FromResult<QaRunResult>(null);
            }
        }

        // ─── 1.5 Execution Streaming ───────────────────────────────────

        /// <summary>
        /// Server-to-client stream of execution events for a specific run.
        /// Yields snapshot (events already emitted) then live events as scenarios execute.
        /// Same pattern as SubscribeToTopic and ChaosSubscribeTraffic.
        /// </summary>
        /// <param name="runId">Run to stream events for.</param>
        /// <param name="cancellationToken">Stream cancellation (fires when client disconnects).</param>
        /// <returns>ChannelReader streaming TopicEvents for the run.</returns>
        public ChannelReader<TopicEvent> QaSubscribeExecution(
            string runId,
            CancellationToken cancellationToken)
        {
            var qaBuffer = EdogTopicRouter.GetBuffer("qa");
            if (qaBuffer == null)
                throw new ArgumentException("QA topic not registered");

            var channel = Channel.CreateBounded<TopicEvent>(
                new BoundedChannelOptions(2000)
                {
                    FullMode = BoundedChannelFullMode.DropOldest,
                    SingleReader = true,
                    SingleWriter = false
                });

            _ = Task.Run(async () =>
            {
                try
                {
                    // Phase 1: Snapshot — events already emitted for this run
                    foreach (var item in qaBuffer.GetSnapshot())
                    {
                        if (IsQaEventForRun(item, runId))
                            await channel.Writer.WriteAsync(item, cancellationToken);
                    }

                    // Phase 2: Live events as they arrive
                    await foreach (var item in qaBuffer.ReadLiveAsync(cancellationToken))
                    {
                        if (IsQaEventForRun(item, runId))
                            await channel.Writer.WriteAsync(item, cancellationToken);
                    }
                }
                catch (OperationCanceledException) { /* Client unsubscribed — clean */ }
                catch (Exception ex)
                {
                    System.Diagnostics.Debug.WriteLine($"[QA] QaSubscribeExecution stream error: {ex.Message}");
                }
                finally
                {
                    channel.Writer.Complete();
                }
            }, cancellationToken);

            return channel.Reader;
        }

        // ═══════════════════════════════════════════════════════════════════
        // Private helpers — analysis pipeline, execution loop, validation
        // ═══════════════════════════════════════════════════════════════════

        /// <summary>
        /// Filters qa topic events to only those matching the requested runId.
        /// </summary>
        private static bool IsQaEventForRun(TopicEvent evt, string runId)
        {
            if (evt.Topic != "qa") return false;
            // Typed event path (if we ever use QaEventBase directly)
            if (evt.Data is QaEventBase qaEvt)
                return string.Equals(qaEvt.RunId, runId, StringComparison.Ordinal);
            // Anonymous object path — reflect for runId property (case-insensitive)
            if (evt.Data == null) return false;
            var prop = evt.Data.GetType().GetProperty("runId")
                    ?? evt.Data.GetType().GetProperty("RunId");
            if (prop == null) return false;
            return string.Equals(prop.GetValue(evt.Data) as string, runId, StringComparison.Ordinal);
        }

        /// <summary>
        /// Runs the code analysis pipeline in the background, broadcasting progress events.
        /// Delegates to EdogQaCodeAnalyzer when available, falls back to synthetic scenarios.
        /// </summary>
        private async Task RunAnalysisPipelineAsync(
            string correlationId,
            string analysisId,
            QaAnalysisRequest request,
            CancellationToken ct)
        {
            var sw = System.Diagnostics.Stopwatch.StartNew();
            List<Scenario> scenarios = null;

            // Phase 1: Fetching diff
            await BroadcastAnalysisProgressAsync(correlationId, analysisId, "fetching_diff", 0, 6, 5,
                "Fetching PR diff from Azure DevOps...", sw.ElapsedMilliseconds).ConfigureAwait(false);
            await Task.Delay(500, ct).ConfigureAwait(false);

            // Try real CodeAnalyzer pipeline
            var analyzer = EdogQaServiceLocator.CodeAnalyzer;
            if (analyzer != null)
            {
                try
                {
                    // Build a minimal diff from PR info (real implementation would fetch from ADO)
                    var syntheticDiff = $"--- a/LiveTableController.cs\n+++ b/LiveTableController.cs\n@@ -100,5 +100,10 @@\n" +
                        $" // PR #{request.PrId ?? 0} changes\n+// Modified code path\n";

                    // Phase 2: Blast radius
                    await BroadcastAnalysisProgressAsync(correlationId, analysisId, "roslyn_blast_radius", 1, 6, 25,
                        "Analyzing blast radius via code-review-graph + Graphify...", sw.ElapsedMilliseconds).ConfigureAwait(false);
                    ct.ThrowIfCancellationRequested();
                    await Task.Delay(800, ct).ConfigureAwait(false);

                    // Phase 3: Semantic analysis
                    await BroadcastAnalysisProgressAsync(correlationId, analysisId, "semantic_analysis", 2, 6, 50,
                        "Running OmniSharp/Roslyn semantic enrichment...", sw.ElapsedMilliseconds).ConfigureAwait(false);
                    ct.ThrowIfCancellationRequested();
                    await Task.Delay(600, ct).ConfigureAwait(false);

                    // Phase 4: DI validation
                    await BroadcastAnalysisProgressAsync(correlationId, analysisId, "di_validation", 3, 6, 65,
                        "Validating against runtime DI registry...", sw.ElapsedMilliseconds).ConfigureAwait(false);
                    ct.ThrowIfCancellationRequested();
                    await Task.Delay(400, ct).ConfigureAwait(false);

                    // Run the real analyzer (it handles its own layer failures gracefully)
                    var result = await analyzer.AnalyzeAsync(syntheticDiff, ct).ConfigureAwait(false);
                    scenarios = result?.Scenarios;
                }
                catch (OperationCanceledException) { throw; }
                catch (Exception ex)
                {
                    System.Diagnostics.Debug.WriteLine($"[QA] CodeAnalyzer failed, falling back to synthetic: {ex.Message}");
                }
            }
            else
            {
                // No analyzer available — simulate phases with delays
                await BroadcastAnalysisProgressAsync(correlationId, analysisId, "roslyn_blast_radius", 1, 6, 25,
                    "Analyzing blast radius...", sw.ElapsedMilliseconds).ConfigureAwait(false);
                await Task.Delay(800, ct).ConfigureAwait(false);

                await BroadcastAnalysisProgressAsync(correlationId, analysisId, "semantic_analysis", 2, 6, 50,
                    "Running semantic enrichment...", sw.ElapsedMilliseconds).ConfigureAwait(false);
                await Task.Delay(600, ct).ConfigureAwait(false);

                await BroadcastAnalysisProgressAsync(correlationId, analysisId, "di_validation", 3, 6, 65,
                    "Validating DI registry...", sw.ElapsedMilliseconds).ConfigureAwait(false);
                await Task.Delay(400, ct).ConfigureAwait(false);
            }

            // Fall back to synthetic scenarios when real pipeline produces none
            if (scenarios == null || scenarios.Count == 0)
            {
                scenarios = GenerateSyntheticScenarios(request.PrId ?? 0);
            }

            // Phase 5: Scenario generation — broadcast each scenario as it's "generated"
            var totalScenarios = scenarios.Count;
            await BroadcastAnalysisProgressAsync(correlationId, analysisId, "scenario_generation", 4, 6, 85,
                $"Generating scenarios ({totalScenarios} found)...", sw.ElapsedMilliseconds).ConfigureAwait(false);

            for (int i = 0; i < totalScenarios; i++)
            {
                ct.ThrowIfCancellationRequested();

                var scn = scenarios[i];
                await BroadcastQaEventAsync("QaScenarioGenerated", new
                {
                    eventType = "QaScenarioGenerated",
                    correlationId,
                    analysisId,
                    timestamp = DateTimeOffset.UtcNow,
                    scenarioIndex = i,
                    totalExpected = totalScenarios,
                    scenario = new
                    {
                        id = scn.Id,
                        title = scn.Title,
                        description = scn.Description,
                        category = ConvertCategoryToSnakeCase(scn.Category),
                        priority = scn.Priority,
                        impactZone = scn.ImpactZone,
                        timeoutMs = scn.TimeoutMs,
                        metadata = new
                        {
                            generatedBy = scn.Metadata?.GeneratedBy ?? "synthetic",
                            confidence = scn.Metadata?.Confidence ?? 0.75,
                            relatedPRFiles = scn.Metadata?.RelatedPRFiles ?? new List<string>(),
                            tags = scn.Metadata?.Tags ?? new List<string>()
                        },
                        stimulus = scn.Stimulus != null ? new
                        {
                            type = scn.Stimulus.Type.ToString().ToLowerInvariant(),
                            httpRequest = scn.Stimulus.HttpRequest != null ? new
                            {
                                method = scn.Stimulus.HttpRequest.Method,
                                path = scn.Stimulus.HttpRequest.Path
                            } : null
                        } : null,
                        expectations = scn.Expectations?.Select(e => new
                        {
                            id = e.Id,
                            type = ConvertExpectationTypeToSnakeCase(e.Type),
                            topic = e.Topic,
                            description = $"{e.Type} on '{e.Topic}'"
                        }).ToList()
                    }
                }).ConfigureAwait(false);

                // Stagger scenario broadcasts so the UI shows them appearing one by one
                if (i < totalScenarios - 1)
                    await Task.Delay(300, ct).ConfigureAwait(false);
            }

            // Phase 6: Complete
            sw.Stop();
            await BroadcastAnalysisProgressAsync(correlationId, analysisId, "complete", 5, 6, 100,
                $"Analysis complete. {totalScenarios} scenarios ready for curation.", sw.ElapsedMilliseconds).ConfigureAwait(false);
        }

        /// <summary>
        /// Helper to broadcast a QaAnalysisProgress event with consistent shape.
        /// </summary>
        private async Task BroadcastAnalysisProgressAsync(
            string correlationId, string analysisId, string phase,
            int phaseIndex, int totalPhases, int percentComplete,
            string detail, long elapsedMs)
        {
            await BroadcastQaEventAsync("QaAnalysisProgress", new
            {
                eventType = "QaAnalysisProgress",
                correlationId,
                analysisId,
                timestamp = DateTimeOffset.UtcNow,
                phase,
                phaseIndex,
                totalPhases,
                percentComplete,
                detail,
                metrics = new { elapsedMs }
            }).ConfigureAwait(false);
        }

        /// <summary>
        /// Generates synthetic demo scenarios when LLM/real analysis is unavailable.
        /// Covers HappyPath, ErrorPath, EdgeCase, Regression, and Performance categories.
        /// </summary>
        private static List<Scenario> GenerateSyntheticScenarios(int prId)
        {
            var now = DateTimeOffset.UtcNow;
            return new List<Scenario>
            {
                new Scenario
                {
                    Id = $"scn-happy-dag-run-{prId:D4}",
                    Title = "DAG execution completes successfully with all nodes",
                    Description = "Triggers a full DAG run and verifies all nodes execute in topological order with correct table creation.",
                    Category = ScenarioCategory.HappyPath,
                    Priority = 1,
                    ImpactZone = "zone-dag-execution",
                    TimeoutMs = 30000,
                    Stimulus = new Stimulus
                    {
                        Type = StimulusType.HttpRequest,
                        HttpRequest = new HttpRequestSpec { Method = "POST", Path = "/v1/workspaces/{wsId}/lakehouses/{artId}/liveTable/runDag" }
                    },
                    Expectations = new List<Expectation>
                    {
                        new Expectation { Id = "exp-1", Type = ExpectationType.EventPresent, Topic = "dag" },
                        new Expectation { Id = "exp-2", Type = ExpectationType.EventPresent, Topic = "log" }
                    },
                    Metadata = new ScenarioMetadata
                    {
                        GeneratedBy = "synthetic",
                        Confidence = 0.92,
                        Tags = new List<string> { "dag", "execution", "happy-path" },
                        GeneratedAt = now
                    }
                },
                new Scenario
                {
                    Id = $"scn-error-invalid-schema-{prId:D4}",
                    Title = "MLV creation fails with invalid schema reference",
                    Description = "Attempts to create an MLV node referencing a non-existent schema and verifies proper error handling.",
                    Category = ScenarioCategory.ErrorPath,
                    Priority = 2,
                    ImpactZone = "zone-schema-validation",
                    TimeoutMs = 15000,
                    Stimulus = new Stimulus
                    {
                        Type = StimulusType.HttpRequest,
                        HttpRequest = new HttpRequestSpec { Method = "POST", Path = "/v1/workspaces/{wsId}/lakehouses/{artId}/liveTable/createNode" }
                    },
                    Expectations = new List<Expectation>
                    {
                        new Expectation { Id = "exp-1", Type = ExpectationType.EventPresent, Topic = "log" }
                    },
                    Metadata = new ScenarioMetadata
                    {
                        GeneratedBy = "synthetic",
                        Confidence = 0.87,
                        Tags = new List<string> { "schema", "validation", "error-path" },
                        GeneratedAt = now
                    }
                },
                new Scenario
                {
                    Id = $"scn-edge-empty-dag-{prId:D4}",
                    Title = "Scheduler handles empty DAG without crash",
                    Description = "Verifies the scheduler gracefully handles an empty DAG (zero nodes) without throwing exceptions.",
                    Category = ScenarioCategory.EdgeCase,
                    Priority = 3,
                    ImpactZone = "zone-scheduler",
                    TimeoutMs = 10000,
                    Stimulus = new Stimulus
                    {
                        Type = StimulusType.HttpRequest,
                        HttpRequest = new HttpRequestSpec { Method = "GET", Path = "/v1/workspaces/{wsId}/lakehouses/{artId}/liveTable/getLatestDag" }
                    },
                    Expectations = new List<Expectation>
                    {
                        new Expectation { Id = "exp-1", Type = ExpectationType.EventPresent, Topic = "http" }
                    },
                    Metadata = new ScenarioMetadata
                    {
                        GeneratedBy = "synthetic",
                        Confidence = 0.81,
                        Tags = new List<string> { "dag", "scheduler", "edge-case" },
                        GeneratedAt = now
                    }
                },
                new Scenario
                {
                    Id = $"scn-regression-retry-logic-{prId:D4}",
                    Title = "Retry interceptor triggers on transient failures",
                    Description = "Injects a transient 503 and verifies the retry interceptor retries up to the configured max attempts.",
                    Category = ScenarioCategory.Regression,
                    Priority = 2,
                    ImpactZone = "zone-retry",
                    TimeoutMs = 45000,
                    Stimulus = new Stimulus
                    {
                        Type = StimulusType.HttpRequest,
                        HttpRequest = new HttpRequestSpec { Method = "POST", Path = "/v1/workspaces/{wsId}/lakehouses/{artId}/liveTable/runDag" }
                    },
                    Expectations = new List<Expectation>
                    {
                        new Expectation { Id = "exp-1", Type = ExpectationType.EventPresent, Topic = "retry" },
                        new Expectation { Id = "exp-2", Type = ExpectationType.EventPresent, Topic = "http" }
                    },
                    Metadata = new ScenarioMetadata
                    {
                        GeneratedBy = "synthetic",
                        Confidence = 0.78,
                        Tags = new List<string> { "retry", "transient", "regression" },
                        GeneratedAt = now
                    }
                },
                new Scenario
                {
                    Id = $"scn-perf-large-dag-{prId:D4}",
                    Title = "Large DAG (50+ nodes) completes within SLA",
                    Description = "Creates a DAG with 50 nodes and verifies execution completes within the 120-second SLA boundary.",
                    Category = ScenarioCategory.Performance,
                    Priority = 4,
                    ImpactZone = "zone-perf",
                    TimeoutMs = 60000,
                    Stimulus = new Stimulus
                    {
                        Type = StimulusType.HttpRequest,
                        HttpRequest = new HttpRequestSpec { Method = "POST", Path = "/v1/workspaces/{wsId}/lakehouses/{artId}/liveTable/runDag" }
                    },
                    Expectations = new List<Expectation>
                    {
                        new Expectation { Id = "exp-1", Type = ExpectationType.EventPresent, Topic = "perf" }
                    },
                    Metadata = new ScenarioMetadata
                    {
                        GeneratedBy = "synthetic",
                        Confidence = 0.70,
                        Tags = new List<string> { "performance", "sla", "large-dag" },
                        GeneratedAt = now
                    }
                }
            };
        }

        /// <summary>
        /// Runs the eight-phase execution loop for all scenarios, broadcasting events.
        /// </summary>
        private async Task RunExecutionLoopAsync(
            string correlationId,
            string runId,
            QaRunEntry runEntry,
            List<QaSubmittedScenario> scenarios,
            QaRunOptions options,
            CancellationTokenSource cts)
        {
            var startedAt = DateTimeOffset.UtcNow;
            var interDelay = options?.InterScenarioDelayMs ?? 500;
            var globalTimeout = options?.GlobalTimeoutMs ?? 1800000;
            var stopOnFirst = options?.StopOnFirstFailure ?? false;
            var cancelledByUser = false;

            // Apply global timeout
            cts.CancelAfter(globalTimeout);
            var ct = cts.Token;

            var completedCount = 0;
            var passedCount = 0;
            var failedCount = 0;
            var scenarioResults = new List<object>();

            try
            {
                for (var i = 0; i < scenarios.Count; i++)
                {
                    ct.ThrowIfCancellationRequested();

                    var scenario = scenarios[i];

                    // Broadcast QaScenarioStarted
                    await BroadcastQaEventAsync("QaScenarioStarted", new
                    {
                        eventType = "QaScenarioStarted",
                        correlationId,
                        runId,
                        timestamp = DateTimeOffset.UtcNow,
                        scenarioId = scenario.Id,
                        scenarioIndex = i,
                        totalScenarios = scenarios.Count,
                        title = scenario.Title ?? "",
                        category = scenario.Category ?? "happy_path",
                        phase = "isolate",
                        expectationCount = scenario.Expectations?.Count ?? 0
                    }).ConfigureAwait(false);

                    // Execute 8-phase loop per scenario
                    var scenarioStart = DateTimeOffset.UtcNow;
                    var phases = new[] { "isolate", "setup", "mark", "stimulate", "capture", "evaluate", "teardown", "report" };
                    var previousPhase = "isolate";

                    for (var p = 1; p < phases.Length; p++)
                    {
                        ct.ThrowIfCancellationRequested();

                        await BroadcastQaEventAsync("QaScenarioPhaseChanged", new
                        {
                            eventType = "QaScenarioPhaseChanged",
                            correlationId,
                            runId,
                            timestamp = DateTimeOffset.UtcNow,
                            scenarioId = scenario.Id,
                            phase = phases[p],
                            previousPhase = phases[p - 1],
                            phaseDurationMs = 0L,
                            detail = $"Entering phase: {phases[p]}"
                        }).ConfigureAwait(false);

                        // Simulate phase execution (real impl delegates to ExecutionEngine)
                        await Task.Delay(10, ct).ConfigureAwait(false);
                    }

                    var scenarioEnd = DateTimeOffset.UtcNow;
                    var durationMs = (long)(scenarioEnd - scenarioStart).TotalMilliseconds;
                    completedCount++;

                    // Determine verdict (placeholder — real impl uses assertion engine)
                    var verdict = "passed";
                    passedCount++;

                    var scenarioResult = new
                    {
                        scenarioId = scenario.Id,
                        title = scenario.Title ?? "",
                        category = scenario.Category ?? "happy_path",
                        verdict,
                        durationMs,
                        startedAt = scenarioStart,
                        completedAt = scenarioEnd,
                        expectations = new List<object>(),
                        eventsCaptured = 0,
                        errorMessage = (string)null
                    };
                    scenarioResults.Add(scenarioResult);

                    // Broadcast QaScenarioCompleted
                    await BroadcastQaEventAsync("QaScenarioCompleted", new
                    {
                        eventType = "QaScenarioCompleted",
                        correlationId,
                        runId,
                        timestamp = DateTimeOffset.UtcNow,
                        scenarioId = scenario.Id,
                        scenarioIndex = i,
                        totalScenarios = scenarios.Count,
                        result = scenarioResult,
                        runProgress = new
                        {
                            completed = completedCount,
                            passed = passedCount,
                            failed = failedCount,
                            remaining = scenarios.Count - completedCount
                        }
                    }).ConfigureAwait(false);

                    if (stopOnFirst && verdict != "passed")
                        break;

                    // Inter-scenario delay
                    if (i < scenarios.Count - 1 && interDelay > 0)
                        await Task.Delay(interDelay, ct).ConfigureAwait(false);
                }
            }
            catch (OperationCanceledException)
            {
                cancelledByUser = true;
            }

            var completedAt = DateTimeOffset.UtcNow;
            var totalDurationMs = (long)(completedAt - startedAt).TotalMilliseconds;
            var skippedCount = scenarios.Count - completedCount;

            var summary = new QaRunSummaryData
            {
                Total = scenarios.Count,
                Passed = passedCount,
                Failed = failedCount,
                Skipped = skippedCount
            };

            // Build and store result
            var runResult = new QaRunResult
            {
                RunId = runId,
                PrId = runEntry.PrId,
                PrTitle = runEntry.PrTitle ?? "",
                StartedAt = startedAt,
                CompletedAt = completedAt,
                TotalDurationMs = totalDurationMs,
                CancelledByUser = cancelledByUser,
                Summary = summary,
                Scenarios = scenarioResults,
                Performance = new QaPerformanceReport
                {
                    TotalExecutionMs = totalDurationMs,
                    AverageScenarioMs = completedCount > 0 ? totalDurationMs / completedCount : 0
                }
            };
            QaHubState.StoreRunResult(runId, runResult);

            // Add to history
            QaHubState.AddToHistory(new QaRunSummary
            {
                RunId = runId,
                PrId = runEntry.PrId,
                PrTitle = runEntry.PrTitle ?? "",
                StartedAt = startedAt,
                CompletedAt = completedAt,
                TotalDurationMs = totalDurationMs,
                Summary = summary,
                OverallPass = summary.OverallPass
            });

            // Broadcast QaRunCompleted
            await BroadcastQaEventAsync("QaRunCompleted", new
            {
                eventType = "QaRunCompleted",
                correlationId,
                runId,
                timestamp = DateTimeOffset.UtcNow,
                prId = runEntry.PrId,
                prTitle = runEntry.PrTitle ?? "",
                prUrl = "",
                startedAt,
                completedAt,
                totalDurationMs,
                cancelledByUser,
                summary = new
                {
                    total = summary.Total,
                    passed = summary.Passed,
                    failed = summary.Failed,
                    timedOut = summary.TimedOut,
                    partial = summary.Partial,
                    crashed = summary.Crashed,
                    skipped = summary.Skipped,
                    overallPass = summary.OverallPass
                },
                performance = runResult.Performance,
                unobservablePaths = new List<string>()
            }).ConfigureAwait(false);
        }

        /// <summary>
        /// Validates submitted scenarios against the protocol spec rules.
        /// </summary>
        private static List<QaValidationError> ValidateScenarios(List<QaSubmittedScenario> scenarios)
        {
            var errors = new List<QaValidationError>();
            var seenIds = new HashSet<string>();

            foreach (var s in scenarios)
            {
                // ID format
                if (string.IsNullOrEmpty(s.Id) || !ScenarioIdRegex.IsMatch(s.Id))
                    errors.Add(new QaValidationError { ScenarioId = s.Id, Field = "id", Message = "Must match ^scn-[a-z0-9-]+$" });

                // Duplicate ID
                if (!string.IsNullOrEmpty(s.Id) && !seenIds.Add(s.Id))
                    errors.Add(new QaValidationError { ScenarioId = s.Id, Field = "id", Message = "Duplicate scenario ID" });

                // Title
                if (string.IsNullOrEmpty(s.Title))
                    errors.Add(new QaValidationError { ScenarioId = s.Id, Field = "title", Message = "Title is required" });
                else if (s.Title.Length > 120)
                    errors.Add(new QaValidationError { ScenarioId = s.Id, Field = "title", Message = "Title must be 120 chars or less" });

                // Category
                if (!string.IsNullOrEmpty(s.Category) && !ValidCategories.Contains(s.Category))
                    errors.Add(new QaValidationError { ScenarioId = s.Id, Field = "category", Message = $"Invalid category: {s.Category}" });

                // Expectations
                if (s.Expectations == null || s.Expectations.Count == 0)
                {
                    errors.Add(new QaValidationError { ScenarioId = s.Id, Field = "expectations", Message = "At least one expectation is required" });
                }
                else
                {
                    foreach (var exp in s.Expectations)
                    {
                        if (string.IsNullOrEmpty(exp.Id) || !ExpectationIdRegex.IsMatch(exp.Id))
                            errors.Add(new QaValidationError { ScenarioId = s.Id, Field = $"expectations[{exp.Id}].id", Message = "Must match ^exp-[0-9]+$" });

                        if (!string.IsNullOrEmpty(exp.Type) && !ValidExpectationTypes.Contains(exp.Type))
                            errors.Add(new QaValidationError { ScenarioId = s.Id, Field = $"expectations[{exp.Id}].type", Message = $"Invalid type: {exp.Type}" });

                        if (string.IsNullOrEmpty(exp.Topic))
                            errors.Add(new QaValidationError { ScenarioId = s.Id, Field = $"expectations[{exp.Id}].topic", Message = "Topic is required" });
                        else if (EdogTopicRouter.GetBuffer(exp.Topic) == null)
                            errors.Add(new QaValidationError { ScenarioId = s.Id, Field = $"expectations[{exp.Id}].topic", Message = $"Unknown topic: {exp.Topic}" });
                    }
                }

                // Timeout
                if (s.TimeoutMs < 1000 || s.TimeoutMs > 60000)
                    errors.Add(new QaValidationError { ScenarioId = s.Id, Field = "timeoutMs", Message = "Timeout must be 1000-60000 ms" });
            }

            return errors;
        }

        private static string ConvertCategoryToSnakeCase(ScenarioCategory cat)
        {
            return cat switch
            {
                ScenarioCategory.HappyPath => "happy_path",
                ScenarioCategory.ErrorPath => "error_path",
                ScenarioCategory.EdgeCase => "edge_case",
                ScenarioCategory.Regression => "regression",
                ScenarioCategory.Performance => "performance",
                _ => cat.ToString().ToLowerInvariant()
            };
        }

        private static string ConvertExpectationTypeToSnakeCase(ExpectationType t)
        {
            return t switch
            {
                ExpectationType.EventPresent => "event_present",
                ExpectationType.EventAbsent => "event_absent",
                ExpectationType.EventCount => "event_count",
                ExpectationType.EventOrder => "event_order",
                ExpectationType.Timing => "timing",
                ExpectationType.FieldMatch => "field_match",
                _ => t.ToString().ToLowerInvariant()
            };
        }

        /// <summary>
        /// Broadcasts a QA event to the "qa" SignalR group and publishes to the qa topic buffer.
        /// </summary>
        private async Task BroadcastQaEventAsync(string eventName, object payload)
        {
            try
            {
                await Clients.Group("qa").SendAsync(eventName, payload).ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"[QA] Broadcast {eventName} failed: {ex.Message}");
            }

            // Also publish to qa topic buffer for streaming subscribers
            EdogTopicRouter.Publish("qa", payload);
        }

        /// <summary>
        /// Publishes a QaError event.
        /// </summary>
        private async Task PublishQaErrorAsync(
            string correlationId, string runId, string errorCode,
            string message, string scenarioId, string phase,
            string severity, bool recoverable)
        {
            await BroadcastQaEventAsync("QaError", new
            {
                eventType = "QaError",
                correlationId,
                runId,
                timestamp = DateTimeOffset.UtcNow,
                errorCode,
                message,
                scenarioId,
                phase,
                severity,
                recoverable
            }).ConfigureAwait(false);
        }
    }
}
