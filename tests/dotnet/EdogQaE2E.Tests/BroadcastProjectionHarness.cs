// SPDX-License-Identifier: MIT
// F27 — Contract test for the QA scenario broadcast projection.
//
// This harness pins the wire-shape contract between
// EdogPlaygroundHub.QaScenarioGenerated (server → curator) and
// EdogPlaygroundHub.ConvertSubmittedToEngineScenario (curator → server)
// so that the lossy hand-projection that previously stripped every
// non-HttpRequest stimulus variant and every expectation sub-object
// cannot regress.
//
// The harness drives, for each of the six StimulusType discriminator
// values, the full round-trip:
//
//   1. Build a typed Scenario with every nested field populated to
//      sentinel values (matcher with all five predicate branches,
//      timeWindow, count, order, full stimulus payload per variant).
//   2. Project via EdogPlaygroundHub.ProjectStimulusForWire and
//      EdogPlaygroundHub.ProjectExpectationForWire.
//   3. Serialize the projected envelope with the SignalR JSON options
//      EdogLogServer registers (camelCase + JsonStringEnumConverter).
//   4. Deserialize that JSON back into the QaSubmittedScenario wire
//      shape used by QaSubmitCuratedScenarios.
//   5. Convert via EdogPlaygroundHub.ConvertSubmittedToEngineScenarioInternal
//      back into a typed Scenario.
//   6. Compare the input typed Stimulus + Expectations against the
//      round-tripped values using canonical JSON equality (System.Text.Json
//      surfaces object-valued payload bodies / args as JsonElement
//      after round-trip, so structural equality is the right contract,
//      not CLR object identity).
//
// Emits one HARNESS-JSON-BEGIN/END block consumed by the pytest wrapper
// tests/test_qa_broadcast_projection.py.

namespace Microsoft.LiveTable.Service.DevMode.E2ETests
{
    using System;
    using System.Collections.Generic;
    using System.Text.Json;
    using System.Text.Json.Serialization;
    using System.Threading;
    using System.Threading.Tasks;
    using Microsoft.LiveTable.Service.DevMode;

    internal static class BroadcastProjectionHarness
    {
        // Matches EdogLogServer.AddJsonProtocol options so this test
        // exercises the actual wire serializer.
        private static readonly JsonSerializerOptions WireOpts = new()
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            DefaultIgnoreCondition = JsonIgnoreCondition.Never,
            Converters = { new JsonStringEnumConverter() },
        };

        // Canonical-JSON comparator: ignore key order, treat
        // missing-and-default fields as equal. Used to compare
        // a typed object before and after the wire round-trip.
        private static readonly JsonSerializerOptions CanonicalOpts = new()
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
            Converters = { new JsonStringEnumConverter() },
        };

        public static Task<int> RunAsync(CancellationToken ct)
        {
            var cases = new List<object>
            {
                RunCase("http_request", BuildHttpRequestScenario()),
                RunCase("signalr_broadcast", BuildSignalRBroadcastScenario()),
                RunCase("dag_trigger", BuildDagTriggerScenario()),
                RunCase("file_event", BuildFileEventScenario()),
                RunCase("timer_tick", BuildTimerTickScenario()),
                RunCase("di_invocation", BuildDiInvocationScenario()),
            };

            EmitJson(new
            {
                ok = true,
                harness = "broadcast-projection",
                cases,
            });
            return Task.FromResult(0);
        }

        // ─── Round-trip plumbing ─────────────────────────────────────

        private static object RunCase(string name, Scenario original)
        {
            // 1. Project
            var projectedStimulus = EdogPlaygroundHub.ProjectStimulusForWire(original.Stimulus);
            var projectedExpectations = new List<object>();
            foreach (var e in original.Expectations)
            {
                projectedExpectations.Add(EdogPlaygroundHub.ProjectExpectationForWire(e));
            }

            // 2. Serialize with the SignalR JSON options.
            var stimulusJson = JsonSerializer.Serialize(projectedStimulus, WireOpts);
            var expectationsJson = JsonSerializer.Serialize(projectedExpectations, WireOpts);

            // 3. Deserialize into the curator-submit wire shape.
            //    QaSubmittedScenario.Stimulus is `object` (polymorphic);
            //    expectations have typed Matcher/TimeWindow/Count/Order
            //    so they decode directly.
            var submittedStimulus = JsonSerializer.Deserialize<object>(stimulusJson, WireOpts);
            var submittedExpectations = JsonSerializer.Deserialize<List<QaSubmittedExpectation>>(expectationsJson, WireOpts);

            var submitted = new QaSubmittedScenario
            {
                Id = original.Id,
                Title = original.Title,
                Description = original.Description,
                Category = SnakeCaseCategory(original.Category),
                Priority = original.Priority,
                ImpactZone = original.ImpactZone,
                TimeoutMs = original.TimeoutMs,
                Stimulus = submittedStimulus,
                Expectations = submittedExpectations ?? new List<QaSubmittedExpectation>(),
            };

            // 4. Convert back to the typed engine model.
            Scenario roundTripped;
            string conversionError = null;
            try
            {
                roundTripped = EdogPlaygroundHub.ConvertSubmittedToEngineScenarioInternal(submitted);
            }
            catch (Exception ex)
            {
                roundTripped = null;
                conversionError = ex.GetType().Name + ": " + ex.Message;
            }

            // 5. Compare structurally via canonical JSON.
            var origStimulusCanonical = Canonical(original.Stimulus);
            var rtStimulusCanonical = Canonical(roundTripped?.Stimulus);
            var origExpectationsCanonical = Canonical(original.Expectations);
            var rtExpectationsCanonical = Canonical(roundTripped?.Expectations);

            var stimulusEquals = string.Equals(origStimulusCanonical, rtStimulusCanonical, StringComparison.Ordinal);
            var expectationsEquals = string.Equals(origExpectationsCanonical, rtExpectationsCanonical, StringComparison.Ordinal);

            return new
            {
                name,
                conversionError,
                projectedStimulusJson = stimulusJson,
                projectedExpectationsJson = expectationsJson,
                stimulusEquals,
                expectationsEquals,
                // Diagnostic surface — emitted on every run so the
                // pytest wrapper can pin the canonical shape and so a
                // diff is visible on failure.
                originalStimulus = origStimulusCanonical,
                roundTrippedStimulus = rtStimulusCanonical,
                originalExpectations = origExpectationsCanonical,
                roundTrippedExpectations = rtExpectationsCanonical,
            };
        }

        private static string Canonical(object value)
        {
            if (value == null) return "null";
            return JsonSerializer.Serialize(value, CanonicalOpts);
        }

        private static string SnakeCaseCategory(ScenarioCategory c) => c switch
        {
            ScenarioCategory.HappyPath => "happy_path",
            ScenarioCategory.ErrorPath => "error_path",
            ScenarioCategory.EdgeCase => "edge_case",
            ScenarioCategory.Regression => "regression",
            ScenarioCategory.Performance => "performance",
            _ => c.ToString().ToLowerInvariant(),
        };

        // ─── Fixtures: one Scenario per StimulusType ─────────────────

        private static Scenario BuildHttpRequestScenario() => Wrap(new Stimulus
        {
            Type = StimulusType.HttpRequest,
            HttpRequest = new HttpRequestSpec
            {
                Method = "POST",
                Path = "/api/v2.0.6/insights/summary",
                ContentType = "application/json",
                Headers = new Dictionary<string, string>
                {
                    ["X-Trace-Id"] = "trace-001",
                    ["Authorization"] = "Bearer redacted",
                },
                Body = new Dictionary<string, object>
                {
                    ["startTime"] = "2026-01-01T00:00:00Z",
                    ["endTime"] = "2026-01-08T00:00:00Z",
                },
            },
        });

        private static Scenario BuildSignalRBroadcastScenario() => Wrap(new Stimulus
        {
            Type = StimulusType.SignalRBroadcast,
            SignalRBroadcast = new SignalRBroadcastSpec
            {
                Hub = "/hub/playground",
                Method = "QaSubmitCuratedScenarios",
                Args = new List<object> { "arg1", 42, true },
            },
        });

        private static Scenario BuildDagTriggerScenario() => Wrap(new Stimulus
        {
            Type = StimulusType.DagTrigger,
            DagTrigger = new DagTriggerSpec
            {
                IterationId = "iter-12345",
                NodeFilter = new List<string> { "node-A", "node-B" },
            },
        });

        private static Scenario BuildFileEventScenario() => Wrap(new Stimulus
        {
            Type = StimulusType.FileEvent,
            FileEvent = new FileEventSpec
            {
                Path = "/onelake/workspace/table/_delta_log/00000000000000000001.json",
                Content = "{\"add\":{...}}",
                Encoding = "utf-8",
            },
        });

        private static Scenario BuildTimerTickScenario() => Wrap(new Stimulus
        {
            Type = StimulusType.TimerTick,
            TimerTick = new TimerTickSpec
            {
                TickSource = "scheduler:hourly",
                Topic = "retention",
                MaxWaitMs = 90_000,
            },
        });

        private static Scenario BuildDiInvocationScenario() => Wrap(new Stimulus
        {
            Type = StimulusType.DiInvocation,
            DiInvocation = new DiInvocationSpec
            {
                ServiceType = "Microsoft.LiveTable.Service.Insights.IInsightsQueryService",
                Method = "GetSummaryAsync",
                Args = new List<object>
                {
                    "2026-01-01T00:00:00Z",
                    "2026-01-08T00:00:00Z",
                },
            },
        });

        private static Scenario Wrap(Stimulus stimulus)
        {
            return new Scenario
            {
                Id = "scn-broadcast-projection-" + stimulus.Type.ToString().ToLowerInvariant(),
                Title = "Broadcast projection round-trip for " + stimulus.Type,
                Description = "Pin the wire contract — every nested field must survive the broadcast→submit hop.",
                Category = ScenarioCategory.HappyPath,
                Priority = 1,
                ImpactZone = "zone-projection-001",
                TimeoutMs = 30_000,
                Stimulus = stimulus,
                Expectations = new List<Expectation>
                {
                    new Expectation
                    {
                        Id = "exp-1",
                        Type = ExpectationType.FieldMatch,
                        Topic = "http",
                        Description = "Status code must be 200 and body must include the requested window.",
                        Matcher = new LegacyMatcher
                        {
                            Exact = new Dictionary<string, object> { ["statusCode"] = 200 },
                            Contains = new Dictionary<string, string> { ["body"] = "summary" },
                            Regex = new Dictionary<string, string> { ["path"] = "^/api/v2\\.0\\.6/.*$" },
                            Range = new Dictionary<string, RangeBounds>
                            {
                                ["durationMs"] = new RangeBounds { Min = 0, Max = 5_000 },
                            },
                            Exists = new List<string> { "traceId" },
                        },
                        TimeWindow = new TimeWindowSpec { WithinMs = 5_000, AfterMs = 0 },
                        Count = new CountSpec { Min = 1, Max = 1, Exact = 1 },
                        Order = new OrderSpec { After = "exp-0" },
                    },
                },
            };
        }

        private static void EmitJson(object payload)
        {
            Console.WriteLine("---HARNESS-JSON-BEGIN---");
            Console.WriteLine(JsonSerializer.Serialize(payload, new JsonSerializerOptions
            {
                WriteIndented = true,
                DefaultIgnoreCondition = JsonIgnoreCondition.Never,
            }));
            Console.WriteLine("---HARNESS-JSON-END---");
        }
    }
}
