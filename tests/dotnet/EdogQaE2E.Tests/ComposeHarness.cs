// <copyright file="ComposeHarness.cs" company="Microsoft">
// Copyright (c) Microsoft Corporation. All rights reserved.
// </copyright>
//
// F27 P3 - Analyzer to Aggregator compose harness.
//
// Runs the analyzer with fake providers, then synthesizes a passing
// ScenarioResult per produced Scenario and feeds them into the aggregator.
// Emits the chain summary so pytest can assert that no scenario IDs are
// dropped or renamed between the two stages - this is the "the 5 stages
// compose" guard requested by the F27 P3 plan.

#nullable disable

namespace Microsoft.LiveTable.Service.DevMode.E2ETests
{
    using System;
    using System.Collections.Generic;
    using System.Linq;
    using System.Text.Json;
    using System.Threading;
    using System.Threading.Tasks;
    using Microsoft.LiveTable.Service.DevMode;

    internal static class ComposeHarness
    {
        public static async Task<int> RunAsync(CancellationToken ct)
        {
            // Hermetic harness — pin EDOG_QA_LLM_V2=off so the new Auto
            // default doesn't add llm_v2_fallback_to_legacy to the analyzer
            // degradation flags (the V2 probe never starts in this context).
            Environment.SetEnvironmentVariable("EDOG_QA_LLM_V2", "off");

            var diff = FixtureScenarios.ReadPrDiffFixture();
            var prContext = FixtureScenarios.InsightsBaselinePrContext();
            var goldenScenarios = FixtureScenarios.InsightsBaselineGolden();

            var analyzer = new EdogQaCodeAnalyzer(
                new FakeGraphProvider(),
                new FakeOmniSharpProvider(),
                new FakeLlmProvider(goldenScenarios),
                new FakeDiRegistryProvider(),
                onProgress: null);

            AnalysisResult analysis;
            try
            {
                analysis = await analyzer.AnalyzeAsync(diff, prContext, ct);
            }
            catch (Exception ex)
            {
                EmitJson(new
                {
                    harness = "compose",
                    ok = false,
                    stage = "analyze",
                    error = $"{ex.GetType().Name}: {ex.Message}",
                });
                return 0;
            }

            var context = new QaRunContext
            {
                PrId = 999_001,
                PrTitle = prContext.Title,
                PrUrl = "https://dev.azure.com/test/_git/test/pullrequest/999001",
                UnobservablePaths = new List<string>(),
            };
            var aggregator = new EdogQaResultAggregator("run-p3-compose", context);

            var t0 = DateTimeOffset.UtcNow;
            foreach (var s in analysis.Scenarios ?? new List<Scenario>())
            {
                aggregator.AddScenarioResult(new ScenarioResult
                {
                    ScenarioId = s.Id,
                    Title = s.Title,
                    Category = s.Category.ToString(),
                    Verdict = ScenarioVerdict.Passed,
                    DurationMs = 750,
                    StartedAt = t0,
                    CompletedAt = t0.AddMilliseconds(750),
                    EventsCaptured = 3,
                    Expectations = new List<ExpectationResult>(),
                    CapturedEvents = new List<TopicEvent>(),
                });
                t0 = t0.AddMilliseconds(750);
            }

            var runResult = aggregator.GetRunResult();

            // The compose proof: every analyzer-produced ID must show up in
            // the aggregator's run result, and the aggregator must not invent
            // IDs that the analyzer never produced.
            var analyzerIds = (analysis.Scenarios ?? new List<Scenario>())
                .Select(s => s.Id)
                .OrderBy(x => x)
                .ToList();
            var aggregatorIds = runResult.Scenarios
                .Select(s => s.ScenarioId)
                .OrderBy(x => x)
                .ToList();

            EmitJson(new
            {
                harness = "compose",
                ok = true,
                analyzerScenarioCount = analyzerIds.Count,
                aggregatorScenarioCount = aggregatorIds.Count,
                analyzerIds,
                aggregatorIds,
                idsMatch = analyzerIds.SequenceEqual(aggregatorIds),
                analyzerDegradationFlags = analysis.DegradationFlags ?? new List<string>(),
                aggregatorVerdictAllPassed = runResult.Summary.Failed == 0
                                          && runResult.Summary.Skipped == 0
                                          && runResult.Summary.Passed == aggregatorIds.Count,
                summaryPassed = runResult.Summary.Passed,
                summaryFailed = runResult.Summary.Failed,
                summarySkipped = runResult.Summary.Skipped,
            });
            return 0;
        }

        private static readonly JsonSerializerOptions JsonOptions = new()
        {
            WriteIndented = true,
        };

        private static void EmitJson(object payload)
        {
            Console.Out.WriteLine("---HARNESS-JSON-BEGIN---");
            Console.Out.WriteLine(JsonSerializer.Serialize(payload, JsonOptions));
            Console.Out.WriteLine("---HARNESS-JSON-END---");
        }
    }
}
