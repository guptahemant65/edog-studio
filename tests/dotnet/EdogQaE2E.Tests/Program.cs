// <copyright file="Program.cs" company="Microsoft">
// Copyright (c) Microsoft Corporation. All rights reserved.
// </copyright>
//
// F27 P3 - Entry point for the E2E harness binary.
//
// Usage: dotnet run -- <subcommand>
//   analyze    - Run the analyzer pipeline against the pr-baseline fixture.
//   aggregate  - Run the aggregator against canned mixed-verdict results.
//   compose    - Run analyzer to aggregator, asserting no scenario IDs drift.
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
                Console.Error.WriteLine("usage: <harness-exe> {analyze|aggregate|compose}");
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
