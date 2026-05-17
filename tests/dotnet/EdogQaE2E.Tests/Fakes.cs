// <copyright file="Fakes.cs" company="Microsoft">
// Copyright (c) Microsoft Corporation. All rights reserved.
// </copyright>
//
// F27 P3 - Test doubles for the QA Code Analyzer's four provider interfaces.
// All four return deterministic, empty-but-valid data so the analyzer treats
// them as "ran fine, found nothing exotic" rather than emitting degradation
// flags. The single exception is FakeLlmProvider, which returns a canned
// scenario set that mirrors what the production LLM is expected to produce
// for the pr-baseline fixture (the 60-day strict-date PR).
//
// IMPORTANT: These classes must NOT be named StubGraphProvider /
// StubOmniSharpProvider / StubLlmProvider - the analyzer does a runtime
// `is StubXxxProvider` check and would set degradation flags. Hence Fake*.

#nullable disable

namespace Microsoft.LiveTable.Service.DevMode.E2ETests
{
    using System;
    using System.Collections.Generic;
    using System.IO;
    using System.Threading;
    using System.Threading.Tasks;
    using Microsoft.LiveTable.Service.DevMode;

    /// <summary>
    /// Returns a minimal valid CodeGraph echoing the changed symbols as nodes.
    /// </summary>
    internal sealed class FakeGraphProvider : IGraphProvider
    {
        public Task<CodeGraph> BuildStructuralGraphAsync(
            List<ChangedSymbol> changedSymbols,
            int maxDepth = 4,
            CancellationToken cancellationToken = default)
        {
            var graph = new CodeGraph();
            foreach (var sym in changedSymbols ?? new List<ChangedSymbol>())
            {
                var nodeId = $"{sym.File}:{sym.Method}";
                graph.AddNode(new GraphNode
                {
                    Id = nodeId,
                    File = sym.File,
                    Method = sym.Method,
                    NodeType = "method",
                    IsChanged = true,
                    Community = "community-0",
                });
                graph.Communities[nodeId] = "community-0";
            }
            return Task.FromResult(graph);
        }
    }

    /// <summary>
    /// Reports ready; performs no-op enrichment so the analyzer treats L3
    /// as having run cleanly.
    /// </summary>
    internal sealed class FakeOmniSharpProvider : IOmniSharpProvider
    {
        public bool IsReady => true;

        public Task WarmUpAsync(string solutionPath, CancellationToken cancellationToken = default) =>
            Task.CompletedTask;

        public Task EnrichGraphAsync(
            CodeGraph graph,
            List<ChangedSymbol> changedSymbols,
            int maxConcurrentQueries = 4,
            CancellationToken cancellationToken = default) => Task.CompletedTask;

        public Task<List<string>> FindImplementationsAsync(
            string interfaceType,
            CancellationToken cancellationToken = default) =>
            Task.FromResult(new List<string>());

        public Task<List<CallerInfo>> GetIncomingCallsAsync(
            string filePath,
            string methodName,
            int maxDepth = 4,
            CancellationToken cancellationToken = default) =>
            Task.FromResult(new List<CallerInfo>());
    }

    /// <summary>
    /// Reports available with an empty DI registry. The analyzer treats this
    /// as "L5 ran, found no relevant registrations" rather than degrading.
    /// </summary>
    internal sealed class FakeDiRegistryProvider : IDiRegistryProvider
    {
        public bool IsAvailable => true;

        public void LoadSnapshot()
        {
            // No-op: empty registry.
        }

        public DiRegistration Resolve(string interfaceType) => null;

        public List<DiRegistration> GetAll() => new();

        public InterfaceValidation ValidateMapping(string interfaceType, string inferredImpl) =>
            new InterfaceValidation
            {
                Status = "unregistered",
                ConfidenceDelta = 0.0,
                Note = "Fake test double - empty DI registry.",
            };
    }

    /// <summary>
    /// Returns the canned scenario set for the pr-baseline fixture. Per the
    /// analyzer's design, this is called once PER impact zone, so we return
    /// the same set for every zone in this single-zone fixture.
    /// </summary>
    internal sealed class FakeLlmProvider : ILlmProvider
    {
        private readonly List<Scenario> _scenarios;

        public FakeLlmProvider(List<Scenario> scenarios)
        {
            _scenarios = scenarios ?? new List<Scenario>();
        }

        public Task<List<Scenario>> GenerateScenariosAsync(
            LlmPromptRequest request,
            CancellationToken cancellationToken = default)
        {
            // Stamp the zone id so the analyzer's per-zone wiring is exercised.
            var stamped = new List<Scenario>(_scenarios.Count);
            foreach (var s in _scenarios)
            {
                stamped.Add(CloneWithZone(s, request?.Zone?.ZoneId ?? "zone-001"));
            }
            return Task.FromResult(stamped);
        }

        private static Scenario CloneWithZone(Scenario src, string zoneId)
        {
            return new Scenario
            {
                Id = src.Id,
                Title = src.Title,
                Description = src.Description,
                Category = src.Category,
                Priority = src.Priority,
                ImpactZone = zoneId,
                Lifecycle = src.Lifecycle,
                Setup = src.Setup,
                Stimulus = src.Stimulus,
                Expectations = src.Expectations,
                Teardown = src.Teardown,
                TimeoutMs = src.TimeoutMs,
                Metadata = src.Metadata,
                Technique = src.Technique,
                InvariantsAddressed = src.InvariantsAddressed,
                GroundingEvidence = src.GroundingEvidence,
            };
        }
    }

    // ──────────────────────────────────────────────────────────────────
    // Canned scenario fixtures used by both the analyzer-pipeline harness
    // and the compose harness. Kept in C# (rather than parsed from JSON
    // at runtime) so the fixture deliberately exercises every property
    // that downstream stages depend on - if a model rename breaks the
    // build, the test build fails fast.
    // ──────────────────────────────────────────────────────────────────

    internal static class FixtureScenarios
    {
        public static List<Scenario> InsightsBaselineGolden()
        {
            var generatedAt = new DateTimeOffset(2026, 5, 17, 12, 0, 0, TimeSpan.Zero);

            return new List<Scenario>
            {
                new Scenario
                {
                    Id = "scn-insights-range-within-60d-pass",
                    Title = "GET /range with 30-day window returns 200",
                    Description = "Within the 60-day strict contract, the endpoint must succeed.",
                    Category = ScenarioCategory.HappyPath,
                    Priority = 2,
                    ImpactZone = "zone-001",
                    Lifecycle = ScenarioLifecycle.Generated,
                    TimeoutMs = 30_000,
                    Stimulus = new Stimulus
                    {
                        Type = StimulusType.HttpRequest,
                        HttpRequest = new HttpRequestSpec
                        {
                            Method = "GET",
                            Path = "/api/insights/range?startTime=2025-04-01T00:00:00Z&endTime=2025-05-01T00:00:00Z",
                        },
                    },
                    Expectations = new List<Expectation>
                    {
                        new Expectation
                        {
                            Id = "exp-001",
                            Type = ExpectationType.EventPresent,
                            Topic = "http",
                            Description = "HTTP 200 returned",
                            Matcher = new Matcher
                            {
                                Exact = new Dictionary<string, object> { ["statusCode"] = 200 },
                            },
                        },
                    },
                    Metadata = new ScenarioMetadata
                    {
                        GeneratedBy = "ai",
                        Confidence = 0.92,
                        RelatedPRFiles = new List<string>
                        {
                            "Service/Microsoft.LiveTable.Service/Controllers/LiveTableInsightsController.cs",
                        },
                        Tags = new List<string> { "happy-path", "insights" },
                        SchemaVersion = 2,
                        GeneratedAt = generatedAt,
                    },
                    Technique = ScenarioTechnique.BoundaryTriplet,
                    InvariantsAddressed = new List<string> { "inv-numeric_constant-deadbe" },
                    GroundingEvidence = new List<GroundingEvidence>
                    {
                        new GroundingEvidence
                        {
                            File = "Service/Microsoft.LiveTable.Service/Controllers/LiveTableInsightsController.cs",
                            StartLine = 21,
                            EndLine = 27,
                            Reason = "Validates MaxStrictDateRangeDays=60 guard does not trigger for in-range requests.",
                        },
                    },
                },
                new Scenario
                {
                    Id = "scn-insights-range-exceed-60d-reject",
                    Title = "GET /range with 61-day window returns 400",
                    Description = "Just over the 60-day cap must return HTTP 400.",
                    Category = ScenarioCategory.ErrorPath,
                    Priority = 1,
                    ImpactZone = "zone-001",
                    Lifecycle = ScenarioLifecycle.Generated,
                    TimeoutMs = 30_000,
                    Stimulus = new Stimulus
                    {
                        Type = StimulusType.HttpRequest,
                        HttpRequest = new HttpRequestSpec
                        {
                            Method = "GET",
                            Path = "/api/insights/range?startTime=2025-03-01T00:00:00Z&endTime=2025-05-01T00:00:01Z",
                        },
                    },
                    Expectations = new List<Expectation>
                    {
                        new Expectation
                        {
                            Id = "exp-002",
                            Type = ExpectationType.EventPresent,
                            Topic = "http",
                            Description = "HTTP 400 returned with cap message",
                            Matcher = new Matcher
                            {
                                Exact = new Dictionary<string, object> { ["statusCode"] = 400 },
                            },
                        },
                    },
                    Metadata = new ScenarioMetadata
                    {
                        GeneratedBy = "ai",
                        Confidence = 0.94,
                        RelatedPRFiles = new List<string>
                        {
                            "Service/Microsoft.LiveTable.Service/Controllers/LiveTableInsightsController.cs",
                        },
                        Tags = new List<string> { "boundary", "negative", "insights" },
                        SchemaVersion = 2,
                        GeneratedAt = generatedAt,
                    },
                    Technique = ScenarioTechnique.BoundaryTriplet,
                    InvariantsAddressed = new List<string> { "inv-numeric_constant-deadbe" },
                    GroundingEvidence = new List<GroundingEvidence>
                    {
                        new GroundingEvidence
                        {
                            File = "Service/Microsoft.LiveTable.Service/Controllers/LiveTableInsightsController.cs",
                            StartLine = 21,
                            EndLine = 27,
                            Reason = "Validates MaxStrictDateRangeDays=60 boundary rejects (endTime - startTime) > 60 days.",
                        },
                    },
                },
                new Scenario
                {
                    Id = "scn-insights-range-exactly-60d-pass",
                    Title = "GET /range at exactly 60 days returns 200 (boundary inclusive)",
                    Description = "Exactly 60-day window must be accepted (strictly greater than).",
                    Category = ScenarioCategory.EdgeCase,
                    Priority = 2,
                    ImpactZone = "zone-001",
                    Lifecycle = ScenarioLifecycle.Generated,
                    TimeoutMs = 30_000,
                    Stimulus = new Stimulus
                    {
                        Type = StimulusType.HttpRequest,
                        HttpRequest = new HttpRequestSpec
                        {
                            Method = "GET",
                            Path = "/api/insights/range?startTime=2025-03-02T00:00:00Z&endTime=2025-05-01T00:00:00Z",
                        },
                    },
                    Expectations = new List<Expectation>
                    {
                        new Expectation
                        {
                            Id = "exp-003",
                            Type = ExpectationType.EventPresent,
                            Topic = "http",
                            Description = "HTTP 200 at exact boundary",
                            Matcher = new Matcher
                            {
                                Exact = new Dictionary<string, object> { ["statusCode"] = 200 },
                            },
                        },
                    },
                    Metadata = new ScenarioMetadata
                    {
                        GeneratedBy = "ai",
                        Confidence = 0.88,
                        RelatedPRFiles = new List<string>
                        {
                            "Service/Microsoft.LiveTable.Service/Controllers/LiveTableInsightsController.cs",
                        },
                        Tags = new List<string> { "boundary", "edge", "insights" },
                        SchemaVersion = 2,
                        GeneratedAt = generatedAt,
                    },
                    Technique = ScenarioTechnique.BoundaryTriplet,
                    InvariantsAddressed = new List<string> { "inv-numeric_constant-deadbe" },
                    GroundingEvidence = new List<GroundingEvidence>
                    {
                        new GroundingEvidence
                        {
                            File = "Service/Microsoft.LiveTable.Service/Controllers/LiveTableInsightsController.cs",
                            StartLine = 21,
                            EndLine = 27,
                            Reason = "Boundary edge: exactly 60 days must remain in-range.",
                        },
                    },
                },
            };
        }

        public static PrContext InsightsBaselinePrContext()
        {
            return new PrContext
            {
                Title = "Insights v2.0.6 strict date contract",
                Author = "edog-tester@microsoft.com",
                Description = "Reject Insights date ranges > 60 days with HTTP 400.",
                WorkItems = new List<WorkItemSummary>
                {
                    new WorkItemSummary
                    {
                        Id = 123456,
                        Title = "Enforce 60-day strict date contract on Insights range endpoint",
                        State = "Active",
                        AcceptanceCriteria = "GET /api/insights/range returns HTTP 400 when (endTime - startTime) > 60 days.",
                        DescriptionSnippet = "Enforce a hard cap with a 400.",
                    },
                },
                ApiCatalog = new ApiCatalogContext
                {
                    Controllers = new List<string> { "LiveTableInsightsController" },
                },
            };
        }

        /// <summary>Read the PR diff fixture from disk.</summary>
        public static string ReadPrDiffFixture()
        {
            var path = Path.Combine(AppContext.BaseDirectory, "Fixtures", "pr-diff.txt");
            return File.ReadAllText(path);
        }
    }
}
