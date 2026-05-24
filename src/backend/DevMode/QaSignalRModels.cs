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

        /// <summary>
        /// IDs of scenarios that the curator opened in the editor and saved
        /// (i.e. modified before approval). Used by the hub to compute the
        /// curator approval rate (unedited vs edited vs rejected).
        /// Optional — older clients may omit; treated as empty.
        /// </summary>
        public List<string> EditedScenarioIds { get; set; } = new();

        /// <summary>
        /// Total scenarios produced by the analyzer for this analysis, before
        /// any curator deletions. Used together with the submitted Scenarios
        /// list to derive the rejected count. Zero means "unknown / older
        /// client" and the hub will fall back to Scenarios.Count.
        /// </summary>
        public int TotalGenerated { get; set; }
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

        /// <summary>Typed p10 matchers submitted alongside the legacy expectations.
        /// Deserialized as opaque JSON because MatcherValue is abstract and
        /// System.Text.Json cannot instantiate it without a custom converter.
        /// The execution path re-parses these in ConvertSubmittedToEngineScenario.</summary>
        public List<System.Text.Json.JsonElement> Matchers { get; set; } = new();

        /// <summary>Catalog hash envelope grounding the submitted scenario.
        /// Deserialized as opaque JSON because the wire format uses array-of-pairs
        /// for matcherTopicHashes while the engine model uses Dictionary.</summary>
        public System.Text.Json.JsonElement? CatalogHashes { get; set; }

        /// <summary>Lifecycle state supplied by the curation pipeline.</summary>
        public ScenarioLifecycle Lifecycle { get; set; } = ScenarioLifecycle.Generated;

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

        // F27 P8: the real EdogQaExecutionEngine consumes these via
        // EdogQaAssertionEngine. Pre-P8 the run was stubbed, so the wire
        // model dropped them; SignalR silently truncated the LLM-supplied
        // matcher data, which is fine for a fake loop but devastating for
        // real verdicts. Carrying them through verbatim restores fidelity.

        /// <summary>Field-level matching predicates (AND logic).</summary>
        public LegacyMatcher Matcher { get; set; }

        /// <summary>Optional time window constraints relative to T0.</summary>
        public TimeWindowSpec TimeWindow { get; set; }

        /// <summary>Optional event-count constraints.</summary>
        public CountSpec Count { get; set; }

        /// <summary>Optional ordering constraints relative to other expectations.</summary>
        public OrderSpec Order { get; set; }
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

        /// <summary>
        /// True only if every submitted scenario passed cleanly. A run with
        /// any Failed/Partial/Crashed/TimedOut/Skipped scenarios — or a zero-
        /// scenario "did nothing" run — is NOT a pass. F27 P8 tightened this
        /// from the old "Failed==0 && Crashed==0" definition so the honesty-
        /// gate skip path can't quietly report green.
        /// </summary>
        public bool OverallPass => Total > 0 && Passed == Total;
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

        /// <summary>
        /// Curator approval rate snapshot for this run (how many of the
        /// generated scenarios were kept unedited / edited / rejected).
        /// Null when the submission predates the approval-tracking wire.
        /// </summary>
        public QaCuratorApproval CuratorApproval { get; set; }
    }

    /// <summary>
    /// Snapshot of curator dispositions for a single run, computed by
    /// EdogPlaygroundHub.QaSubmitCuratedScenarios and carried forward
    /// onto the QaRunResult so the studio UI can render a tiny "9/11
    /// approved (82%), 7 unedited (64%), 2 edited, 2 rejected" stat row.
    /// </summary>
    public sealed class QaCuratorApproval
    {
        /// <summary>Total scenarios produced by the analyzer.</summary>
        public int TotalGenerated { get; set; }

        /// <summary>Approved scenarios the curator did not modify.</summary>
        public int ApprovedUnedited { get; set; }

        /// <summary>Approved scenarios the curator opened and saved edits on.</summary>
        public int ApprovedEdited { get; set; }

        /// <summary>Generated minus approved — the implicit-reject bucket.</summary>
        public int Rejected { get; set; }

        /// <summary>(unedited + edited) / totalGenerated, in [0, 1].</summary>
        public float ApprovalRate { get; set; }

        /// <summary>unedited / totalGenerated, in [0, 1].</summary>
        public float UneditedRate { get; set; }
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

        // ── V2 LLM readiness (F27 P9 T4-D follow-up) ────────────────

        /// <summary>True when both Architect and Editor probes passed and V2 pipeline is live.</summary>
        public bool LlmV2Ready { get; set; }

        /// <summary>True when the Architect probe (gpt-5.4 default) passed all required capabilities.</summary>
        public bool ArchitectReady { get; set; }

        /// <summary>True when the Editor probe (gpt-5.4-mini default) passed all required capabilities.</summary>
        public bool EditorReady { get; set; }

        /// <summary>Human-readable diagnostic of the V2 readiness state, including which role failed and why.</summary>
        public string LlmV2Reason { get; set; }

        /// <summary>UTC timestamp the dual probe completed (or null if it has not finished yet).</summary>
        public DateTimeOffset? LlmV2ProbedAt { get; set; }

        /// <summary>Effective mode after probe gating — one of "off" | "auto" | "shadow" | "on".</summary>
        public string LlmV2RequestedMode { get; set; }
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

    // ──────────────────────────────────────────────
    // F27 P7 — Persistent History + Run-to-Run Comparison
    // ──────────────────────────────────────────────

    /// <summary>
    /// Full persisted record of a completed QA run. Written to disk by
    /// <see cref="EdogQaRunStore"/> at the end of <c>RunExecutionLoopAsync</c>
    /// so history survives FLT process restarts. Scenarios carry summary
    /// fields only — captured events and expectation details stay
    /// in-process to keep file size bounded.
    /// </summary>
    public sealed class QaRunRecord
    {
        /// <summary>Run identifier.</summary>
        public string RunId { get; set; }

        /// <summary>Associated PR id; <c>0</c> means "no PR scope" (ad-hoc run).</summary>
        public int PrId { get; set; }

        /// <summary>PR title at submission time. Captured for history rendering.</summary>
        public string PrTitle { get; set; }

        /// <summary>UTC start time.</summary>
        public DateTimeOffset StartedAt { get; set; }

        /// <summary>UTC completion time.</summary>
        public DateTimeOffset CompletedAt { get; set; }

        /// <summary>Total duration in ms.</summary>
        public long TotalDurationMs { get; set; }

        /// <summary>Whether the run was cancelled by the user before all scenarios ran.</summary>
        public bool CancelledByUser { get; set; }

        /// <summary>Aggregated counts ("passed", "failed", "crashed", …).</summary>
        public QaRunSummaryData Summary { get; set; }

        /// <summary>True if no scenario failed and none crashed.</summary>
        public bool OverallPass { get; set; }

        /// <summary>Per-scenario summary rows. Sufficient for comparison + dropdown rendering.</summary>
        public List<QaScenarioRecord> Scenarios { get; set; } = new();

        /// <summary>Run-level quarantine reason recorded during p10 migration.</summary>
        public string QuarantineReason { get; set; }

        /// <summary>Whether the run contains pre-contract-quarantined scenarios.</summary>
        public bool IsPreContractQuarantined { get; set; }
    }

    /// <summary>
    /// Per-scenario summary row stored inside a <see cref="QaRunRecord"/>.
    /// Carries enough identity to support content-aware run-to-run
    /// comparison: <see cref="ScenarioHash"/> is the primary match key,
    /// <see cref="ScenarioId"/> is the back-compat fallback.
    /// </summary>
    public sealed class QaScenarioRecord
    {
        /// <summary>Original scenario id (display + back-compat fallback for matching).</summary>
        public string ScenarioId { get; set; }

        /// <summary>Stable content fingerprint synthesised at persist time from
        /// title + category + id. Authoritative match key during comparison.</summary>
        public string ScenarioHash { get; set; }

        /// <summary>Scenario title for display.</summary>
        public string Title { get; set; }

        /// <summary>Scenario category as string.</summary>
        public string Category { get; set; }

        /// <summary>Final verdict serialised as a string (e.g. "Passed", "Failed").</summary>
        public string Status { get; set; }

        /// <summary>Short failure summary. Null/empty when the scenario passed.</summary>
        public string ErrorSummary { get; set; }

        /// <summary>Typed matchers captured for p10 replay and migration.
        /// Stored as opaque objects (JsonElement at runtime) because
        /// MatcherValue is abstract and cannot round-trip through
        /// System.Text.Json without a custom converter.</summary>
        public List<object> Matchers { get; set; } = new();

        /// <summary>CatalogHashes captured alongside the scenario for p10 grounding checks.
        /// Stored as opaque object because the wire format uses array-of-pairs
        /// for matcherTopicHashes while the engine uses Dictionary.</summary>
        public object CatalogHashes { get; set; }

        /// <summary>Lifecycle snapshot captured when the scenario completed.</summary>
        public string Lifecycle { get; set; }

        /// <summary>Per-scenario quarantine reason set during p10 migration.</summary>
        public string QuarantineReason { get; set; }

        /// <summary>Whether the scenario was archived as pre-contract-quarantined.</summary>
        public bool IsPreContractQuarantined { get; set; }
    }

    /// <summary>
    /// Comparison request: diff <c>BaseRunId</c> vs <c>TargetRunId</c>.
    /// Convention: target is the newer run, base is the older one — the UI
    /// passes the currently-viewed run as target so diff badges read
    /// naturally ("NEW", "GONE", "→ PASS", "→ FAIL").
    /// </summary>
    public sealed class QaComparisonRequest
    {
        /// <summary>Older run id.</summary>
        public string BaseRunId { get; set; }

        /// <summary>Newer run id (the one currently viewed).</summary>
        public string TargetRunId { get; set; }
    }

    /// <summary>
    /// Result of comparing two runs via <c>QaCompareRuns</c>. Scenarios are
    /// matched primarily by <see cref="QaScenarioRecord.ScenarioHash"/>;
    /// when either side lacks a hash the matcher falls back to
    /// <see cref="QaScenarioRecord.ScenarioId"/> and surfaces a warning so
    /// the UI can render a degraded-confidence banner.
    /// </summary>
    public sealed class QaRunComparison
    {
        /// <summary>Older run id (echoed from the request).</summary>
        public string BaseRunId { get; set; }

        /// <summary>Newer run id (echoed from the request).</summary>
        public string TargetRunId { get; set; }

        /// <summary>True when both runs were loaded successfully.</summary>
        public bool Success { get; set; }

        /// <summary>Scenarios present in target but not in base. Render as "NEW" badge.</summary>
        public List<QaScenarioRecord> AddedInTarget { get; set; } = new();

        /// <summary>Scenarios present in base but not in target. Render as "GONE" badge.</summary>
        public List<QaScenarioRecord> RemovedFromTarget { get; set; } = new();

        /// <summary>Scenarios present in both whose status differs. Render as "→ PASS" / "→ FAIL".</summary>
        public List<QaScenarioFlip> StatusFlips { get; set; } = new();

        /// <summary>Non-fatal observations the UI should surface (matching strategy, unscoped PRs, …).</summary>
        public List<string> Warnings { get; set; } = new();

        /// <summary>Reason a comparison could not be produced (e.g. "Base run not found").</summary>
        public string Error { get; set; }
    }

    /// <summary>
    /// Represents a scenario that appeared in both runs but switched verdict.
    /// </summary>
    public sealed class QaScenarioFlip
    {
        /// <summary>Match key used (echoed for UI keying).</summary>
        public string ScenarioId { get; set; }

        /// <summary>Content hash used to match the scenario when available.</summary>
        public string ScenarioHash { get; set; }

        /// <summary>Display title from the target run.</summary>
        public string Title { get; set; }

        /// <summary>Status in the base (older) run.</summary>
        public string BaseStatus { get; set; }

        /// <summary>Status in the target (newer) run.</summary>
        public string TargetStatus { get; set; }
    }
}
