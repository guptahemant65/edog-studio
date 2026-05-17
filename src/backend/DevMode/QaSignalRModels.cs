// <copyright file="QaSignalRModels.cs" company="Microsoft">
// Copyright (c) Microsoft Corporation. All rights reserved.
// </copyright>

#nullable disable
#pragma warning disable // DevMode-only file

namespace Microsoft.LiveTable.Service.DevMode
{
    using System;
    using System.Collections.Generic;

    // ──────────────────────────────────────────────
    // Base class for qa topic events (streaming filter)
    // ──────────────────────────────────────────────

    /// <summary>
    /// Base class for all QA events published to the "qa" topic buffer.
    /// Used by <see cref="EdogPlaygroundHub.IsQaEventForRun"/> to filter
    /// streaming events by runId.
    /// </summary>
    public abstract class QaEventBase
    {
        /// <summary>Event type discriminator, e.g. "QaRunStarted".</summary>
        public string EventType { get; set; }

        /// <summary>Correlation ID for request/response pairing.</summary>
        public string CorrelationId { get; set; }

        /// <summary>Run ID this event belongs to (null for analysis-only events).</summary>
        public string RunId { get; set; }

        /// <summary>UTC timestamp when the event was created.</summary>
        public DateTimeOffset Timestamp { get; set; }
    }

    // ──────────────────────────────────────────────
    // Client → Server: Request Types
    // ──────────────────────────────────────────────

    /// <summary>
    /// Request to start the five-layer code analysis pipeline for a PR.
    /// </summary>
    public sealed class QaAnalysisRequest
    {
        /// <summary>Correlation ID for request/response pairing.</summary>
        public string CorrelationId { get; set; }

        /// <summary>Full ADO pull request URL.</summary>
        public string PrUrl { get; set; }

        /// <summary>Pull request numeric ID (alternative to PrUrl).</summary>
        public int? PrId { get; set; }

        /// <summary>Analysis configuration options.</summary>
        public QaAnalysisOptions Options { get; set; }
    }

    /// <summary>
    /// Options for code analysis pipeline.
    /// </summary>
    public sealed class QaAnalysisOptions
    {
        /// <summary>Maximum number of scenarios to generate. Default 30.</summary>
        public int MaxScenarios { get; set; } = 30;

        /// <summary>Scenario categories to include. Null = all.</summary>
        public List<string> Categories { get; set; }

        /// <summary>Priority threshold (1-5). Default 5 (include all).</summary>
        public int PriorityThreshold { get; set; } = 5;

        /// <summary>Whether to include F24 chaos suggestions. Default true.</summary>
        public bool IncludeChaosSuggestions { get; set; } = true;

        /// <summary>Analysis timeout in milliseconds. Default 120000.</summary>
        public int TimeoutMs { get; set; } = 120000;
    }

    /// <summary>
    /// Submission of user-curated scenarios for execution.
    /// </summary>
    public sealed class QaScenarioSubmission
    {
        /// <summary>Correlation ID for request/response pairing.</summary>
        public string CorrelationId { get; set; }

        /// <summary>Analysis ID from QaStartCodeAnalysis.</summary>
        public string AnalysisId { get; set; }

        /// <summary>Curated scenarios to queue for execution.</summary>
        public List<QaSubmittedScenario> Scenarios { get; set; }
    }

    /// <summary>
    /// A single scenario as submitted by the frontend curation UI.
    /// Uses string-based enums matching the JSON wire format.
    /// </summary>
    public sealed class QaSubmittedScenario
    {
        /// <summary>Scenario ID matching ^scn-[a-z0-9-]+$.</summary>
        public string Id { get; set; }

        /// <summary>Human-readable title (max 120 chars).</summary>
        public string Title { get; set; }

        /// <summary>Detailed description (max 500 chars).</summary>
        public string Description { get; set; }

        /// <summary>Category: happy_path, error_path, edge_case, regression, performance.</summary>
        public string Category { get; set; }

        /// <summary>Priority 1-5.</summary>
        public int Priority { get; set; }

        /// <summary>Back-reference to impact zone.</summary>
        public string ImpactZone { get; set; }

        /// <summary>Setup steps.</summary>
        public List<object> Setup { get; set; } = new();

        /// <summary>Stimulus definition.</summary>
        public object Stimulus { get; set; }

        /// <summary>Expectations to evaluate.</summary>
        public List<QaSubmittedExpectation> Expectations { get; set; } = new();

        /// <summary>Teardown steps.</summary>
        public List<object> Teardown { get; set; } = new();

        /// <summary>Timeout in ms (1000-60000).</summary>
        public int TimeoutMs { get; set; } = 30000;

        /// <summary>Scenario metadata.</summary>
        public object Metadata { get; set; }
    }

    /// <summary>
    /// Expectation as submitted in the curation payload (string-based types).
    /// </summary>
    public sealed class QaSubmittedExpectation
    {
        /// <summary>Expectation ID matching ^exp-[0-9]+$.</summary>
        public string Id { get; set; }

        /// <summary>Expectation type string.</summary>
        public string Type { get; set; }

        /// <summary>Topic to monitor.</summary>
        public string Topic { get; set; }

        /// <summary>Human-readable description.</summary>
        public string Description { get; set; }
    }

    /// <summary>
    /// Request to start execution of a curated scenario run.
    /// </summary>
    public sealed class QaRunRequest
    {
        /// <summary>Correlation ID for request/response pairing.</summary>
        public string CorrelationId { get; set; }

        /// <summary>Run ID from QaSubmitCuratedScenarios.</summary>
        public string RunId { get; set; }

        /// <summary>Subset of scenario IDs to run. Null = run all in order.</summary>
        public List<string> ScenarioIds { get; set; }

        /// <summary>Execution options.</summary>
        public QaRunOptions Options { get; set; }
    }

    /// <summary>
    /// Execution run options.
    /// </summary>
    public sealed class QaRunOptions
    {
        /// <summary>Stop after first failure. Default false.</summary>
        public bool StopOnFirstFailure { get; set; }

        /// <summary>Delay between scenarios in ms. Default 500.</summary>
        public int InterScenarioDelayMs { get; set; } = 500;

        /// <summary>Global run timeout in ms. Default 1800000 (30 min).</summary>
        public int GlobalTimeoutMs { get; set; } = 1800000;
    }

    /// <summary>
    /// Request for run history.
    /// </summary>
    public sealed class QaHistoryRequest
    {
        /// <summary>Correlation ID for request/response pairing.</summary>
        public string CorrelationId { get; set; }

        /// <summary>Optional PR ID filter.</summary>
        public int? PrId { get; set; }

        /// <summary>Max results. Default 20, max 100.</summary>
        public int Limit { get; set; } = 20;

        /// <summary>Pagination offset. Default 0.</summary>
        public int Offset { get; set; }
    }

    // ──────────────────────────────────────────────
    // Client → Server: Response Types
    // ──────────────────────────────────────────────

    /// <summary>
    /// Result of QaStartCodeAnalysis.
    /// </summary>
    public sealed class QaAnalysisResult
    {
        /// <summary>Whether the operation succeeded.</summary>
        public bool Success { get; set; }

        /// <summary>Correlation ID echoed back.</summary>
        public string CorrelationId { get; set; }

        /// <summary>Unique analysis identifier.</summary>
        public string AnalysisId { get; set; }

        /// <summary>Human-readable status message.</summary>
        public string Message { get; set; }

        /// <summary>ID of a previously running analysis that was cancelled, or null.</summary>
        public string CancelledPreviousAnalysis { get; set; }
    }

    /// <summary>
    /// Result of QaSubmitCuratedScenarios.
    /// </summary>
    public sealed class QaSubmissionResult
    {
        /// <summary>Whether the operation succeeded.</summary>
        public bool Success { get; set; }

        /// <summary>Correlation ID echoed back.</summary>
        public string CorrelationId { get; set; }

        /// <summary>Generated run ID for the scenario set.</summary>
        public string RunId { get; set; }

        /// <summary>Number of valid scenarios accepted.</summary>
        public int ScenarioCount { get; set; }

        /// <summary>Human-readable status message.</summary>
        public string Message { get; set; }

        /// <summary>Per-scenario validation errors (empty on success).</summary>
        public List<QaValidationError> ValidationErrors { get; set; } = new();
    }

    /// <summary>
    /// Generic operation result for cancel/start/etc.
    /// </summary>
    public sealed class QaOperationResult
    {
        /// <summary>Whether the operation succeeded.</summary>
        public bool Success { get; set; }

        /// <summary>Correlation ID echoed back.</summary>
        public string CorrelationId { get; set; }

        /// <summary>Human-readable status message.</summary>
        public string Message { get; set; }
    }

    /// <summary>
    /// Per-field validation error for scenario submission.
    /// </summary>
    public sealed class QaValidationError
    {
        /// <summary>Scenario ID that failed validation.</summary>
        public string ScenarioId { get; set; }

        /// <summary>Field name that failed.</summary>
        public string Field { get; set; }

        /// <summary>Validation error description.</summary>
        public string Message { get; set; }
    }

    // ──────────────────────────────────────────────
    // History & Result Types
    // ──────────────────────────────────────────────

    /// <summary>
    /// Summary of a completed run (for history listing).
    /// </summary>
    public sealed class QaRunSummary
    {
        /// <summary>Run identifier.</summary>
        public string RunId { get; set; }

        /// <summary>Associated PR ID.</summary>
        public int PrId { get; set; }

        /// <summary>PR title.</summary>
        public string PrTitle { get; set; }

        /// <summary>UTC start time.</summary>
        public DateTimeOffset StartedAt { get; set; }

        /// <summary>UTC completion time.</summary>
        public DateTimeOffset CompletedAt { get; set; }

        /// <summary>Total duration in ms.</summary>
        public long TotalDurationMs { get; set; }

        /// <summary>Aggregated verdict counts.</summary>
        public QaRunSummaryData Summary { get; set; }

        /// <summary>True if no failures or crashes.</summary>
        public bool OverallPass { get; set; }
    }

    /// <summary>
    /// Aggregated scenario verdict counts.
    /// </summary>
    public sealed class QaRunSummaryData
    {
        /// <summary>Total scenario count.</summary>
        public int Total { get; set; }

        /// <summary>Passed count.</summary>
        public int Passed { get; set; }

        /// <summary>Failed count.</summary>
        public int Failed { get; set; }

        /// <summary>Timed out count.</summary>
        public int TimedOut { get; set; }

        /// <summary>Partial pass count.</summary>
        public int Partial { get; set; }

        /// <summary>Crashed count.</summary>
        public int Crashed { get; set; }

        /// <summary>Skipped count.</summary>
        public int Skipped { get; set; }

        /// <summary>True if no failures or crashes.</summary>
        public bool OverallPass => Failed == 0 && Crashed == 0;
    }

    /// <summary>
    /// Full run result with all scenario details.
    /// </summary>
    public sealed class QaRunResult
    {
        /// <summary>Run identifier.</summary>
        public string RunId { get; set; }

        /// <summary>Associated PR ID.</summary>
        public int PrId { get; set; }

        /// <summary>PR title.</summary>
        public string PrTitle { get; set; }

        /// <summary>PR URL.</summary>
        public string PrUrl { get; set; }

        /// <summary>UTC start time.</summary>
        public DateTimeOffset StartedAt { get; set; }

        /// <summary>UTC completion time.</summary>
        public DateTimeOffset CompletedAt { get; set; }

        /// <summary>Total duration in ms.</summary>
        public long TotalDurationMs { get; set; }

        /// <summary>Whether the run was cancelled by the user.</summary>
        public bool CancelledByUser { get; set; }

        /// <summary>Aggregated verdict counts.</summary>
        public QaRunSummaryData Summary { get; set; }

        /// <summary>Per-scenario results.</summary>
        public List<object> Scenarios { get; set; } = new();

        /// <summary>Unobservable code paths.</summary>
        public List<string> UnobservablePaths { get; set; } = new();

        /// <summary>Performance metrics.</summary>
        public QaPerformanceReport Performance { get; set; }
    }

    /// <summary>
    /// Immutable telemetry snapshot returned by QaGetTelemetry hub method.
    /// Surfaces every fallback path the engine has taken since startup so
    /// the studio UI and integration tests can detect silent degradation.
    /// </summary>
    public sealed class QaTelemetrySnapshot
    {
        /// <summary>UTC timestamp when the engine started.</summary>
        public DateTimeOffset StartedAt { get; set; }

        /// <summary>UTC timestamp when this snapshot was captured.</summary>
        public DateTimeOffset CapturedAt { get; set; }

        /// <summary>Times the synthetic-scenarios fallback in EdogPlaygroundHub fired.</summary>
        public long SyntheticScenariosFallbackCount { get; set; }

        /// <summary>Times the StubLlmProvider was invoked (placeholder LLM output).</summary>
        public long StubLlmProviderCallCount { get; set; }

        /// <summary>Times the StubOmniSharpProvider was invoked (no semantic enrichment).</summary>
        public long StubOmniSharpProviderCallCount { get; set; }

        /// <summary>Times the StubGraphProvider built a minimal graph (no real BFS).</summary>
        public long StubGraphProviderCallCount { get; set; }

        /// <summary>Fake "stub connectivity" edges emitted by StubGraphProvider.</summary>
        public long GraphStubConnectivityEdgeCount { get; set; }

        /// <summary>Times ChaosIntegration.ApplyChaosRuleAsync no-op'd (Layer-1 unwired).</summary>
        public long ChaosNoOpCount { get; set; }

        /// <summary>Times FlagOverrideStore.ApplyOverrideAsync no-op'd (Layer-1 unwired).</summary>
        public long FlagOverrideNoOpCount { get; set; }

        /// <summary>Real LLM call attempts (includes retries).</summary>
        public long LlmCallCount { get; set; }

        /// <summary>Real LLM calls that threw or returned empty/unconfigured.</summary>
        public long LlmErrorCount { get; set; }

        /// <summary>Code-analysis runs started.</summary>
        public long AnalysisStartedCount { get; set; }

        /// <summary>Code-analysis runs that reached the complete phase.</summary>
        public long AnalysisCompletedCount { get; set; }

        /// <summary>QA runs started.</summary>
        public long RunStartedCount { get; set; }

        /// <summary>QA runs that completed (regardless of verdict).</summary>
        public long RunCompletedCount { get; set; }

        // ── F27 P5 capability counters ─────────────────────────────────

        /// <summary>Real feature-flag overrides successfully merged into <c>EdogFeatureOverrideStore</c>.</summary>
        public long FlagOverrideAppliedCount { get; set; }

        /// <summary>Per-scenario teardowns that removed at least one override key.</summary>
        public long FlagOverrideRestoredCount { get; set; }

        /// <summary>Flag override requests refused (e.g. force-OFF in V1).</summary>
        public long FlagOverrideUnavailableCount { get; set; }

        /// <summary>Chaos rules successfully applied via <c>EdogHttpFaultStore</c>.</summary>
        public long ChaosAppliedCount { get; set; }

        /// <summary>Chaos rule requests refused due to unsupported fault type or disabled backend.</summary>
        public long ChaosUnavailableCount { get; set; }

        /// <summary>Scenarios that exited the engine with <c>Skipped</c> verdict due to a missing capability.</summary>
        public long ScenariosSkippedForCapabilityCount { get; set; }
    }

    /// <summary>
    /// Capability snapshot returned by <c>QaGetCapabilities</c>. Surfaces
    /// which scenario-setup primitives the host can actually satisfy so
    /// the curation UI can render capability badges before submission and
    /// users are never surprised by silent runtime skips.
    /// </summary>
    public sealed class QaCapabilityReport
    {
        /// <summary>UTC timestamp this snapshot was built.</summary>
        public DateTimeOffset CapturedAt { get; set; }

        /// <summary>True when feature-flag overrides can be applied (force-ON).</summary>
        public bool FlagOverrideSupported { get; set; }

        /// <summary>True when force-OFF overrides are also supported. Always false in V1.</summary>
        public bool FlagOverrideForceOffSupported { get; set; }

        /// <summary>Human-readable description of the flag-override surface.</summary>
        public string FlagOverrideReason { get; set; }

        /// <summary>True when HTTP fault injection is available (Stage 2 + env var).</summary>
        public bool HttpChaosSupported { get; set; }

        /// <summary>Human-readable reason for the HTTP-chaos state, including how to enable when disabled.</summary>
        public string HttpChaosReason { get; set; }

        /// <summary>Catalog of chaos fault types currently supported. Empty when HttpChaosSupported is false.</summary>
        public List<string> SupportedChaosFaults { get; set; } = new();
    }

    /// <summary>
    /// Performance metrics for a completed run.
    /// </summary>
    public sealed class QaPerformanceReport
    {
        /// <summary>Duration of the slowest scenario in ms.</summary>
        public long SlowestScenarioMs { get; set; }

        /// <summary>ID of the slowest scenario.</summary>
        public string SlowestScenarioId { get; set; }

        /// <summary>Average scenario duration in ms.</summary>
        public long AverageScenarioMs { get; set; }

        /// <summary>Total execution time in ms.</summary>
        public long TotalExecutionMs { get; set; }

        /// <summary>Overhead time in ms.</summary>
        public long OverheadMs { get; set; }
    }
}
