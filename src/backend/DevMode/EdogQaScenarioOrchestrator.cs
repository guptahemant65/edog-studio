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
    using System.Collections.Generic;
    using System.Diagnostics;
    using System.Linq;
    using System.Net.Http;
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
        }

        // ═══════════════════════════════════════════════════════════════
        // Construction + entry point
        // ═══════════════════════════════════════════════════════════════

        private readonly HttpClient _httpClient;

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

                var single = EdogQaScenarioProjector.Project(w.Plan, new[] { w.Accepted });
                foreach (var p in single.Projected) mergedScenarios.Add(p);
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
                };

                // ── Architect ─────────────────────────────────────────
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
                    config.Validation);

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

                // ── T1e Branch B: validator-quarantine repair pass ───
                //
                // Replacement-only semantics: the orchestrator preserves
                // the initial Accepted set as an invariant; the repair
                // pass can only ADD scenarios. Repair input is the
                // quarantined list as JSON-encoded diagnostic data
                // (not free-text instructions — see SECURITY.md §3 A1).
                if (config.EnableRepairLoop
                    && zr.RepairAttempts < ComputeMaxRepairPasses(config.ReachableSlotCount)
                    && zr.Quarantined.Count > 0
                    && !isBudgetTripped()
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
                                config.Validation);

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
                });
            }
            return items;
        }

        private async Task<(EdogQaLlmClient.LlmClientResult repairResult, EdogQaScenarioValidator.ValidationResult validation, bool dispatched)> RunSingleScenarioEscalationAsync(
            OrchestratorConfig config,
            EdogQaLlmClient.ArchitectPlan plan,
            EdogQaLlmClient.ZoneContext zoneCtx,
            List<EdogQaScenarioValidator.QuarantinedScenario> quarantined,
            string unifiedDiff,
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
                config.Validation);
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
        }
    }
}
