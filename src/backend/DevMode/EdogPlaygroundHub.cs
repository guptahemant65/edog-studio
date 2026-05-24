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

        /// <summary>Per-zone contract catalog assembler (P10). Optional — null when providers unavailable.</summary>
        internal static EdogQaContractCatalog ContractCatalog { get; set; }

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

        // F27 P7: tracks whether disk-backed history has been merged in.
        // First caller of GetHistory triggers a one-shot hydration via
        // EdogQaRunStore.ListAllSummaries(). Reads happen outside the lock
        // and the merge happens under it — see HydrateHistoryFromStore.
        private static volatile bool _historyHydrated;

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
            HydrateHistoryFromStore();
            lock (_lock)
            {
                IEnumerable<QaRunSummary> query = _history;
                if (prId.HasValue)
                    query = query.Where(h => h.PrId == prId.Value);
                return query.Skip(offset).Take(limit).ToList();
            }
        }

        /// <summary>
        /// F27 P7: merges disk-backed run summaries into <c>_history</c> on
        /// first access. Idempotent — repeat calls short-circuit on the
        /// <c>_historyHydrated</c> flag. Disk I/O happens BEFORE the state
        /// lock is taken so SignalR read paths don't stall behind file
        /// reads. Merge strategy: newest-completed wins per <c>RunId</c>,
        /// final list re-sorted descending by <c>StartedAt</c> and capped
        /// at <see cref="MaxHistoryEntries"/>.
        /// </summary>
        private static void HydrateHistoryFromStore()
        {
            if (_historyHydrated) return;
            List<QaRunSummary> diskRuns;
            try
            {
                diskRuns = EdogQaRunStore.ListAllSummaries();
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine(
                    $"[QA] History hydration failed (non-fatal): {ex.Message}");
                // F27 P7 fix: do NOT flip the hydrated flag here. A
                // concurrent caller may still produce a successful load.
                // Setting the flag outside the lock would race-strand
                // persisted history for the lifetime of the process.
                return;
            }

            lock (_lock)
            {
                if (_historyHydrated) return;
                if (diskRuns != null && diskRuns.Count > 0)
                {
                    var byRunId = new Dictionary<string, QaRunSummary>();
                    foreach (var entry in _history.Concat(diskRuns))
                    {
                        if (entry == null || string.IsNullOrEmpty(entry.RunId)) continue;
                        if (!byRunId.TryGetValue(entry.RunId, out var existing)
                            || entry.CompletedAt > existing.CompletedAt)
                        {
                            byRunId[entry.RunId] = entry;
                        }
                    }
                    _history.Clear();
                    _history.AddRange(byRunId.Values.OrderByDescending(r => r.StartedAt));
                    while (_history.Count > MaxHistoryEntries)
                        _history.RemoveAt(_history.Count - 1);
                }
                _historyHydrated = true;
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
            if (_runs.TryGetValue(runId, out var entry) && entry.Result != null)
                return entry.Result;

            // F27 P7: fall back to disk-backed history for runs from a
            // prior FLT process. We reconstruct a lossy QaRunResult shape
            // — scenarios are summary rows, not full ScenarioResult — so
            // detail views can still surface verdict + error summary
            // across restarts.
            try
            {
                var record = EdogQaRunStore.Get(runId);
                if (record == null) return null;
                return new QaRunResult
                {
                    RunId = record.RunId,
                    PrId = record.PrId,
                    PrTitle = record.PrTitle ?? string.Empty,
                    StartedAt = record.StartedAt,
                    CompletedAt = record.CompletedAt,
                    TotalDurationMs = record.TotalDurationMs,
                    CancelledByUser = record.CancelledByUser,
                    Summary = record.Summary,
                    Scenarios = (record.Scenarios ?? new List<QaScenarioRecord>())
                        .Select(s => (object)new
                        {
                            scenarioId = s.ScenarioId,
                            scenarioHash = s.ScenarioHash,
                            title = s.Title,
                            category = s.Category,
                            verdict = s.Status,
                            failureMessage = s.ErrorSummary,
                        })
                        .ToList(),
                };
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine(
                    $"[QA] GetRunResult disk fallback failed (non-fatal): {ex.Message}");
                return null;
            }
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

        /// <summary>
        /// Snapshot of curator dispositions captured at submission time.
        /// Forwarded onto QaRunResult when the run completes.
        /// </summary>
        public QaCuratorApproval CuratorApproval { get; set; }

        /// <summary>When the run was created.</summary>
        public DateTimeOffset CreatedAt { get; set; }
    }

    // ═══════════════════════════════════════════════════════════════════
    // F28 MITM — Hub DTOs (input / result envelopes)
    // ═══════════════════════════════════════════════════════════════════

    /// <summary>Input payload for <c>MitmCreateRule</c>. Mirrors §5.1 of architecture.md.</summary>
    public sealed class MitmRuleInput
    {
        public string Id { get; set; }
        public string Name { get; set; }
        public bool Enabled { get; set; } = true;
        public int Priority { get; set; }
        public MitmMatchInput Match { get; set; }
        public MitmActionInput Action { get; set; }
    }

    /// <summary>Match predicate block on a <see cref="MitmRuleInput"/>.</summary>
    public sealed class MitmMatchInput
    {
        public MitmUrlPatternInput UrlPattern { get; set; }
        public string[] Methods { get; set; }
        public string HttpClientName { get; set; }

        /// <summary>"request" | "response".</summary>
        public string Phase { get; set; }
    }

    /// <summary>URL pattern shape.</summary>
    public sealed class MitmUrlPatternInput
    {
        /// <summary>"substring" | "regex" | "exact".</summary>
        public string Kind { get; set; }
        public string Value { get; set; }
    }

    /// <summary>
    /// Flattened action input. Only fields relevant to <see cref="Type"/> are read.
    /// The hub builds the proper <see cref="MitmAction"/> subclass on insert.
    /// </summary>
    public sealed class MitmActionInput
    {
        /// <summary>"breakpoint" | "block" | "forge" | "modify" | "passthrough".</summary>
        public string Type { get; set; }

        // Block / Forge fields
        public int? StatusCode { get; set; }
        public string Body { get; set; }
        public string ReasonPhrase { get; set; }
        public Dictionary<string, string> Headers { get; set; }

        // Breakpoint
        public int? TimeoutMs { get; set; }

        // Modify
        public string ReplacementUrl { get; set; }
        public Dictionary<string, string> SetHeaders { get; set; }
        public string[] RemoveHeaders { get; set; }
        public string ReplacementBody { get; set; }
    }

    /// <summary>Common result envelope returned by most <c>Mitm*</c> RPCs.</summary>
    public class MitmOperationResult
    {
        public bool Success { get; set; }
        public string Code { get; set; }
        public string Message { get; set; }
    }

    /// <summary>Return shape for <c>MitmCreateRule</c>.</summary>
    public sealed class MitmRuleResult : MitmOperationResult
    {
        public string RuleId { get; set; }
        public long Revision { get; set; }
    }

    /// <summary>Return shape for <c>MitmListRules</c>.</summary>
    public sealed class MitmRuleListResult : MitmOperationResult
    {
        public long Revision { get; set; }
        public IReadOnlyList<object> Rules { get; set; }
    }

    /// <summary>Return shape for <c>MitmSendToPlayground</c>.</summary>
    public sealed class MitmPlaygroundTransferResult : MitmOperationResult
    {
        public PlaygroundTransferPayload Payload { get; set; }
    }

    /// <summary>Playground "Send to" transfer envelope (audit-friendly copy of an http row).</summary>
    public sealed class PlaygroundTransferPayload
    {
        public string Source { get; set; }
        public long SourceRowId { get; set; }
        public string InterceptId { get; set; }
        public string Method { get; set; }
        public string Url { get; set; }
        public List<PlaygroundTransferHeader> Headers { get; set; }
        public string Body { get; set; }
        public string TokenType { get; set; }
    }

    /// <summary>Header entry on a <see cref="PlaygroundTransferPayload"/>.</summary>
    public sealed class PlaygroundTransferHeader
    {
        public string Name { get; set; }
        public string Value { get; set; }
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
        /// F28 — purge this connection's MITM rules and resume any pending
        /// breakpoints owned by it. Other interceptors that own per-connection
        /// state can be added here later. Never throws.
        /// </summary>
        public override async Task OnDisconnectedAsync(Exception exception)
        {
            var connectionId = Context.ConnectionId;
            try
            {
                int purged = MitmRuleStore.PurgeByOwner(connectionId);
                int cancelled = MitmCoordinator.CancelOwner(connectionId, "disconnect");
                if (purged > 0 || cancelled > 0)
                {
                    System.Diagnostics.Debug.WriteLine(
                        $"[EDOG] MITM disconnect cleanup: conn={connectionId} rulesPurged={purged} pendingCancelled={cancelled}");
                }
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine(
                    $"[EDOG] OnDisconnectedAsync MITM cleanup error: {ex.Message}");
            }

            // Session Guard — drop this connection from the registry so other
            // engineers probing /api/edog/sessions don't see a ghost.
            try
            {
                EdogSessionRegistry.Unregister(connectionId);
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine(
                    $"[EDOG] OnDisconnectedAsync session unregister error: {ex.Message}");
            }

            await base.OnDisconnectedAsync(exception);
        }

        /// <summary>
        /// Session Guard — client identifies itself shortly after connecting
        /// so other engineers probing this capacity before deploying see who
        /// is actively connected. Identity is OS user + machine name because
        /// the whole team authenticates as the same Fabric service principal.
        /// Calling this RPC more than once on the same connection overwrites
        /// the previous entry (e.g. user switched workspaces in the UI).
        /// Never throws.
        /// </summary>
        public Task EdogIdentify(
            string machine,
            string osUser,
            string lakehouseId,
            string lakehouseName,
            string workspaceId,
            string workspaceName)
        {
            try
            {
                EdogSessionRegistry.Register(
                    Context.ConnectionId,
                    machine,
                    osUser,
                    lakehouseId,
                    lakehouseName,
                    workspaceId,
                    workspaceName);
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine(
                    $"[EDOG] EdogIdentify error: {ex.Message}");
            }

            return Task.CompletedTask;
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

        /// <summary>
        /// Closed topic vocabulary the QA schema accepts for
        /// <c>expectations[*].topic</c>. Mirrors the enum in
        /// <see cref="EdogQaLlmClient"/>'s single-scenario schema and the
        /// EditorSystemPrompt "EXPECTATION TOPIC VOCABULARY" block. The
        /// submission validator uses this set instead of
        /// <see cref="EdogTopicRouter.GetBuffer"/> because the runtime router
        /// only carries topics that are actively intercepted in the current
        /// FLT process — but the schema legitimately allows topics whose
        /// interceptors exist in the FLT codebase even when no buffer is
        /// registered for them in this session (the symptom that caused
        /// QaSubmitCuratedScenarios to fail server-side with "Unknown topic").
        /// </summary>
        private static readonly HashSet<string> ValidTopicVocabulary = new(StringComparer.OrdinalIgnoreCase)
        {
            "http", "token", "flag", "perf", "spark", "log",
            "telemetry", "retry", "cache", "fileop", "catalog",
            "dag", "flt-ops", "nexus", "di", "capacity",
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

                // ─── Curator approval rate (Pixel/Vex 2026) ────────────
                // Compute disposition counts from the submission. The frontend
                // sends EditedScenarioIds (ids touched in the editor overlay)
                // and TotalGenerated (analyzer output before any deletions).
                // Older clients omit both — we fall back to "no edits known"
                // and treat the submitted count as the universe.
                int totalGenerated = submission.TotalGenerated > 0
                    ? submission.TotalGenerated
                    : submission.Scenarios.Count;
                var editedIds = submission.EditedScenarioIds ?? new List<string>();
                var editedSet = new HashSet<string>(editedIds, StringComparer.Ordinal);
                int approvedEdited = 0;
                foreach (var scn in submission.Scenarios)
                {
                    if (scn != null && scn.Id != null && editedSet.Contains(scn.Id))
                    {
                        approvedEdited++;
                    }
                }
                int approvedUnedited = submission.Scenarios.Count - approvedEdited;
                int rejected = Math.Max(0, totalGenerated - approvedUnedited - approvedEdited);
                float approvalRate = totalGenerated > 0
                    ? (float)(approvedUnedited + approvedEdited) / totalGenerated
                    : 0f;
                float uneditedRate = totalGenerated > 0
                    ? (float)approvedUnedited / totalGenerated
                    : 0f;

                var curatorApproval = new QaCuratorApproval
                {
                    TotalGenerated = totalGenerated,
                    ApprovedUnedited = approvedUnedited,
                    ApprovedEdited = approvedEdited,
                    Rejected = rejected,
                    ApprovalRate = approvalRate,
                    UneditedRate = uneditedRate,
                };

                Console.WriteLine(
                    $"[QA-DIAG] Curator approval: {approvedUnedited + approvedEdited}/{totalGenerated} " +
                    $"approved ({approvalRate:P0}), {approvedUnedited} unedited ({uneditedRate:P0}), " +
                    $"{approvedEdited} edited, {rejected} rejected");

                // Mirror the curator approval diagnostic to the browser
                // console via QaAnalysisWarning. Fire-and-forget so the
                // sync submission path isn't gated on broadcast latency.
                _ = BroadcastQaEventAsync("QaAnalysisWarning", new
                {
                    eventType = "QaAnalysisWarning",
                    correlationId = submission.CorrelationId,
                    analysisId = submission.AnalysisId,
                    timestamp = DateTimeOffset.UtcNow,
                    warning = "qa_diagnostic",
                    message =
                        $"Curator approval: {approvedUnedited + approvedEdited}/{totalGenerated} " +
                        $"approved ({approvalRate:P0}), {approvedUnedited} unedited ({uneditedRate:P0}), " +
                        $"{approvedEdited} edited, {rejected} rejected",
                });

                EdogQaTelemetry.EmitContractEvent(
                    "qa_curator_approval",
                    submission.AnalysisId ?? "unknown",
                    $"{uneditedRate:F2}",
                    $"total={totalGenerated};unedited={approvedUnedited};edited={approvedEdited};rejected={rejected}");

                var entry = new QaRunEntry
                {
                    RunId = runId,
                    AnalysisId = submission.AnalysisId,
                    CorrelationId = submission.CorrelationId,
                    Scenarios = submission.Scenarios,
                    CuratorApproval = curatorApproval,
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
                Console.WriteLine($"[QA-DIAG] *** QaSubmitCuratedScenarios EXCEPTION: {ex.GetType().Name}: {ex.Message}");
                Console.WriteLine($"[QA-DIAG] Stack: {ex.StackTrace?.Substring(0, Math.Min(500, ex.StackTrace?.Length ?? 0))}");
                _ = BroadcastQaEventAsync("QaAnalysisWarning", new
                {
                    eventType = "QaAnalysisWarning",
                    correlationId = submission?.CorrelationId,
                    timestamp = DateTimeOffset.UtcNow,
                    warning = "qa_diagnostic",
                    message = $"*** SUBMIT EXCEPTION: {ex.GetType().Name}: {ex.Message}",
                });
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

                // Telemetry: this run is now active.
                EdogQaTelemetry.IncrementRunStarted();

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
                        Console.WriteLine($"[QA-DIAG] *** Execution loop EXCEPTION: {ex.GetType().Name}: {ex.Message}");
                        _ = BroadcastQaEventAsync("QaAnalysisWarning", new
                        {
                            eventType = "QaAnalysisWarning",
                            correlationId,
                            timestamp = DateTimeOffset.UtcNow,
                            warning = "qa_diagnostic",
                            message = $"*** EXECUTION EXCEPTION: {ex.GetType().Name}: {ex.Message}\n{ex.StackTrace?.Substring(0, Math.Min(500, ex.StackTrace?.Length ?? 0))}",
                        });
                        System.Diagnostics.Debug.WriteLine($"[QA] Execution loop error: {ex.Message}");
                        await PublishQaErrorAsync(correlationId, runId, "INTERNAL_ERROR",
                            $"Execution failed: {ex.Message}", null, null, "error", false).ConfigureAwait(false);
                    }
                    finally
                    {
                        QaHubState.CompleteRun();
                        EdogQaTelemetry.IncrementRunCompleted();
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

        /// <summary>
        /// Returns a snapshot of the QA telemetry counters tracked by
        /// <see cref="EdogQaTelemetry"/>. Used by the studio UI to render a
        /// fallback-usage banner and by integration tests to assert that no
        /// stubbed/fallback path fired during a successful run.
        ///
        /// Cheap and safe to call at any time; counters are in-process and
        /// reset only on FLT restart.
        /// </summary>
        /// <returns>Telemetry snapshot.</returns>
        public Task<QaTelemetrySnapshot> QaGetTelemetry()
        {
            return Task.FromResult(EdogQaTelemetry.Snapshot());
        }

        /// <summary>
        /// Returns the current capability snapshot — which scenario-setup
        /// primitives (feature-flag overrides, HTTP chaos, …) the host
        /// can actually satisfy. Used by the curation UI to render
        /// per-scenario capability badges before submission so users are
        /// not surprised by silent <c>Skipped</c> verdicts at runtime.
        /// </summary>
        /// <returns>Immutable capability report.</returns>
        public Task<QaCapabilityReport> QaGetCapabilities()
        {
            return Task.FromResult(EdogQaCapabilityRegistry.BuildReport());
        }

        /// <summary>
        /// F27 P7: diffs two persisted runs and returns the set of
        /// scenarios added, removed, and flipped between them. The
        /// frontend conventionally passes the currently-viewed run as
        /// <c>TargetRunId</c> and a prior run as <c>BaseRunId</c> so
        /// diff badges read naturally ("NEW", "GONE", "→ PASS", "→ FAIL").
        /// Matching is content-aware via <c>ScenarioHash</c> with
        /// scenarioId fallback when hashes are absent (a warning is
        /// surfaced so the UI can render a degraded-confidence banner).
        /// </summary>
        public Task<QaRunComparison> QaCompareRuns(QaComparisonRequest request)
        {
            try
            {
                if (request == null)
                {
                    return Task.FromResult(new QaRunComparison
                    {
                        Error = "QaCompareRuns request was null.",
                    });
                }
                var comparison = EdogQaRunStore.Compare(request.BaseRunId, request.TargetRunId);
                return Task.FromResult(comparison);
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"[QA] QaCompareRuns error: {ex.Message}");
                return Task.FromResult(new QaRunComparison
                {
                    BaseRunId = request?.BaseRunId,
                    TargetRunId = request?.TargetRunId,
                    Error = "QaCompareRuns encountered an internal error.",
                });
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
            List<LintFinding> lintFindings = null;
            List<string> analysisDegradationFlags = null;
            EdogQaLlmClient.TestingGuidance testingGuidance = null;

            // Local helper — mirror a [QA-DIAG] stdout line to the browser
            // console via the QaAnalysisWarning channel. Fire-and-forget on
            // any broadcast failure so diagnostics never crash the pipeline.
            async Task BroadcastQaDiagAsync(string message)
            {
                try
                {
                    await BroadcastQaEventAsync("QaAnalysisWarning", new
                    {
                        eventType = "QaAnalysisWarning",
                        correlationId,
                        analysisId,
                        timestamp = DateTimeOffset.UtcNow,
                        warning = "qa_diagnostic",
                        message,
                    }).ConfigureAwait(false);
                }
                catch
                {
                    // Diagnostics must never crash the pipeline.
                }
            }

            Console.WriteLine($"[QA-DIAG] ═══ RunRealAnalysisPipelineAsync START ═══");
            await BroadcastQaDiagAsync("═══ RunRealAnalysisPipelineAsync START ═══").ConfigureAwait(false);
            Console.WriteLine($"[QA-DIAG] PrUrl={request.PrUrl ?? "(null)"}, PrId={request.PrId}");
            await BroadcastQaDiagAsync($"PrUrl={request.PrUrl ?? "(null)"}, PrId={request.PrId}").ConfigureAwait(false);

            // Phase 1: Fetch real PR diff from ADO via dev-server proxy
            await BroadcastAnalysisProgressAsync(correlationId, analysisId, "fetching_diff", 0, 6, 5,
                "Fetching PR diff from Azure DevOps...", sw.ElapsedMilliseconds).ConfigureAwait(false);

            string realDiff = null;
            string diffError = null;
            PrContext prContext = null;
            if (!string.IsNullOrEmpty(request.PrUrl))
            {
                try
                {
                    using var httpClient = new System.Net.Http.HttpClient { Timeout = System.TimeSpan.FromSeconds(60) };
                    var encodedUrl = System.Net.WebUtility.UrlEncode(request.PrUrl);
                    var proxyUrl = $"http://localhost:5555/api/ado-proxy/pr-diff?prUrl={encodedUrl}";
                    var resp = await httpClient.GetAsync(proxyUrl, ct).ConfigureAwait(false);
                    var body = await resp.Content.ReadAsStringAsync().ConfigureAwait(false);

                    if (resp.IsSuccessStatusCode)
                    {
                        var diffResult = System.Text.Json.JsonSerializer.Deserialize<System.Text.Json.JsonElement>(body);
                        realDiff = diffResult.GetProperty("diff").GetString();
                        var filesChanged = diffResult.GetProperty("filesChanged").GetInt32();
                        var filesDiffed = diffResult.GetProperty("filesDiffed").GetInt32();
                        var linesAdded = diffResult.GetProperty("linesAdded").GetInt32();
                        var linesRemoved = diffResult.GetProperty("linesRemoved").GetInt32();

                        if (string.IsNullOrWhiteSpace(realDiff) || filesDiffed == 0)
                        {
                            // Successful fetch but no analyzable diff content
                            var skippedCount = 0;
                            if (diffResult.TryGetProperty("skippedFiles", out var skippedArr))
                                skippedCount = skippedArr.GetArrayLength();
                            diffError = $"PR diff fetched but empty — {filesChanged} files changed, {skippedCount} skipped (binary/large). No analyzable code diff.";
                            realDiff = null;
                        }
                        else
                        {
                            await BroadcastAnalysisProgressAsync(correlationId, analysisId, "fetching_diff", 0, 6, 15,
                                $"PR diff fetched: {filesDiffed}/{filesChanged} files, +{linesAdded}/-{linesRemoved} lines",
                                sw.ElapsedMilliseconds).ConfigureAwait(false);
                        }

                        // F27 item 1: parse PR contract context (best-effort).
                        prContext = TryParsePrContext(diffResult);

                        System.Diagnostics.Debug.WriteLine($"[QA] Real PR diff fetched: {realDiff?.Length ?? 0} chars, {filesDiffed} files; contract={(prContext != null ? "present" : "absent")}");
                        Console.WriteLine($"[QA-DIAG] PR diff fetched OK: {realDiff?.Length ?? 0} chars, {filesDiffed}/{filesChanged} files, +{linesAdded}/-{linesRemoved}");
                        await BroadcastQaDiagAsync($"PR diff fetched OK: {realDiff?.Length ?? 0} chars, {filesDiffed}/{filesChanged} files, +{linesAdded}/-{linesRemoved}").ConfigureAwait(false);
                    }
                    else
                    {
                        diffError = $"ADO proxy returned {(int)resp.StatusCode}: {body}";
                        System.Diagnostics.Debug.WriteLine($"[QA] PR diff fetch failed: {diffError}");
                        Console.WriteLine($"[QA-DIAG] PR diff fetch FAILED: {diffError}");
                        await BroadcastQaDiagAsync($"PR diff fetch FAILED: {diffError}").ConfigureAwait(false);
                    }
                }
                catch (OperationCanceledException) { throw; }
                catch (Exception ex)
                {
                    diffError = $"PR diff fetch error: {ex.Message}";
                    System.Diagnostics.Debug.WriteLine($"[QA] {diffError}");
                }
            }
            else
            {
                diffError = "No PR URL provided — cannot fetch diff from ADO";
            }

            // If diff fetch failed, broadcast warning (don't silently fall back)
            if (string.IsNullOrEmpty(realDiff) && diffError != null)
            {
                await BroadcastQaEventAsync("QaAnalysisWarning", new
                {
                    eventType = "QaAnalysisWarning",
                    correlationId,
                    analysisId,
                    timestamp = DateTimeOffset.UtcNow,
                    warning = "pr_diff_fetch_failed",
                    message = diffError,
                    fallback = "placeholder_diff",
                }).ConfigureAwait(false);
            }

            // Use real diff if available, otherwise synthetic placeholder
            var diffToAnalyze = realDiff;
            if (string.IsNullOrEmpty(diffToAnalyze))
            {
                diffToAnalyze = $"--- a/LiveTableController.cs\n+++ b/LiveTableController.cs\n@@ -100,5 +100,10 @@\n" +
                    $" // PR #{request.PrId ?? 0} changes\n+// Modified code path\n";
            }

            // Try real CodeAnalyzer pipeline
            var analyzer = EdogQaServiceLocator.CodeAnalyzer;
            Console.WriteLine($"[QA-DIAG] CodeAnalyzer={(analyzer != null ? "present" : "NULL")}, diff={diffToAnalyze?.Length ?? 0} chars");
            await BroadcastQaDiagAsync($"CodeAnalyzer={(analyzer != null ? "present" : "NULL")}, diff={diffToAnalyze?.Length ?? 0} chars").ConfigureAwait(false);
            if (analyzer != null)
            {
                try
                {
                    // Phase-to-UI mapping: analyzer phases → frontend phase indices
                    // Frontend phases: 0=fetching_diff, 1=roslyn_blast_radius, 2=semantic_analysis,
                    //                  3=di_validation, 4=scenario_generation, 5=complete
                    Action<AnalysisProgress> progressCallback = progress =>
                    {
                        if (progress.Phase == "warning")
                        {
                            // Surface degradation warnings to frontend
                            _ = BroadcastQaEventAsync("QaAnalysisWarning", new
                            {
                                eventType = "QaAnalysisWarning",
                                correlationId,
                                analysisId,
                                timestamp = DateTimeOffset.UtcNow,
                                warning = "pipeline_degradation",
                                message = progress.Message,
                            });
                            return;
                        }

                        int phaseIndex;
                        string uiPhase;
                        switch (progress.Phase)
                        {
                            case "diff_parsing":
                                phaseIndex = 0; uiPhase = "fetching_diff"; break;
                            case "graph_construction":
                                phaseIndex = 1; uiPhase = "roslyn_blast_radius"; break;
                            case "semantic_enrichment":
                                phaseIndex = 2; uiPhase = "semantic_analysis"; break;
                            case "di_validation":
                            case "clustering":
                            case "entry_points":
                                phaseIndex = 3; uiPhase = "di_validation"; break;
                            case "llm_generation":
                                phaseIndex = 4; uiPhase = "scenario_generation"; break;
                            case "complete":
                                phaseIndex = 5; uiPhase = "complete"; break;
                            default:
                                phaseIndex = 3; uiPhase = progress.Phase; break;
                        }

                        _ = BroadcastAnalysisProgressAsync(correlationId, analysisId,
                            uiPhase, phaseIndex, 6, progress.PercentComplete,
                            progress.Message, progress.ElapsedMs);
                    };

                    // Run the real analyzer with live progress callback
                    var result = await analyzer.AnalyzeAsync(diffToAnalyze, prContext, ct, progressCallback).ConfigureAwait(false);
                    scenarios = result?.Scenarios;
                    lintFindings = result?.LintFindings;
                    analysisDegradationFlags = result?.DegradationFlags;
                    testingGuidance = result?.TestingGuidance;
                    Console.WriteLine($"[QA-DIAG] AnalyzeAsync returned: scenarios={scenarios?.Count ?? 0}, lint={lintFindings?.Count ?? 0}, degradation=[{string.Join(", ", result?.DegradationFlags ?? new List<string>())}]");
                    await BroadcastQaDiagAsync($"AnalyzeAsync returned: scenarios={scenarios?.Count ?? 0}, lint={lintFindings?.Count ?? 0}, degradation=[{string.Join(", ", result?.DegradationFlags ?? new List<string>())}]").ConfigureAwait(false);

                    // Surface degradation flags as warnings
                    if (result?.DegradationFlags?.Count > 0)
                    {
                        foreach (var flag in result.DegradationFlags)
                        {
                            await BroadcastQaEventAsync("QaAnalysisWarning", new
                            {
                                eventType = "QaAnalysisWarning",
                                correlationId,
                                analysisId,
                                timestamp = DateTimeOffset.UtcNow,
                                warning = flag,
                                message = $"Analysis degraded: {flag.Replace('_', ' ')}",
                            }).ConfigureAwait(false);
                        }
                    }
                }
                catch (OperationCanceledException) { throw; }
                catch (LlmProviderException llmEx)
                {
                    Console.WriteLine($"[QA-DIAG] LlmProviderException: kind={llmEx.KindCode}, msg={llmEx.Message}, retryable={llmEx.Retryable}");
                    await BroadcastQaDiagAsync($"LlmProviderException: kind={llmEx.KindCode}, msg={llmEx.Message}, retryable={llmEx.Retryable}").ConfigureAwait(false);
                    // F27 P4: typed LLM provider failure. Emit a QaError
                    // with the wire-stable errorCode so the studio can
                    // render an actionable inline panel + optional Retry
                    // CTA (when llmEx.Retryable). Do NOT silently fall to
                    // synthetic scenarios — that masquerade is exactly
                    // what P4 kills.
                    System.Diagnostics.Debug.WriteLine(
                        $"[QA] LLM provider failure ({llmEx.KindCode}): {llmEx.Message}");
                    await PublishQaErrorAsync(
                        correlationId,
                        runId: null,
                        errorCode: llmEx.ErrorCode,
                        message: llmEx.Message,
                        scenarioId: null,
                        phase: "scenario_generation",
                        severity: "error",
                        recoverable: llmEx.Retryable).ConfigureAwait(false);

                    // Leave `scenarios` null so the fallback gate below
                    // takes over: in demo mode it emits tagged synthetic
                    // scenarios; in normal mode it emits a second QaError
                    // and aborts.
                }
                catch (Exception ex)
                {
                    Console.WriteLine($"[QA-DIAG] Analyzer EXCEPTION: {ex.GetType().Name}: {ex.Message}");
                    await BroadcastQaDiagAsync($"Analyzer EXCEPTION: {ex.GetType().Name}: {ex.Message}").ConfigureAwait(false);
                    System.Diagnostics.Debug.WriteLine($"[QA] CodeAnalyzer failed: {ex.Message}");
                    await BroadcastQaEventAsync("QaAnalysisWarning", new
                    {
                        eventType = "QaAnalysisWarning",
                        correlationId,
                        analysisId,
                        timestamp = DateTimeOffset.UtcNow,
                        warning = "analyzer_failed",
                        message = $"Code analyzer failed: {ex.Message}.",
                    }).ConfigureAwait(false);
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

            // F27 P4: synthetic-scenarios fallback is now opt-in via
            // EDOG_QA_DEMO_FALLBACK=1. Without that env var, an empty
            // scenario list emits a typed NO_SCENARIOS_GENERATED QaError
            // and aborts the scenario-generation phase. The graph / DI /
            // lint broadcasts already sent above remain visible so the
            // studio still shows the analysis work that completed.
            if (scenarios == null || scenarios.Count == 0)
            {
                Console.WriteLine($"[QA-DIAG] *** NO SCENARIOS — scenarios={(scenarios == null ? "null" : $"empty(count={scenarios.Count})")}");
                await BroadcastQaDiagAsync($"*** NO SCENARIOS — scenarios={(scenarios == null ? "null" : $"empty(count={scenarios.Count})")}").ConfigureAwait(false);
                if (QaAnalysisFallbackPolicy.IsDemoFallbackEnabled())
                {
                    EdogQaTelemetry.IncrementSyntheticScenariosFallback();
                    await BroadcastQaEventAsync("QaAnalysisWarning", new
                    {
                        eventType = "QaAnalysisWarning",
                        correlationId,
                        analysisId,
                        timestamp = DateTimeOffset.UtcNow,
                        warning = "synthetic_scenarios_used",
                        message = "EDOG_QA_DEMO_FALLBACK=1 active — emitting 5 hand-coded demo scenarios. " +
                                  "Each title is prefixed with [DEMO] and metadata.generatedBy = 'demo_synthetic'.",
                        fallback = "demo_synthetic",
                    }).ConfigureAwait(false);
                    scenarios = GenerateSyntheticScenarios(request.PrId ?? 0);
                    QaAnalysisFallbackPolicy.TagAsDemo(scenarios);
                }
                else
                {
                    // Build an actionable message. When degradation flags
                    // indicate a specific V2 pipeline failure, surface that
                    // instead of the generic "configure LLM" message so the
                    // user knows WHY zero scenarios were produced.
                    var degradation = analysisDegradationFlags;
                    string noScenariosMessage;
                    string noScenariosCause = null;
                    if (degradation != null && degradation.Contains("llm_v2_zone_failed"))
                    {
                        noScenariosMessage = "No scenarios produced. The LLM pipeline ran but all "
                            + "zone(s) failed the Architect/Editor/Validator gates. "
                            + "Check the QaAnalysisWarning events above for the specific failure code.";
                        noScenariosCause = "v2_zone_failed";
                    }
                    else if (degradation != null && degradation.Contains("llm_v2_budget_all_skipped"))
                    {
                        noScenariosMessage = "No scenarios produced. The LLM budget gate tripped "
                            + "before any zone could run. Increase EDOG_QA_MAX_BUDGET_USD or check "
                            + "QaAnalysisWarning for budget details.";
                        noScenariosCause = "v2_budget_skipped";
                    }
                    else if (degradation != null && degradation.Contains("llm_v2_projection_rejected"))
                    {
                        noScenariosMessage = "No scenarios produced. The validator accepted scenarios "
                            + "but projection rejected all of them (grounding evidence ref resolution failed). "
                            + "Check QaAnalysisWarning for details.";
                        noScenariosCause = "v2_projection_rejected";
                    }
                    else if (degradation != null && degradation.Contains("llm_v2_all_quarantined"))
                    {
                        noScenariosMessage = "No scenarios produced. The LLM generated scenarios but "
                            + "all were quarantined by the validator. Check QaAnalysisWarning for details.";
                        noScenariosCause = "v2_all_quarantined";
                    }
                    else if (degradation != null && degradation.Contains("llm_v2_no_testable_changes"))
                    {
                        noScenariosMessage = "No scenarios produced. The Architect determined this PR "
                            + "has no testable behavior changes (comment-only, whitespace, or generated files).";
                        noScenariosCause = "v2_no_testable_changes";
                    }
                    else
                    {
                        noScenariosMessage = "No scenarios produced. Configure the LLM provider "
                            + "(AZURE_OPENAI_ENDPOINT + AZURE_OPENAI_API_KEY or run the dev-server proxy "
                            + "with a populated donna-app/.env) or set EDOG_QA_DEMO_FALLBACK=1 to use "
                            + "the hand-coded demo scenarios for screenshots / walkthroughs.";
                    }

                    await PublishQaErrorAsync(
                        correlationId,
                        runId: null,
                        errorCode: "NO_SCENARIOS_GENERATED",
                        message: noScenariosMessage,
                        scenarioId: null,
                        phase: "scenario_generation",
                        severity: "error",
                        recoverable: false,
                        cause: noScenariosCause).ConfigureAwait(false);
                    scenarios = new List<Scenario>();
                }
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
                        // F27 wire-projection fix: emit the FULL stimulus
                        // discriminated union (all six variants) and FULL
                        // expectation shape (matcher/timeWindow/count/order).
                        // The legacy hand-projection silently dropped every
                        // non-HttpRequest stimulus variant and every
                        // expectation sub-object, breaking end-to-end
                        // execution for DiInvocation / SignalRBroadcast /
                        // DagTrigger / FileEvent / TimerTick scenarios.
                        // See tests/dotnet/EdogQaE2E.Tests/BroadcastProjectionHarness.cs.
                        stimulus = ProjectStimulusForWire(scn.Stimulus),
                        expectations = scn.Expectations?.Select(ProjectExpectationForWire).ToList(),
                        // F27 items 3 + 6: test-technique taxonomy and grounding evidence.
                        // Surfaced to the curation UI so reviewers can see what
                        // testing pattern the LLM intended and which diff lines
                        // each scenario is grounded in. Defaults are safe for
                        // older synthetic scenarios that don't populate them.
                        technique = scn.Technique.ToString(),
                        invariantsAddressed = scn.InvariantsAddressed ?? new List<string>(),
                        groundingEvidence = (scn.GroundingEvidence ?? new List<GroundingEvidence>()).Select(g => new
                        {
                            file = g.File,
                            startLine = g.StartLine,
                            endLine = g.EndLine,
                            reason = g.Reason,
                            invariantId = g.InvariantId,
                        }).ToList(),
                        // P10 fix (P0-2): broadcast typed matchers + catalog
                        // hashes so the curation UI and downstream consumers
                        // can render assertion semantics and verify catalog
                        // grounding. Without these fields the wire payload
                        // silently dropped the entire typed-contract envelope.
                        matchers = (scn.Matchers ?? new List<Matcher>()).Select(m => new
                        {
                            topicField = m?.TopicField,
                            assertion = m?.Assertion.ToString(),
                            value = m?.Value,
                        }).ToList(),
                        catalogHashes = scn.CatalogHashes == null ? null : new
                        {
                            stimulusSlotHash = scn.CatalogHashes.StimulusSlotHash,
                            catalogSnapshotId = scn.CatalogHashes.CatalogSnapshotId,
                            // Array-of-pairs format keeps JSON dictionary
                            // ordering stable across serializers and avoids
                            // key-name encoding ambiguity in JS consumers.
                            matcherTopicHashes = (scn.CatalogHashes.MatcherTopicHashes ?? new Dictionary<string, string>())
                                .Select(kvp => new { topic = kvp.Key, hash = kvp.Value })
                                .ToList(),
                        },
                        // F27 wiring fix: surface FeatureFlagOverrides on the
                        // wire so the curation UI can render flag-state badges
                        // and the runner can mechanically enforce overrides
                        // (otherwise the projector's FlagOverride setup step
                        // ships with no UI surface).
                        featureFlagOverrides = (scn.FeatureFlagOverrides ?? new List<FlagOverride>())
                            .Select(f => new { flagName = f.FlagName, value = f.Value })
                            .ToArray(),
                        stimulusId = scn.StimulusId ?? string.Empty,
                    }
                }).ConfigureAwait(false);

                // Stagger scenario broadcasts so the UI shows them appearing one by one
                if (i < totalScenarios - 1)
                    await Task.Delay(300, ct).ConfigureAwait(false);
            }

            // F27 item 5: surface deterministic lint findings produced by
            // EdogQaScenarioLinter. One batched event before the "complete"
            // phase so the curation UI can render badges and a findings panel
            // in the same render pass as the scenarios.
            if (lintFindings != null && lintFindings.Count > 0)
            {
                await BroadcastQaEventAsync("QaLintFindings", new
                {
                    eventType = "QaLintFindings",
                    correlationId,
                    analysisId,
                    timestamp = DateTimeOffset.UtcNow,
                    totalCount = lintFindings.Count,
                    errorCount = lintFindings.Count(f => f.Severity == LintSeverity.Error),
                    warningCount = lintFindings.Count(f => f.Severity == LintSeverity.Warning),
                    infoCount = lintFindings.Count(f => f.Severity == LintSeverity.Info),
                    findings = lintFindings.Select(f => new
                    {
                        code = f.Code,
                        severity = f.Severity.ToString().ToLowerInvariant(),
                        message = f.Message,
                        scenarioId = f.ScenarioId,
                        invariantId = f.InvariantId,
                    }).ToList(),
                }).ConfigureAwait(false);
            }

            // F27 P11 wiring fix: surface the Architect-emitted testing
            // guidance so the curation UI can render the panel. Emitted
            // alongside lint findings (immediately before the "complete"
            // phase) so the UI can render guidance, scenarios, and findings
            // in the same pass.
            if (testingGuidance != null)
            {
                await BroadcastQaEventAsync("QaTestingGuidance", new
                {
                    eventType = "QaTestingGuidance",
                    correlationId,
                    analysisId,
                    timestamp = DateTimeOffset.UtcNow,
                    testingGuidance = new
                    {
                        codePaths = (testingGuidance.CodePaths ?? new List<EdogQaLlmClient.CodePathItem>())
                            .Select(c => new
                            {
                                id = c.Id,
                                description = c.Description,
                                changeKind = c.ChangeKind,
                                evidenceRefs = c.EvidenceRefs ?? new List<string>(),
                            }).ToList(),
                        featureFlagMatrix = (testingGuidance.FeatureFlagMatrix ?? new List<EdogQaLlmClient.FeatureFlagCombination>())
                            .Select(m => new
                            {
                                id = m.Id,
                                flags = (m.Flags ?? new List<EdogQaLlmClient.FlagAssignment>())
                                    .Select(fa => new { name = fa.Name, value = fa.Value }).ToList(),
                                rationale = m.Rationale,
                                mustCover = m.MustCover,
                            }).ToList(),
                        stimuliRequired = (testingGuidance.StimuliRequired ?? new List<EdogQaLlmClient.StimulusRequirement>())
                            .Select(s => new
                            {
                                id = s.Id,
                                kind = s.Kind,
                                description = s.Description,
                                toolingHint = s.ToolingHint,
                            }).ToList(),
                        observableSignals = (testingGuidance.ObservableSignals ?? new List<EdogQaLlmClient.ObservableSignal>())
                            .Select(o => new
                            {
                                id = o.Id,
                                kind = o.Kind,
                                description = o.Description,
                                source = o.Source,
                            }).ToList(),
                        errorModesToTest = (testingGuidance.ErrorModesToTest ?? new List<EdogQaLlmClient.ErrorModeItem>())
                            .Select(e => new
                            {
                                id = e.Id,
                                description = e.Description,
                                trigger = e.Trigger,
                                expectedHandling = e.ExpectedHandling,
                                evidenceRefs = e.EvidenceRefs ?? new List<string>(),
                            }).ToList(),
                        externalDependencyFailures = (testingGuidance.ExternalDependencyFailures ?? new List<EdogQaLlmClient.ExternalDependencyFailure>())
                            .Select(x => new
                            {
                                id = x.Id,
                                dependency = x.Dependency,
                                failureMode = x.FailureMode,
                                expectedSystemResponse = x.ExpectedSystemResponse,
                            }).ToList(),
                        diagnosticNotes = testingGuidance.DiagnosticNotes,
                    },
                }).ConfigureAwait(false);
            }

            // Phase 6: Complete
            sw.Stop();
            await BroadcastAnalysisProgressAsync(correlationId, analysisId, "complete", 5, 6, 100,
                $"Analysis complete. {totalScenarios} scenarios ready for curation.", sw.ElapsedMilliseconds).ConfigureAwait(false);
        }

        // ──────────────────────────────────────────────────────────
        // F27 "Pinnacle" Quality Gates — item 1: PR context parsing.
        // ──────────────────────────────────────────────────────────

        /// <summary>
        /// Parse the enriched PR context fields returned by the dev-server's
        /// <c>/api/ado-proxy/pr-diff</c> endpoint into a typed
        /// <see cref="PrContext"/>. Returns null only when every field is
        /// missing — otherwise returns a partially-populated context with
        /// best-effort sections.
        /// </summary>
        /// <remarks>
        /// The dev-server already applies per-field caps; this method does
        /// not re-validate sizes. JSON parse failures on individual fields
        /// are swallowed and recorded in <see cref="PrContext.Warnings"/>
        /// so they surface as degradation flags on the analysis result.
        /// </remarks>
        private static PrContext TryParsePrContext(System.Text.Json.JsonElement diffResult)
        {
            try
            {
                var ctx = new PrContext();
                var hasAny = false;

                if (diffResult.TryGetProperty("title", out var titleEl)
                    && titleEl.ValueKind == System.Text.Json.JsonValueKind.String)
                {
                    ctx.Title = titleEl.GetString();
                    hasAny |= !string.IsNullOrEmpty(ctx.Title);
                }
                if (diffResult.TryGetProperty("author", out var authorEl)
                    && authorEl.ValueKind == System.Text.Json.JsonValueKind.String)
                {
                    ctx.Author = authorEl.GetString();
                }
                if (diffResult.TryGetProperty("description", out var descEl)
                    && descEl.ValueKind == System.Text.Json.JsonValueKind.String)
                {
                    ctx.Description = descEl.GetString();
                    hasAny |= !string.IsNullOrEmpty(ctx.Description);
                }

                if (diffResult.TryGetProperty("workItems", out var wiArr)
                    && wiArr.ValueKind == System.Text.Json.JsonValueKind.Array)
                {
                    foreach (var wi in wiArr.EnumerateArray())
                    {
                        try
                        {
                            ctx.WorkItems.Add(new WorkItemSummary
                            {
                                Id = wi.TryGetProperty("id", out var idEl)
                                     && idEl.ValueKind == System.Text.Json.JsonValueKind.Number
                                     && idEl.TryGetInt64(out var idVal) ? idVal : 0,
                                Title = wi.TryGetProperty("title", out var t)
                                        && t.ValueKind == System.Text.Json.JsonValueKind.String
                                        ? t.GetString() : null,
                                State = wi.TryGetProperty("state", out var s)
                                        && s.ValueKind == System.Text.Json.JsonValueKind.String
                                        ? s.GetString() : null,
                                AcceptanceCriteria = wi.TryGetProperty("acceptanceCriteria", out var ac)
                                                     && ac.ValueKind == System.Text.Json.JsonValueKind.String
                                                     ? ac.GetString() : null,
                                DescriptionSnippet = wi.TryGetProperty("descriptionSnippet", out var ds)
                                                     && ds.ValueKind == System.Text.Json.JsonValueKind.String
                                                     ? ds.GetString() : null,
                            });
                            hasAny = true;
                        }
                        catch (Exception ex)
                        {
                            ctx.Warnings.Add($"work_item_parse_failed: {ex.Message}");
                        }
                    }
                }

                if (diffResult.TryGetProperty("linkedSpecExcerpts", out var specsArr)
                    && specsArr.ValueKind == System.Text.Json.JsonValueKind.Array)
                {
                    foreach (var sp in specsArr.EnumerateArray())
                    {
                        try
                        {
                            var url = sp.TryGetProperty("url", out var u)
                                      && u.ValueKind == System.Text.Json.JsonValueKind.String
                                      ? u.GetString() : null;
                            var content = sp.TryGetProperty("content", out var c)
                                          && c.ValueKind == System.Text.Json.JsonValueKind.String
                                          ? c.GetString() : null;
                            if (!string.IsNullOrEmpty(url) || !string.IsNullOrEmpty(content))
                            {
                                ctx.LinkedSpecExcerpts.Add(new SpecExcerpt { Url = url, Content = content });
                                hasAny = true;
                            }
                        }
                        catch (Exception ex)
                        {
                            ctx.Warnings.Add($"spec_excerpt_parse_failed: {ex.Message}");
                        }
                    }
                }

                if (diffResult.TryGetProperty("apiCatalog", out var catalogEl)
                    && catalogEl.ValueKind == System.Text.Json.JsonValueKind.Object)
                {
                    try
                    {
                        var cat = new ApiCatalogContext();
                        if (catalogEl.TryGetProperty("controllers", out var ctrls)
                            && ctrls.ValueKind == System.Text.Json.JsonValueKind.Array)
                        {
                            foreach (var c in ctrls.EnumerateArray())
                            {
                                if (c.ValueKind == System.Text.Json.JsonValueKind.String)
                                {
                                    cat.Controllers.Add(c.GetString());
                                }
                            }
                        }
                        if (catalogEl.TryGetProperty("endpoints", out var eps)
                            && eps.ValueKind == System.Text.Json.JsonValueKind.Array)
                        {
                            foreach (var ep in eps.EnumerateArray())
                            {
                                if (ep.ValueKind != System.Text.Json.JsonValueKind.Object) continue;
                                var dict = new Dictionary<string, object>();
                                foreach (var prop in ep.EnumerateObject())
                                {
                                    dict[prop.Name] = prop.Value.Clone();
                                }
                                cat.Endpoints.Add(dict);
                            }
                        }
                        if (catalogEl.TryGetProperty("truncated", out var trEl)
                            && (trEl.ValueKind == System.Text.Json.JsonValueKind.True
                                || trEl.ValueKind == System.Text.Json.JsonValueKind.False))
                        {
                            cat.Truncated = trEl.GetBoolean();
                        }
                        if (cat.Endpoints.Count > 0 || cat.Controllers.Count > 0)
                        {
                            ctx.ApiCatalog = cat;
                            hasAny = true;
                        }
                    }
                    catch (Exception ex)
                    {
                        ctx.Warnings.Add($"api_catalog_parse_failed: {ex.Message}");
                    }
                }

                if (diffResult.TryGetProperty("priorTests", out var ptArr)
                    && ptArr.ValueKind == System.Text.Json.JsonValueKind.Array)
                {
                    foreach (var pt in ptArr.EnumerateArray())
                    {
                        try
                        {
                            var entry = new PriorTestFile
                            {
                                File = pt.TryGetProperty("file", out var f)
                                       && f.ValueKind == System.Text.Json.JsonValueKind.String
                                       ? f.GetString() : null,
                                Controller = pt.TryGetProperty("controller", out var cc)
                                             && cc.ValueKind == System.Text.Json.JsonValueKind.String
                                             ? cc.GetString() : null,
                                TotalMethods = pt.TryGetProperty("totalMethods", out var tm)
                                               && tm.ValueKind == System.Text.Json.JsonValueKind.Number
                                               && tm.TryGetInt32(out var tmVal) ? tmVal : 0,
                            };
                            if (pt.TryGetProperty("methods", out var m)
                                && m.ValueKind == System.Text.Json.JsonValueKind.Array)
                            {
                                foreach (var mm in m.EnumerateArray())
                                {
                                    if (mm.ValueKind == System.Text.Json.JsonValueKind.String)
                                    {
                                        entry.Methods.Add(mm.GetString());
                                    }
                                }
                            }
                            if (!string.IsNullOrEmpty(entry.File) || entry.Methods.Count > 0)
                            {
                                ctx.PriorTests.Add(entry);
                                hasAny = true;
                            }
                        }
                        catch (Exception ex)
                        {
                            ctx.Warnings.Add($"prior_test_parse_failed: {ex.Message}");
                        }
                    }
                }

                if (diffResult.TryGetProperty("extrasWarnings", out var warnArr)
                    && warnArr.ValueKind == System.Text.Json.JsonValueKind.Array)
                {
                    foreach (var w in warnArr.EnumerateArray())
                    {
                        if (w.ValueKind == System.Text.Json.JsonValueKind.String)
                        {
                            ctx.Warnings.Add(w.GetString());
                        }
                    }
                }

                return hasAny ? ctx : null;
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"[QA] TryParsePrContext failed: {ex.Message}");
                return null;
            }
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
            var globalTimeout = options?.GlobalTimeoutMs ?? 1800000;
            // NB: InterScenarioDelayMs and StopOnFirstFailure are owned by the
            // execution engine now. The engine inserts its own inter-scenario
            // safety gap and runs every submitted scenario; stop-on-first
            // semantics are deferred until the engine surfaces a hook.
            var cancelledByUser = false;

            // Apply global timeout
            cts.CancelAfter(globalTimeout);
            var ct = cts.Token;

            var completedCount = 0;
            var passedCount = 0;
            var failedCount = 0;
            var scenarioResults = new List<object>();
            // F27 P7: parallel typed list for persistence. We can't reflect on
            // the anonymous-typed `scenarioResults` entries above, so we
            // populate a typed mirror in the same loop and hand it off to
            // EdogQaRunStore at run completion.
            var persistedScenarios = new List<QaScenarioRecord>();
            RunResult engineRunResult = null;

            // ── F27 P8: Honesty gate. The run loop used to fake-pass every
            // scenario via Task.Delay(10) + hardcoded verdict="passed". If the
            // execution engine is not registered (e.g. DevMode init failed or
            // a host is running without DI wiring), refuse to silently produce
            // green verdicts — broadcast a QaError and finish the run as
            // failed with zero scenarios executed.
            var engine = EdogQaServiceLocator.ExecutionEngine;

            // ── Execution diagnostics to browser console ──────────────
            Console.WriteLine($"[QA-DIAG] Execution loop started: runId={runId}, scenarios={scenarios.Count}, globalTimeout={globalTimeout}ms");
            _ = BroadcastQaEventAsync("QaAnalysisWarning", new
            {
                eventType = "QaAnalysisWarning",
                correlationId,
                timestamp = DateTimeOffset.UtcNow,
                warning = "qa_diagnostic",
                message = $"Execution loop started: {scenarios.Count} scenarios, timeout={globalTimeout}ms, engine={(engine != null ? engine.GetType().Name : "NULL")}",
            });

            if (engine == null)
            {
                await PublishQaErrorAsync(
                    correlationId, runId,
                    errorCode: "ENGINE_NOT_REGISTERED",
                    message: "QA execution engine is not registered. DevMode initialization is incomplete; no scenarios were executed.",
                    scenarioId: null, phase: "initialize",
                    severity: "fatal", recoverable: false).ConfigureAwait(false);

                await BuildAndFinalizeRunAsync(
                    correlationId, runId, runEntry, startedAt,
                    cancelledByUser: false,
                    scenarios.Count,
                    scenarioResults, persistedScenarios,
                    passedCount: 0, failedCount: 0,
                    completedCount: 0,
                    engineRunResult: null).ConfigureAwait(false);
                return;
            }

            // ── Convert wire-format scenarios into engine-format Scenarios.
            // Failures here are caller-data problems, not engine bugs; surface
            // them loudly rather than dropping silently.
            List<Scenario> engineScenarios;
            try
            {
                Console.WriteLine($"[QA-DIAG] Converting {scenarios.Count} submitted scenarios to engine format...");
                engineScenarios = scenarios.Select(ConvertSubmittedToEngineScenario).ToList();
                Console.WriteLine($"[QA-DIAG] Conversion OK: {engineScenarios.Count} engine scenarios");
                _ = BroadcastQaEventAsync("QaAnalysisWarning", new
                {
                    eventType = "QaAnalysisWarning",
                    correlationId,
                    timestamp = DateTimeOffset.UtcNow,
                    warning = "qa_diagnostic",
                    message = $"Scenario conversion OK: {engineScenarios.Count} engine scenarios ready",
                });
            }
            catch (Exception convEx)
            {
                Console.WriteLine($"[QA-DIAG] *** Conversion FAILED: {convEx.GetType().Name}: {convEx.Message}");
                _ = BroadcastQaEventAsync("QaAnalysisWarning", new
                {
                    eventType = "QaAnalysisWarning",
                    correlationId,
                    timestamp = DateTimeOffset.UtcNow,
                    warning = "qa_diagnostic",
                    message = $"*** CONVERSION FAILED: {convEx.GetType().Name}: {convEx.Message}",
                });
                await PublishQaErrorAsync(
                    correlationId, runId,
                    errorCode: "SCENARIO_CONVERSION_FAILED",
                    message: $"Failed to convert submitted scenarios to engine format: {convEx.Message}",
                    scenarioId: null, phase: "initialize",
                    severity: "fatal", recoverable: false).ConfigureAwait(false);

                await BuildAndFinalizeRunAsync(
                    correlationId, runId, runEntry, startedAt,
                    cancelledByUser: false,
                    scenarios.Count,
                    scenarioResults, persistedScenarios,
                    passedCount: 0, failedCount: 0,
                    completedCount: 0,
                    engineRunResult: null).ConfigureAwait(false);
                return;
            }

            // Lookup tables for enrichment of engine progress events with the
            // submitted-scenario context (title/category/expectation count).
            var submittedById = new Dictionary<string, QaSubmittedScenario>(scenarios.Count);
            var indexById = new Dictionary<string, int>(scenarios.Count);
            for (var i = 0; i < scenarios.Count; i++)
            {
                submittedById[scenarios[i].Id] = scenarios[i];
                indexById[scenarios[i].Id] = i;
            }

            // The engine fires onProgress synchronously; bridge it to SignalR
            // via fire-and-forget tasks. A SemaphoreSlim(1) serializes the
            // bridges so QaScenarioCompleted can never overtake the
            // QaScenarioStarted for the same scenario (and broadcasts stay
            // in engine-order), and as a side effect mutual exclusion
            // protects the shared scenarioResults / persistedScenarios /
            // counters without needing a separate lock.
            var bridgeTasks = new ConcurrentBag<Task>();
            var bridgeMutex = new SemaphoreSlim(1, 1);

            void EnqueueBridge(QaExecutionProgress p)
            {
                bridgeTasks.Add(BridgeProgressAsync(p));
            }

            async Task BridgeProgressAsync(QaExecutionProgress p)
            {
                await bridgeMutex.WaitAsync().ConfigureAwait(false);
                try
                {
                    var idx = indexById.TryGetValue(p.ScenarioId, out var ix) ? ix : -1;
                    var submitted = submittedById.TryGetValue(p.ScenarioId, out var sb) ? sb : null;

                    if (p.Phase == ExecutionPhase.Isolate)
                    {
                        await BroadcastQaEventAsync("QaScenarioStarted", new
                        {
                            eventType = "QaScenarioStarted",
                            correlationId,
                            runId,
                            timestamp = DateTimeOffset.UtcNow,
                            scenarioId = p.ScenarioId,
                            scenarioIndex = idx,
                            totalScenarios = p.TotalCount,
                            title = submitted?.Title ?? "",
                            category = submitted?.Category ?? "happy_path",
                            phase = "isolate",
                            expectationCount = submitted?.Expectations?.Count ?? 0
                        }).ConfigureAwait(false);
                        return;
                    }

                    if (p.Phase != ExecutionPhase.Report || p.Result == null)
                        return;

                    var sr = p.Result;
                    var verdictStr = sr.Verdict.ToString().ToLowerInvariant();
                    var category = sr.Category ?? submitted?.Category ?? "happy_path";
                    var title = sr.Title ?? submitted?.Title ?? "";
                    var scenarioHash = EdogQaRunStore.ComputeScenarioHash(
                        sr.ScenarioId, title, category);

                    // Per design decision A (production-bar honest): Partial
                    // and Crashed both count toward the headline "failed"
                    // rollup. Skipped stays separate (capability gap, not a
                    // failure of the SUT). The atomic per-verdict counts
                    // remain available in the typed QaRunSummaryData fields.
                    var bumpPassed = sr.Verdict == ScenarioVerdict.Passed;
                    var bumpFailed = sr.Verdict == ScenarioVerdict.Failed
                                     || sr.Verdict == ScenarioVerdict.Partial
                                     || sr.Verdict == ScenarioVerdict.TimedOut
                                     || sr.Verdict == ScenarioVerdict.Crashed
                                     || sr.Verdict == ScenarioVerdict.Stale
                                     || sr.Verdict == ScenarioVerdict.Inconclusive;

                    completedCount++;
                    if (bumpPassed) passedCount++;
                    else if (bumpFailed) failedCount++;

                    var scenarioResult = new
                    {
                        scenarioId = sr.ScenarioId,
                        scenarioHash,
                        title,
                        category,
                        verdict = verdictStr,
                        durationMs = sr.DurationMs,
                        startedAt = sr.StartedAt,
                        completedAt = sr.CompletedAt,
                        expectations = sr.Expectations ?? new List<ExpectationResult>(),
                        eventsCaptured = sr.EventsCaptured,
                        errorMessage = sr.ErrorMessage,
                        failedAtPhase = sr.FailedAtPhase.ToString().ToLowerInvariant()
                    };

                    scenarioResults.Add(scenarioResult);
                    persistedScenarios.Add(new QaScenarioRecord
                    {
                        ScenarioId = sr.ScenarioId,
                        ScenarioHash = scenarioHash,
                        Title = title,
                        Category = category,
                        Status = verdictStr,
                        ErrorSummary = sr.ErrorMessage,
                        Matchers = submitted?.Matchers != null
                            ? submitted.Matchers.Cast<object>().ToList()
                            : new List<object>(),
                        CatalogHashes = submitted?.CatalogHashes.HasValue == true
                            ? (object)submitted.CatalogHashes.Value
                            : null,
                        Lifecycle = (submitted?.Lifecycle ?? ScenarioLifecycle.Completed).ToString(),
                    });

                    await BroadcastQaEventAsync("QaScenarioCompleted", new
                    {
                        eventType = "QaScenarioCompleted",
                        correlationId,
                        runId,
                        timestamp = DateTimeOffset.UtcNow,
                        scenarioId = sr.ScenarioId,
                        scenarioIndex = idx,
                        totalScenarios = p.TotalCount,
                        result = scenarioResult,
                        runProgress = new
                        {
                            completed = completedCount,
                            passed = passedCount,
                            failed = failedCount,
                            remaining = scenarios.Count - completedCount
                        }
                    }).ConfigureAwait(false);
                }
                catch (Exception bridgeEx)
                {
                    // Don't fail the run for a broadcast hiccup, but surface
                    // the failure to the browser console.
                    Console.WriteLine(
                        $"[QA-DIAG] *** Bridge failed for {p?.ScenarioId} phase={p?.Phase}: {bridgeEx.GetType().Name}: {bridgeEx.Message}");
                    _ = BroadcastQaEventAsync("QaAnalysisWarning", new
                    {
                        eventType = "QaAnalysisWarning",
                        correlationId,
                        timestamp = DateTimeOffset.UtcNow,
                        warning = "qa_diagnostic",
                        message = $"*** Bridge error for {p?.ScenarioId}: {bridgeEx.GetType().Name}: {bridgeEx.Message}",
                    });
                }
                finally
                {
                    bridgeMutex.Release();
                }
            }

            try
            {
                Console.WriteLine($"[QA-DIAG] Calling engine.ExecuteRunAsync: runId={runId}, scenarios={engineScenarios.Count}");
                _ = BroadcastQaEventAsync("QaAnalysisWarning", new
                {
                    eventType = "QaAnalysisWarning",
                    correlationId,
                    timestamp = DateTimeOffset.UtcNow,
                    warning = "qa_diagnostic",
                    message = $"Engine.ExecuteRunAsync starting: {engineScenarios.Count} scenarios",
                });
                engineRunResult = await engine
                    .ExecuteRunAsync(runId, engineScenarios, EnqueueBridge, ct)
                    .ConfigureAwait(false);
                Console.WriteLine($"[QA-DIAG] Engine.ExecuteRunAsync returned: passed={engineRunResult?.Summary?.Passed}, failed={engineRunResult?.Summary?.Failed}");
                _ = BroadcastQaEventAsync("QaAnalysisWarning", new
                {
                    eventType = "QaAnalysisWarning",
                    correlationId,
                    timestamp = DateTimeOffset.UtcNow,
                    warning = "qa_diagnostic",
                    message = $"Engine execution done: passed={engineRunResult?.Summary?.Passed}, failed={engineRunResult?.Summary?.Failed}, passedCount={passedCount}, failedCount={failedCount}",
                });
            }
            catch (OperationCanceledException)
            {
                Console.WriteLine($"[QA-DIAG] Engine execution CANCELLED");
                cancelledByUser = true;
            }
            catch (Exception engineEx)
            {
                Console.WriteLine($"[QA-DIAG] *** Engine execution FAILED: {engineEx.GetType().Name}: {engineEx.Message}");
                _ = BroadcastQaEventAsync("QaAnalysisWarning", new
                {
                    eventType = "QaAnalysisWarning",
                    correlationId,
                    timestamp = DateTimeOffset.UtcNow,
                    warning = "qa_diagnostic",
                    message = $"*** ENGINE FAILED: {engineEx.GetType().Name}: {engineEx.Message}",
                });
                await PublishQaErrorAsync(
                    correlationId, runId,
                    errorCode: "ENGINE_EXECUTION_FAILED",
                    message: engineEx.Message,
                    scenarioId: null, phase: "execute",
                    severity: "fatal", recoverable: false).ConfigureAwait(false);
            }

            // Drain any in-flight bridge broadcasts so SignalR clients see
            // every QaScenarioCompleted before QaRunCompleted lands.
            try
            {
                await Task.WhenAll(bridgeTasks.ToArray()).ConfigureAwait(false);
            }
            catch
            {
                // per-task errors already swallowed in BridgeProgressAsync
            }

            await BuildAndFinalizeRunAsync(
                correlationId, runId, runEntry, startedAt,
                cancelledByUser,
                scenarios.Count,
                scenarioResults, persistedScenarios,
                passedCount, failedCount,
                completedCount, engineRunResult).ConfigureAwait(false);
        }

        /// <summary>
        /// Builds the final QaRunResult, persists history, and broadcasts
        /// <c>QaRunCompleted</c>. Pulled out of <see cref="RunExecutionLoopAsync"/>
        /// so both the happy path and the honesty-gate / engine-failure paths
        /// emit a consistent terminal event.
        /// </summary>
        private async Task BuildAndFinalizeRunAsync(
            string correlationId,
            string runId,
            QaRunEntry runEntry,
            DateTimeOffset startedAt,
            bool cancelledByUser,
            int totalScenarioCount,
            List<object> scenarioResults,
            List<QaScenarioRecord> persistedScenarios,
            int passedCount,
            int failedCount,
            int completedCount,
            RunResult engineRunResult)
        {
            var completedAt = DateTimeOffset.UtcNow;
            var totalDurationMs = (long)(completedAt - startedAt).TotalMilliseconds;

            int partialCount = 0, crashedCount = 0, timedOutCount = 0;
            if (engineRunResult?.Summary != null)
            {
                partialCount = engineRunResult.Summary.Partial;
                crashedCount = engineRunResult.Summary.Crashed;
                timedOutCount = engineRunResult.Summary.TimedOut;
            }
            var skippedCount = totalScenarioCount - completedCount;
            if (skippedCount < 0) skippedCount = 0;

            // Strict per-verdict count for the Failed field on the wire/disk.
            // The "failed" rollup that the headline UI shows is computed
            // separately below to honor the Partial->Failed design choice.
            var strictFailed = failedCount - partialCount - crashedCount - timedOutCount;
            if (strictFailed < 0) strictFailed = failedCount;

            var summary = new QaRunSummaryData
            {
                Total = totalScenarioCount,
                Passed = passedCount,
                Failed = strictFailed,
                Partial = partialCount,
                Crashed = crashedCount,
                TimedOut = timedOutCount,
                Skipped = skippedCount,
            };

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
                    TotalExecutionMs = engineRunResult?.TotalDurationMs ?? totalDurationMs,
                    AverageScenarioMs = completedCount > 0 ? totalDurationMs / completedCount : 0
                },
                CuratorApproval = runEntry.CuratorApproval,
            };
            QaHubState.StoreRunResult(runId, runResult);

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

            try
            {
                EdogQaRunStore.Add(new QaRunRecord
                {
                    RunId = runId,
                    PrId = runEntry.PrId,
                    PrTitle = runEntry.PrTitle ?? string.Empty,
                    StartedAt = startedAt,
                    CompletedAt = completedAt,
                    TotalDurationMs = totalDurationMs,
                    CancelledByUser = cancelledByUser,
                    Summary = summary,
                    OverallPass = summary.OverallPass,
                    Scenarios = persistedScenarios,
                });
            }
            catch (Exception persistEx)
            {
                System.Diagnostics.Debug.WriteLine(
                    $"[QA] EdogQaRunStore.Add failed (non-fatal): {persistEx.Message}");
            }

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
                    // Wire-level "failed" honors the design decision: Partial,
                    // Crashed, and TimedOut all roll up into the headline
                    // failure metric the UI displays. Atomic counts (partial,
                    // crashed, timedOut) remain available alongside.
                    failed = strictFailed + partialCount + crashedCount + timedOutCount,
                    timedOut = timedOutCount,
                    partial = partialCount,
                    crashed = crashedCount,
                    skipped = summary.Skipped,
                    // OverallPass is strict at the model layer (Total > 0 &&
                    // Passed == Total). Skipped/Partial/Crashed/TimedOut all
                    // force this to false, including the honesty-gate path
                    // where the engine didn't run at all.
                    overallPass = summary.OverallPass
                },
                performance = runResult.Performance,
                unobservablePaths = engineRunResult?.UnobservablePaths ?? new List<string>()
            }).ConfigureAwait(false);
        }

        /// <summary>
        /// Converts a wire-format <see cref="QaSubmittedScenario"/> (string-
        /// typed fields, boxed Stimulus/Metadata via SignalR JSON) into the
        /// engine-format <see cref="Scenario"/> with proper enums and typed
        /// sub-records. Throws on malformed input; the run loop turns that
        /// into a fatal QaError rather than swallowing it.
        /// </summary>
        private static Scenario ConvertSubmittedToEngineScenario(QaSubmittedScenario s)
        {
            return ConvertSubmittedToEngineScenarioInternal(s);
        }

        // Test-visible seam for the broadcast-projection contract harness
        // (tests/dotnet/EdogQaE2E.Tests/BroadcastProjectionHarness.cs).
        // Behaviour is identical to the private wrapper above — splitting
        // the visibility means a future refactor of the private API does
        // not break the test, and the test does not have to use reflection.
        internal static Scenario ConvertSubmittedToEngineScenarioInternal(QaSubmittedScenario s)
        {
            if (s == null) throw new ArgumentNullException(nameof(s));

            return new Scenario
            {
                Id = s.Id ?? string.Empty,
                Title = s.Title ?? string.Empty,
                Description = s.Description ?? string.Empty,
                Category = ParseScenarioCategory(s.Category),
                Priority = s.Priority,
                ImpactZone = s.ImpactZone ?? string.Empty,
                Lifecycle = ScenarioLifecycle.Queued,
                TimeoutMs = s.TimeoutMs > 0 ? s.TimeoutMs : 30_000,
                Stimulus = DeserializeAs<Stimulus>(s.Stimulus),
                Expectations = (s.Expectations ?? new List<QaSubmittedExpectation>())
                    .Select(e => new Expectation
                    {
                        Id = e.Id ?? string.Empty,
                        Type = ParseExpectationType(e.Type),
                        Topic = e.Topic ?? string.Empty,
                        Description = e.Description ?? string.Empty,
                        // F27 P8: pass the full match semantics through.
                        // Engine assertion runs against these — dropping
                        // them would make every matcher match anything.
                        Matcher = e.Matcher,
                        TimeWindow = e.TimeWindow,
                        Count = e.Count,
                        Order = e.Order,
                    })
                    .ToList(),
                Setup = (s.Setup ?? new List<object>())
                    .Select(DeserializeAs<SetupStep>)
                    .Where(x => x != null)
                    .ToList(),
                Teardown = (s.Teardown ?? new List<object>())
                    .Select(DeserializeAs<TeardownStep>)
                    .Where(x => x != null)
                    .ToList(),
                Metadata = DeserializeAs<ScenarioMetadata>(s.Metadata) ?? new ScenarioMetadata(),
            };
        }

        private static ScenarioCategory ParseScenarioCategory(string raw)
        {
            // ValidateScenarios already enforces snake_case via a case-
            // insensitive HashSet, so anything that reaches conversion is
            // one of the known values (or empty). Unknown input is a
            // contract bug — fail loud rather than silently mapping to
            // HappyPath, which would mask a wire-format change.
            if (string.IsNullOrEmpty(raw))
                return ScenarioCategory.HappyPath;
            return raw.ToLowerInvariant() switch
            {
                "happy_path" => ScenarioCategory.HappyPath,
                "error_path" => ScenarioCategory.ErrorPath,
                "edge_case" => ScenarioCategory.EdgeCase,
                "regression" => ScenarioCategory.Regression,
                "performance" => ScenarioCategory.Performance,
                _ => throw new ArgumentException(
                    $"Unknown scenario category: '{raw}'. Expected one of " +
                    "happy_path, error_path, edge_case, regression, performance.")
            };
        }

        private static ExpectationType ParseExpectationType(string raw)
        {
            // Strict mapping: silently defaulting an unknown type to
            // EventPresent would invert assertion semantics — e.g. a
            // misspelled "event_absnt" becomes a presence check, the
            // opposite of what the LLM/curator intended.
            if (string.IsNullOrEmpty(raw))
                return ExpectationType.EventPresent;
            return raw.ToLowerInvariant() switch
            {
                "event_present" => ExpectationType.EventPresent,
                "event_absent" => ExpectationType.EventAbsent,
                "event_count" => ExpectationType.EventCount,
                "event_order" => ExpectationType.EventOrder,
                "timing" => ExpectationType.Timing,
                "field_match" => ExpectationType.FieldMatch,
                _ => throw new ArgumentException(
                    $"Unknown expectation type: '{raw}'. Expected one of " +
                    "event_present, event_absent, event_count, event_order, timing, field_match.")
            };
        }

        private static readonly System.Text.Json.JsonSerializerOptions _engineConvertOpts =
            new System.Text.Json.JsonSerializerOptions
            {
                PropertyNameCaseInsensitive = true,
                Converters =
                {
                    new System.Text.Json.Serialization.JsonStringEnumConverter(
                        System.Text.Json.JsonNamingPolicy.SnakeCaseLower,
                        allowIntegerValues: false),
                },
            };

        /// <summary>
        /// Coerces a boxed JSON value (typically a <see cref="System.Text.Json.JsonElement"/>
        /// from SignalR deserialization) into a typed engine record via a
        /// JSON round-trip. Returns null on null input.
        /// </summary>
        private static T DeserializeAs<T>(object raw) where T : class
        {
            if (raw == null) return null;
            if (raw is T already) return already;
            try
            {
                if (raw is System.Text.Json.JsonElement je)
                {
                    return System.Text.Json.JsonSerializer
                        .Deserialize<T>(je.GetRawText(), _engineConvertOpts);
                }
                var json = System.Text.Json.JsonSerializer.Serialize(raw, _engineConvertOpts);
                return System.Text.Json.JsonSerializer.Deserialize<T>(json, _engineConvertOpts);
            }
            catch
            {
                return null;
            }
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
                        else if (!ValidTopicVocabulary.Contains(exp.Topic))
                            errors.Add(new QaValidationError { ScenarioId = s.Id, Field = $"expectations[{exp.Id}].topic", Message = $"Unknown topic: {exp.Topic}" });
                    }
                }

                // Timeout
                if (s.TimeoutMs < 1000 || s.TimeoutMs > 120000)
                    errors.Add(new QaValidationError { ScenarioId = s.Id, Field = "timeoutMs", Message = "Timeout must be 1000-120000 ms" });
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

        // ─────────────────────────────────────────────────────────────
        // F27: QA scenario wire-projection helpers.
        //
        // These project the typed Stimulus / Expectation models into
        // the SignalR payload shape consumed by the QA curation panel.
        // The previous hand-rolled anonymous projection silently
        // dropped every non-HttpRequest stimulus variant and every
        // expectation sub-object (matcher / timeWindow / count /
        // order), which made every DiInvocation / SignalRBroadcast /
        // DagTrigger / FileEvent / TimerTick scenario fail end-to-end
        // because the curator could not see — or re-submit — the
        // payload the LLM had actually generated.
        //
        // The helpers below pass the typed nested specs straight
        // through. The SignalR JSON protocol is already configured
        // for camelCase + JsonStringEnumConverter (see
        // EdogLogServer.AddJsonProtocol), so every future field
        // added to HttpRequestSpec / SignalRBroadcastSpec / DagTriggerSpec
        // / FileEventSpec / TimerTickSpec / DiInvocationSpec / Matcher
        // / TimeWindowSpec / CountSpec / OrderSpec flows to the wire
        // automatically — there is no leaf-level hand-projection to
        // forget to update.
        //
        // The discriminator (`type` for stimulus, snake_case for
        // expectation.type) is kept on the wire as historically
        // emitted so the frontend remains backward-compatible.
        // `internal` so the dotnet contract-test harness can drive
        // these directly and lock the invariant.
        // ─────────────────────────────────────────────────────────────
        internal static object ProjectStimulusForWire(Stimulus s)
        {
            if (s == null) return null;
            return new
            {
                type = s.Type.ToString().ToLowerInvariant(),
                httpRequest = s.HttpRequest,
                signalRBroadcast = s.SignalRBroadcast,
                dagTrigger = s.DagTrigger,
                fileEvent = s.FileEvent,
                timerTick = s.TimerTick,
                diInvocation = s.DiInvocation,
            };
        }

        internal static object ProjectExpectationForWire(Expectation e)
        {
            if (e == null) return null;
            return new
            {
                id = e.Id,
                type = ConvertExpectationTypeToSnakeCase(e.Type),
                topic = e.Topic,
                // Preserve the LLM/curator-authored description when
                // present; fall back to the synthetic legacy string
                // only when the source description was empty.
                description = !string.IsNullOrEmpty(e.Description)
                    ? e.Description
                    : $"{e.Type} on '{e.Topic}'",
                matcher = e.Matcher,
                timeWindow = e.TimeWindow,
                count = e.Count,
                order = e.Order,
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
            string severity, bool recoverable, string cause = null)
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
                recoverable,
                cause
            }).ConfigureAwait(false);
        }

        #region MITM (F28)

        // ═══════════════════════════════════════════════════════════════════
        // F28 — HTTP MITM hub methods (8 client→server RPCs)
        // Pattern mirrors the Qa* methods above: try/catch every entry point,
        // log with [EDOG] prefix, return a typed error envelope on failure.
        // ═══════════════════════════════════════════════════════════════════

        private const string MitmTopic = "mitm";

        /// <summary>
        /// Returns the MITM capability snapshot. Used by the frontend to gate
        /// the entire MITM surface before issuing any other Mitm* call.
        /// </summary>
        public Task<MitmCapabilityReport> MitmGetCapabilities()
        {
            try
            {
                return Task.FromResult(MitmCoordinator.GetCapabilities(Context.ConnectionId));
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"[EDOG] MitmGetCapabilities error: {ex.Message}");
                return Task.FromResult(new MitmCapabilityReport { });
            }
        }

        /// <summary>
        /// Validates and stores a new MITM rule under the current connection's
        /// ownership. Publishes <c>mitm.ruleCreated</c> on success.
        /// </summary>
        public Task<MitmRuleResult> MitmCreateRule(MitmRuleInput input)
        {
            var connectionId = Context.ConnectionId;
            try
            {
                if (input == null)
                {
                    return Task.FromResult(new MitmRuleResult
                    {
                        Success = false,
                        Code = "RULE_VALIDATION_FAILED",
                        Message = "Rule input is required.",
                    });
                }

                if (!TryBuildMitmRule(input, connectionId, out var rule, out var validationError))
                {
                    return Task.FromResult(new MitmRuleResult
                    {
                        Success = false,
                        Code = "RULE_VALIDATION_FAILED",
                        Message = validationError,
                    });
                }

                var insertResult = MitmRuleStore.AddOrReplace(rule);
                if (!insertResult.Success)
                {
                    return Task.FromResult(new MitmRuleResult
                    {
                        Success = false,
                        Code = "RULE_VALIDATION_FAILED",
                        Message = insertResult.Message,
                    });
                }

                EdogTopicRouter.Publish(MitmTopic, new
                {
                    type = "ruleCreated",
                    revision = insertResult.Revision,
                    rule,
                    byConnectionId = connectionId,
                });

                return Task.FromResult(new MitmRuleResult
                {
                    Success = true,
                    Message = insertResult.Message,
                    RuleId = insertResult.RuleId ?? rule.Id,
                    Revision = insertResult.Revision,
                });
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"[EDOG] MitmCreateRule error: {ex.Message}");
                return Task.FromResult(new MitmRuleResult
                {
                    Success = false,
                    Code = "RULE_VALIDATION_FAILED",
                    Message = "Internal error while creating rule.",
                });
            }
        }

        /// <summary>
        /// Removes a rule by id. Idempotent — returns success even when the rule
        /// is unknown. Publishes <c>mitm.ruleDeleted</c> on a real delete.
        /// </summary>
        public Task<MitmOperationResult> MitmDeleteRule(string ruleId)
        {
            try
            {
                if (string.IsNullOrWhiteSpace(ruleId))
                {
                    return Task.FromResult(new MitmOperationResult
                    {
                        Success = false,
                        Code = "RULE_VALIDATION_FAILED",
                        Message = "ruleId is required.",
                    });
                }

                bool removed = MitmRuleStore.Remove(ruleId);
                if (removed)
                {
                    EdogTopicRouter.Publish(MitmTopic, new
                    {
                        type = "ruleDeleted",
                        revision = MitmRuleStore.Revision,
                        ruleId,
                        reason = "user",
                        byConnectionId = Context.ConnectionId,
                    });
                }

                return Task.FromResult(new MitmOperationResult
                {
                    Success = true,
                    Message = removed ? "Deleted" : "Not found",
                });
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"[EDOG] MitmDeleteRule error: {ex.Message}");
                return Task.FromResult(new MitmOperationResult
                {
                    Success = false,
                    Code = "RULE_VALIDATION_FAILED",
                    Message = "Internal error while deleting rule.",
                });
            }
        }

        /// <summary>Lists all rules across all owners (diagnostic / UI list view).</summary>
        public Task<MitmRuleListResult> MitmListRules()
        {
            try
            {
                var rules = MitmRuleStore.GetAll();
                return Task.FromResult(new MitmRuleListResult
                {
                    Success = true,
                    Revision = MitmRuleStore.Revision,
                    Rules = rules?.Cast<object>().ToList() ?? new List<object>(),
                });
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"[EDOG] MitmListRules error: {ex.Message}");
                return Task.FromResult(new MitmRuleListResult
                {
                    Success = false,
                    Code = "RULE_VALIDATION_FAILED",
                    Message = "Internal error while listing rules.",
                    Rules = new List<object>(),
                });
            }
        }

        /// <summary>
        /// Submits a user decision for a paused breakpoint. The connection
        /// submitting must match the connection that received the breakpoint
        /// (owner-locked — see MitmCoordinator.SubmitDecision).
        /// </summary>
        public Task<MitmOperationResult> MitmResumeBreakpoint(MitmDecision decision)
        {
            try
            {
                if (decision == null || string.IsNullOrEmpty(decision.Verdict))
                {
                    return Task.FromResult(new MitmOperationResult
                    {
                        Success = false,
                        Code = "RESUME_VALIDATION_FAILED",
                        Message = "decision and verdict are required.",
                    });
                }

                // BE-003: InterceptId is now an explicit field on MitmDecision.
                // The SubmittedByConnectionId field is reserved for server-side
                // attribution and is always stamped with the caller's connection id.
                // For backward compatibility we still accept a legacy "id:<X>;"
                // prefix in NoteForAudit when InterceptId is absent.
                string interceptId = decision.InterceptId;
                if (string.IsNullOrEmpty(interceptId)
                    && !string.IsNullOrEmpty(decision.NoteForAudit)
                    && decision.NoteForAudit.StartsWith("id:", StringComparison.Ordinal))
                {
                    int semi = decision.NoteForAudit.IndexOf(';');
                    interceptId = semi > 3
                        ? decision.NoteForAudit.Substring(3, semi - 3)
                        : decision.NoteForAudit.Substring(3);
                }

                // BE-003: Stamp caller's connection id server-side as intended.
                decision.SubmittedByConnectionId = Context.ConnectionId;

                if (string.IsNullOrEmpty(interceptId))
                {
                    return Task.FromResult(new MitmOperationResult
                    {
                        Success = false,
                        Code = "INTERCEPT_NOT_FOUND",
                        Message = "interceptId could not be resolved from decision payload.",
                    });
                }

                var result = MitmCoordinator.SubmitDecision(interceptId, decision, Context.ConnectionId);
                return Task.FromResult(new MitmOperationResult
                {
                    Success = result.Success,
                    Code = result.Success ? null : (result.Error ?? "RESUME_VALIDATION_FAILED"),
                    Message = result.Success ? "Resumed" : result.Error,
                });
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"[EDOG] MitmResumeBreakpoint error: {ex.Message}");
                return Task.FromResult(new MitmOperationResult
                {
                    Success = false,
                    Code = "RESUME_VALIDATION_FAILED",
                    Message = "Internal error while resuming breakpoint.",
                });
            }
        }

        /// <summary>
        /// Kill switch — resumes all pending intercepts and wipes the rule
        /// store. Publishes <c>mitm.cleared</c> for the UI to react to.
        /// </summary>
        public Task<MitmOperationResult> MitmClearAll()
        {
            try
            {
                int resumed = MitmCoordinator.ClearAllPending("kill-switch");
                MitmRuleStore.ClearAll();

                EdogTopicRouter.Publish(MitmTopic, new
                {
                    type = "cleared",
                    resumedCount = resumed,
                    byConnectionId = Context.ConnectionId,
                });

                return Task.FromResult(new MitmOperationResult
                {
                    Success = true,
                    Message = $"Resumed {resumed} pending intercept(s); rules cleared.",
                });
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"[EDOG] MitmClearAll error: {ex.Message}");
                return Task.FromResult(new MitmOperationResult
                {
                    Success = false,
                    Code = "INTERNAL_ERROR",
                    Message = "Internal error while clearing MITM state.",
                });
            }
        }

        /// <summary>
        /// Global pass-through toggle. When <paramref name="enabled"/> is
        /// false, ShouldPause* short-circuits to false regardless of rule
        /// store contents. Existing rules survive.
        /// </summary>
        public Task<MitmOperationResult> MitmToggleInterception(bool enabled)
        {
            try
            {
                MitmCoordinator.SetInterceptionEnabled(enabled, Context.ConnectionId);
                return Task.FromResult(new MitmOperationResult
                {
                    Success = true,
                    Message = enabled ? "Interception enabled" : "Interception disabled",
                });
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"[EDOG] MitmToggleInterception error: {ex.Message}");
                return Task.FromResult(new MitmOperationResult
                {
                    Success = false,
                    Code = "INTERNAL_ERROR",
                    Message = "Internal error while toggling interception.",
                });
            }
        }

        /// <summary>
        /// Builds a Playground transfer payload from an http topic buffer row.
        /// Looks up the row by <paramref name="rowId"/> (matching <c>SequenceId</c>)
        /// and returns the full (un-truncated) body when available. Publishes
        /// <c>mitm.sentToPlayground</c> for audit.
        /// </summary>
        public Task<MitmPlaygroundTransferResult> MitmSendToPlayground(long rowId)
        {
            try
            {
                var buffer = EdogTopicRouter.GetBuffer("http");
                if (buffer == null)
                {
                    return Task.FromResult(new MitmPlaygroundTransferResult
                    {
                        Success = false,
                        Code = "ROW_NOT_FOUND",
                        Message = "http topic buffer unavailable.",
                    });
                }

                TopicEvent match = null;
                foreach (var evt in buffer.GetSnapshot())
                {
                    if (evt != null && evt.SequenceId == rowId) { match = evt; break; }
                }

                if (match == null || match.Data == null)
                {
                    return Task.FromResult(new MitmPlaygroundTransferResult
                    {
                        Success = false,
                        Code = "ROW_NOT_FOUND",
                        Message = $"http row {rowId} not found in buffer.",
                    });
                }

                var payload = BuildPlaygroundTransfer(match);

                EdogTopicRouter.Publish(MitmTopic, new
                {
                    type = "sentToPlayground",
                    sourceRowId = rowId,
                    byConnectionId = Context.ConnectionId,
                });

                return Task.FromResult(new MitmPlaygroundTransferResult
                {
                    Success = true,
                    Payload = payload,
                });
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"[EDOG] MitmSendToPlayground error: {ex.Message}");
                return Task.FromResult(new MitmPlaygroundTransferResult
                {
                    Success = false,
                    Code = "INTERNAL_ERROR",
                    Message = "Internal error while building transfer payload.",
                });
            }
        }

        // ─── MITM helpers (internal to hub) ─────────────────────────────────

        /// <summary>
        /// Translates the wire-friendly <see cref="MitmRuleInput"/> into the
        /// internal immutable <see cref="MitmRule"/> shape. Owner is always
        /// set from <paramref name="connectionId"/> — clients cannot forge it.
        /// </summary>
        private static bool TryBuildMitmRule(
            MitmRuleInput input, string connectionId,
            out MitmRule rule, out string error)
        {
            rule = null;
            error = null;

            if (input.Match == null || input.Match.UrlPattern == null)
            {
                error = "match and match.urlPattern are required.";
                return false;
            }
            if (input.Action == null || string.IsNullOrEmpty(input.Action.Type))
            {
                error = "action.type is required.";
                return false;
            }

            var phase = string.Equals(input.Match.Phase, "response", StringComparison.OrdinalIgnoreCase)
                ? MitmPhase.Response
                : MitmPhase.Request;

            var kindStr = input.Match.UrlPattern.Kind ?? "substring";
            MitmUrlMatchKind kind;
            if (string.Equals(kindStr, "regex", StringComparison.OrdinalIgnoreCase))
                kind = MitmUrlMatchKind.Regex;
            else if (string.Equals(kindStr, "exact", StringComparison.OrdinalIgnoreCase))
                kind = MitmUrlMatchKind.Exact;
            else
                kind = MitmUrlMatchKind.Substring;

            Regex compiledRegex = null;
            if (kind == MitmUrlMatchKind.Regex)
            {
                try
                {
                    compiledRegex = new Regex(
                        input.Match.UrlPattern.Value ?? string.Empty,
                        RegexOptions.Compiled | RegexOptions.CultureInvariant,
                        TimeSpan.FromMilliseconds(50));
                }
                catch (Exception ex)
                {
                    error = $"Regex compile failed: {ex.Message}";
                    return false;
                }
            }

            MitmAction action;
            switch (input.Action.Type.ToLowerInvariant())
            {
                case "breakpoint":
                    action = new MitmBreakpointAction
                    {
                        Type = MitmActionType.Breakpoint,
                        TimeoutMs = input.Action.TimeoutMs ?? 30_000,
                    };
                    break;
                case "block":
                    action = new MitmBlockAction
                    {
                        Type = MitmActionType.Block,
                        StatusCode = input.Action.StatusCode ?? 503,
                        Body = input.Action.Body,
                        Headers = input.Action.Headers,
                    };
                    break;
                case "forge":
                    action = new MitmForgeAction
                    {
                        Type = MitmActionType.Forge,
                        StatusCode = input.Action.StatusCode ?? 200,
                        Body = input.Action.Body,
                        Headers = input.Action.Headers,
                        ReasonPhrase = input.Action.ReasonPhrase,
                    };
                    break;
                case "modify":
                    action = new MitmModifyAction
                    {
                        Type = MitmActionType.Modify,
                        ReplacementUrl = input.Action.ReplacementUrl,
                        SetHeaders = input.Action.SetHeaders,
                        RemoveHeaders = input.Action.RemoveHeaders,
                        ReplacementBody = input.Action.ReplacementBody,
                    };
                    break;
                case "passthrough":
                    action = new MitmPassthroughAction { Type = MitmActionType.Passthrough };
                    break;
                default:
                    error = $"Unknown action.type '{input.Action.Type}'.";
                    return false;
            }

            rule = new MitmRule
            {
                Id = string.IsNullOrEmpty(input.Id) ? "rule-" + Guid.NewGuid().ToString("N") : input.Id,
                Name = input.Name ?? string.Empty,
                OwnerConnectionId = connectionId,
                Enabled = input.Enabled,
                Priority = input.Priority,
                CreatedAtUtc = DateTimeOffset.UtcNow,
                Match = new MitmMatch
                {
                    Methods = input.Match.Methods,
                    HttpClientName = input.Match.HttpClientName,
                    Phase = phase,
                    UrlPattern = new MitmUrlPattern
                    {
                        Kind = kind,
                        Value = input.Match.UrlPattern.Value,
                        Compiled = compiledRegex,
                    },
                },
                Action = action,
            };
            return true;
        }

        /// <summary>
        /// Best-effort reflection-based extraction of fields from an
        /// http topic event payload (anonymous object — see EdogHttpPipelineHandler).
        /// </summary>
        private static PlaygroundTransferPayload BuildPlaygroundTransfer(TopicEvent evt)
        {
            var data = evt.Data;
            string method = ReadString(data, "method");
            string url = ReadString(data, "url");
            string body = ReadString(data, "responseBodyPreview");
            string correlationId = ReadString(data, "correlationId");

            var headers = new List<PlaygroundTransferHeader>();
            var headerDict = ReadProperty(data, "requestHeaders") as Dictionary<string, string>;
            if (headerDict != null)
            {
                foreach (var kv in headerDict)
                    headers.Add(new PlaygroundTransferHeader { Name = kv.Key, Value = kv.Value });
            }

            return new PlaygroundTransferPayload
            {
                Source = "http-tab",
                SourceRowId = evt.SequenceId,
                InterceptId = null,
                Method = method,
                Url = url,
                Headers = headers,
                Body = body,
                TokenType = correlationId != null ? "fabric" : null,
            };
        }

        private static object ReadProperty(object obj, string name)
        {
            if (obj == null) return null;
            try
            {
                if (obj is IDictionary<string, object> dict && dict.TryGetValue(name, out var v))
                    return v;
                var prop = obj.GetType().GetProperty(name);
                return prop?.GetValue(obj);
            }
            catch
            {
                return null;
            }
        }

        private static string ReadString(object obj, string name)
        {
            var v = ReadProperty(obj, name);
            return v?.ToString();
        }

        #endregion
    }
}
