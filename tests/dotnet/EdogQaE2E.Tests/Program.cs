// <copyright file="Program.cs" company="Microsoft">
// Copyright (c) Microsoft Corporation. All rights reserved.
// </copyright>
//
// F27 P3 - Entry point for the E2E harness binary.
//
// Usage: dotnet run -- <subcommand>
//   analyze            - Run the analyzer pipeline against the pr-baseline fixture.
//   aggregate          - Run the aggregator against canned mixed-verdict results.
//   compose            - Run analyzer to aggregator, asserting no scenario IDs drift.
//   classify-llm       - F27 P4: pin LlmProviderExceptionClassifier matrix.
//   fallback-policy    - F27 P4: pin QaAnalysisFallbackPolicy env-gate + tagging.
//   pipeline-chaos     - F27 P5: behavioural HTTP chaos pipeline.
//   history-store      - F27 P7: durability + restart of EdogQaRunStore.
//   capability-probe   - F27 P9 T1a: real Azure OpenAI capability probe.
//   llm-client         - F27 P9 T1b: Architect/Editor LLM client behavioural matrix.
//   validator          - F27 P9 T1c-a: scenario validator behavioural matrix.
//   projector          - F27 P9 T1c-a-2: V2-to-engine scenario projector matrix.
//
// Each subcommand emits a single JSON block delimited by HARNESS-JSON-BEGIN
// / HARNESS-JSON-END markers on stdout. The pytest wrapper parses those.

#nullable disable

namespace Microsoft.LiveTable.Service.DevMode.E2ETests
{
    using System;
    using System.Threading;
    using System.Threading.Tasks;

    internal static class Program
    {
        public static async Task<int> Main(string[] args)
        {
            if (args.Length == 0)
            {
                Console.Error.WriteLine("usage: <harness-exe> {analyze|aggregate|compose|classify-llm|fallback-policy|pipeline-chaos|history-store|capability-probe|llm-client|validator|projector}");
                return 2;
            }

            using var cts = new CancellationTokenSource(TimeSpan.FromMinutes(2));
            try
            {
                return args[0] switch
                {
                    "analyze" => await AnalyzerHarness.RunAsync(cts.Token),
                    "aggregate" => await AggregatorHarness.RunAsync(),
                    "compose" => await ComposeHarness.RunAsync(cts.Token),
                    "classify-llm" => await LlmClassifyHarness.RunAsync(),
                    "fallback-policy" => await FallbackPolicyHarness.RunAsync(),
                    "pipeline-chaos" => await PipelineChaosHarness.RunAsync(cts.Token),
                    "history-store" => await QaHistoryStoreHarness.RunAsync(cts.Token),
                    "capability-probe" => await CapabilityProbeHarness.RunAsync(cts.Token),
                    "llm-client" => await LlmClientHarness.RunAsync(cts.Token),
                    "validator" => await ValidatorHarness.RunAsync(cts.Token),
                    "projector" => await ProjectorHarness.RunAsync(cts.Token),
                    _ => Fail($"unknown subcommand: {args[0]}"),
                };
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"FATAL: {ex.GetType().Name}: {ex.Message}");
                Console.Error.WriteLine(ex.StackTrace);
                return 1;
            }
        }

        private static int Fail(string message)
        {
            Console.Error.WriteLine(message);
            return 2;
        }
    }
}
