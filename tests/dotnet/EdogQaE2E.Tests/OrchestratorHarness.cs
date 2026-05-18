// SPDX-License-Identifier: MIT
// F27 P9 T1c-b — behavioural harness for EdogQaScenarioOrchestrator.
//
// Drives the orchestrator via the ArchitectOverride/EditorOverride
// delegate seams so no HTTP traffic happens. The 19 cases cover:
//   1.  happy_single_zone                — one zone → one merged scenario
//   2.  happy_multi_zone                 — three zones → three merged
//   3.  cross_zone_dedup                 — two zones same hash → 1 win + 1 dup
//   4.  dedup_winner_is_first_zone       — winner deterministic by index
//   5.  architect_no_testable_changes    — outcome=NoTestableChanges
//   6.  architect_failure_isolation      — sibling zones still succeed
//   7.  editor_failure_isolation         — sibling zones still succeed
//   8.  projector_rejects_winner         — winner has malformed stimulus
//   9.  bounded_concurrency_le_3         — 6 zones, observed max ≤ 3
//   10. budget_cost_exceeded             — cost cap trips, later zones skipped
//   11. budget_time_exceeded             — deadline trips, later zones skipped
//   12. progress_events_emitted          — Started + Completed + Batch
//   13. cancellation_throws_oce          — external CT → OperationCanceledException
//   14. repair_skipped_when_no_quarantine — happy path, RepairAttempts=0
//   15. repair_replaces_quarantined      — Branch B fixes 1 quarantined → final 2
//   16. repair_parse_fail_then_succeeds  — Branch A recovers Editor parse failure
//   17. repair_parse_fail_then_also_fails — Branch A repair fails → zone Failed
//   18. repair_skipped_when_budget_tripped — sibling tripped budget → no repair
//   19. repair_throws_fallback_to_initial — Branch B repair throws → initial preserved
//
// Determinism: every case uses a fixed configuration; outputs are
// JSON-serialised under HARNESS-JSON-BEGIN/END so pytest can assert
// exact field values. Where ordering may vary (event lists), each case
// reports a SORTED view in addition to the raw count.

namespace Microsoft.LiveTable.Service.DevMode.E2ETests
{
    using System;
    using System.Collections.Generic;
    using System.Diagnostics;
    using System.Linq;
    using System.Net.Http;
    using System.Text.Json;
    using System.Threading;
    using System.Threading.Tasks;
    using Microsoft.LiveTable.Service.DevMode;

    internal static class OrchestratorHarness
    {
        private const string CanonicalDiff =
            "--- a/src/Foo.cs\n" +
            "+++ b/src/Foo.cs\n" +
            "@@ -10,4 +10,6 @@\n" +
            " public class Foo\n" +
            " {\n" +
            "-    public int Bar() => 1;\n" +
            "+    public int Bar() => 2;\n" +
            "+\n" +
            "+    public int Baz() => 3;\n" +
            " }\n";

        private const int RightLine13 = 13;
        private const string SamplePath = "src/Foo.cs";

        private static readonly List<string> StubTopics = new()
        {
            "http", "token", "flag", "perf", "spark", "log",
            "telemetry", "retry", "cache", "fileop", "catalog",
            "dag", "flt-ops", "nexus", "di", "capacity",
        };

        public static async Task<int> RunAsync(CancellationToken ct)
        {
            var cases = new List<object>
            {
                await RunHappySingleZone(ct).ConfigureAwait(false),
                await RunHappyMultiZone(ct).ConfigureAwait(false),
                await RunCrossZoneDedup(ct).ConfigureAwait(false),
                await RunDedupWinnerIsFirstZone(ct).ConfigureAwait(false),
                await RunArchitectNoTestableChanges(ct).ConfigureAwait(false),
                await RunArchitectFailureIsolation(ct).ConfigureAwait(false),
                await RunEditorFailureIsolation(ct).ConfigureAwait(false),
                await RunProjectorRejectsWinner(ct).ConfigureAwait(false),
                await RunBoundedConcurrency(ct).ConfigureAwait(false),
                await RunBudgetCostExceeded(ct).ConfigureAwait(false),
                await RunBudgetTimeExceeded(ct).ConfigureAwait(false),
                await RunProgressEventsEmitted(ct).ConfigureAwait(false),
                await RunCancellationThrowsOce(ct).ConfigureAwait(false),
                await RunRepairSkippedWhenNoQuarantine(ct).ConfigureAwait(false),
                await RunRepairReplacesQuarantined(ct).ConfigureAwait(false),
                await RunRepairParseFailThenSucceeds(ct).ConfigureAwait(false),
                await RunRepairParseFailThenAlsoFails(ct).ConfigureAwait(false),
                await RunRepairSkippedWhenBudgetTripped(ct).ConfigureAwait(false),
                await RunRepairThrowsFallbackToInitial(ct).ConfigureAwait(false),
            };

            EmitJson(new
            {
                ok = true,
                harness = "orchestrator",
                cases,
            });
            return 0;
        }

        // ─── Cases ────────────────────────────────────────────────────

        private static async Task<object> RunHappySingleZone(CancellationToken ct)
        {
            var zone = ZoneInput("z-0");
            var (architect, editor) = StubStages(zone, scenarioId: "sk-1");

            var result = await RunOrchestratorAsync(
                zones: new[] { zone },
                architectOverride: architect,
                editorOverride: editor,
                ct: ct).ConfigureAwait(false);

            return CaseSummary("happy_single_zone", result);
        }

        private static async Task<object> RunHappyMultiZone(CancellationToken ct)
        {
            var z0 = ZoneInput("z-0");
            var z1 = ZoneInput("z-1");
            var z2 = ZoneInput("z-2");
            var stagesByZone = new Dictionary<string, (EdogQaScenarioOrchestrator.ArchitectStageDelegate a, EdogQaScenarioOrchestrator.EditorStageDelegate e)>
            {
                ["z-0"] = StubStages(z0, scenarioId: "sk-0", methodName: "Baz0"),
                ["z-1"] = StubStages(z1, scenarioId: "sk-1", methodName: "Baz1"),
                ["z-2"] = StubStages(z2, scenarioId: "sk-2", methodName: "Baz2"),
            };

            var result = await RunOrchestratorAsync(
                zones: new[] { z0, z1, z2 },
                architectOverride: (zctx, c) => stagesByZone[zctx.ZoneId].a(zctx, c),
                editorOverride: (plan, zctx, c) => stagesByZone[zctx.ZoneId].e(plan, zctx, c),
                ct: ct).ConfigureAwait(false);

            return CaseSummary("happy_multi_zone", result);
        }

        private static async Task<object> RunCrossZoneDedup(CancellationToken ct)
        {
            // Both zones produce a scenario with identical (StimulusType +
            // StimulusSpec + Expectations), so the Validator hash collides
            // and the orchestrator's cross-zone dedup kicks in.
            var z0 = ZoneInput("z-0");
            var z1 = ZoneInput("z-1");
            var stagesByZone = new Dictionary<string, (EdogQaScenarioOrchestrator.ArchitectStageDelegate a, EdogQaScenarioOrchestrator.EditorStageDelegate e)>
            {
                ["z-0"] = StubStages(z0, scenarioId: "sk-dup"),
                ["z-1"] = StubStages(z1, scenarioId: "sk-dup"),
            };

            var result = await RunOrchestratorAsync(
                zones: new[] { z0, z1 },
                architectOverride: (zctx, c) => stagesByZone[zctx.ZoneId].a(zctx, c),
                editorOverride: (plan, zctx, c) => stagesByZone[zctx.ZoneId].e(plan, zctx, c),
                ct: ct).ConfigureAwait(false);

            return new
            {
                caseId = "cross_zone_dedup",
                mergedScenarioCount = result.MergedScenarios.Count,
                duplicateCount = result.Duplicates.Count,
                winnerZoneIds = result.Duplicates.Select(d => d.WinnerZoneId).OrderBy(s => s, StringComparer.Ordinal).ToList(),
                loserZoneIds = result.Duplicates.Select(d => d.LoserZoneId).OrderBy(s => s, StringComparer.Ordinal).ToList(),
                zoneOutcomes = result.Zones.Select(z => new { z.ZoneId, outcome = z.Outcome.ToString() }).ToList(),
            };
        }

        private static async Task<object> RunDedupWinnerIsFirstZone(CancellationToken ct)
        {
            // Same as cross_zone_dedup but with a deliberate completion-
            // order inversion: z-1 finishes BEFORE z-0. The winner must
            // still be z-0 because dedup is sorted by ZoneInputIndex, not
            // by completion order.
            var z0 = ZoneInput("z-0");
            var z1 = ZoneInput("z-1");
            var z0Slow = WithDelay(StubStages(z0, scenarioId: "sk-dup"), architectDelay: TimeSpan.FromMilliseconds(60));
            var z1Fast = StubStages(z1, scenarioId: "sk-dup");
            var stagesByZone = new Dictionary<string, (EdogQaScenarioOrchestrator.ArchitectStageDelegate a, EdogQaScenarioOrchestrator.EditorStageDelegate e)>
            {
                ["z-0"] = z0Slow,
                ["z-1"] = z1Fast,
            };

            var result = await RunOrchestratorAsync(
                zones: new[] { z0, z1 },
                architectOverride: (zctx, c) => stagesByZone[zctx.ZoneId].a(zctx, c),
                editorOverride: (plan, zctx, c) => stagesByZone[zctx.ZoneId].e(plan, zctx, c),
                ct: ct).ConfigureAwait(false);

            return new
            {
                caseId = "dedup_winner_is_first_zone",
                mergedScenarioCount = result.MergedScenarios.Count,
                duplicateCount = result.Duplicates.Count,
                duplicateWinnerZoneId = result.Duplicates.FirstOrDefault()?.WinnerZoneId,
                duplicateLoserZoneId = result.Duplicates.FirstOrDefault()?.LoserZoneId,
            };
        }

        private static async Task<object> RunArchitectNoTestableChanges(CancellationToken ct)
        {
            var zone = ZoneInput("z-0");
            EdogQaScenarioOrchestrator.ArchitectStageDelegate architect = (zctx, c) =>
                Task.FromResult(new EdogQaLlmClient.LlmClientResult
                {
                    Status = EdogQaLlmClient.LlmClientStatus.NoTestableChanges,
                    Plan = new EdogQaLlmClient.ArchitectPlan
                    {
                        ZoneId = zctx.ZoneId,
                        ZoneSummary = "no behaviour to test",
                        PlanOutcome = EdogQaLlmClient.PlanOutcomeNoTestableChanges,
                    },
                    ArchitectElapsedMs = 5,
                    ArchitectInputTokens = 100,
                    ArchitectOutputTokens = 20,
                });
            EdogQaScenarioOrchestrator.EditorStageDelegate editor = (plan, zctx, c) =>
                throw new InvalidOperationException("Editor must not be called when Architect returns NoTestableChanges.");

            var result = await RunOrchestratorAsync(
                zones: new[] { zone },
                architectOverride: architect,
                editorOverride: editor,
                ct: ct).ConfigureAwait(false);

            return new
            {
                caseId = "architect_no_testable_changes",
                zoneOutcome = result.Zones[0].Outcome.ToString(),
                zoneOutcomeReason = result.Zones[0].OutcomeReason,
                mergedScenarioCount = result.MergedScenarios.Count,
            };
        }

        private static async Task<object> RunArchitectFailureIsolation(CancellationToken ct)
        {
            var z0 = ZoneInput("z-0");
            var z1 = ZoneInput("z-1");
            EdogQaScenarioOrchestrator.ArchitectStageDelegate architect = (zctx, c) =>
            {
                if (zctx.ZoneId == "z-0")
                {
                    return Task.FromResult(new EdogQaLlmClient.LlmClientResult
                    {
                        Status = EdogQaLlmClient.LlmClientStatus.Failed,
                        Errors = new List<string> { EdogQaLlmClient.ErrorCodeArchitectNetworkError + " — HTTP 503. body" },
                        ArchitectElapsedMs = 5,
                        ArchitectInputTokens = 100,
                        ArchitectOutputTokens = 0,
                    });
                }
                return StubArchitectFor(zctx);
            };
            EdogQaScenarioOrchestrator.EditorStageDelegate editor = (plan, zctx, c) => StubEditorFor(plan, zctx, scenarioId: "sk-" + zctx.ZoneId);

            var result = await RunOrchestratorAsync(
                zones: new[] { z0, z1 },
                architectOverride: architect,
                editorOverride: editor,
                ct: ct).ConfigureAwait(false);

            return new
            {
                caseId = "architect_failure_isolation",
                z0Outcome = result.Zones.First(z => z.ZoneId == "z-0").Outcome.ToString(),
                z0Reason = result.Zones.First(z => z.ZoneId == "z-0").OutcomeReason,
                z1Outcome = result.Zones.First(z => z.ZoneId == "z-1").Outcome.ToString(),
                mergedScenarioCount = result.MergedScenarios.Count,
            };
        }

        private static async Task<object> RunEditorFailureIsolation(CancellationToken ct)
        {
            var z0 = ZoneInput("z-0");
            var z1 = ZoneInput("z-1");
            EdogQaScenarioOrchestrator.ArchitectStageDelegate architect = (zctx, c) => StubArchitectFor(zctx);
            EdogQaScenarioOrchestrator.EditorStageDelegate editor = (plan, zctx, c) =>
            {
                if (zctx.ZoneId == "z-0")
                {
                    return Task.FromResult(new EdogQaLlmClient.LlmClientResult
                    {
                        Status = EdogQaLlmClient.LlmClientStatus.Failed,
                        Errors = new List<string> { EdogQaLlmClient.ErrorCodeEditorSchemaViolation + " — strict schema rejected output" },
                        EditorElapsedMs = 5,
                        EditorInputTokens = 50,
                        EditorOutputTokens = 0,
                    });
                }
                return StubEditorFor(plan, zctx, scenarioId: "sk-" + zctx.ZoneId);
            };

            var result = await RunOrchestratorAsync(
                zones: new[] { z0, z1 },
                architectOverride: architect,
                editorOverride: editor,
                ct: ct).ConfigureAwait(false);

            return new
            {
                caseId = "editor_failure_isolation",
                z0Outcome = result.Zones.First(z => z.ZoneId == "z-0").Outcome.ToString(),
                z0Reason = result.Zones.First(z => z.ZoneId == "z-0").OutcomeReason,
                z1Outcome = result.Zones.First(z => z.ZoneId == "z-1").Outcome.ToString(),
                mergedScenarioCount = result.MergedScenarios.Count,
            };
        }

        private static async Task<object> RunProjectorRejectsWinner(CancellationToken ct)
        {
            // Editor produces a scenario whose StimulusSpec is missing the
            // required `path` field for HttpRequest. Validator accepts it
            // (the validator treats specs as opaque); the Projector
            // rejects it.
            var z0 = ZoneInput("z-0");
            EdogQaScenarioOrchestrator.ArchitectStageDelegate architect = (zctx, c) => StubArchitectFor(zctx);
            EdogQaScenarioOrchestrator.EditorStageDelegate editor = (plan, zctx, c) =>
            {
                var scen = BuildValidScenario(refs: new List<string> { "ev-1" }, sketchId: "sk-bad");
                scen.StimulusType = "HttpRequest";
                scen.StimulusSpec = "{\"method\":\"GET\"}"; // missing `path` → projector rejects
                return Task.FromResult(new EdogQaLlmClient.LlmClientResult
                {
                    Status = EdogQaLlmClient.LlmClientStatus.Ok,
                    Plan = plan,
                    Scenarios = new List<EdogQaLlmClient.GeneratedScenario> { scen },
                    EditorElapsedMs = 5,
                    EditorInputTokens = 50,
                    EditorOutputTokens = 60,
                });
            };

            var result = await RunOrchestratorAsync(
                zones: new[] { z0 },
                architectOverride: architect,
                editorOverride: editor,
                ct: ct).ConfigureAwait(false);

            return new
            {
                caseId = "projector_rejects_winner",
                zoneOutcome = result.Zones[0].Outcome.ToString(),
                zoneAcceptedCount = result.Zones[0].Accepted.Count,
                mergedScenarioCount = result.MergedScenarios.Count,
                projectionRejectedCount = result.ProjectionRejected.Count,
                projectionRejectedCodes = result.ProjectionRejected
                    .SelectMany(q => q.Reasons.Select(r => r.Code))
                    .OrderBy(s => s, StringComparer.Ordinal).ToList(),
            };
        }

        private static async Task<object> RunBoundedConcurrency(CancellationToken ct)
        {
            // Six zones. Architect delegate increments a shared counter on
            // entry and decrements on exit, recording the max observed.
            // With MaxConcurrentZones=3 the observed max must be ≤ 3.
            var concurrent = 0;
            var maxObserved = 0;
            var gate = new object();

            EdogQaScenarioOrchestrator.ArchitectStageDelegate architect = async (zctx, c) =>
            {
                lock (gate)
                {
                    concurrent++;
                    if (concurrent > maxObserved) maxObserved = concurrent;
                }
                try
                {
                    await Task.Delay(30, c).ConfigureAwait(false);
                    return await StubArchitectFor(zctx).ConfigureAwait(false);
                }
                finally
                {
                    lock (gate) { concurrent--; }
                }
            };
            EdogQaScenarioOrchestrator.EditorStageDelegate editor = (plan, zctx, c) => StubEditorFor(plan, zctx, scenarioId: "sk-" + zctx.ZoneId);

            var zones = Enumerable.Range(0, 6).Select(i => ZoneInput("z-" + i)).ToArray();
            var result = await RunOrchestratorAsync(
                zones: zones,
                architectOverride: architect,
                editorOverride: editor,
                maxConcurrent: 3,
                ct: ct).ConfigureAwait(false);

            return new
            {
                caseId = "bounded_concurrency_le_3",
                maxConcurrentZones = 3,
                observedMaxConcurrent = maxObserved,
                completedZoneCount = result.Zones.Count(z => z.Outcome == EdogQaScenarioOrchestrator.ZoneOutcome.Completed),
            };
        }

        private static async Task<object> RunBudgetCostExceeded(CancellationToken ct)
        {
            // Pricing: high per-token rate so a single zone exceeds the
            // tiny cap. Three zones submitted; the first one to complete
            // pushes accumulated cost over the cap; later-arriving zones
            // are skipped with BUDGET_EXCEEDED_COST.
            //
            // Architect delegate stalls (Task.Delay) so the cost-trip
            // window is observable. Zone 0 has no delay; zones 1+2 wait,
            // see budget tripped post-semaphore, and skip.
            var zones = new[] { ZoneInput("z-0"), ZoneInput("z-1"), ZoneInput("z-2") };

            EdogQaScenarioOrchestrator.ArchitectStageDelegate architect = async (zctx, c) =>
            {
                if (zctx.ZoneId != "z-0") await Task.Delay(60, c).ConfigureAwait(false);
                return await StubArchitectFor(zctx).ConfigureAwait(false);
            };
            EdogQaScenarioOrchestrator.EditorStageDelegate editor = (plan, zctx, c) => StubEditorFor(plan, zctx, scenarioId: "sk-" + zctx.ZoneId);

            // Aggressive pricing so a single zone produces > $1e-6 cost.
            var pricing = new EdogQaScenarioOrchestrator.PricingTable
            {
                Architect = new() { InputPerThousand = 100.0, OutputPerThousand = 100.0, ReasoningPerThousand = 100.0 },
                Editor = new() { InputPerThousand = 100.0, OutputPerThousand = 100.0, ReasoningPerThousand = 100.0 },
                Source = "BudgetCostTest",
            };

            var result = await RunOrchestratorAsync(
                zones: zones,
                architectOverride: architect,
                editorOverride: editor,
                maxConcurrent: 1,           // serialize so zone-0 finishes before zone-1 starts
                pricing: pricing,
                maxBudgetUsd: 0.0001,         // very tight
                ct: ct).ConfigureAwait(false);

            return new
            {
                caseId = "budget_cost_exceeded",
                budgetGateTripped = result.BudgetGateTripped,
                budgetGateReason = result.BudgetGateReason,
                z0Outcome = result.Zones.First(z => z.ZoneId == "z-0").Outcome.ToString(),
                skippedCount = result.Zones.Count(z => z.Outcome == EdogQaScenarioOrchestrator.ZoneOutcome.SkippedForBudget),
                skippedReasonsSorted = result.Zones
                    .Where(z => z.Outcome == EdogQaScenarioOrchestrator.ZoneOutcome.SkippedForBudget)
                    .Select(z => z.OutcomeReason)
                    .OrderBy(s => s, StringComparer.Ordinal).ToList(),
            };
        }

        private static async Task<object> RunBudgetTimeExceeded(CancellationToken ct)
        {
            // MaxBudgetSeconds=1; per-zone delay 700ms; concurrency 1. Zone
            // 0 finishes well within deadline; by the time zone 1 acquires
            // the semaphore, deadline has passed → SkippedForBudget with
            // BUDGET_EXCEEDED_TIME. Same for zone 2.
            var zones = new[] { ZoneInput("z-0"), ZoneInput("z-1"), ZoneInput("z-2") };
            EdogQaScenarioOrchestrator.ArchitectStageDelegate architect = async (zctx, c) =>
            {
                await Task.Delay(700, c).ConfigureAwait(false);
                return await StubArchitectFor(zctx).ConfigureAwait(false);
            };
            EdogQaScenarioOrchestrator.EditorStageDelegate editor = (plan, zctx, c) => StubEditorFor(plan, zctx, scenarioId: "sk-" + zctx.ZoneId);

            var result = await RunOrchestratorAsync(
                zones: zones,
                architectOverride: architect,
                editorOverride: editor,
                maxConcurrent: 1,
                maxBudgetSeconds: 1,
                maxBudgetUsd: 1000.0, // disabled
                ct: ct).ConfigureAwait(false);

            return new
            {
                caseId = "budget_time_exceeded",
                budgetGateTripped = result.BudgetGateTripped,
                budgetGateReason = result.BudgetGateReason,
                completedCount = result.Zones.Count(z => z.Outcome == EdogQaScenarioOrchestrator.ZoneOutcome.Completed),
                skippedCount = result.Zones.Count(z => z.Outcome == EdogQaScenarioOrchestrator.ZoneOutcome.SkippedForBudget),
                skippedReasonsSorted = result.Zones
                    .Where(z => z.Outcome == EdogQaScenarioOrchestrator.ZoneOutcome.SkippedForBudget)
                    .Select(z => z.OutcomeReason)
                    .OrderBy(s => s, StringComparer.Ordinal).ToList(),
            };
        }

        private static async Task<object> RunProgressEventsEmitted(CancellationToken ct)
        {
            var zone = ZoneInput("z-0");
            var (architect, editor) = StubStages(zone, scenarioId: "sk-1");

            var events = new List<EdogQaScenarioOrchestrator.OrchestratorEvent>();
            var progress = new SimpleProgress<EdogQaScenarioOrchestrator.OrchestratorEvent>(ev =>
            {
                lock (events) events.Add(ev);
            });

            await RunOrchestratorAsync(
                zones: new[] { zone },
                architectOverride: architect,
                editorOverride: editor,
                progress: progress,
                ct: ct).ConfigureAwait(false);

            var kinds = events.Select(e => e.Kind.ToString()).ToList();
            return new
            {
                caseId = "progress_events_emitted",
                eventCount = events.Count,
                kindsInOrder = kinds,
                hasZoneStarted = kinds.Contains("ZoneStarted"),
                hasZoneArchitectCompleted = kinds.Contains("ZoneArchitectCompleted"),
                hasZoneEditorCompleted = kinds.Contains("ZoneEditorCompleted"),
                hasZoneValidated = kinds.Contains("ZoneValidated"),
                hasZoneCompleted = kinds.Contains("ZoneCompleted"),
                hasCrossZoneDedupCompleted = kinds.Contains("CrossZoneDedupCompleted"),
                hasBatchCompleted = kinds.Contains("BatchCompleted"),
                lastKind = kinds.Count > 0 ? kinds[kinds.Count - 1] : null,
            };
        }

        private static async Task<object> RunCancellationThrowsOce(CancellationToken outerCt)
        {
            // Local CTS we'll cancel mid-run.
            var cts = CancellationTokenSource.CreateLinkedTokenSource(outerCt);
            var zone = ZoneInput("z-0");

            EdogQaScenarioOrchestrator.ArchitectStageDelegate architect = async (zctx, c) =>
            {
                cts.Cancel();
                await Task.Delay(50, c).ConfigureAwait(false);
                return await StubArchitectFor(zctx).ConfigureAwait(false);
            };
            EdogQaScenarioOrchestrator.EditorStageDelegate editor = (plan, zctx, c) => StubEditorFor(plan, zctx, scenarioId: "sk-1");

            bool threwOce = false;
            try
            {
                await RunOrchestratorAsync(
                    zones: new[] { zone },
                    architectOverride: architect,
                    editorOverride: editor,
                    ct: cts.Token).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                threwOce = true;
            }
            catch (Exception ex)
            {
                return new { caseId = "cancellation_throws_oce", threwOce = false, otherException = ex.GetType().Name };
            }

            return new
            {
                caseId = "cancellation_throws_oce",
                threwOce,
            };
        }

        // ─── T1e: Editor repair-loop cases ────────────────────────────

        private static async Task<object> RunRepairSkippedWhenNoQuarantine(CancellationToken ct)
        {
            var zone = ZoneInput("z-0");
            var (architect, editor) = StubStages(zone, scenarioId: "sk-1");

            // Repair delegate must not be invoked when nothing is quarantined.
            EdogQaScenarioOrchestrator.EditorRepairStageDelegate repair = (plan, zctx, fb, c) =>
                throw new InvalidOperationException("Repair must not fire when there is no quarantine.");

            var result = await RunOrchestratorAsync(
                zones: new[] { zone },
                architectOverride: architect,
                editorOverride: editor,
                editorRepairOverride: repair,
                ct: ct).ConfigureAwait(false);

            var z = result.Zones[0];
            return new
            {
                caseId = "repair_skipped_when_no_quarantine",
                outcome = z.Outcome.ToString(),
                repairAttempts = z.RepairAttempts,
                repairBranch = z.RepairBranch,
                acceptedCount = z.Accepted.Count,
                quarantinedCount = z.Quarantined.Count,
                mergedScenarioCount = result.MergedScenarios.Count,
            };
        }

        private static async Task<object> RunRepairReplacesQuarantined(CancellationToken ct)
        {
            // Initial Editor: 1 valid scenario (ev-1) + 1 quarantined (ev-unknown).
            // Repair Editor: 1 replacement scenario (ev-2) with a distinct stimulus
            // (different method name) so its SemanticHash differs from the initial.
            var zone = ZoneInput("z-0");

            EdogQaScenarioOrchestrator.ArchitectStageDelegate architect = (zctx, c) =>
                Task.FromResult(BuildPlanResult(zctx, new[] { "ev-1", "ev-2" }));

            EdogQaScenarioOrchestrator.EditorStageDelegate editor = (plan, zctx, c) =>
                Task.FromResult(new EdogQaLlmClient.LlmClientResult
                {
                    Status = EdogQaLlmClient.LlmClientStatus.Ok,
                    Plan = plan,
                    Scenarios = new List<EdogQaLlmClient.GeneratedScenario>
                    {
                        BuildValidScenario(refs: new List<string> { "ev-1" }, sketchId: "sk-good", methodName: "Baz"),
                        BuildValidScenario(refs: new List<string> { "ev-unknown" }, sketchId: "sk-bad", methodName: "BazBad"),
                    },
                    EditorElapsedMs = 5,
                    EditorInputTokens = 100,
                    EditorOutputTokens = 80,
                });

            EdogQaScenarioOrchestrator.EditorRepairStageDelegate repair = (plan, zctx, fb, c) =>
                Task.FromResult(new EdogQaLlmClient.LlmClientResult
                {
                    Status = EdogQaLlmClient.LlmClientStatus.Ok,
                    Plan = plan,
                    Scenarios = new List<EdogQaLlmClient.GeneratedScenario>
                    {
                        BuildValidScenario(refs: new List<string> { "ev-2" }, sketchId: "sk-repair", methodName: "BazRepaired"),
                    },
                    EditorElapsedMs = 5,
                    EditorInputTokens = 60,
                    EditorOutputTokens = 40,
                });

            var result = await RunOrchestratorAsync(
                zones: new[] { zone },
                architectOverride: architect,
                editorOverride: editor,
                editorRepairOverride: repair,
                ct: ct).ConfigureAwait(false);

            var z = result.Zones[0];
            return new
            {
                caseId = "repair_replaces_quarantined",
                outcome = z.Outcome.ToString(),
                repairAttempts = z.RepairAttempts,
                repairBranch = z.RepairBranch,
                initialAccepted = z.InitialAcceptedCount,
                initialQuarantined = z.InitialQuarantinedCount,
                repairAccepted = z.RepairAcceptedCount,
                repairQuarantined = z.RepairQuarantinedCount,
                repairInputTokens = z.RepairInputTokens,
                repairOutputTokens = z.RepairOutputTokens,
                finalAccepted = z.Accepted.Count,
                finalQuarantined = z.Quarantined.Count,
                mergedScenarioCount = result.MergedScenarios.Count,
                mergedIdsSorted = result.MergedScenarios.Select(s => s.Id).OrderBy(s => s, StringComparer.Ordinal).ToList(),
                repairFailureCode = z.RepairFailureCode,
            };
        }

        private static async Task<object> RunRepairParseFailThenSucceeds(CancellationToken ct)
        {
            var zone = ZoneInput("z-0");
            EdogQaScenarioOrchestrator.ArchitectStageDelegate architect = (zctx, c) =>
                Task.FromResult(BuildPlanResult(zctx, new[] { "ev-1" }));

            // Initial Editor pass fails (parse / schema / binding).
            EdogQaScenarioOrchestrator.EditorStageDelegate editor = (plan, zctx, c) =>
                Task.FromResult(new EdogQaLlmClient.LlmClientResult
                {
                    Status = EdogQaLlmClient.LlmClientStatus.Failed,
                    Plan = plan,
                    Errors = new List<string> { "EDITOR_RESPONSE_UNPARSEABLE — invalid JSON envelope" },
                    EditorElapsedMs = 5,
                    EditorInputTokens = 100,
                    EditorOutputTokens = 0,
                });

            // Repair recovers with a valid scenario.
            EdogQaScenarioOrchestrator.EditorRepairStageDelegate repair = (plan, zctx, fb, c) =>
                Task.FromResult(new EdogQaLlmClient.LlmClientResult
                {
                    Status = EdogQaLlmClient.LlmClientStatus.Ok,
                    Plan = plan,
                    Scenarios = new List<EdogQaLlmClient.GeneratedScenario>
                    {
                        BuildValidScenario(refs: new List<string> { "ev-1" }, sketchId: "sk-recovered", methodName: "Baz"),
                    },
                    EditorElapsedMs = 5,
                    EditorInputTokens = 50,
                    EditorOutputTokens = 40,
                });

            var result = await RunOrchestratorAsync(
                zones: new[] { zone },
                architectOverride: architect,
                editorOverride: editor,
                editorRepairOverride: repair,
                ct: ct).ConfigureAwait(false);

            var z = result.Zones[0];
            return new
            {
                caseId = "repair_parse_fail_then_succeeds",
                outcome = z.Outcome.ToString(),
                repairAttempts = z.RepairAttempts,
                repairBranch = z.RepairBranch,
                repairFailureCode = z.RepairFailureCode,
                finalAccepted = z.Accepted.Count,
                mergedScenarioCount = result.MergedScenarios.Count,
            };
        }

        private static async Task<object> RunRepairParseFailThenAlsoFails(CancellationToken ct)
        {
            var zone = ZoneInput("z-0");
            EdogQaScenarioOrchestrator.ArchitectStageDelegate architect = (zctx, c) =>
                Task.FromResult(BuildPlanResult(zctx, new[] { "ev-1" }));

            EdogQaScenarioOrchestrator.EditorStageDelegate editor = (plan, zctx, c) =>
                Task.FromResult(new EdogQaLlmClient.LlmClientResult
                {
                    Status = EdogQaLlmClient.LlmClientStatus.Failed,
                    Plan = plan,
                    Errors = new List<string> { "EDITOR_RESPONSE_UNPARSEABLE — initial pass broke" },
                    EditorElapsedMs = 5,
                    EditorInputTokens = 100,
                    EditorOutputTokens = 0,
                });

            EdogQaScenarioOrchestrator.EditorRepairStageDelegate repair = (plan, zctx, fb, c) =>
                Task.FromResult(new EdogQaLlmClient.LlmClientResult
                {
                    Status = EdogQaLlmClient.LlmClientStatus.Failed,
                    Plan = plan,
                    Errors = new List<string> { "EDITOR_SCHEMA_VIOLATION — repair also broke" },
                    EditorElapsedMs = 5,
                    EditorInputTokens = 50,
                    EditorOutputTokens = 0,
                });

            var result = await RunOrchestratorAsync(
                zones: new[] { zone },
                architectOverride: architect,
                editorOverride: editor,
                editorRepairOverride: repair,
                ct: ct).ConfigureAwait(false);

            var z = result.Zones[0];
            return new
            {
                caseId = "repair_parse_fail_then_also_fails",
                outcome = z.Outcome.ToString(),
                outcomeReason = z.OutcomeReason,
                repairAttempts = z.RepairAttempts,
                repairBranch = z.RepairBranch,
                repairFailureCode = z.RepairFailureCode,
                finalAccepted = z.Accepted.Count,
            };
        }

        private static async Task<object> RunRepairSkippedWhenBudgetTripped(CancellationToken ct)
        {
            // Two zones. Zone-0 finishes fast and trips the cost budget at
            // its Completed AccumulateDelta call (no quarantine → no repair
            // attempt of its own). Zone-1 is delayed so by the time it
            // reaches its Branch B check the budget is already tripped →
            // repair must be skipped; zone-1 still completes with the
            // initial Accepted set preserved.
            var z0 = ZoneInput("z-0");
            var z1 = ZoneInput("z-1");

            EdogQaScenarioOrchestrator.ArchitectStageDelegate architect = async (zctx, c) =>
            {
                if (zctx.ZoneId == "z-1")
                {
                    // Delay long enough that z-0 completes first.
                    await Task.Delay(120, c).ConfigureAwait(false);
                }
                return BuildPlanResult(zctx, new[] { "ev-1", "ev-2" }, archInputTokens: zctx.ZoneId == "z-0" ? 5_000_000 : 200);
            };

            EdogQaScenarioOrchestrator.EditorStageDelegate editor = (plan, zctx, c) =>
            {
                if (zctx.ZoneId == "z-0")
                {
                    // Single accepted scenario, no quarantine → no Branch B.
                    return Task.FromResult(new EdogQaLlmClient.LlmClientResult
                    {
                        Status = EdogQaLlmClient.LlmClientStatus.Ok,
                        Plan = plan,
                        Scenarios = new List<EdogQaLlmClient.GeneratedScenario>
                        {
                            BuildValidScenario(refs: new List<string> { "ev-1" }, sketchId: "sk-z0", methodName: "BazZ0"),
                        },
                        EditorElapsedMs = 5,
                        EditorInputTokens = 100,
                        EditorOutputTokens = 80,
                    });
                }
                // z-1: 1 accepted + 1 quarantined → would normally trigger
                // Branch B, but the budget will be tripped by z-0 first.
                return Task.FromResult(new EdogQaLlmClient.LlmClientResult
                {
                    Status = EdogQaLlmClient.LlmClientStatus.Ok,
                    Plan = plan,
                    Scenarios = new List<EdogQaLlmClient.GeneratedScenario>
                    {
                        BuildValidScenario(refs: new List<string> { "ev-1" }, sketchId: "sk-z1-good", methodName: "BazZ1"),
                        BuildValidScenario(refs: new List<string> { "ev-unknown" }, sketchId: "sk-z1-bad", methodName: "BazZ1Bad"),
                    },
                    EditorElapsedMs = 5,
                    EditorInputTokens = 100,
                    EditorOutputTokens = 80,
                });
            };

            int repairCallCount = 0;
            EdogQaScenarioOrchestrator.EditorRepairStageDelegate repair = (plan, zctx, fb, c) =>
            {
                System.Threading.Interlocked.Increment(ref repairCallCount);
                return Task.FromResult(new EdogQaLlmClient.LlmClientResult
                {
                    Status = EdogQaLlmClient.LlmClientStatus.Ok,
                    Plan = plan,
                    Scenarios = new List<EdogQaLlmClient.GeneratedScenario>(),
                });
            };

            // Use Architect rate ≈ $0.01 per 1K input tokens so 5M tokens ≈ $50 cost,
            // well above the 0.01 cap below.
            var pricing = new EdogQaScenarioOrchestrator.PricingTable
            {
                Architect = new EdogQaScenarioOrchestrator.DeploymentPricing
                {
                    InputPerThousand = 0.01,
                    OutputPerThousand = 0.01,
                    ReasoningPerThousand = 0.01,
                },
                Editor = new EdogQaScenarioOrchestrator.DeploymentPricing
                {
                    InputPerThousand = 0.001,
                    OutputPerThousand = 0.001,
                    ReasoningPerThousand = 0.001,
                },
                Source = "test_repair_budget_skip",
            };

            var result = await RunOrchestratorAsync(
                zones: new[] { z0, z1 },
                architectOverride: architect,
                editorOverride: editor,
                editorRepairOverride: repair,
                maxConcurrent: 2,
                pricing: pricing,
                maxBudgetUsd: 0.01,
                ct: ct).ConfigureAwait(false);

            var zResults = result.Zones.OrderBy(z => z.ZoneInputIndex).ToList();
            var z1Result = zResults.FirstOrDefault(z => z.ZoneId == "z-1");
            return new
            {
                caseId = "repair_skipped_when_budget_tripped",
                budgetGateTripped = result.BudgetGateTripped,
                budgetGateReason = result.BudgetGateReason,
                z1Outcome = z1Result?.Outcome.ToString(),
                z1RepairAttempts = z1Result?.RepairAttempts ?? -1,
                z1RepairBranch = z1Result?.RepairBranch,
                z1InitialAccepted = z1Result?.InitialAcceptedCount ?? -1,
                z1FinalAccepted = z1Result?.Accepted.Count ?? -1,
                repairCallCount,
            };
        }

        private static async Task<object> RunRepairThrowsFallbackToInitial(CancellationToken ct)
        {
            var zone = ZoneInput("z-0");
            EdogQaScenarioOrchestrator.ArchitectStageDelegate architect = (zctx, c) =>
                Task.FromResult(BuildPlanResult(zctx, new[] { "ev-1" }));

            EdogQaScenarioOrchestrator.EditorStageDelegate editor = (plan, zctx, c) =>
                Task.FromResult(new EdogQaLlmClient.LlmClientResult
                {
                    Status = EdogQaLlmClient.LlmClientStatus.Ok,
                    Plan = plan,
                    Scenarios = new List<EdogQaLlmClient.GeneratedScenario>
                    {
                        BuildValidScenario(refs: new List<string> { "ev-1" }, sketchId: "sk-keep", methodName: "Baz"),
                        BuildValidScenario(refs: new List<string> { "ev-unknown" }, sketchId: "sk-drop", methodName: "BazDrop"),
                    },
                    EditorElapsedMs = 5,
                    EditorInputTokens = 100,
                    EditorOutputTokens = 80,
                });

            // Repair delegate throws — orchestrator must absorb, preserve
            // initial Accepted, complete the zone, and surface the failure
            // code on the ZoneResult.
            EdogQaScenarioOrchestrator.EditorRepairStageDelegate repair = (plan, zctx, fb, c) =>
                throw new InvalidOperationException("simulated repair failure");

            var result = await RunOrchestratorAsync(
                zones: new[] { zone },
                architectOverride: architect,
                editorOverride: editor,
                editorRepairOverride: repair,
                ct: ct).ConfigureAwait(false);

            var z = result.Zones[0];
            return new
            {
                caseId = "repair_throws_fallback_to_initial",
                outcome = z.Outcome.ToString(),
                repairAttempts = z.RepairAttempts,
                repairBranch = z.RepairBranch,
                repairFailureCode = z.RepairFailureCode,
                initialAccepted = z.InitialAcceptedCount,
                initialQuarantined = z.InitialQuarantinedCount,
                finalAccepted = z.Accepted.Count,
                mergedScenarioCount = result.MergedScenarios.Count,
            };
        }

        // ─── Runner ───────────────────────────────────────────────────

        private static async Task<EdogQaScenarioOrchestrator.OrchestratorResult> RunOrchestratorAsync(
            IReadOnlyList<EdogQaScenarioOrchestrator.ZoneInput> zones,
            EdogQaScenarioOrchestrator.ArchitectStageDelegate architectOverride,
            EdogQaScenarioOrchestrator.EditorStageDelegate editorOverride,
            int maxConcurrent = 3,
            EdogQaScenarioOrchestrator.PricingTable pricing = null,
            double maxBudgetUsd = 1000.0,
            int maxBudgetSeconds = 600,
            IProgress<EdogQaScenarioOrchestrator.OrchestratorEvent> progress = null,
            EdogQaScenarioOrchestrator.EditorRepairStageDelegate editorRepairOverride = null,
            bool enableRepairLoop = true,
            CancellationToken ct = default)
        {
            var orch = new EdogQaScenarioOrchestrator(new HttpClient());
            var config = new EdogQaScenarioOrchestrator.OrchestratorConfig
            {
                MaxConcurrentZones = maxConcurrent,
                MaxBudgetUsd = maxBudgetUsd,
                MaxBudgetSeconds = maxBudgetSeconds,
                Validation = new EdogQaScenarioValidator.ValidationContext { ValidTopics = StubTopics },
                Pricing = pricing ?? EdogQaScenarioOrchestrator.PricingTable.DefaultPlaceholder(),
                ArchitectOverride = architectOverride,
                EditorOverride = editorOverride,
                EditorRepairOverride = editorRepairOverride,
                EnableRepairLoop = enableRepairLoop,
            };
            return await orch.RunAsync(zones, config, progress, ct).ConfigureAwait(false);
        }

        // ─── Stub stage delegates ─────────────────────────────────────

        private static (EdogQaScenarioOrchestrator.ArchitectStageDelegate, EdogQaScenarioOrchestrator.EditorStageDelegate) StubStages(
            EdogQaScenarioOrchestrator.ZoneInput zone, string scenarioId, string methodName = "Baz")
        {
            EdogQaScenarioOrchestrator.ArchitectStageDelegate architect = (zctx, c) => StubArchitectFor(zctx);
            EdogQaScenarioOrchestrator.EditorStageDelegate editor = (plan, zctx, c) => StubEditorFor(plan, zctx, scenarioId, methodName);
            return (architect, editor);
        }

        private static (EdogQaScenarioOrchestrator.ArchitectStageDelegate, EdogQaScenarioOrchestrator.EditorStageDelegate) WithDelay(
            (EdogQaScenarioOrchestrator.ArchitectStageDelegate a, EdogQaScenarioOrchestrator.EditorStageDelegate e) stages,
            TimeSpan architectDelay)
        {
            EdogQaScenarioOrchestrator.ArchitectStageDelegate slow = async (zctx, c) =>
            {
                await Task.Delay(architectDelay, c).ConfigureAwait(false);
                return await stages.a(zctx, c).ConfigureAwait(false);
            };
            return (slow, stages.e);
        }

        private static Task<EdogQaLlmClient.LlmClientResult> StubArchitectFor(EdogQaLlmClient.ZoneContext zctx)
        {
            return Task.FromResult(BuildPlanResult(zctx, new[] { "ev-1" }));
        }

        /// <summary>
        /// T1e helper: build an Architect <see cref="EdogQaLlmClient.LlmClientResult"/>
        /// for the canonical diff with the supplied evidence IDs. All
        /// evidence points at line 13 on the right side so the validator's
        /// grounding-line gate is satisfied for refs in this set.
        /// </summary>
        private static EdogQaLlmClient.LlmClientResult BuildPlanResult(
            EdogQaLlmClient.ZoneContext zctx,
            IEnumerable<string> evidenceIds,
            int archInputTokens = 200,
            int archOutputTokens = 100,
            int archReasoningTokens = 50)
        {
            var evidence = new List<EdogQaLlmClient.ArchitectGroundingEvidence>();
            foreach (var id in evidenceIds ?? Array.Empty<string>())
            {
                evidence.Add(new EdogQaLlmClient.ArchitectGroundingEvidence
                {
                    EvidenceId = id,
                    RepoRelativePath = SamplePath,
                    Side = "right",
                    BaseSha = "abc",
                    HunkId = "h-1",
                    NewLine = RightLine13,
                    Excerpt = "Baz() => 3",
                    Reason = "added behaviour (" + id + ")",
                });
            }
            var plan = new EdogQaLlmClient.ArchitectPlan
            {
                ZoneId = zctx.ZoneId,
                ZoneSummary = "stub plan",
                PlanOutcome = EdogQaLlmClient.PlanOutcomeTestable,
                GroundingEvidence = evidence,
                BehavioralChanges = new List<EdogQaLlmClient.BehavioralChange>(),
                ScenarioSketches = new List<EdogQaLlmClient.ScenarioSketch>(),
            };
            return new EdogQaLlmClient.LlmClientResult
            {
                Status = EdogQaLlmClient.LlmClientStatus.Ok,
                Plan = plan,
                ArchitectElapsedMs = 5,
                ArchitectInputTokens = archInputTokens,
                ArchitectOutputTokens = archOutputTokens,
                ArchitectReasoningTokens = archReasoningTokens,
            };
        }

        private static Task<EdogQaLlmClient.LlmClientResult> StubEditorFor(
            EdogQaLlmClient.ArchitectPlan plan, EdogQaLlmClient.ZoneContext zctx, string scenarioId, string methodName = "Baz")
        {
            var scen = BuildValidScenario(refs: new List<string> { "ev-1" }, sketchId: scenarioId, methodName: methodName);
            return Task.FromResult(new EdogQaLlmClient.LlmClientResult
            {
                Status = EdogQaLlmClient.LlmClientStatus.Ok,
                Plan = plan,
                Scenarios = new List<EdogQaLlmClient.GeneratedScenario> { scen },
                EditorElapsedMs = 5,
                EditorInputTokens = 100,
                EditorOutputTokens = 80,
            });
        }

        // ─── Builders ─────────────────────────────────────────────────

        private static EdogQaScenarioOrchestrator.ZoneInput ZoneInput(string zoneId) => new()
        {
            ZoneId = zoneId,
            ZoneSummary = "summary for " + zoneId,
            RedactedDiff = CanonicalDiff,
            UnifiedDiff = CanonicalDiff,
            BaseSha = "base",
            HeadSha = "head",
        };

        private static EdogQaLlmClient.GeneratedScenario BuildValidScenario(List<string> refs, string sketchId, string methodName = "Baz")
        {
            return new EdogQaLlmClient.GeneratedScenario
            {
                Id = sketchId,
                Title = "Baz returns 3 on initial call",
                Description = "When Baz is invoked it must return 3 for a freshly constructed Foo.",
                Category = "HappyPath",
                Priority = 2,
                ImpactZone = "zone-001",
                Technique = "EquivalencePartition",
                StimulusType = "DirectInvoke",
                StimulusSpec = "{\"serviceType\":\"IFoo\",\"method\":\"" + methodName + "\",\"args\":[]}",
                Expectations = new List<EdogQaLlmClient.GeneratedExpectation>
                {
                    new EdogQaLlmClient.GeneratedExpectation
                    {
                        Type = "FieldMatch",
                        Topic = "log",
                        MatcherSpec = "{\"exact\":{\"returnValue\":3}}",
                        Rationale = "Direct return value must be 3.",
                    },
                },
                TimeoutMs = 5_000,
                GroundingEvidenceRefs = refs,
                Confidence = 0.85,
            };
        }

        // ─── Helpers ──────────────────────────────────────────────────

        private static object CaseSummary(string caseId, EdogQaScenarioOrchestrator.OrchestratorResult r)
        {
            return new
            {
                caseId,
                mergedScenarioCount = r.MergedScenarios.Count,
                duplicateCount = r.Duplicates.Count,
                projectionRejectedCount = r.ProjectionRejected.Count,
                zoneCount = r.Zones.Count,
                completedZoneCount = r.Zones.Count(z => z.Outcome == EdogQaScenarioOrchestrator.ZoneOutcome.Completed),
                budgetGateTripped = r.BudgetGateTripped,
                budgetGateReason = r.BudgetGateReason,
                pricingSource = r.PricingSource,
                mergedScenarioIdsSorted = r.MergedScenarios.Select(s => s.Id).OrderBy(s => s, StringComparer.Ordinal).ToList(),
                zoneOutcomes = r.Zones.Select(z => new { z.ZoneId, outcome = z.Outcome.ToString(), z.OutcomeReason }).ToList(),
            };
        }

        private static void EmitJson(object payload)
        {
            Console.WriteLine("---HARNESS-JSON-BEGIN---");
            Console.WriteLine(JsonSerializer.Serialize(payload, new JsonSerializerOptions
            {
                WriteIndented = true,
                DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.Never,
            }));
            Console.WriteLine("---HARNESS-JSON-END---");
        }

        private sealed class SimpleProgress<T> : IProgress<T>
        {
            private readonly Action<T> _handler;

            public SimpleProgress(Action<T> handler) { _handler = handler; }

            public void Report(T value) => _handler(value);
        }
    }
}
