// <copyright file="FallbackPolicyHarness.cs" company="Microsoft">
// Copyright (c) Microsoft Corporation. All rights reserved.
// </copyright>
//
// F27 P4 - Demo-fallback policy gate harness.
//
// Pins:
//   1. QaAnalysisFallbackPolicy.IsDemoFallbackEnabled() returns true only
//      when EDOG_QA_DEMO_FALLBACK == "1" exactly (no "true", "yes", etc).
//   2. TagAsDemo() mutates a scenario list in-place to prefix titles with
//      "[DEMO] " and set metadata.generatedBy to "demo_synthetic".
//   3. TagAsDemo() is idempotent — calling it twice does not produce
//      "[DEMO] [DEMO] " titles.

#nullable disable

namespace Microsoft.LiveTable.Service.DevMode.E2ETests
{
    using System;
    using System.Collections.Generic;
    using System.Text.Json;
    using System.Threading.Tasks;
    using Microsoft.LiveTable.Service.DevMode;

    internal static class FallbackPolicyHarness
    {
        public static Task<int> RunAsync()
        {
            // Probe the env gate against a controlled set of values.
            var envCases = new List<object>();
            foreach (var (label, value) in new[]
            {
                ("unset", (string)null),
                ("empty", string.Empty),
                ("zero", "0"),
                ("one", "1"),
                ("true_string", "true"),
                ("yes_string", "yes"),
                ("uppercase_one", "1 "),   // trailing whitespace — must be off
            })
            {
                Environment.SetEnvironmentVariable(QaAnalysisFallbackPolicy.DemoFallbackEnvVar, value);
                envCases.Add(new
                {
                    label,
                    value,
                    enabled = QaAnalysisFallbackPolicy.IsDemoFallbackEnabled(),
                });
            }

            // Reset to off so the harness leaves no residue.
            Environment.SetEnvironmentVariable(QaAnalysisFallbackPolicy.DemoFallbackEnvVar, null);

            // Tagging behaviour: titles get prefixed; generatedBy is rewritten.
            var raw = new List<Scenario>
            {
                MakeScenario("scn-a", "Happy path"),
                MakeScenario("scn-b", "Error path"),
            };
            QaAnalysisFallbackPolicy.TagAsDemo(raw);

            // Second call — must be idempotent.
            QaAnalysisFallbackPolicy.TagAsDemo(raw);

            // Tag a null list — should not throw.
            QaAnalysisFallbackPolicy.TagAsDemo(null);

            // Tag a list with a null entry — should skip it.
            var mixed = new List<Scenario> { null, MakeScenario("scn-c", "Edge case") };
            QaAnalysisFallbackPolicy.TagAsDemo(mixed);

            EmitJson(new
            {
                ok = true,
                harness = "fallback-policy",
                envVarName = QaAnalysisFallbackPolicy.DemoFallbackEnvVar,
                expectedGeneratedBy = QaAnalysisFallbackPolicy.DemoGeneratedBy,
                expectedTitlePrefix = QaAnalysisFallbackPolicy.DemoTitlePrefix,
                envCases,
                tagged = new
                {
                    titles = raw.ConvertAll(s => s.Title),
                    generatedBy = raw.ConvertAll(s => s.Metadata?.GeneratedBy),
                    doublePrefixed = raw.Exists(s => s.Title?.StartsWith("[DEMO] [DEMO] ") ?? false),
                },
                mixedTagged = new
                {
                    titles = mixed.ConvertAll(s => s?.Title),
                    skippedNullEntry = mixed[0] == null,
                },
            });

            return Task.FromResult(0);
        }

        private static Scenario MakeScenario(string id, string title)
        {
            return new Scenario
            {
                Id = id,
                Title = title,
                Description = $"desc {id}",
                Category = ScenarioCategory.HappyPath,
                Priority = 3,
                TimeoutMs = 1000,
                ImpactZone = "test-zone",
                Metadata = new ScenarioMetadata { GeneratedBy = "ai" },
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
