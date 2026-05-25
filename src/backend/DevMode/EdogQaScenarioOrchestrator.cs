// SPDX-License-Identifier: MIT
// F27 P9 T1c-b — V2 LLM Scenario Orchestrator.
//
// The orchestrator is the conductor that drives the entire V2 generation
// pipeline for one analysis. Inputs are a batch of ImpactZones already
// distilled by EdogQaCodeAnalyzer; outputs are the engine-shape Scenarios
// ready for the curation UI or the execution engine.
//
// Pipeline per zone:
//
//     Architect (gpt-5.4, high effort, structured plan)
//        ↓ ArchitectPlan
//     Editor    (gpt-5.4-mini, low effort, strict-schema scenarios)
//        ↓ GeneratedScenario[]
//     Validator (5 gates, hash-dedup intra-zone)
//        ↓ AcceptedScenario[]                        (with SemanticHash)
//        + QuarantinedScenario[]
//
// Cross-zone (after all zones finish):
//
//     Deterministic dedup on SemanticHash → winners[]
//     Project winners → engine Scenario[]
//
// Cross-cutting concerns the orchestrator owns:
//   • Bounded concurrency: SemaphoreSlim(MaxConcurrentZones) gates work.
//   • Budget gate: cumulative cost (μUSD fixed-point) and monotonic
//     wall-clock deadline. Checked AFTER semaphore acquisition so the
//     queue race the rubber-duck flagged cannot leak through.
//   • First-tripped budget reason claimed via CompareExchange so the
//     BudgetExceeded event fires exactly once.
//   • Progress events for SignalR live-progress.
//   • Per-zone failure isolation: any throw inside a zone task becomes a
//     ZoneOutcome=Failed result; sibling zones continue.
//   • External cancellation: the caller's CancellationToken throws OCE;
//     per-zone exceptions never throw to the caller.
//   • Determinism: same inputs ⇒ same MergedScenarios regardless of
//     zone-completion order. Final merge is sorted by
//     (ZoneInputIndex, ScenarioId, SemanticHash) before projection.
//
// Test seam: ArchitectStageDelegate + EditorStageDelegate allow the
// harness to inject canned LlmClientResults without any HTTP traffic.

#nullable disable
#pragma warning disable // DevMode-only file — suppress all warnings

namespace Microsoft.LiveTable.Service.DevMode
{
    using System;
    using System.Collections.Concurrent;
    using System.Collections.Generic;
    using System.Diagnostics;
    using System.Linq;
    using System.Net.Http;
    using System.Security.Cryptography;
    using System.Text;
    using System.Text.Json;
    using System.Threading;
    using System.Threading.Tasks;

    // ═══════════════════════════════════════════════════════════════════
    // Public API
    // ═══════════════════════════════════════════════════════════════════

    internal sealed class EdogQaScenarioOrchestrator
    {
        // ── Wire-stable budget codes ───────────────────────────────────

        public const string CodeBudgetExceededCost = "BUDGET_EXCEEDED_COST";
        public const string CodeBudgetExceededTime = "BUDGET_EXCEEDED_TIME";

        // ── Wire-stable orchestrator errors (not LLM client errors) ────

        public const string CodeDelegateReturnedNull = "ORCH_DELEGATE_RETURNED_NULL";
        public const string CodeUnexpectedException = "ORCH_UNEXPECTED_EXCEPTION";

        // ── Pricing ────────────────────────────────────────────────────

        /// <summary>
        /// Per-1k-token pricing for a single deployment. All units are USD.
        /// Placeholder defaults are documented but every operational
        /// deployment SHOULD inject a real table; <see cref="PricingTable.Source"/>
        /// makes the provenance explicit so operators never confuse
        /// placeholders for authoritative pricing.
        /// </summary>
        public sealed class DeploymentPricing
        {
            public double InputPerThousand { get; set; }

            public double OutputPerThousand { get; set; }

            public double ReasoningPerThousand { get; set; }
        }

        public sealed class PricingTable
        {
            public DeploymentPricing Architect { get; set; } = new();

            public DeploymentPricing Editor { get; set; } = new();

            /// <summary>Free-form tag, e.g. "DefaultPlaceholder", "Azure-2026-05", "EvalRunFixed". Telemetry / logs surface this to operators.</summary>
            public string Source { get; set; } = "DefaultPlaceholder";

            public static PricingTable DefaultPlaceholder() => new()
            {
                // Conservative placeholders chosen so a $0.50 cap holds for
                // a single-digit-zone analysis at gpt-5.4 + gpt-5.4-mini.
                // Real pricing must be injected via configuration.
                Architect = new() { InputPerThousand = 0.025, OutputPerThousand = 0.075, ReasoningPerThousand = 0 },
                Editor = new() { InputPerThousand = 0.005, OutputPerThousand = 0.015, ReasoningPerThousand = 0 },
                Source = "DefaultPlaceholder",
            };
        }

        // ── Stage delegates (testing seam) ─────────────────────────────

        public delegate Task<EdogQaLlmClient.LlmClientResult> ArchitectStageDelegate(
            EdogQaLlmClient.ZoneContext zone,
            CancellationToken ct);

        /// <summary>
        /// Step-1 Analyst stage delegate. Observation-only pass that produces
        /// the structured payload the Architect consumes as frozen trusted
        /// context. Split from <see cref="ArchitectStageDelegate"/> so the
        /// orchestrator can run them as two sequential calls with independent
        /// override seams for testing.
        /// </summary>
        public delegate Task<EdogQaLlmClient.LlmClientResult> AnalystStageDelegate(
            EdogQaLlmClient.ZoneContext zone,
            CancellationToken ct);

        public delegate Task<EdogQaLlmClient.LlmClientResult> EditorStageDelegate(
            EdogQaLlmClient.ArchitectPlan plan,
            EdogQaLlmClient.ZoneContext zone,
            CancellationToken ct);

        /// <summary>
        /// Repair-aware Editor stage delegate. T1e introduced a second
        /// Editor pass driven by <see cref="EdogQaLlmClient.EditorRepairContext"/>
        /// — either to recover from a parse/schema/binding failure
        /// (Branch A) or to re-emit replacements for validator-quarantined
        /// scenarios (Branch B). The delegate is split from
        /// <see cref="EditorStageDelegate"/> deliberately so existing
        /// 3-parameter test lambdas keep compiling unchanged.
        /// </summary>
        public delegate Task<EdogQaLlmClient.LlmClientResult> EditorRepairStageDelegate(
            EdogQaLlmClient.ArchitectPlan plan,
            EdogQaLlmClient.ZoneContext zone,
            EdogQaLlmClient.EditorRepairContext repair,
            CancellationToken ct);

        // ── Config ─────────────────────────────────────────────────────

        public sealed class OrchestratorConfig
        {
            /// <summary>Azure OpenAI architect deployment config. Required unless <see cref="ArchitectOverride"/> is non-null.</summary>
            public EdogQaLlmClient.ArchitectConfig Architect { get; set; }

            /// <summary>Azure OpenAI editor deployment config. Required unless <see cref="EditorOverride"/> is non-null.</summary>
            public EdogQaLlmClient.EditorConfig Editor { get; set; }

            /// <summary>Bounded concurrency across zones. Must be ≥ 1.</summary>
            public int MaxConcurrentZones { get; set; } = 3;

            /// <summary>Maximum cumulative cost (USD) before the orchestrator stops accepting new zones. Set ≤ 0 to disable cost gating.</summary>
            public double MaxBudgetUsd { get; set; } = 0.50;

            /// <summary>Maximum wall-clock seconds before the orchestrator stops accepting new zones. Set ≤ 0 to disable time gating.</summary>
            public int MaxBudgetSeconds { get; set; } = 90;

            /// <summary>Validator context (frozen valid-topics + flags). Required.</summary>
            public EdogQaScenarioValidator.ValidationContext Validation { get; set; }

            /// <summary>Pricing table for cost accounting. Required; default = <see cref="PricingTable.DefaultPlaceholder"/>.</summary>
            public PricingTable Pricing { get; set; } = PricingTable.DefaultPlaceholder();

            /// <summary>Test override for the Architect stage. When non-null, the orchestrator does not call <see cref="EdogQaLlmClient.ArchitectOnceAsync"/>.</summary>
            public ArchitectStageDelegate ArchitectOverride { get; set; }

            /// <summary>
            /// Test override for the Analyst stage (Step 1 of the 2-step
            /// Analyst→Architect pipeline). When non-null, the orchestrator does
            /// not call <see cref="EdogQaLlmClient.AnalystOnceAsync"/>. When this
            /// AND <see cref="Architect"/> are both null, the Analyst pass is
            /// skipped entirely and the Architect runs without observations
            /// (graceful degradation — the Architect prompt handles the
            /// missing-observations case).
            /// </summary>
            public AnalystStageDelegate AnalystOverride { get; set; }

            /// <summary>Test override for the Editor stage. When non-null, the orchestrator does not call EditorOnceAsync.</summary>
            public EditorStageDelegate EditorOverride { get; set; }

            /// <summary>
            /// Test override for the Editor REPAIR stage (T1e). When non-null
            /// the orchestrator does not call the repair-aware overload of
            /// EditorOnceAsync. When this and
            /// <see cref="EditorOverride"/> are both null but
            /// <see cref="EnableRepairLoop"/> is true, the orchestrator uses
            /// the live LLM client for both passes.
            /// </summary>
            public EditorRepairStageDelegate EditorRepairOverride { get; set; }

            /// <summary>
            /// F27 P9 T1e: enable the one-shot Editor repair loop. When
            /// <c>true</c> (default), the orchestrator (a) retries Editor
            /// once if the initial call failed parse/schema/binding gates,
            /// and (b) re-emits replacements for validator-quarantined
            /// scenarios after a successful initial call. Default
            /// <c>true</c>; the analyzer wire-in flips it off only for
            /// tests that need to assert the un-repaired baseline.
            /// </summary>
            public bool EnableRepairLoop { get; set; } = true;

            /// <summary>Optional revisioned options provider captured once per run for prompt/config stability.</summary>
            public IQaContractOptionsProvider OptionsProvider { get; set; }

            /// <summary>
            /// Total number of reachable stimulus slots from the catalog snapshot.
            /// Used to compute the max repair passes via <c>min(2, floor(reachableSlotCount / 8))</c>.
            /// When 0 or negative, the orchestrator defaults to 1 repair pass maximum.
            /// </summary>
            public int ReachableSlotCount { get; set; }
        }

        // ── Input ──────────────────────────────────────────────────────

        public sealed class ZoneInput
        {
            public string ZoneId { get; set; }

            public string ZoneSummary { get; set; }

            public string RedactedDiff { get; set; }

            public string BaseSha { get; set; }

            public string HeadSha { get; set; }

            /// <summary>Full unified diff passed to the validator's evidence-binding gate. May equal <see cref="RedactedDiff"/> if no separate unredacted view exists.</summary>
            public string UnifiedDiff { get; set; }

            /// <summary>P10: pre-rendered slot purposes text for the Architect. May be empty.</summary>
            public string SlotPurposesText { get; set; }

            /// <summary>P10: pre-rendered few-shot exemplars text. May be empty.</summary>
            public string FewShotExemplarsText { get; set; }

            /// <summary>P10: compact structured catalog reference JSON for the Editor. May be empty.</summary>
            public string CatalogReferenceJson { get; set; }

            /// <summary>
            /// Runtime catalog snapshot for this zone. Carried through to
            /// the projector so it can deterministically fill
            /// <c>scenario.catalogHashes</c> after the Editor produces
            /// scenarios — the Editor cannot compute SHA hashes. May be
            /// null when catalog assembly was skipped or failed (the
            /// projector treats null as "leave hashes as the Editor
            /// emitted them"). Spec §3.2 catalog-hash-projection fix.
            /// </summary>
            public CatalogSnapshot Catalog { get; set; }

            /// <summary>
            /// PA-1: test-file hunks split out of <see cref="RedactedDiff"/> so the Architect
            /// prompt can present them as secondary evidence. May be empty when the PR
            /// touches no test files (or when the splitter degraded). The Validator still
            /// reads <see cref="UnifiedDiff"/> for evidence binding, so a split here never
            /// loses grounding information downstream.
            /// </summary>
            public string TestDiff { get; set; }

            /// <summary>
            /// PE-1: trusted harness-context summary of PR intent (title + description +
            /// linked work-items). Forwarded into <see cref="EdogQaLlmClient.ZoneContext.PrIntentSummary"/>
            /// so the Architect can orient on the central behavioural change. May be empty
            /// when no <c>PrContext</c> metadata is available (e.g. shadow-mode shortcut,
            /// harness fixture).
            /// </summary>
            public string PrIntentSummary { get; set; }

            /// <summary>Compact invariant list for the Editor so it can populate
            /// invariantsAddressed. One line per invariant: "inv-ID (kind symbol)".</summary>
            public string InvariantsSummary { get; set; }
        }

        // ── Output ─────────────────────────────────────────────────────

        public enum ZoneOutcome
        {
            /// <summary>Zone completed Architect+Editor+Validator pipeline (Accepted may still be empty).</summary>
            Completed = 0,

            /// <summary>Architect returned no_testable_changes; editor was skipped.</summary>
            NoTestableChanges = 1,

            /// <summary>Zone skipped because budget was tripped before its turn.</summary>
            SkippedForBudget = 2,

            /// <summary>Zone failed at some pipeline stage; <see cref="ZoneResult.Errors"/> carries wire codes.</summary>
            Failed = 3,
        }

        public sealed class ZoneResult
        {
            public int ZoneInputIndex { get; set; }

            public string ZoneId { get; set; }

            public ZoneOutcome Outcome { get; set; }

            /// <summary>Single tagged reason for non-Completed outcomes (e.g. <c>BUDGET_EXCEEDED_COST</c>, <c>ARCHITECT_NETWORK_ERROR</c>). Empty for Completed.</summary>
            public string OutcomeReason { get; set; } = string.Empty;

            public EdogQaLlmClient.ArchitectPlan Plan { get; set; }

            /// <summary>Runtime catalog snapshot carried from the matching <see cref="ZoneInput.Catalog"/> so cross-zone dedup + projection can find the right hashes per winner.</summary>
            public CatalogSnapshot Catalog { get; set; }

            /// <summary>F27 P11: testingGuidance projected out of the Analyst's observations
            /// (codePaths, featureFlagMatrix, stimuliRequired, observableSignals,
            /// errorModesToTest, externalDependencyFailures). Null when P11 is disabled or
            /// when the Analyst was skipped/failed. Consumed by the scenario validator
            /// (coverage gate) and surfaced to the curator UI.</summary>
            public EdogQaLlmClient.TestingGuidance TestingGuidance { get; set; }

            /// <summary>Validator-accepted scenarios for THIS zone (pre cross-zone dedup). Each carries SemanticHash; the orchestrator consumes these to build the global merged list.</summary>
            public List<EdogQaScenarioValidator.AcceptedScenario> Accepted { get; set; } = new();

            /// <summary>Validator-quarantined scenarios for THIS zone.</summary>
            public List<EdogQaScenarioValidator.QuarantinedScenario> Quarantined { get; set; } = new();

            /// <summary>Wire-stable error codes from any pipeline stage. Empty for Completed.</summary>
            public List<string> Errors { get; set; } = new();

            public long ElapsedMs { get; set; }

            public int InputTokens { get; set; }

            public int OutputTokens { get; set; }

            public int ReasoningTokens { get; set; }

            public double CostUsd { get; set; }

            // ── T1e: Editor repair-pass telemetry ────────────────────────

            /// <summary>Number of repair passes executed. Capped at <c>min(2, floor(reachableSlotCount / 8))</c> per spec §4.2.</summary>
            public int RepairAttempts { get; set; }

            /// <summary>Wire-stable tag identifying the repair branch that fired. Empty when <see cref="RepairAttempts"/> = 0.</summary>
            /// <remarks>
            /// Values: <c>"editor_failed"</c> (Branch A — initial Editor returned <see cref="EdogQaLlmClient.LlmClientStatus.Failed"/>),
            /// <c>"validator_quarantine"</c> (Branch B — initial validator quarantined ≥ 1 scenario),
            /// <c>"skipped_budget"</c> (repair would have fired but the budget was already tripped).
            /// </remarks>
            public string RepairBranch { get; set; } = string.Empty;

            /// <summary>How many scenarios the validator accepted from the initial Editor pass (Branch B only; 0 if the initial pass failed entirely or no repair fired).</summary>
            public int InitialAcceptedCount { get; set; }

            /// <summary>How many scenarios the validator quarantined from the initial Editor pass (Branch B only).</summary>
            public int InitialQuarantinedCount { get; set; }

            /// <summary>How many replacement scenarios the validator accepted from the repair pass (Branch A: this is the total accepted; Branch B: only the repair-pass replacements).</summary>
            public int RepairAcceptedCount { get; set; }

            /// <summary>How many replacement scenarios the validator quarantined from the repair pass.</summary>
            public int RepairQuarantinedCount { get; set; }

            /// <summary>Editor repair-pass input tokens (additive to <see cref="InputTokens"/>).</summary>
            public int RepairInputTokens { get; set; }

            /// <summary>Editor repair-pass output tokens (additive to <see cref="OutputTokens"/>).</summary>
            public int RepairOutputTokens { get; set; }

            /// <summary>Wire-stable failure code if the repair pass itself failed (parse, schema, binding, or stage exception). Empty on success.</summary>
            public string RepairFailureCode { get; set; } = string.Empty;

            /// <summary>Contract-options revision snapshot captured for this run.</summary>
            public long OptionsRevision { get; set; }

            // ── Analyst (Step 1 of the 2-step Analyst→Architect pipeline) ──

            /// <summary>Analyst pass input tokens (additive to <see cref="InputTokens"/>).</summary>
            public int AnalystInputTokens { get; set; }

            /// <summary>Analyst pass output tokens (additive to <see cref="OutputTokens"/>).</summary>
            public int AnalystOutputTokens { get; set; }

            /// <summary>Analyst pass reasoning tokens (additive to <see cref="ReasoningTokens"/>).</summary>
            public int AnalystReasoningTokens { get; set; }

            /// <summary>Wall-clock duration of the Analyst pass in ms.</summary>
            public long AnalystElapsedMs { get; set; }

            /// <summary>Wire-stable failure code if the Analyst pass failed (non-fatal — Architect ran without observations). Empty on success or when the pass was skipped.</summary>
            public string AnalystFailureCode { get; set; } = string.Empty;
        }

        public sealed class DedupDuplicate
        {
            public string SemanticHash { get; set; }

            public string WinnerZoneId { get; set; }

            public string WinnerScenarioId { get; set; }

            public string LoserZoneId { get; set; }

            public string LoserScenarioId { get; set; }
        }

        public sealed class OrchestratorResult
        {
            public List<ZoneResult> Zones { get; set; } = new();

            /// <summary>Engine-shape scenarios after cross-zone dedup + projection. Deterministic order: <c>(WinnerZoneInputIndex, ScenarioId, SemanticHash)</c> ordinal-ascending.</summary>
            public List<Scenario> MergedScenarios { get; set; } = new();

            /// <summary>Accepted-scenario duplicates dropped during cross-zone dedup. Loser identified by zone+scenario id; winner is the survivor in <see cref="MergedScenarios"/>.</summary>
            public List<DedupDuplicate> Duplicates { get; set; } = new();

            /// <summary>Scenarios that survived validation + dedup but failed projection. Origin <c>ZoneId</c> is preserved on each.</summary>
            public List<EdogQaScenarioValidator.QuarantinedScenario> ProjectionRejected { get; set; } = new();

            public long TotalElapsedMs { get; set; }

            public int TotalInputTokens { get; set; }

            public int TotalOutputTokens { get; set; }

            public int TotalReasoningTokens { get; set; }

            public double TotalCostUsd { get; set; }

            public bool BudgetGateTripped { get; set; }

            /// <summary><see cref="CodeBudgetExceededCost"/> or <see cref="CodeBudgetExceededTime"/>; empty when <see cref="BudgetGateTripped"/> is false.</summary>
            public string BudgetGateReason { get; set; } = string.Empty;

            public string PricingSource { get; set; } = string.Empty;

            public long OptionsRevision { get; set; }

            /// <summary>
            /// Diagnostic messages emitted during the run (per-zone analyst
            /// failures, coverage gaps, projector stub fallbacks, etc.).
            /// Surfaced to the browser console by the caller (the hub
            /// drains these via <see cref="EdogQaCodeAnalyzer"/>'s
            /// PublishWarning channel). Order reflects emission order,
            /// modulo cross-zone parallelism.
            /// </summary>
            public List<string> DiagnosticMessages { get; set; } = new();
        }

        // ── Progress events ────────────────────────────────────────────

        public enum OrchestratorEventKind
        {
            ZoneStarted = 0,
            ZoneArchitectCompleted = 1,
            ZoneEditorCompleted = 2,
            ZoneValidated = 3,
            ZoneCompleted = 4,
            ZoneFailed = 5,
            ZoneSkipped = 6,
            ZoneNoTestableChanges = 7,
            BudgetExceeded = 8,
            CrossZoneDedupCompleted = 9,
            BatchCompleted = 10,

            /// <summary>F27 P9 T1e: one repair pass fired for this zone. <see cref="OrchestratorEvent.ErrorCode"/> carries the branch tag.</summary>
            ZoneRepairAttempted = 11,

            /// <summary>Informational diagnostic from inside the orchestrator
            /// (or its projector). Mirrors a <c>[QA-DIAG]</c> stdout line so
            /// the browser console sees the same trace as the FLT log file.
            /// <see cref="OrchestratorEvent.Message"/> carries the body.</summary>
            DiagnosticMessage = 12,
        }

        public sealed class OrchestratorEvent
        {
            public OrchestratorEventKind Kind { get; set; }

            public string ZoneId { get; set; } = string.Empty;

            public int ZoneInputIndex { get; set; }

            public string Message { get; set; } = string.Empty;

            public long ElapsedMs { get; set; }

            public int InputTokens { get; set; }

            public int OutputTokens { get; set; }

            public int ReasoningTokens { get; set; }

            public double CostUsd { get; set; }

            public int AcceptedCount { get; set; }

            public int QuarantinedCount { get; set; }

            public int ProjectedCount { get; set; }

            public int RejectedCount { get; set; }

            public int DuplicateCount { get; set; }

            public string ErrorCode { get; set; } = string.Empty;

            /// <summary>F27 P11: testingGuidance produced by the Analyst pass.
            /// Set on the <see cref="OrchestratorEventKind.ZoneArchitectCompleted"/> event so the
            /// frontend's Testing Guidance panel can render counts/lists without waiting for
            /// the full zone-completion payload. Null when P11 is disabled or the Analyst pass
            /// produced no parseable testingGuidance block.</summary>
            public EdogQaLlmClient.TestingGuidance TestingGuidance { get; set; }
        }

        // ═══════════════════════════════════════════════════════════════
        // Construction + entry point
        // ═══════════════════════════════════════════════════════════════

        private readonly HttpClient _httpClient;

        // Diagnostic sink active for the duration of one RunAsync call.
        // Per-zone tasks push [QA-DIAG]-equivalent messages here; the final
        // contents are copied to OrchestratorResult.DiagnosticMessages so
        // the analyzer can surface them to the browser via PublishWarning.
        private ConcurrentQueue<string> _runDiagnostics;

        public EdogQaScenarioOrchestrator(HttpClient httpClient)
        {
            _httpClient = httpClient ?? throw new ArgumentNullException(nameof(httpClient));
        }

        /// <summary>
        /// Run the full V2 pipeline over <paramref name="zones"/>. Same inputs ⇒
        /// same <see cref="OrchestratorResult.MergedScenarios"/> regardless of
        /// task completion order. External <paramref name="ct"/> cancellation
        /// throws <see cref="OperationCanceledException"/>; per-zone failures
        /// are caught and surfaced via <see cref="ZoneResult.Outcome"/>.
        /// </summary>
        public async Task<OrchestratorResult> RunAsync(
            IReadOnlyList<ZoneInput> zones,
            OrchestratorConfig config,
            IProgress<OrchestratorEvent> progress,
            CancellationToken ct)
        {
            if (zones == null) throw new ArgumentNullException(nameof(zones));
            if (config == null) throw new ArgumentNullException(nameof(config));
            if (config.MaxConcurrentZones < 1) throw new ArgumentException("MaxConcurrentZones must be >= 1", nameof(config));
            if (config.Validation == null) throw new ArgumentException("Validation context required", nameof(config));
            if (config.Pricing == null) throw new ArgumentException("Pricing table required", nameof(config));
            if (config.ArchitectOverride == null && config.Architect == null) throw new ArgumentException("Architect config required when no ArchitectOverride is supplied", nameof(config));
            if (config.EditorOverride == null && config.Editor == null) throw new ArgumentException("Editor config required when no EditorOverride is supplied", nameof(config));

            var result = new OrchestratorResult { PricingSource = config.Pricing.Source ?? string.Empty };
            _runDiagnostics = new ConcurrentQueue<string>();
            var optionsSnapshot = config.OptionsProvider?.CaptureSnapshot();
            result.OptionsRevision = optionsSnapshot?.Revision ?? 0;
            if (optionsSnapshot != null)
            {
                EdogQaTelemetry.EmitContractEvent(
                    EdogQaTelemetry.EventFeatureFlagSnapshot,
                    "orchestrator",
                    optionsSnapshot.Revision.ToString(),
                    $"enabled={optionsSnapshot.Enabled};fewShot={optionsSnapshot.FewShotEnabled};disabledKinds={string.Join(",", optionsSnapshot.DisabledKinds != null ? optionsSnapshot.DisabledKinds : (IEnumerable<string>)Array.Empty<string>())}");
            }

            // Empty zones short-circuit cleanly.
            if (zones.Count == 0)
            {
                SafeReport(progress, new OrchestratorEvent { Kind = OrchestratorEventKind.BatchCompleted });
                return result;
            }

            // Monotonic deadline computed once.
            var batchStopwatch = Stopwatch.StartNew();
            var deadlineTicks = config.MaxBudgetSeconds > 0
                ? batchStopwatch.ElapsedTicks + TimeSpan.FromSeconds(config.MaxBudgetSeconds).Ticks
                : long.MaxValue;

            // Cost in micro-USD (1 USD = 1_000_000 μUSD) for atomic accumulation.
            long maxBudgetMicroUsd = config.MaxBudgetUsd > 0
                ? (long)Math.Round(config.MaxBudgetUsd * 1_000_000.0)
                : long.MaxValue;
            long accumulatedMicroUsd = 0;

            // First-tripped reason ownership via CompareExchange. 0 = untripped, 1 = cost, 2 = time.
            int budgetTripped = 0;
            string budgetReason = string.Empty;

            using var semaphore = new SemaphoreSlim(config.MaxConcurrentZones, config.MaxConcurrentZones);

            var zoneResults = new ZoneResult[zones.Count];

            // Fan out one task per zone. Each task waits on the semaphore,
            // re-checks the budget AFTER acquiring the slot (rubber-duck
            // blocker #1 fix), and never throws to the orchestrator caller
            // unless the external CT is cancelled.
            var tasks = new Task[zones.Count];
            for (var i = 0; i < zones.Count; i++)
            {
                var idx = i;
                var zone = zones[i];
                tasks[i] = ProcessZoneAsync(
                    idx, zone, config, result.OptionsRevision, progress, semaphore,
                    batchStopwatch, deadlineTicks, maxBudgetMicroUsd,
                    refAccumulate: () => Volatile.Read(ref accumulatedMicroUsd),
                    addAccumulate: spent => Interlocked.Add(ref accumulatedMicroUsd, spent),
                    tripBudget: (reasonCode, kind) =>
                    {
                        if (Interlocked.CompareExchange(ref budgetTripped, kind, 0) == 0)
                        {
                            budgetReason = reasonCode;
                            SafeReport(progress, new OrchestratorEvent
                            {
                                Kind = OrchestratorEventKind.BudgetExceeded,
                                ErrorCode = reasonCode,
                                ElapsedMs = batchStopwatch.ElapsedMilliseconds,
                            });
                        }
                    },
                    isBudgetTripped: () => Volatile.Read(ref budgetTripped) != 0,
                    storeResult: zr => zoneResults[idx] = zr,
                    ct: ct);
            }

            try
            {
                await Task.WhenAll(tasks).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                throw;
            }
            // Any other exception escaping a zone task is a bug; let it bubble.

            ct.ThrowIfCancellationRequested();

            // ── Cross-zone dedup (deterministic) ───────────────────────
            //
            // Pool all accepted scenarios from Completed zones. Group by
            // SemanticHash. Within each group, sort by
            // (ZoneInputIndex, ScenarioId, SemanticHash) ordinal-asc and
            // keep the first as winner; the rest are duplicates.
            //
            // Scenarios with null/empty SemanticHash bypass dedup (each
            // is its own group) so the validator's contract failure
            // doesn't silently collapse genuinely distinct work.

            var pool = new List<PoolEntry>();
            foreach (var zr in zoneResults)
            {
                if (zr == null || zr.Outcome != ZoneOutcome.Completed) continue;
                foreach (var acc in zr.Accepted)
                {
                    pool.Add(new PoolEntry
                    {
                        ZoneInputIndex = zr.ZoneInputIndex,
                        ZoneId = zr.ZoneId,
                        Accepted = acc,
                        Plan = zr.Plan,
                        Catalog = zr.Catalog,
                    });
                }
            }

            var groups = new Dictionary<string, List<PoolEntry>>(StringComparer.Ordinal);
            int dedupGroupSeq = 0;
            foreach (var entry in pool)
            {
                var hash = entry.Accepted?.SemanticHash;
                string key;
                if (string.IsNullOrEmpty(hash))
                {
                    // Force a unique key so null-hash scenarios are never
                    // merged with each other. The sentinel is namespaced
                    // so it cannot collide with a real SHA-256 hex.
                    key = "__nohash__:" + dedupGroupSeq.ToString();
                    dedupGroupSeq++;
                }
                else
                {
                    key = hash;
                }

                if (!groups.TryGetValue(key, out var bucket))
                {
                    bucket = new List<PoolEntry>();
                    groups[key] = bucket;
                }
                bucket.Add(entry);
            }

            var winners = new List<PoolEntry>();
            var duplicates = new List<DedupDuplicate>();
            foreach (var kv in groups)
            {
                kv.Value.Sort(ComparePoolEntry);
                var winner = kv.Value[0];
                winners.Add(winner);
                for (var i = 1; i < kv.Value.Count; i++)
                {
                    var loser = kv.Value[i];
                    duplicates.Add(new DedupDuplicate
                    {
                        SemanticHash = winner.Accepted.SemanticHash ?? string.Empty,
                        WinnerZoneId = winner.ZoneId ?? string.Empty,
                        WinnerScenarioId = winner.Accepted.Scenario?.Id ?? string.Empty,
                        LoserZoneId = loser.ZoneId ?? string.Empty,
                        LoserScenarioId = loser.Accepted.Scenario?.Id ?? string.Empty,
                    });
                }
            }

            // Sort winners deterministically before projection so
            // MergedScenarios order is stable across runs.
            winners.Sort(ComparePoolEntry);

            // ── Project winners to engine shape, grouped by plan ───────
            //
            // The projector resolves evidence refs against the plan's
            // GroundingEvidence pool, so winners from zone A must use
            // plan A. Group winners by plan reference and call Project
            // once per plan.

            var mergedScenarios = new List<Scenario>();
            var projectionRejected = new List<EdogQaScenarioValidator.QuarantinedScenario>();

            foreach (var w in winners)
            {
                // Walk winners in the sorted order so projected output
                // appears in the same order winners were sorted in.
                // Per-winner project (each plan handles only its own
                // accepted entry here to preserve order).
                if (w.Plan == null)
                {
                    projectionRejected.Add(new EdogQaScenarioValidator.QuarantinedScenario
                    {
                        Scenario = w.Accepted?.Scenario,
                        Reasons = new List<EdogQaScenarioValidator.QuarantineReason>
                        {
                            new() { Code = EdogQaScenarioProjector.CodeGroundingRefUnresolved, Message = "Winner has no plan reference; cannot resolve grounding refs." },
                        },
                    });
                    continue;
                }

                var single = EdogQaScenarioProjector.Project(w.Plan, new[] { w.Accepted }, w.Catalog);
                if (single.Diagnostics != null)
                {
                    // The projector already wrote each line to stdout; we
                    // just need to surface them to the browser via the
                    // run-diagnostics queue + a progress event. No second
                    // Console.WriteLine — that would double-log.
                    foreach (var d in single.Diagnostics)
                    {
                        _runDiagnostics?.Enqueue(d);
                        SafeReport(progress, new OrchestratorEvent
                        {
                            Kind = OrchestratorEventKind.DiagnosticMessage,
                            Message = d,
                        });
                    }
                }
                foreach (var p in single.Projected)
                {
                    // Copy sketch coverage IDs onto the projected Scenario
                    // by sketchId (sketches live on the Plan; the Editor
                    // preserves sketchId verbatim on the emitted scenario,
                    // so we resolve via that join rather than positional
                    // index — the Editor may drop or reorder scenarios,
                    // which would corrupt an index-based join).
                    if (p != null
                        && w.Accepted?.Scenario != null
                        && w.Plan?.ScenarioSketches != null)
                    {
                        EdogQaLlmClient.ScenarioSketch sketch = null;
                        var sid = w.Accepted.Scenario.SketchId;
                        if (!string.IsNullOrEmpty(sid))
                        {
                            for (var si = 0; si < w.Plan.ScenarioSketches.Count; si++)
                            {
                                var candidate = w.Plan.ScenarioSketches[si];
                                if (candidate != null
                                    && string.Equals(candidate.SketchId, sid, StringComparison.Ordinal))
                                {
                                    sketch = candidate;
                                    break;
                                }
                            }
                        }
                        if (sketch != null)
                        {
                            if (sketch.AddressesCodePathIds != null)
                            {
                                p.AddressesCodePathIds = new List<string>(sketch.AddressesCodePathIds);
                            }
                            if (sketch.AddressesErrorModeIds != null)
                            {
                                p.AddressesErrorModeIds = new List<string>(sketch.AddressesErrorModeIds);
                            }
                        }
                    }
                    mergedScenarios.Add(p);
                }
                foreach (var r in single.Rejected) projectionRejected.Add(r);
            }

            SafeReport(progress, new OrchestratorEvent
            {
                Kind = OrchestratorEventKind.CrossZoneDedupCompleted,
                AcceptedCount = pool.Count,
                ProjectedCount = mergedScenarios.Count,
                RejectedCount = projectionRejected.Count,
                DuplicateCount = duplicates.Count,
            });

            // ── Roll up totals ─────────────────────────────────────────

            int totalInput = 0, totalOutput = 0, totalReasoning = 0;
            double totalCost = 0;
            for (var i = 0; i < zoneResults.Length; i++)
            {
                var zr = zoneResults[i];
                if (zr == null) continue;
                totalInput += zr.InputTokens;
                totalOutput += zr.OutputTokens;
                totalReasoning += zr.ReasoningTokens;
                totalCost += zr.CostUsd;
                result.Zones.Add(zr);
            }

            result.MergedScenarios = mergedScenarios;
            result.Duplicates = duplicates;
            result.ProjectionRejected = projectionRejected;
            result.TotalElapsedMs = batchStopwatch.ElapsedMilliseconds;
            result.TotalInputTokens = totalInput;
            result.TotalOutputTokens = totalOutput;
            result.TotalReasoningTokens = totalReasoning;
            result.TotalCostUsd = totalCost;
            result.BudgetGateTripped = Volatile.Read(ref budgetTripped) != 0;
            result.BudgetGateReason = budgetReason ?? string.Empty;

            // Drain per-run diagnostics into the result so the analyzer
            // can surface them to the browser via PublishWarning.
            while (_runDiagnostics != null && _runDiagnostics.TryDequeue(out var diag))
            {
                result.DiagnosticMessages.Add(diag);
            }
            _runDiagnostics = null;

            SafeReport(progress, new OrchestratorEvent
            {
                Kind = OrchestratorEventKind.BatchCompleted,
                ElapsedMs = result.TotalElapsedMs,
                InputTokens = result.TotalInputTokens,
                OutputTokens = result.TotalOutputTokens,
                ReasoningTokens = result.TotalReasoningTokens,
                CostUsd = result.TotalCostUsd,
                AcceptedCount = pool.Count,
                ProjectedCount = mergedScenarios.Count,
                RejectedCount = projectionRejected.Count,
                DuplicateCount = duplicates.Count,
                ErrorCode = result.BudgetGateTripped ? result.BudgetGateReason : string.Empty,
            });

            return result;
        }

        // ═══════════════════════════════════════════════════════════════
        // Per-zone driver
        // ═══════════════════════════════════════════════════════════════

        private async Task ProcessZoneAsync(
            int zoneInputIndex,
            ZoneInput zoneInput,
            OrchestratorConfig config,
            long optionsRevision,
            IProgress<OrchestratorEvent> progress,
            SemaphoreSlim semaphore,
            Stopwatch batchStopwatch,
            long deadlineTicks,
            long maxBudgetMicroUsd,
            Func<long> refAccumulate,
            Func<long, long> addAccumulate,
            Action<string, int> tripBudget,
            Func<bool> isBudgetTripped,
            Action<ZoneResult> storeResult,
            CancellationToken ct)
        {
            var zr = new ZoneResult
            {
                ZoneInputIndex = zoneInputIndex,
                ZoneId = zoneInput?.ZoneId ?? string.Empty,
                OptionsRevision = optionsRevision,
                Catalog = zoneInput?.Catalog,
            };
            var zoneStopwatch = Stopwatch.StartNew();
            // T1e: per-zone running tally of how much we've BOOKED into
            // the shared budget accumulator. Each AccumulateDeltaAndMaybeTrip
            // call books (zr.CostUsd - bookedCostUsd) and refreshes the
            // tally. This eliminates the pre-existing double-count where
            // a multi-stage zone billed the cumulative cost on every
            // call (Architect cost was billed twice on the editor path,
            // three times if a repair pass fired).
            double bookedCostUsd = 0;

            await semaphore.WaitAsync(ct).ConfigureAwait(false);
            try
            {
                // ── Budget gate (post-semaphore, blocker #1 fix) ──────
                if (isBudgetTripped())
                {
                    zr.Outcome = ZoneOutcome.SkippedForBudget;
                    zr.OutcomeReason = budgetReasonFromExisting(deadlineTicks, batchStopwatch, refAccumulate, maxBudgetMicroUsd);
                    zr.ElapsedMs = zoneStopwatch.ElapsedMilliseconds;
                    SafeReport(progress, new OrchestratorEvent
                    {
                        Kind = OrchestratorEventKind.ZoneSkipped,
                        ZoneId = zr.ZoneId,
                        ZoneInputIndex = zoneInputIndex,
                        ErrorCode = zr.OutcomeReason,
                    });
                    storeResult(zr);
                    return;
                }
                if (batchStopwatch.ElapsedTicks > deadlineTicks)
                {
                    tripBudget(CodeBudgetExceededTime, 2);
                    zr.Outcome = ZoneOutcome.SkippedForBudget;
                    zr.OutcomeReason = CodeBudgetExceededTime;
                    zr.ElapsedMs = zoneStopwatch.ElapsedMilliseconds;
                    SafeReport(progress, new OrchestratorEvent
                    {
                        Kind = OrchestratorEventKind.ZoneSkipped,
                        ZoneId = zr.ZoneId,
                        ZoneInputIndex = zoneInputIndex,
                        ErrorCode = CodeBudgetExceededTime,
                    });
                    storeResult(zr);
                    return;
                }
                if (refAccumulate() >= maxBudgetMicroUsd)
                {
                    tripBudget(CodeBudgetExceededCost, 1);
                    zr.Outcome = ZoneOutcome.SkippedForBudget;
                    zr.OutcomeReason = CodeBudgetExceededCost;
                    zr.ElapsedMs = zoneStopwatch.ElapsedMilliseconds;
                    SafeReport(progress, new OrchestratorEvent
                    {
                        Kind = OrchestratorEventKind.ZoneSkipped,
                        ZoneId = zr.ZoneId,
                        ZoneInputIndex = zoneInputIndex,
                        ErrorCode = CodeBudgetExceededCost,
                    });
                    storeResult(zr);
                    return;
                }

                SafeReport(progress, new OrchestratorEvent
                {
                    Kind = OrchestratorEventKind.ZoneStarted,
                    ZoneId = zr.ZoneId,
                    ZoneInputIndex = zoneInputIndex,
                });

                var zoneCtx = new EdogQaLlmClient.ZoneContext
                {
                    ZoneId = zoneInput.ZoneId ?? string.Empty,
                    ZoneSummary = zoneInput.ZoneSummary ?? string.Empty,
                    UntrustedRedactedDiff = zoneInput.RedactedDiff ?? string.Empty,
                    BaseSha = zoneInput.BaseSha ?? string.Empty,
                    HeadSha = zoneInput.HeadSha ?? string.Empty,
                    SlotPurposesText = zoneInput.SlotPurposesText ?? string.Empty,
                    FewShotExemplarsText = zoneInput.FewShotExemplarsText ?? string.Empty,
                    CatalogReferenceJson = zoneInput.CatalogReferenceJson ?? string.Empty,
                    TestDiff = zoneInput.TestDiff ?? string.Empty,
                    PrIntentSummary = zoneInput.PrIntentSummary ?? string.Empty,
                    InvariantsSummary = zoneInput.InvariantsSummary ?? string.Empty,
                };

                // ── Step 1: Analyst (observation only, non-fatal on failure) ──
                // The Analyst pass produces a structured payload of changed
                // surfaces / behavioral paths / boundary conditions / error paths
                // that the Architect consumes as frozen trusted context. Any
                // failure here is non-fatal: we wipe AnalystObservations on the
                // zone context and let the Architect run without them. The
                // Architect prompt is built to handle either case.
                //
                // The pass is SKIPPED entirely when there is neither an override
                // nor a live Architect config — that keeps existing test harnesses
                // (which only set ArchitectOverride/EditorOverride) deterministic
                // and avoids spurious "config missing" errors in the analyst slot.
                if (config.AnalystOverride != null || config.Architect != null)
                {
                    EdogQaLlmClient.LlmClientResult analystResult = null;
                    try
                    {
                        if (config.AnalystOverride != null)
                        {
                            analystResult = await config.AnalystOverride(zoneCtx, ct).ConfigureAwait(false);
                        }
                        else
                        {
                            analystResult = await EdogQaLlmClient.AnalystOnceAsync(_httpClient, config.Architect, zoneCtx, ct).ConfigureAwait(false);
                        }
                    }
                    catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
                    catch (Exception ex)
                    {
                        EmitDiagnostic(progress, $"Analyst pass failed (non-fatal): {ex.GetType().Name}: {ex.Message}");
                        zr.AnalystFailureCode = EdogQaLlmClient.ErrorCodeAnalystNetworkError;
                    }

                    if (analystResult != null)
                    {
                        zr.AnalystInputTokens = analystResult.AnalystInputTokens;
                        zr.AnalystOutputTokens = analystResult.AnalystOutputTokens;
                        zr.AnalystReasoningTokens = analystResult.AnalystReasoningTokens;
                        zr.AnalystElapsedMs = analystResult.AnalystElapsedMs;
                        zr.InputTokens += analystResult.AnalystInputTokens;
                        zr.OutputTokens += analystResult.AnalystOutputTokens;
                        zr.ReasoningTokens += analystResult.AnalystReasoningTokens;

                        if (analystResult.Status == EdogQaLlmClient.LlmClientStatus.Ok
                            && !string.IsNullOrWhiteSpace(analystResult.AnalystObservations))
                        {
                            zoneCtx.AnalystObservations = analystResult.AnalystObservations;
                            // F27 P11: stash testingGuidance on the ZoneResult so the
                            // validator (coverage gate) and downstream consumers can read it
                            // without re-parsing the Analyst JSON.
                            if (analystResult.TestingGuidance != null)
                            {
                                zr.TestingGuidance = analystResult.TestingGuidance;
                            }
                        }
                        else if (analystResult.Errors != null && analystResult.Errors.Count > 0)
                        {
                            zr.AnalystFailureCode = StableCodePrefix(analystResult.Errors[0]);
                        }
                    }
                }

                // ── Step 2: Architect ─────────────────────────────────
                EdogQaLlmClient.LlmClientResult architectResult;
                try
                {
                    if (config.ArchitectOverride != null)
                    {
                        architectResult = await config.ArchitectOverride(zoneCtx, ct).ConfigureAwait(false);
                    }
                    else
                    {
                        architectResult = await EdogQaLlmClient.ArchitectOnceAsync(_httpClient, config.Architect, zoneCtx, ct).ConfigureAwait(false);
                    }
                }
                catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
                catch (Exception ex)
                {
                    zr.Outcome = ZoneOutcome.Failed;
                    zr.OutcomeReason = CodeUnexpectedException;
                    zr.Errors.Add(CodeUnexpectedException + " — architect stage: " + ex.GetType().Name);
                    zr.ElapsedMs = zoneStopwatch.ElapsedMilliseconds;
                    SafeReport(progress, new OrchestratorEvent
                    {
                        Kind = OrchestratorEventKind.ZoneFailed,
                        ZoneId = zr.ZoneId,
                        ZoneInputIndex = zoneInputIndex,
                        ErrorCode = CodeUnexpectedException,
                    });
                    storeResult(zr);
                    return;
                }

                if (architectResult == null)
                {
                    zr.Outcome = ZoneOutcome.Failed;
                    zr.OutcomeReason = CodeDelegateReturnedNull;
                    zr.Errors.Add(CodeDelegateReturnedNull + " — architect");
                    zr.ElapsedMs = zoneStopwatch.ElapsedMilliseconds;
                    SafeReport(progress, new OrchestratorEvent
                    {
                        Kind = OrchestratorEventKind.ZoneFailed,
                        ZoneId = zr.ZoneId,
                        ZoneInputIndex = zoneInputIndex,
                        ErrorCode = CodeDelegateReturnedNull,
                    });
                    storeResult(zr);
                    return;
                }

                zr.InputTokens += architectResult.ArchitectInputTokens;
                zr.OutputTokens += architectResult.ArchitectOutputTokens;
                zr.ReasoningTokens += architectResult.ArchitectReasoningTokens;
                zr.Plan = architectResult.Plan;

                SafeReport(progress, new OrchestratorEvent
                {
                    Kind = OrchestratorEventKind.ZoneArchitectCompleted,
                    ZoneId = zr.ZoneId,
                    ZoneInputIndex = zoneInputIndex,
                    ElapsedMs = architectResult.ArchitectElapsedMs,
                    InputTokens = architectResult.ArchitectInputTokens,
                    OutputTokens = architectResult.ArchitectOutputTokens,
                    ReasoningTokens = architectResult.ArchitectReasoningTokens,
                    // F27 P11: forward the Analyst-produced testingGuidance so the frontend
                    // can render the Testing Guidance panel immediately on Architect-complete
                    // (rather than waiting for the full ZoneCompleted payload).
                    TestingGuidance = zr.TestingGuidance,
                });

                if (architectResult.Status == EdogQaLlmClient.LlmClientStatus.Failed)
                {
                    zr.Outcome = ZoneOutcome.Failed;
                    var firstError = architectResult.Errors != null && architectResult.Errors.Count > 0 ? architectResult.Errors[0] : "ARCHITECT_UNKNOWN_ERROR";
                    zr.OutcomeReason = StableCodePrefix(firstError);
                    zr.Errors.AddRange(architectResult.Errors ?? new());
                    zr.CostUsd = ComputeCost(zr, config.Pricing);
                    AccumulateDeltaAndMaybeTrip(zr, ref bookedCostUsd, addAccumulate, refAccumulate, maxBudgetMicroUsd, tripBudget);
                    zr.ElapsedMs = zoneStopwatch.ElapsedMilliseconds;
                    SafeReport(progress, new OrchestratorEvent
                    {
                        Kind = OrchestratorEventKind.ZoneFailed,
                        ZoneId = zr.ZoneId,
                        ZoneInputIndex = zoneInputIndex,
                        ErrorCode = zr.OutcomeReason,
                        CostUsd = zr.CostUsd,
                    });
                    storeResult(zr);
                    return;
                }

                if (architectResult.Status == EdogQaLlmClient.LlmClientStatus.NoTestableChanges)
                {
                    zr.Outcome = ZoneOutcome.NoTestableChanges;
                    zr.OutcomeReason = EdogQaLlmClient.PlanOutcomeNoTestableChanges;
                    zr.CostUsd = ComputeCost(zr, config.Pricing);
                    AccumulateDeltaAndMaybeTrip(zr, ref bookedCostUsd, addAccumulate, refAccumulate, maxBudgetMicroUsd, tripBudget);
                    zr.ElapsedMs = zoneStopwatch.ElapsedMilliseconds;
                    SafeReport(progress, new OrchestratorEvent
                    {
                        Kind = OrchestratorEventKind.ZoneNoTestableChanges,
                        ZoneId = zr.ZoneId,
                        ZoneInputIndex = zoneInputIndex,
                        CostUsd = zr.CostUsd,
                    });
                    storeResult(zr);
                    return;
                }

                // ── Coverage checker (deterministic, no LLM call) ────
                // Informational only — never blocks. Verifies that the
                // Architect's per-sketch coverage IDs (addressesCodePathIds /
                // addressesErrorModeIds, F27 P11) reference the Analyst's
                // codePaths/errorModesToTest enumeration. The Architect's
                // groundingEvidence IDs (ev-*) live in a DIFFERENT namespace
                // from the Analyst's cp-*/em-* IDs, so comparing EvidenceRefs
                // against expectedIds was always 100% uncovered — that
                // historical bug is fixed here. Falls back to an
                // informational note when neither side declares IDs we can
                // line up; the real quality gates are the validator + linter,
                // not this diagnostic.
                if (!string.IsNullOrWhiteSpace(zoneCtx.AnalystObservations)
                    && architectResult.Plan?.ScenarioSketches != null)
                {
                    try
                    {
                        var analystDoc = System.Text.Json.JsonDocument.Parse(zoneCtx.AnalystObservations);
                        var expectedIds = new HashSet<string>(StringComparer.Ordinal);
                        foreach (var listName in new[] { "codePaths", "errorModesToTest" })
                        {
                            if (analystDoc.RootElement.TryGetProperty(listName, out var arr)
                                && arr.ValueKind == System.Text.Json.JsonValueKind.Array)
                            {
                                foreach (var item in arr.EnumerateArray())
                                {
                                    if (item.TryGetProperty("id", out var idEl)
                                        && idEl.ValueKind == System.Text.Json.JsonValueKind.String)
                                    {
                                        var id = idEl.GetString();
                                        if (!string.IsNullOrEmpty(id)) expectedIds.Add(id);
                                    }
                                }
                            }
                        }

                        // Collect coverage IDs from the Architect's per-sketch
                        // addressesCodePathIds + addressesErrorModeIds (these
                        // are the cp-*/em-* references that line up with the
                        // Analyst enumeration). EvidenceRefs (ev-*) are
                        // INTENTIONALLY ignored here — they're a different
                        // namespace and produced the historical 100%-uncovered
                        // false alarm.
                        var coveredIds = new HashSet<string>(StringComparer.Ordinal);
                        var sketchCount = 0;
                        var sketchesWithCoverageIds = 0;
                        foreach (var sketch in architectResult.Plan.ScenarioSketches)
                        {
                            if (sketch == null) continue;
                            sketchCount++;
                            var hadCoverageId = false;
                            if (sketch.AddressesCodePathIds != null)
                            {
                                foreach (var r in sketch.AddressesCodePathIds)
                                {
                                    if (!string.IsNullOrEmpty(r)) { coveredIds.Add(r); hadCoverageId = true; }
                                }
                            }
                            if (sketch.AddressesErrorModeIds != null)
                            {
                                foreach (var r in sketch.AddressesErrorModeIds)
                                {
                                    if (!string.IsNullOrEmpty(r)) { coveredIds.Add(r); hadCoverageId = true; }
                                }
                            }
                            if (hadCoverageId) sketchesWithCoverageIds++;
                        }

                        if (expectedIds.Count == 0)
                        {
                            EmitDiagnostic(progress, "Coverage check skipped: Analyst emitted no codePaths/errorModesToTest IDs to verify against.");
                        }
                        else if (sketchesWithCoverageIds == 0)
                        {
                            // Architect produced sketches but none declared
                            // coverage IDs — can't compute coverage. Surface
                            // as informational, not a warning, because the
                            // validator/linter are the real gates.
                            EmitDiagnostic(progress,
                                $"Coverage check skipped: {sketchCount} Architect sketches but none declared addressesCodePathIds/addressesErrorModeIds.");
                        }
                        else
                        {
                            var uncovered = new List<string>();
                            foreach (var id in expectedIds)
                            {
                                if (!coveredIds.Contains(id)) uncovered.Add(id);
                            }

                            if (uncovered.Count > 0)
                            {
                                EmitDiagnostic(progress,
                                    $"Coverage gap: {uncovered.Count}/{expectedIds.Count} analyst observations "
                                    + $"uncovered by Architect sketches: [{string.Join(", ", uncovered)}]");
                                SafeReport(progress, new OrchestratorEvent
                                {
                                    Kind = OrchestratorEventKind.ZoneValidated,
                                    ZoneId = zr.ZoneId,
                                    ZoneInputIndex = zoneInputIndex,
                                    Message = $"Coverage gap: {uncovered.Count} analyst observations without sketches",
                                    ErrorCode = "COVERAGE_GAP",
                                });
                            }
                            else
                            {
                                EmitDiagnostic(progress, $"Coverage check passed: all {expectedIds.Count} analyst observations covered");
                            }
                        }

                        analystDoc.Dispose();
                    }
                    catch (Exception ex)
                    {
                        EmitDiagnostic(progress, $"Coverage check failed (non-fatal): {ex.GetType().Name}: {ex.Message}");
                    }
                }

                // ── Editor ───────────────────────────────────────────
                EdogQaLlmClient.LlmClientResult editorResult;
                try
                {
                    if (config.EditorOverride != null)
                    {
                        editorResult = await config.EditorOverride(architectResult.Plan, zoneCtx, ct).ConfigureAwait(false);
                    }
                    else
                    {
                        editorResult = await EdogQaLlmClient.EditorOnceAsync(_httpClient, config.Editor, architectResult.Plan, zoneCtx, ct).ConfigureAwait(false);
                    }
                }
                catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
                catch (Exception ex)
                {
                    zr.Outcome = ZoneOutcome.Failed;
                    zr.OutcomeReason = CodeUnexpectedException;
                    zr.Errors.Add(CodeUnexpectedException + " — editor stage: " + ex.GetType().Name);
                    zr.CostUsd = ComputeCost(zr, config.Pricing);
                    AccumulateDeltaAndMaybeTrip(zr, ref bookedCostUsd, addAccumulate, refAccumulate, maxBudgetMicroUsd, tripBudget);
                    zr.ElapsedMs = zoneStopwatch.ElapsedMilliseconds;
                    SafeReport(progress, new OrchestratorEvent
                    {
                        Kind = OrchestratorEventKind.ZoneFailed,
                        ZoneId = zr.ZoneId,
                        ZoneInputIndex = zoneInputIndex,
                        ErrorCode = CodeUnexpectedException,
                    });
                    storeResult(zr);
                    return;
                }

                if (editorResult == null)
                {
                    zr.Outcome = ZoneOutcome.Failed;
                    zr.OutcomeReason = CodeDelegateReturnedNull;
                    zr.Errors.Add(CodeDelegateReturnedNull + " — editor");
                    zr.CostUsd = ComputeCost(zr, config.Pricing);
                    AccumulateDeltaAndMaybeTrip(zr, ref bookedCostUsd, addAccumulate, refAccumulate, maxBudgetMicroUsd, tripBudget);
                    zr.ElapsedMs = zoneStopwatch.ElapsedMilliseconds;
                    SafeReport(progress, new OrchestratorEvent
                    {
                        Kind = OrchestratorEventKind.ZoneFailed,
                        ZoneId = zr.ZoneId,
                        ZoneInputIndex = zoneInputIndex,
                        ErrorCode = CodeDelegateReturnedNull,
                    });
                    storeResult(zr);
                    return;
                }

                zr.InputTokens += editorResult.EditorInputTokens;
                zr.OutputTokens += editorResult.EditorOutputTokens;

                SafeReport(progress, new OrchestratorEvent
                {
                    Kind = OrchestratorEventKind.ZoneEditorCompleted,
                    ZoneId = zr.ZoneId,
                    ZoneInputIndex = zoneInputIndex,
                    ElapsedMs = editorResult.EditorElapsedMs,
                    InputTokens = editorResult.EditorInputTokens,
                    OutputTokens = editorResult.EditorOutputTokens,
                });

                if (editorResult.Status == EdogQaLlmClient.LlmClientStatus.Failed)
                {
                    // ── T1e Branch A: one-shot Editor repair ──────────
                    EdogQaLlmClient.LlmClientResult repairResult = null;
                    bool repairDispatched = false;
                    string repairExceptionCode = string.Empty;

                    if (config.EnableRepairLoop
                        && !isBudgetTripped()
                        && (config.EditorRepairOverride != null || config.Editor != null))
                    {
                        SafeReport(progress, new OrchestratorEvent
                        {
                            Kind = OrchestratorEventKind.ZoneRepairAttempted,
                            ZoneId = zr.ZoneId,
                            ZoneInputIndex = zoneInputIndex,
                            ErrorCode = "editor_failed",
                        });

                        var feedback = new EdogQaLlmClient.EditorRepairContext
                        {
                            EditorErrors = editorResult.Errors != null
                                ? new List<string>(editorResult.Errors)
                                : new List<string>(),
                        };

                        try
                        {
                            (repairResult, repairDispatched) = await TryCallEditorRepairAsync(
                                config, architectResult.Plan, zoneCtx, feedback, ct).ConfigureAwait(false);
                        }
                        catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
                        catch (Exception ex)
                        {
                            repairDispatched = true;
                            repairExceptionCode = CodeUnexpectedException;
                            zr.Errors.Add(CodeUnexpectedException + " — editor repair stage: " + ex.GetType().Name);
                        }

                        if (repairDispatched)
                        {
                            zr.RepairAttempts = 1;
                            zr.RepairBranch = "editor_failed";
                        }

                        if (repairResult != null)
                        {
                            zr.RepairInputTokens += repairResult.EditorInputTokens;
                            zr.RepairOutputTokens += repairResult.EditorOutputTokens;
                            zr.InputTokens += repairResult.EditorInputTokens;
                            zr.OutputTokens += repairResult.EditorOutputTokens;
                        }
                    }

                    if (repairResult != null
                        && repairResult.Status != EdogQaLlmClient.LlmClientStatus.Failed)
                    {
                        // Repair recovered — adopt the repair output and
                        // fall through to the validator below as if the
                        // initial Editor pass had succeeded.
                        editorResult = repairResult;
                    }
                    else
                    {
                        if (repairResult != null
                            && repairResult.Status == EdogQaLlmClient.LlmClientStatus.Failed)
                        {
                            var firstRepairError = repairResult.Errors != null && repairResult.Errors.Count > 0
                                ? StableCodePrefix(repairResult.Errors[0])
                                : "EDITOR_REPAIR_UNKNOWN_ERROR";
                            zr.RepairFailureCode = firstRepairError;
                            zr.Errors.AddRange(repairResult.Errors ?? new());
                        }
                        else if (!string.IsNullOrEmpty(repairExceptionCode))
                        {
                            zr.RepairFailureCode = repairExceptionCode;
                        }

                        zr.Outcome = ZoneOutcome.Failed;
                        var firstError = editorResult.Errors != null && editorResult.Errors.Count > 0 ? editorResult.Errors[0] : "EDITOR_UNKNOWN_ERROR";
                        zr.OutcomeReason = StableCodePrefix(firstError);
                        zr.Errors.AddRange(editorResult.Errors ?? new());
                        zr.CostUsd = ComputeCost(zr, config.Pricing);
                        AccumulateDeltaAndMaybeTrip(zr, ref bookedCostUsd, addAccumulate, refAccumulate, maxBudgetMicroUsd, tripBudget);
                        zr.ElapsedMs = zoneStopwatch.ElapsedMilliseconds;
                        SafeReport(progress, new OrchestratorEvent
                        {
                            Kind = OrchestratorEventKind.ZoneFailed,
                            ZoneId = zr.ZoneId,
                            ZoneInputIndex = zoneInputIndex,
                            ErrorCode = zr.OutcomeReason,
                            CostUsd = zr.CostUsd,
                        });
                        storeResult(zr);
                        return;
                    }
                }

                // ── Validator ────────────────────────────────────────
                var validation = EdogQaScenarioValidator.Validate(
                    architectResult.Plan,
                    editorResult.Scenarios ?? new List<EdogQaLlmClient.GeneratedScenario>(),
                    zoneInput.UnifiedDiff ?? zoneInput.RedactedDiff ?? string.Empty,
                    config.Validation,
                    zr.TestingGuidance);

                zr.Accepted = validation.Accepted ?? new();
                zr.Quarantined = validation.Quarantined ?? new();
                // BatchErrors from the validator surface as zone errors but
                // do not flip the outcome — the zone Completed cleanly even
                // if no scenarios survived; an empty accepted list is valid.
                if (validation.BatchErrors != null && validation.BatchErrors.Count > 0)
                {
                    foreach (var be in validation.BatchErrors) zr.Errors.Add(be.Code ?? "VALIDATOR_BATCH_ERROR");
                }

                SafeReport(progress, new OrchestratorEvent
                {
                    Kind = OrchestratorEventKind.ZoneValidated,
                    ZoneId = zr.ZoneId,
                    ZoneInputIndex = zoneInputIndex,
                    AcceptedCount = zr.Accepted.Count,
                    QuarantinedCount = zr.Quarantined.Count,
                });

                // F27 P11: surface Architect advisories (e.g. P11_GUIDANCE_MISSING,
                // P11_COVERAGE_GAP, P11_COVERAGE_REPORT) as informational ZoneValidated
                // events. These do not flip the zone outcome.
                if (architectResult?.Advisories != null && architectResult.Advisories.Count > 0)
                {
                    foreach (var advisory in architectResult.Advisories)
                    {
                        if (string.IsNullOrWhiteSpace(advisory)) continue;
                        var dashIdx = advisory.IndexOf(" — ", StringComparison.Ordinal);
                        var code = dashIdx > 0 ? advisory.Substring(0, dashIdx) : "P11_ADVISORY";
                        var msg = dashIdx > 0 ? advisory.Substring(dashIdx + 3) : advisory;
                        SafeReport(progress, new OrchestratorEvent
                        {
                            Kind = OrchestratorEventKind.ZoneValidated,
                            ZoneId = zr.ZoneId,
                            ZoneInputIndex = zoneInputIndex,
                            ErrorCode = code,
                            Message = msg,
                        });
                    }
                }

                // F27 P11: surface validator BatchInformationalReasons (P11_COVERAGE_GAP,
                // P11_COVERAGE_REPORT) as informational ZoneValidated events.
                if (validation.BatchInformationalReasons != null && validation.BatchInformationalReasons.Count > 0)
                {
                    foreach (var info in validation.BatchInformationalReasons)
                    {
                        if (info == null) continue;
                        SafeReport(progress, new OrchestratorEvent
                        {
                            Kind = OrchestratorEventKind.ZoneValidated,
                            ZoneId = zr.ZoneId,
                            ZoneInputIndex = zoneInputIndex,
                            ErrorCode = info.Code ?? "P11_ADVISORY",
                            Message = info.Message ?? string.Empty,
                        });
                    }
                }

                // ── T1e Branch B: validator-quarantine repair pass ───
                //
                // Replacement-only semantics: the orchestrator preserves
                // the initial Accepted set as an invariant; the repair
                // pass can only ADD scenarios. Repair input is the
                // quarantined list as JSON-encoded diagnostic data
                // (not free-text instructions — see SECURITY.md §3 A1).
                //
                // SYSTEMIC-QUARANTINE SHORT-CIRCUIT: if >=80% of the
                // quarantined scenarios share the SAME failure code AND
                // there are at least 5 of them, the failure is a
                // systemic Editor-output problem (e.g. empty matchers,
                // null stimulus). Asking the Editor to repair
                // its own output one more time in the same format will
                // burn budget without recovering — the fix has to land
                // in the Editor prompt / schema, not in another repair
                // pass. Skip the repair, surface the root cause, and let
                // the operator iterate on the prompt.
                if (config.EnableRepairLoop
                    && zr.Quarantined.Count >= 5)
                {
                    var (dominantCode, dominantCount) = ComputeDominantQuarantineCode(zr.Quarantined);
                    if (!string.IsNullOrEmpty(dominantCode)
                        && dominantCount * 5 >= zr.Quarantined.Count * 4) // >=80%
                    {
                        EmitDiagnostic(progress,
                            $"Systemic quarantine detected: {dominantCount}/{zr.Quarantined.Count} scenarios "
                            + $"failed with the same code [{dominantCode}]. Skipping Editor repair loop — "
                            + "the Editor output format is broken, not individual scenarios. Fix the Editor "
                            + "prompt/schema upstream rather than burning budget on retries.");
                        SafeReport(progress, new OrchestratorEvent
                        {
                            Kind = OrchestratorEventKind.ZoneValidated,
                            ZoneId = zr.ZoneId,
                            ZoneInputIndex = zoneInputIndex,
                            Message = $"Systemic quarantine: {dominantCount}/{zr.Quarantined.Count} share code {dominantCode}",
                            ErrorCode = "SYSTEMIC_QUARANTINE_SKIP_REPAIR",
                        });
                        zr.RepairBranch = "skipped_systemic";
                        zr.RepairFailureCode = dominantCode;
                    }
                }

                if (config.EnableRepairLoop
                    && zr.RepairAttempts < ComputeMaxRepairPasses(config.ReachableSlotCount)
                    && zr.Quarantined.Count > 0
                    && !isBudgetTripped()
                    && zr.RepairBranch != "skipped_systemic"
                    && (config.EditorRepairOverride != null || config.Editor != null))
                {
                    zr.InitialAcceptedCount = zr.Accepted.Count;
                    zr.InitialQuarantinedCount = zr.Quarantined.Count;

                    SafeReport(progress, new OrchestratorEvent
                    {
                        Kind = OrchestratorEventKind.ZoneRepairAttempted,
                        ZoneId = zr.ZoneId,
                        ZoneInputIndex = zoneInputIndex,
                        ErrorCode = "validator_quarantine",
                    });

                    var feedback = new EdogQaLlmClient.EditorRepairContext
                    {
                        QuarantinedScenarios = BuildRepairItemsFromQuarantined(
                            zr.Quarantined,
                            ComputeReachabilityCap(zr.Accepted.Count, zr.Quarantined.Count)),
                    };

                    EdogQaLlmClient.LlmClientResult repairResult = null;
                    bool repairDispatched = false;
                    try
                    {
                        (repairResult, repairDispatched) = await TryCallEditorRepairAsync(
                            config, architectResult.Plan, zoneCtx, feedback, ct).ConfigureAwait(false);
                    }
                    catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
                    catch (Exception ex)
                    {
                        repairDispatched = true;
                        zr.RepairFailureCode = CodeUnexpectedException;
                        zr.Errors.Add(CodeUnexpectedException + " — editor repair stage: " + ex.GetType().Name);
                    }

                    if (repairDispatched)
                    {
                        zr.RepairAttempts = 1;
                        zr.RepairBranch = "validator_quarantine";
                    }

                    if (repairResult != null)
                    {
                        zr.RepairInputTokens += repairResult.EditorInputTokens;
                        zr.RepairOutputTokens += repairResult.EditorOutputTokens;
                        zr.InputTokens += repairResult.EditorInputTokens;
                        zr.OutputTokens += repairResult.EditorOutputTokens;

                        if (repairResult.Status == EdogQaLlmClient.LlmClientStatus.Failed)
                        {
                            var firstRepairError = repairResult.Errors != null && repairResult.Errors.Count > 0
                                ? StableCodePrefix(repairResult.Errors[0])
                                : "EDITOR_REPAIR_UNKNOWN_ERROR";
                            zr.RepairFailureCode = firstRepairError;
                            zr.Errors.AddRange(repairResult.Errors ?? new());
                        }
                        else
                        {
                            var repairValidation = EdogQaScenarioValidator.Validate(
                                architectResult.Plan,
                                repairResult.Scenarios ?? new List<EdogQaLlmClient.GeneratedScenario>(),
                                zoneInput.UnifiedDiff ?? zoneInput.RedactedDiff ?? string.Empty,
                                config.Validation,
                                zr.TestingGuidance);

                            zr.RepairAcceptedCount = repairValidation.Accepted?.Count ?? 0;
                            zr.RepairQuarantinedCount = repairValidation.Quarantined?.Count ?? 0;

                            if (repairValidation.BatchErrors != null && repairValidation.BatchErrors.Count > 0)
                            {
                                foreach (var be in repairValidation.BatchErrors) zr.Errors.Add(be.Code ?? "VALIDATOR_BATCH_ERROR");
                            }

                            // Replacement-only merge: initial Accepted
                            // is preserved; repair-Accepted scenarios
                            // are appended unless their SemanticHash
                            // collides with an existing entry. Empty/
                            // null hashes bypass dedup (unique per
                            // occurrence) so the validator's empty-hash
                            // contract failure never silently swallows
                            // distinct work.
                            MergeAcceptedRepairs(zr.Accepted, repairValidation.Accepted);

                            // Repair-quarantined entries are APPENDED to
                            // the existing quarantined list so the
                            // caller sees both passes' failures; they
                            // never overwrite the initial set that
                            // triggered Branch B.
                            if (repairValidation.Quarantined != null && repairValidation.Quarantined.Count > 0)
                            {
                                zr.Quarantined.AddRange(repairValidation.Quarantined);

                                var (escalationResult, escalationValidation, escalationDispatched) = await RunSingleScenarioEscalationAsync(
                                    config,
                                    architectResult.Plan,
                                    zoneCtx,
                                    repairValidation.Quarantined,
                                    zoneInput.UnifiedDiff ?? zoneInput.RedactedDiff ?? string.Empty,
                                    zr.TestingGuidance,
                                    ct).ConfigureAwait(false);
                                if (escalationDispatched)
                                {
                                    zr.RepairAttempts = Math.Max(zr.RepairAttempts, 2);
                                    zr.RepairBranch = "validator_quarantine_attempt3";
                                }
                                if (escalationResult != null)
                                {
                                    zr.RepairInputTokens += escalationResult.EditorInputTokens;
                                    zr.RepairOutputTokens += escalationResult.EditorOutputTokens;
                                    zr.InputTokens += escalationResult.EditorInputTokens;
                                    zr.OutputTokens += escalationResult.EditorOutputTokens;
                                }
                                if (escalationResult != null && escalationResult.Status == EdogQaLlmClient.LlmClientStatus.Failed)
                                {
                                    var firstEscalationError = escalationResult.Errors != null && escalationResult.Errors.Count > 0
                                        ? StableCodePrefix(escalationResult.Errors[0])
                                        : "EDITOR_REPAIR_ESCALATION_FAILED";
                                    zr.RepairFailureCode = firstEscalationError;
                                    zr.Errors.AddRange(escalationResult.Errors ?? new());
                                }
                                else if (escalationValidation != null)
                                {
                                    zr.RepairAcceptedCount += escalationValidation.Accepted?.Count ?? 0;
                                    zr.RepairQuarantinedCount += escalationValidation.Quarantined?.Count ?? 0;
                                    MergeAcceptedRepairs(zr.Accepted, escalationValidation.Accepted);
                                    if (escalationValidation.Quarantined != null && escalationValidation.Quarantined.Count > 0)
                                    {
                                        zr.Quarantined.AddRange(escalationValidation.Quarantined);
                                    }
                                }
                            }

                            ReorderAcceptedByOriginalIndex(zr.Accepted);
                        }
                    }
                }

                // ── Branch C: lint-triggered repair ─────────────────
                // Separate budget from validator repair: lint repair fires
                // even if validator repair already consumed RepairAttempts.
                // Capped at 1 lint repair pass to avoid cost blow-up.
                var alreadyLintRepaired = zr.RepairBranch != null
                    && zr.RepairBranch.Contains("lint_findings");
                if (config.EnableRepairLoop
                    && zr.Accepted.Count > 0
                    && !isBudgetTripped()
                    && !alreadyLintRepaired
                    && (config.EditorRepairOverride != null || config.Editor != null))
                {
                    var lintRepairItems = QuickLintAccepted(zr.Accepted);
                    if (lintRepairItems.Count > 0)
                    {
                        EmitDiagnostic(progress,
                            $"Lint repair: {lintRepairItems.Count} scenario(s) with repairable findings");

                        SafeReport(progress, new OrchestratorEvent
                        {
                            Kind = OrchestratorEventKind.ZoneRepairAttempted,
                            ZoneId = zr.ZoneId,
                            ZoneInputIndex = zoneInputIndex,
                            ErrorCode = "lint_findings",
                        });

                        var lintFeedback = new EdogQaLlmClient.EditorRepairContext
                        {
                            QuarantinedScenarios = lintRepairItems,
                        };

                        EdogQaLlmClient.LlmClientResult lintRepairResult = null;
                        bool lintRepairDispatched = false;
                        try
                        {
                            (lintRepairResult, lintRepairDispatched) = await TryCallEditorRepairAsync(
                                config, architectResult.Plan, zoneCtx, lintFeedback, ct).ConfigureAwait(false);
                        }
                        catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
                        catch (Exception ex)
                        {
                            lintRepairDispatched = true;
                            zr.RepairFailureCode = CodeUnexpectedException;
                            zr.Errors.Add("LINT_REPAIR_EXCEPTION — " + ex.GetType().Name);
                        }

                        if (lintRepairDispatched)
                        {
                            zr.RepairAttempts++;
                            zr.RepairBranch = string.IsNullOrEmpty(zr.RepairBranch)
                                ? "lint_findings"
                                : zr.RepairBranch + ";lint_findings";
                        }

                        if (lintRepairResult != null)
                        {
                            zr.RepairInputTokens += lintRepairResult.EditorInputTokens;
                            zr.RepairOutputTokens += lintRepairResult.EditorOutputTokens;
                            zr.InputTokens += lintRepairResult.EditorInputTokens;
                            zr.OutputTokens += lintRepairResult.EditorOutputTokens;

                            if (lintRepairResult.Status == EdogQaLlmClient.LlmClientStatus.Failed)
                            {
                                var firstLintError = lintRepairResult.Errors != null && lintRepairResult.Errors.Count > 0
                                    ? StableCodePrefix(lintRepairResult.Errors[0])
                                    : "EDITOR_REPAIR_LINT_FAILED";
                                zr.RepairFailureCode = firstLintError;
                                zr.Errors.AddRange(lintRepairResult.Errors ?? new());
                            }
                            else
                            {
                                var lintRepairValidation = EdogQaScenarioValidator.Validate(
                                    architectResult.Plan,
                                    lintRepairResult.Scenarios ?? new List<EdogQaLlmClient.GeneratedScenario>(),
                                    zoneInput.UnifiedDiff ?? zoneInput.RedactedDiff ?? string.Empty,
                                    config.Validation,
                                    zr.TestingGuidance);

                                zr.RepairAcceptedCount += lintRepairValidation.Accepted?.Count ?? 0;
                                zr.RepairQuarantinedCount += lintRepairValidation.Quarantined?.Count ?? 0;

                                if (lintRepairValidation.BatchErrors != null && lintRepairValidation.BatchErrors.Count > 0)
                                {
                                    foreach (var be in lintRepairValidation.BatchErrors)
                                    {
                                        zr.Errors.Add(be.Code ?? "VALIDATOR_BATCH_ERROR");
                                    }
                                }

                                ReplaceFlaggedScenarios(zr.Accepted, lintRepairItems, lintRepairValidation.Accepted);
                                ReorderAcceptedByOriginalIndex(zr.Accepted);

                                EmitDiagnostic(progress,
                                    $"Lint repair done: {lintRepairValidation.Accepted?.Count ?? 0} replacements accepted, "
                                    + $"{lintRepairValidation.Quarantined?.Count ?? 0} quarantined");
                            }
                        }
                    }
                }

                zr.Outcome = ZoneOutcome.Completed;
                zr.CostUsd = ComputeCost(zr, config.Pricing);
                AccumulateDeltaAndMaybeTrip(zr, ref bookedCostUsd, addAccumulate, refAccumulate, maxBudgetMicroUsd, tripBudget);
                zr.ElapsedMs = zoneStopwatch.ElapsedMilliseconds;

                SafeReport(progress, new OrchestratorEvent
                {
                    Kind = OrchestratorEventKind.ZoneCompleted,
                    ZoneId = zr.ZoneId,
                    ZoneInputIndex = zoneInputIndex,
                    ElapsedMs = zr.ElapsedMs,
                    InputTokens = zr.InputTokens,
                    OutputTokens = zr.OutputTokens,
                    ReasoningTokens = zr.ReasoningTokens,
                    CostUsd = zr.CostUsd,
                    AcceptedCount = zr.Accepted.Count,
                    QuarantinedCount = zr.Quarantined.Count,
                });

                storeResult(zr);
            }
            finally
            {
                semaphore.Release();
            }
        }

        // ═══════════════════════════════════════════════════════════════
        // Helpers
        // ═══════════════════════════════════════════════════════════════

        private static void SafeReport(IProgress<OrchestratorEvent> progress, OrchestratorEvent ev)
        {
            if (progress == null) return;
            try { progress.Report(ev); }
            catch { /* I7: progress callbacks must never bubble. */ }
        }

        /// <summary>
        /// Mirror a <c>[QA-DIAG]</c> message to stdout (for the FLT log
        /// file), enqueue it on the per-run diagnostic sink (so
        /// <see cref="OrchestratorResult.DiagnosticMessages"/> carries
        /// it back to the analyzer / hub for browser surfacing), and
        /// emit a <see cref="OrchestratorEventKind.DiagnosticMessage"/>
        /// progress event for any live SignalR listener.
        /// </summary>
        private void EmitDiagnostic(IProgress<OrchestratorEvent> progress, string message)
        {
            Console.WriteLine($"[QA-DIAG] {message}");
            _runDiagnostics?.Enqueue(message);
            SafeReport(progress, new OrchestratorEvent
            {
                Kind = OrchestratorEventKind.DiagnosticMessage,
                Message = message,
            });
        }

        /// <summary>
        /// T1e: dispatch the Editor repair call via the test override
        /// if present, else the live LLM client. Returns
        /// dispatched=false ONLY when neither path is
        /// available — in that case the caller skips repair entirely
        /// without incrementing the attempts counter.
        /// </summary>
        private async Task<(EdogQaLlmClient.LlmClientResult result, bool dispatched)> TryCallEditorRepairAsync(
            OrchestratorConfig config,
            EdogQaLlmClient.ArchitectPlan plan,
            EdogQaLlmClient.ZoneContext zoneCtx,
            EdogQaLlmClient.EditorRepairContext repair,
            CancellationToken ct)
        {
            if (config.EditorRepairOverride != null)
            {
                var r = await config.EditorRepairOverride(plan, zoneCtx, repair, ct).ConfigureAwait(false);
                return (r, true);
            }
            if (config.Editor != null)
            {
                var r = await EdogQaLlmClient.EditorOnceAsync(_httpClient, config.Editor, plan, zoneCtx, repair, ct).ConfigureAwait(false);
                return (r, true);
            }
            return (null, false);
        }

        /// <summary>
        /// Detect a systemic quarantine pattern: the wire code shared by
        /// the largest plurality of quarantined scenarios, plus its
        /// count. Used by the Branch B short-circuit to avoid spending
        /// repair budget when the failure is uniform across the batch
        /// (e.g. every scenario has null stimulus or null matcher).
        /// Caller decides the dominance threshold; this helper just
        /// returns the tally.
        /// </summary>
        private static (string Code, int Count) ComputeDominantQuarantineCode(
            List<EdogQaScenarioValidator.QuarantinedScenario> quarantined)
        {
            if (quarantined == null || quarantined.Count == 0) return (string.Empty, 0);
            var tally = new Dictionary<string, int>(StringComparer.Ordinal);
            foreach (var q in quarantined)
            {
                if (q?.Reasons == null || q.Reasons.Count == 0) continue;
                // Tally the FIRST reason code per scenario — the validator
                // emits reasons in priority order, so the first is the
                // root cause for scoring purposes.
                var code = q.Reasons[0]?.Code;
                if (string.IsNullOrEmpty(code)) continue;
                tally[code] = tally.TryGetValue(code, out var n) ? n + 1 : 1;
            }
            var winner = (Code: string.Empty, Count: 0);
            foreach (var kv in tally)
            {
                if (kv.Value > winner.Count) winner = (kv.Key, kv.Value);
            }
            return winner;
        }

        /// <summary>
        /// T1e: project the validator's quarantined records into the
        /// Editor repair feedback shape. Reasons are preserved
        /// (Code/Message/EvidenceId/FieldPath) so the model sees
        /// structured diagnostic data, not prose instructions.
        /// </summary>
        private static List<EdogQaLlmClient.RepairFeedbackItem> BuildRepairItemsFromQuarantined(
            List<EdogQaScenarioValidator.QuarantinedScenario> quarantined,
            int takeLimit = int.MaxValue)
        {
            var items = new List<EdogQaLlmClient.RepairFeedbackItem>();
            if (quarantined == null) return items;
            foreach (var q in quarantined
                .Where(x => x != null)
                .OrderBy(x => x.Scenario?.OriginalIndex ?? int.MaxValue)
                .Take(Math.Max(1, takeLimit)))
            {
                var reasons = new List<EdogQaLlmClient.RepairFeedbackReason>();
                if (q.Reasons != null)
                {
                    foreach (var r in q.Reasons)
                    {
                        if (r == null) continue;
                        reasons.Add(new EdogQaLlmClient.RepairFeedbackReason
                        {
                            Code = r.Code ?? string.Empty,
                            Message = r.Message ?? string.Empty,
                            EvidenceId = r.EvidenceId ?? string.Empty,
                            FieldPath = r.FieldPath ?? string.Empty,
                        });
                    }
                }
                items.Add(new EdogQaLlmClient.RepairFeedbackItem
                {
                    ScenarioId = q.Scenario?.Id ?? string.Empty,
                    Title = q.Scenario?.Title ?? string.Empty,
                    OriginalIndex = q.Scenario?.OriginalIndex,
                    Reasons = reasons,
                    // P10 fix (P1-5): forward the full scenario payload so the
                    // repair model can inspect typed matchers, catalog
                    // hashes, grounding evidence, and stimulus spec — not
                    // just the id/title.
                    ScenarioJson = q.Scenario == null ? null : SafeSerializeScenario(q.Scenario),
                });
            }
            return items;
        }

        private static readonly JsonSerializerOptions _repairSerializerOptions = new()
        {
            WriteIndented = false,
            DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
        };

        private static string SafeSerializeScenario(EdogQaLlmClient.GeneratedScenario scenario)
        {
            try
            {
                return JsonSerializer.Serialize(scenario, _repairSerializerOptions);
            }
            catch
            {
                return null;
            }
        }

        private static List<EdogQaLlmClient.RepairFeedbackItem> QuickLintAccepted(
            List<EdogQaScenarioValidator.AcceptedScenario> accepted)
        {
            var itemsById = new Dictionary<string, EdogQaLlmClient.RepairFeedbackItem>(StringComparer.Ordinal);
            if (accepted == null || accepted.Count == 0)
            {
                return itemsById.Values.ToList();
            }

            EdogQaLlmClient.RepairFeedbackItem GetOrAdd(EdogQaLlmClient.GeneratedScenario scenario)
            {
                var key = scenario?.Id ?? scenario?.SketchId ?? string.Empty;
                if (!itemsById.TryGetValue(key, out var item))
                {
                    item = new EdogQaLlmClient.RepairFeedbackItem
                    {
                        ScenarioId = scenario?.Id ?? string.Empty,
                        Title = scenario?.Title ?? string.Empty,
                        OriginalIndex = scenario?.OriginalIndex,
                        ScenarioJson = scenario == null ? null : SafeSerializeScenario(scenario),
                    };
                    itemsById[key] = item;
                }
                return item;
            }

            foreach (var acceptedScenario in accepted)
            {
                var scenario = acceptedScenario?.Scenario;
                if (scenario == null) continue;
                if (!string.Equals(scenario.Technique, "Counterfactual", StringComparison.OrdinalIgnoreCase)) continue;

                var hasAbsent = scenario.Expectations != null
                    && scenario.Expectations.Any(e => string.Equals(e?.Type, "EventAbsent", StringComparison.OrdinalIgnoreCase));
                if (hasAbsent) continue;

                GetOrAdd(scenario).Reasons.Add(new EdogQaLlmClient.RepairFeedbackReason
                {
                    Code = "LNT007_CounterfactualHasAbsent",
                    Message = "Counterfactual scenario must include at least one EventAbsent expectation. Add an expectation asserting that something does NOT happen.",
                });
            }

            var seen = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (var acceptedScenario in accepted)
            {
                var scenario = acceptedScenario?.Scenario;
                if (scenario == null) continue;
                var key = GeneratedScenarioStimulusKey(scenario);
                if (key == null) continue;

                var scenarioId = scenario.Id ?? scenario.SketchId ?? string.Empty;
                if (seen.TryGetValue(key, out var firstId))
                {
                    // Flag only the later duplicate: the first occurrence stays as the
                    // canonical baseline stimulus and the repair pass differentiates the
                    // colliding follower. Repair attempts are capped, so repeated lint
                    // findings surface as diagnostics rather than looping indefinitely.
                    GetOrAdd(scenario).Reasons.Add(new EdogQaLlmClient.RepairFeedbackReason
                    {
                        Code = "LNT009_NoDuplicateStimulus",
                        Message = $"Stimulus is identical to scenario '{firstId}'. Differentiate through featureFlagOverrides, request body, or query parameters.",
                    });
                }
                else
                {
                    seen[key] = scenarioId;
                }
            }

            // LNT011: matcher literals that look like regex/templates/log fragments
            foreach (var acceptedScenario in accepted)
            {
                var scenario = acceptedScenario?.Scenario;
                if (scenario?.Matchers == null) continue;
                foreach (var m in scenario.Matchers)
                {
                    if (m?.Value.ValueKind != System.Text.Json.JsonValueKind.Object) continue;
                    string literalStr = null;
                    try
                    {
                        if (m.Value.TryGetProperty("kind", out var kindEl)
                            && kindEl.GetString() == "string_literal"
                            && m.Value.TryGetProperty("literal", out var litEl)
                            && litEl.ValueKind == System.Text.Json.JsonValueKind.String)
                        {
                            literalStr = litEl.GetString();
                        }
                    }
                    catch { continue; }
                    if (string.IsNullOrWhiteSpace(literalStr)) continue;
                    if (literalStr.Contains("(") || literalStr.Contains(".*")
                        || literalStr.StartsWith("^") || literalStr.EndsWith("$")
                        || literalStr.Contains("{0") || literalStr.Contains("%s"))
                    {
                        GetOrAdd(scenario).Reasons.Add(new EdogQaLlmClient.RepairFeedbackReason
                        {
                            Code = "LNT011_MatcherLiteralQuality",
                            Message = $"Matcher literal '{literalStr}' looks like a log fragment or regex. Use an atomic contract value (e.g. 'DirectAAD', not 'direct token (no OBO)').",
                        });
                        break;
                    }
                }
            }

            return itemsById.Values
                .OrderBy(item => item.OriginalIndex ?? int.MaxValue)
                .ThenBy(item => item.ScenarioId ?? string.Empty, StringComparer.Ordinal)
                .ToList();
        }

        private static string GeneratedScenarioStimulusKey(EdogQaLlmClient.GeneratedScenario scenario)
        {
            if (scenario == null || scenario.Stimulus == null)
            {
                return null;
            }

            var flagSuffix = string.Empty;
            if (scenario.FeatureFlagOverrides != null && scenario.FeatureFlagOverrides.Count > 0)
            {
                var sorted = scenario.FeatureFlagOverrides
                    .Where(f => f != null)
                    .OrderBy(f => f.FlagName ?? string.Empty, StringComparer.OrdinalIgnoreCase)
                    .Select(f => $"{f.FlagName}={f.Value}")
                    .ToList();
                if (sorted.Count > 0)
                {
                    flagSuffix = "|ff:" + ShortHash(string.Join(",", sorted));
                }
            }

            switch (scenario.Stimulus)
            {
                case EdogQaLlmClient.HttpRequestStimulus http:
                    if (string.IsNullOrEmpty(http.Path)) return null;
                    var method = http.Method ?? "GET";
                    var bodyHash = ShortHash(http.Body ?? string.Empty);
                    return $"http|{method.ToUpperInvariant()}|{http.Path}|{bodyHash}{flagSuffix}";
                case EdogQaLlmClient.SignalRBroadcastStimulus signalr:
                    if (string.IsNullOrEmpty(signalr.Method)) return null;
                    var argsHash = signalr.Args != null
                        ? ShortHash(string.Join(",", signalr.Args.Select(a => a?.ToString() ?? "")))
                        : ShortHash(string.Empty);
                    return $"signalr|{signalr.Hub}|{signalr.Method}|{argsHash}{flagSuffix}";
                case EdogQaLlmClient.DagTriggerStimulus dag:
                    var nodeFilter = dag.NodeFilter != null
                        ? string.Join(",", dag.NodeFilter.OrderBy(n => n, StringComparer.Ordinal))
                        : string.Empty;
                    return $"dag|{dag.IterationId}|{nodeFilter}{flagSuffix}";
                case EdogQaLlmClient.FileEventStimulus file:
                    return string.IsNullOrEmpty(file.Path) ? null : $"file|{file.Path}{flagSuffix}";
                case EdogQaLlmClient.TimerTickStimulus timer:
                    return $"timer|{timer.TickSource}|{timer.Topic}{flagSuffix}";
                case EdogQaLlmClient.DiInvocationStimulus di:
                    if (string.IsNullOrEmpty(di.Method)) return null;
                    var diArgsHash = di.Args != null
                        ? ShortHash(string.Join(",", di.Args.Select(a => a?.ToString() ?? "")))
                        : ShortHash(string.Empty);
                    var stimIdTag = !string.IsNullOrEmpty(scenario.StimulusId)
                        ? $"|sid:{scenario.StimulusId}"
                        : string.Empty;
                    return $"direct|{di.ServiceType}|{di.Method}|{diArgsHash}{flagSuffix}{stimIdTag}";
                default:
                    return null;
            }
        }

        private static string GetJsonString(JsonElement element, string propertyName)
        {
            if (!element.TryGetProperty(propertyName, out var property))
            {
                return null;
            }
            return property.ValueKind == JsonValueKind.String ? property.GetString() : property.ToString();
        }

        private static string GetNodeFilterKey(JsonElement element)
        {
            if (!element.TryGetProperty("nodeFilter", out var nodeFilter))
            {
                return string.Empty;
            }

            if (nodeFilter.ValueKind == JsonValueKind.Array)
            {
                return string.Join(",", nodeFilter.EnumerateArray().Select(item => item.ToString()));
            }

            return nodeFilter.ToString();
        }

        private static string CanonicalJson(JsonElement element)
        {
            switch (element.ValueKind)
            {
                case JsonValueKind.Object:
                    var properties = element.EnumerateObject()
                        .OrderBy(property => property.Name, StringComparer.Ordinal)
                        .Select(property => $"\"{property.Name}\":{CanonicalJson(property.Value)}");
                    return "{" + string.Join(",", properties) + "}";
                case JsonValueKind.Array:
                    var items = element.EnumerateArray().Select(CanonicalJson);
                    return "[" + string.Join(",", items) + "]";
                default:
                    return element.GetRawText();
            }
        }

        private static string ShortHash(string raw)
        {
            using var sha = SHA256.Create();
            var bytes = sha.ComputeHash(Encoding.UTF8.GetBytes(raw ?? string.Empty));
            var sb = new StringBuilder(8);
            for (var i = 0; i < 4; i++)
            {
                sb.Append(bytes[i].ToString("x2", System.Globalization.CultureInfo.InvariantCulture));
            }
            return sb.ToString();
        }

        private static void ReplaceFlaggedScenarios(
            List<EdogQaScenarioValidator.AcceptedScenario> accepted,
            List<EdogQaLlmClient.RepairFeedbackItem> flaggedItems,
            List<EdogQaScenarioValidator.AcceptedScenario> replacements)
        {
            if (accepted == null || accepted.Count == 0 || flaggedItems == null || flaggedItems.Count == 0)
            {
                return;
            }

            var flaggedIds = new HashSet<string>(
                flaggedItems.Select(item => item?.ScenarioId).Where(id => !string.IsNullOrEmpty(id)),
                StringComparer.Ordinal);
            var flaggedSketchIds = new HashSet<string>(StringComparer.Ordinal);
            foreach (var existing in accepted)
            {
                var scenario = existing?.Scenario;
                if (scenario == null || !flaggedIds.Contains(scenario.Id ?? string.Empty)) continue;
                if (!string.IsNullOrEmpty(scenario.SketchId))
                {
                    flaggedSketchIds.Add(scenario.SketchId);
                }
            }

            var replacementById = new Dictionary<string, EdogQaScenarioValidator.AcceptedScenario>(StringComparer.Ordinal);
            var replacementBySketchId = new Dictionary<string, EdogQaScenarioValidator.AcceptedScenario>(StringComparer.Ordinal);
            foreach (var replacement in replacements ?? new List<EdogQaScenarioValidator.AcceptedScenario>())
            {
                var scenario = replacement?.Scenario;
                if (scenario == null) continue;
                if (!string.IsNullOrEmpty(scenario.Id) && !replacementById.ContainsKey(scenario.Id))
                {
                    replacementById[scenario.Id] = replacement;
                }
                if (!string.IsNullOrEmpty(scenario.SketchId) && !replacementBySketchId.ContainsKey(scenario.SketchId))
                {
                    replacementBySketchId[scenario.SketchId] = replacement;
                }
            }

            for (var i = 0; i < accepted.Count; i++)
            {
                var existing = accepted[i];
                var scenario = existing?.Scenario;
                if (scenario == null) continue;

                var isFlagged = flaggedIds.Contains(scenario.Id ?? string.Empty)
                    || (!string.IsNullOrEmpty(scenario.SketchId) && flaggedSketchIds.Contains(scenario.SketchId));
                if (!isFlagged) continue;

                if (!string.IsNullOrEmpty(scenario.SketchId)
                    && replacementBySketchId.TryGetValue(scenario.SketchId, out var replacementBySketch))
                {
                    accepted[i] = replacementBySketch;
                    continue;
                }

                if (!string.IsNullOrEmpty(scenario.Id)
                    && replacementById.TryGetValue(scenario.Id, out var replacementByScenarioId))
                {
                    accepted[i] = replacementByScenarioId;
                }
            }
        }

        private async Task<(EdogQaLlmClient.LlmClientResult repairResult, EdogQaScenarioValidator.ValidationResult validation, bool dispatched)> RunSingleScenarioEscalationAsync(
            OrchestratorConfig config,
            EdogQaLlmClient.ArchitectPlan plan,
            EdogQaLlmClient.ZoneContext zoneCtx,
            List<EdogQaScenarioValidator.QuarantinedScenario> quarantined,
            string unifiedDiff,
            EdogQaLlmClient.TestingGuidance testingGuidance,
            CancellationToken ct)
        {
            if (!config.EnableRepairLoop || quarantined == null || quarantined.Count == 0)
            {
                return (null, null, false);
            }

            var feedback = new EdogQaLlmClient.EditorRepairContext
            {
                SingleScenarioOnly = true,
                QuarantinedScenarios = BuildRepairItemsFromQuarantined(quarantined, 1),
            };
            if (feedback.QuarantinedScenarios.Count == 0)
            {
                return (null, null, false);
            }

            EdogQaTelemetry.EmitContractEvent(
                EdogQaTelemetry.EventRepairEscalation,
                zoneCtx?.ZoneId ?? string.Empty,
                "attempt3",
                "Escalating to single-scenario repair.");

            var (repairResult, dispatched) = await TryCallEditorRepairAsync(config, plan, zoneCtx, feedback, ct).ConfigureAwait(false);
            if (!dispatched || repairResult == null || repairResult.Status == EdogQaLlmClient.LlmClientStatus.Failed)
            {
                return (repairResult, null, dispatched);
            }

            var validation = EdogQaScenarioValidator.Validate(
                plan,
                repairResult.Scenarios ?? new List<EdogQaLlmClient.GeneratedScenario>(),
                unifiedDiff,
                config.Validation,
                testingGuidance);
            return (repairResult, validation, dispatched);
        }

        /// <summary>
        /// Computes the maximum number of repair passes for a zone.
        /// Per spec §4.2: <c>min(2, floor(reachableSlotCount / 8))</c>.
        /// Returns at least 1 so every zone gets at least one repair attempt.
        /// </summary>
        internal static int ComputeMaxRepairPasses(int reachableSlotCount)
        {
            if (reachableSlotCount <= 0)
            {
                return 1;
            }

            return Math.Max(1, Math.Min(2, reachableSlotCount / 8));
        }

        private static int ComputeReachabilityCap(int acceptedCount, int quarantinedCount)
        {
            var total = Math.Max(acceptedCount + quarantinedCount, quarantinedCount);
            return Math.Min(8, Math.Max(1, (int)Math.Ceiling(total * 0.35)));
        }

        private static void MergeAcceptedRepairs(
            List<EdogQaScenarioValidator.AcceptedScenario> target,
            List<EdogQaScenarioValidator.AcceptedScenario> repairs)
        {
            if (target == null || repairs == null || repairs.Count == 0)
            {
                return;
            }

            var seenHashes = new HashSet<string>(StringComparer.Ordinal);
            foreach (var existing in target)
            {
                if (!string.IsNullOrEmpty(existing?.SemanticHash))
                {
                    seenHashes.Add(existing.SemanticHash);
                }
            }

            foreach (var repair in repairs)
            {
                if (repair == null) continue;
                if (!string.IsNullOrEmpty(repair.SemanticHash) && !seenHashes.Add(repair.SemanticHash))
                {
                    continue;
                }
                target.Add(repair);
            }
        }

        private static void ReorderAcceptedByOriginalIndex(List<EdogQaScenarioValidator.AcceptedScenario> accepted)
        {
            if (accepted == null || accepted.Count < 2)
            {
                return;
            }

            accepted.Sort((left, right) =>
            {
                var leftIndex = left?.Scenario?.OriginalIndex ?? int.MaxValue;
                var rightIndex = right?.Scenario?.OriginalIndex ?? int.MaxValue;
                var cmp = leftIndex.CompareTo(rightIndex);
                if (cmp != 0) return cmp;
                return string.CompareOrdinal(left?.Scenario?.Id ?? string.Empty, right?.Scenario?.Id ?? string.Empty);
            });
        }

        private static double ComputeCost(ZoneResult zr, PricingTable pricing)
        {
            if (pricing == null) return 0;
            // Architect tokens were added to zr.InputTokens / OutputTokens /
            // ReasoningTokens by the Architect stage. The Editor stage
            // accumulated its own tokens into the SAME cumulative bag.
            // The repair pass (T1e) is split out into RepairInputTokens /
            // RepairOutputTokens so it can be priced at Editor rates
            // separately.
            //
            // Because we don't preserve the architect/editor token split
            // on the cumulative bag itself, this single helper still
            // approximates the non-repair portion at Architect rates.
            // The PER-STAGE accuracy is captured in the per-stage progress
            // events (which carry the live token counts at each step) —
            // that is the canonical source for cost analysis. zr.CostUsd
            // is the wire-stable rollup the budget gate uses.
            double cost = ComputeStageCost(zr.InputTokens, zr.OutputTokens, zr.ReasoningTokens, pricing.Architect);
            if (zr.RepairInputTokens > 0 || zr.RepairOutputTokens > 0)
            {
                cost += ComputeStageCost(zr.RepairInputTokens, zr.RepairOutputTokens, 0, pricing.Editor);
            }
            return cost;
        }

        private static double ComputeStageCost(int inputTokens, int outputTokens, int reasoningTokens, DeploymentPricing pricing)
        {
            if (pricing == null) return 0;
            double cost = 0;
            cost += (inputTokens / 1000.0) * pricing.InputPerThousand;
            cost += (outputTokens / 1000.0) * pricing.OutputPerThousand;
            cost += (reasoningTokens / 1000.0) * pricing.ReasoningPerThousand;
            return cost;
        }

        /// <summary>Strip the " — explanation" tail to keep only the wire-stable prefix code.</summary>
        private static string StableCodePrefix(string raw)
        {
            if (string.IsNullOrEmpty(raw)) return string.Empty;
            var sep = raw.IndexOf(" — ", StringComparison.Ordinal);
            return sep > 0 ? raw.Substring(0, sep) : raw;
        }

        private static string budgetReasonFromExisting(
            long deadlineTicks,
            Stopwatch batchStopwatch,
            Func<long> refAccumulate,
            long maxBudgetMicroUsd)
        {
            // Best-effort attribution when the budget was tripped by a
            // sibling zone before this one reached its post-semaphore
            // check. We prefer the time reason if the deadline has been
            // crossed, else the cost reason.
            if (batchStopwatch.ElapsedTicks > deadlineTicks) return CodeBudgetExceededTime;
            if (refAccumulate() >= maxBudgetMicroUsd) return CodeBudgetExceededCost;
            return CodeBudgetExceededCost;
        }

        private static void AccumulateAndMaybeTrip(
            ZoneResult zr,
            OrchestratorConfig config,
            Func<long, long> addAccumulate,
            Func<long> refAccumulate,
            long maxBudgetMicroUsd,
            Action<string, int> tripBudget)
        {
            var costMicroUsd = (long)Math.Round(zr.CostUsd * 1_000_000.0);
            if (costMicroUsd < 0) costMicroUsd = 0;
            addAccumulate(costMicroUsd);
            if (refAccumulate() >= maxBudgetMicroUsd)
            {
                tripBudget(CodeBudgetExceededCost, 1);
            }
        }

        /// <summary>
        /// T1e: book only the DELTA between the zone's current cumulative
        /// <see cref="ZoneResult.CostUsd"/> and the running
        /// <paramref name="bookedCostUsd"/> tally. This fixes a
        /// pre-existing double-count: <see cref="AccumulateAndMaybeTrip"/>
        /// adds the full <c>zr.CostUsd</c> on every call, so a zone that
        /// crossed two stages (Architect + Editor) was double-billed
        /// against the cost budget. The repair-aware orchestrator
        /// flow always uses this helper; the legacy non-delta helper
        /// remains for any caller that bookkeeps elsewhere.
        /// </summary>
        private static void AccumulateDeltaAndMaybeTrip(
            ZoneResult zr,
            ref double bookedCostUsd,
            Func<long, long> addAccumulate,
            Func<long> refAccumulate,
            long maxBudgetMicroUsd,
            Action<string, int> tripBudget)
        {
            var deltaUsd = zr.CostUsd - bookedCostUsd;
            if (deltaUsd < 0) deltaUsd = 0;
            var deltaMicroUsd = (long)Math.Round(deltaUsd * 1_000_000.0);
            if (deltaMicroUsd < 0) deltaMicroUsd = 0;
            bookedCostUsd = zr.CostUsd;
            addAccumulate(deltaMicroUsd);
            if (refAccumulate() >= maxBudgetMicroUsd)
            {
                tripBudget(CodeBudgetExceededCost, 1);
            }
        }

        private static int ComparePoolEntry(PoolEntry a, PoolEntry b)
        {
            // Deterministic sort by (ZoneInputIndex, ScenarioId, SemanticHash).
            // ZoneInputIndex first so the input order is the dominant key —
            // a duplicate seen in zone-0 always beats the same hash in
            // zone-1 regardless of completion ordering.
            int c = a.ZoneInputIndex.CompareTo(b.ZoneInputIndex);
            if (c != 0) return c;
            var ida = a.Accepted?.Scenario?.Id ?? string.Empty;
            var idb = b.Accepted?.Scenario?.Id ?? string.Empty;
            c = string.CompareOrdinal(ida, idb);
            if (c != 0) return c;
            var ha = a.Accepted?.SemanticHash ?? string.Empty;
            var hb = b.Accepted?.SemanticHash ?? string.Empty;
            return string.CompareOrdinal(ha, hb);
        }

        private sealed class PoolEntry
        {
            public int ZoneInputIndex;

            public string ZoneId;

            public EdogQaScenarioValidator.AcceptedScenario Accepted;

            public EdogQaLlmClient.ArchitectPlan Plan;

            public CatalogSnapshot Catalog;
        }
    }
}
