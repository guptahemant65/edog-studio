// <copyright file="AnalyzerHarness.cs" company="Microsoft">
// Copyright (c) Microsoft Corporation. All rights reserved.
// </copyright>
//
// F27 P3 - Analyzer pipeline harness.
//
// Wires EdogQaCodeAnalyzer up with fake providers, runs against the
// pr-baseline diff fixture, and emits a JSON summary to stdout for the
// pytest wrapper to assert on. Returns exit code 0 always (even on
// "no scenarios" outcomes) - pytest decides pass/fail from the JSON.

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

    internal static class AnalyzerHarness
    {
        public static async Task<int> RunAsync(CancellationToken ct)
        {
            var diff = FixtureScenarios.ReadPrDiffFixture();
            var prContext = FixtureScenarios.InsightsBaselinePrContext();
            var goldenScenarios = FixtureScenarios.InsightsBaselineGolden();

            var analyzer = new EdogQaCodeAnalyzer(
                new FakeGraphProvider(),
                new FakeOmniSharpProvider(),
                new FakeLlmProvider(goldenScenarios),
                new FakeDiRegistryProvider(),
                onProgress: null);

            AnalysisResult result;
            try
            {
                result = await analyzer.AnalyzeAsync(diff, prContext, ct);
            }
            catch (Exception ex)
            {
                EmitJson(new
                {
                    harness = "analyzer",
                    ok = false,
                    error = $"{ex.GetType().Name}: {ex.Message}",
                    stackTrace = ex.StackTrace,
                });
                return 0;
            }

            EmitJson(BuildSummary(result));
            return 0;
        }

        internal static object BuildSummary(AnalysisResult result)
        {
            return new
            {
                harness = "analyzer",
                ok = true,
                totalDurationMs = result.TotalDurationMs,
                impactZoneCount = result.ImpactZones?.Count ?? 0,
                scenarioCount = result.Scenarios?.Count ?? 0,
                scenarioIds = (result.Scenarios ?? new List<Scenario>())
                    .Select(s => s.Id)
                    .ToList(),
                generatedByValues = (result.Scenarios ?? new List<Scenario>())
                    .Select(s => s.Metadata?.GeneratedBy ?? "<null>")
                    .Distinct()
                    .ToList(),
                degradationFlags = result.DegradationFlags ?? new List<string>(),
                lintFindingCount = result.LintFindings?.Count ?? 0,
                lintErrorCount = (result.LintFindings ?? new List<LintFinding>())
                    .Count(f => f.Severity == LintSeverity.Error),
                hasGraphNodes = (result.Graph?.Nodes?.Count ?? 0) > 0,
                invariantCount = 0, // populated separately via prContext if needed
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
