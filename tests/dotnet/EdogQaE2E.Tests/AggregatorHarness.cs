// <copyright file="AggregatorHarness.cs" company="Microsoft">
// Copyright (c) Microsoft Corporation. All rights reserved.
// </copyright>
//
// F27 P3 - Aggregator verdict harness.
//
// Feeds a canned ScenarioResult set (mixed pass + fail + skipped) into
// EdogQaResultAggregator and emits the produced RunResult summary to stdout.
// Pytest asserts on the summary counts + verdict.

#nullable disable

namespace Microsoft.LiveTable.Service.DevMode.E2ETests
{
    using System;
    using System.Collections.Generic;
    using System.Text.Json;
    using System.Threading.Tasks;
    using Microsoft.LiveTable.Service.DevMode;

    internal static class AggregatorHarness
    {
        public static Task<int> RunAsync()
        {
            var context = new QaRunContext
            {
                PrId = 999_001,
                PrTitle = "P3 fixture - mixed verdict aggregation",
                PrUrl = "https://dev.azure.com/test/_git/test/pullrequest/999001",
                UnobservablePaths = new List<string>(),
            };

            var aggregator = new EdogQaResultAggregator("run-p3-fixture", context);

            // Two passes, one fail, one skip - exercises the verdict-rollup logic.
            var t0 = new DateTimeOffset(2026, 5, 17, 12, 0, 0, TimeSpan.Zero);
            aggregator.AddScenarioResult(MakeResult("scn-a", "Happy path", ScenarioVerdict.Passed, t0, 1200));
            aggregator.AddScenarioResult(MakeResult("scn-b", "Boundary negative", ScenarioVerdict.Passed, t0.AddMilliseconds(1300), 1500));
            aggregator.AddScenarioResult(MakeResult("scn-c", "Error path", ScenarioVerdict.Failed, t0.AddMilliseconds(2900), 800));
            aggregator.AddScenarioResult(MakeResult("scn-d", "Slow path", ScenarioVerdict.Skipped, t0.AddMilliseconds(3800), 0));

            var runResult = aggregator.GetRunResult();
            var prComment = aggregator.FormatPrComment();
            var junit = aggregator.ExportJunitXml();

            EmitJson(new
            {
                harness = "aggregator",
                ok = true,
                runId = runResult.RunId,
                prId = runResult.PrId,
                totalScenarios = runResult.Scenarios.Count,
                summaryPassed = runResult.Summary.Passed,
                summaryFailed = runResult.Summary.Failed,
                summarySkipped = runResult.Summary.Skipped,
                summaryTotal = runResult.Summary.Total,
                totalDurationMs = runResult.TotalDurationMs,
                slowestScenarioId = runResult.Performance.SlowestScenarioId,
                slowestScenarioMs = runResult.Performance.SlowestScenarioMs,
                prCommentLength = prComment?.Length ?? 0,
                prCommentContainsRunId = prComment?.Contains(runResult.RunId) ?? false,
                junitLength = junit?.Length ?? 0,
                junitContainsTestcase = junit?.Contains("<testcase") ?? false,
            });
            return Task.FromResult(0);
        }

        private static ScenarioResult MakeResult(
            string id,
            string title,
            ScenarioVerdict verdict,
            DateTimeOffset startedAt,
            long durationMs)
        {
            return new ScenarioResult
            {
                ScenarioId = id,
                Title = title,
                Category = ScenarioCategory.HappyPath.ToString(),
                Verdict = verdict,
                DurationMs = durationMs,
                StartedAt = startedAt,
                CompletedAt = startedAt.AddMilliseconds(durationMs),
                EventsCaptured = verdict == ScenarioVerdict.Skipped ? 0 : 5,
                Expectations = new List<ExpectationResult>(),
                CapturedEvents = new List<TopicEvent>(),
                ErrorMessage = verdict == ScenarioVerdict.Failed ? "Expected HTTP 201, observed HTTP 500" : null,
            };
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
