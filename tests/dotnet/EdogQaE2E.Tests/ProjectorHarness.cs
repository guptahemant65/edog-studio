// SPDX-License-Identifier: MIT
// F27 P9 T1c-a-2 — behavioural harness for EdogQaScenarioProjector.
//
// Mirrors ValidatorHarness in shape: drives the projector across a
// matrix of canned AcceptedScenarios (one per StimulusType for the
// happy path, plus deliberate parse-failure cases). Emits a single
// HARNESS-JSON-BEGIN/END envelope that pytest consumes.
//
// Test plumbing builds Validator outputs directly (no real LLM call),
// then hands them to the Projector. This proves end-to-end:
//   Validator.AcceptedScenario  →  EdogQaScenarioProjector.Project
//     → engine EdogQaModels.Scenario  OR  QuarantinedScenario

namespace Microsoft.LiveTable.Service.DevMode.E2ETests
{
    using System;
    using System.Collections.Generic;
    using System.Linq;
    using System.Text.Json;
    using System.Threading;
    using System.Threading.Tasks;
    using Microsoft.LiveTable.Service.DevMode;

    internal static class ProjectorHarness
    {
        public static Task<int> RunAsync(CancellationToken ct)
        {
            var cases = new List<object>
            {
                RunHappyHttpRequest(),
                RunHappySignalRBroadcast(),
                RunHappyDagTrigger(),
                RunHappyFileEvent(),
                RunHappyTimerTick(),
                RunHappyDiInvocation(),
                RunStimulusSpecMalformed(),
                RunStimulusSpecMissingField(),
                RunMatcherSpecMalformed(),
                RunMatcherSpecEmpty(),
                RunSourceEvidenceIdForwarded(),
                RunMultipleScenariosMixedOutcome(),
            };

            EmitJson(new
            {
                ok = true,
                harness = "projector",
                cases,
            });
            return Task.FromResult(0);
        }

        // ─── Happy paths (one per StimulusType) ──────────────────────

        private static object RunHappyHttpRequest() =>
            RunCase("happy_http_request",
                stimulusType: "HttpRequest",
                stimulus: new EdogQaLlmClient.HttpRequestStimulus
                {
                    Method = "POST", Path = "/api/insights",
                    ContentType = "application/json",
                    Body = "{\"days\":7}",
                    Headers = new() { new() { Name = "X-Trace", Value = "abc" } },
                },
                matcher: MakeMatcher("http.statusCode", "Equals", 200));

        private static object RunHappySignalRBroadcast() =>
            RunCase("happy_signalr_broadcast",
                stimulusType: "SignalRBroadcast",
                stimulus: new EdogQaLlmClient.SignalRBroadcastStimulus
                {
                    Hub = "playground", Method = "Ping",
                    Args = new() { "hello", 42 },
                },
                matcher: MakeMatcher("log.message", "Exists", true));

        private static object RunHappyDagTrigger() =>
            RunCase("happy_dag_trigger",
                stimulusType: "DagTrigger",
                stimulus: new EdogQaLlmClient.DagTriggerStimulus
                {
                    IterationId = "current",
                    NodeFilter = new() { "node-1", "node-2" },
                },
                matcher: MakeMatcher("dag.nodeId", "ContainsAll", "node-1"));

        private static object RunHappyFileEvent() =>
            RunCase("happy_file_event",
                stimulusType: "FileEvent",
                stimulus: new EdogQaLlmClient.FileEventStimulus
                {
                    Path = "/lake/foo.parquet", Content = "hello",
                    Encoding = "utf8", Cleanup = true,
                },
                matcher: MakeMatcher("fileop.path", "ContainsAll", "/lake/"));

        private static object RunHappyTimerTick() =>
            RunCase("happy_timer_tick",
                stimulusType: "TimerTick",
                stimulus: new EdogQaLlmClient.TimerTickStimulus
                {
                    TickSource = "EvictionManager", Topic = "perf", MaxWaitMs = 15000,
                },
                matcher: MakeMatcher("perf.durationMs", "InRange", new { min = 0, max = 100 }));

        private static object RunHappyDiInvocation() =>
            RunCase("happy_di_invocation",
                stimulusType: "DiInvocation",
                stimulus: new EdogQaLlmClient.DiInvocationStimulus
                {
                    ServiceType = "IOneLakeWriter", Method = "WriteFileAsync",
                    Args = new() { "path", "content" },
                },
                matcher: MakeMatcher("di.serviceType", "Equals", "IOneLakeWriter"));

        // ─── Failure cases ───────────────────────────────────────────

        private static object RunStimulusSpecMalformed() =>
            RunCase("stimulus_spec_malformed",
                stimulusType: "HttpRequest",
                stimulus: null,  // null stimulus → stub
                matcher: MakeMatcher("http.statusCode", "Equals", 200));

        private static object RunStimulusSpecMissingField() =>
            RunCase("stimulus_spec_missing_field",
                stimulusType: "HttpRequest",
                stimulus: new EdogQaLlmClient.HttpRequestStimulus
                {
                    Method = "GET",
                    // path deliberately null → auto-normalized to /api/unknown
                },
                matcher: MakeMatcher("http.statusCode", "Equals", 200));

        private static object RunMatcherSpecMalformed() =>
            RunCase("matcher_spec_malformed",
                stimulusType: "DiInvocation",
                stimulus: new EdogQaLlmClient.DiInvocationStimulus
                {
                    ServiceType = "IFoo", Method = "Bar",
                },
                matcher: null);  // null matcher → vacuous

        private static object RunMatcherSpecEmpty() =>
            RunCase("matcher_spec_empty",
                stimulusType: "DiInvocation",
                stimulus: new EdogQaLlmClient.DiInvocationStimulus
                {
                    ServiceType = "IFoo", Method = "Bar",
                },
                matcher: new EdogQaLlmClient.GeneratedMatcher());  // empty → vacuous

        // ─── Audit-trail forward-carry ───────────────────────────────

        private static object RunSourceEvidenceIdForwarded()
        {
            var plan = BuildPlan(
                Evidence("ev-trail-1", "src/Foo.cs", "right", 12, "added Baz() => 3"));
            var accepted = BuildAccepted("sk-1", "DiInvocation",
                new EdogQaLlmClient.DiInvocationStimulus { ServiceType = "IFoo", Method = "Baz" },
                MakeMatcher("di.serviceType", "Equals", "IFoo"),
                refs: new List<string> { "ev-trail-1" });

            var result = EdogQaScenarioProjector.Project(plan, new[] { accepted });
            var projected = result.Projected.SingleOrDefault();
            var grounding = projected?.GroundingEvidence?.SingleOrDefault();

            return new
            {
                caseId = "source_evidence_id_forwarded",
                acceptedCount = result.Projected.Count,
                rejectedCount = result.Rejected.Count,
                groundingSourceEvidenceId = grounding?.SourceEvidenceId,
                groundingFile = grounding?.File,
                groundingStartLine = grounding?.StartLine ?? 0,
                groundingEndLine = grounding?.EndLine ?? 0,
                projectedGeneratedBy = projected?.Metadata?.GeneratedBy,
                projectedLifecycle = projected?.Lifecycle.ToString(),
            };
        }

        private static object RunMultipleScenariosMixedOutcome()
        {
            var plan = BuildPlan(
                Evidence("ev-1", "src/Foo.cs", "right", 12, "valid"));
            var ok = BuildAccepted("sk-ok", "DiInvocation",
                new EdogQaLlmClient.DiInvocationStimulus { ServiceType = "IFoo", Method = "Bar" },
                MakeMatcher("di.serviceType", "Equals", "IFoo"), refs: new List<string> { "ev-1" });
            var bad = BuildAccepted("sk-bad", "SignalRBroadcast",
                new EdogQaLlmClient.SignalRBroadcastStimulus { Hub = null, Method = "Send" },  // missing hub → rejected
                MakeMatcher("log.message", "Exists", true), refs: new List<string> { "ev-1" });

            var result = EdogQaScenarioProjector.Project(plan, new[] { ok, bad });
            return new
            {
                caseId = "multiple_scenarios_mixed_outcome",
                acceptedCount = result.Projected.Count,
                rejectedCount = result.Rejected.Count,
                projectedIds = result.Projected.Select(s => s.Id).OrderBy(s => s, StringComparer.Ordinal).ToList(),
                rejectedIds = result.Rejected.Select(q => q.Scenario.Id).OrderBy(s => s, StringComparer.Ordinal).ToList(),
                rejectedCodes = result.Rejected.SelectMany(q => q.Reasons.Select(r => r.Code))
                    .OrderBy(s => s, StringComparer.Ordinal).ToList(),
            };
        }

        // ─── Single-scenario harness driver ──────────────────────────

        private static object RunCase(
            string caseId, string stimulusType,
            EdogQaLlmClient.GeneratedStimulus stimulus,
            EdogQaLlmClient.GeneratedMatcher matcher)
        {
            var plan = BuildPlan(
                Evidence("ev-1", "src/Foo.cs", "right", 12, "added"));
            var accepted = BuildAccepted("sk-1", stimulusType, stimulus, matcher,
                refs: new List<string> { "ev-1" });

            var result = EdogQaScenarioProjector.Project(plan, new[] { accepted });
            var projected = result.Projected.SingleOrDefault();

            return new
            {
                caseId,
                acceptedCount = result.Projected.Count,
                rejectedCount = result.Rejected.Count,
                rejectedCodes = result.Rejected
                    .SelectMany(q => q.Reasons.Select(r => r.Code))
                    .OrderBy(s => s, StringComparer.Ordinal).ToList(),
                rejectedFieldPaths = result.Rejected
                    .SelectMany(q => q.Reasons.Select(r => r.FieldPath ?? string.Empty))
                    .OrderBy(s => s, StringComparer.Ordinal).ToList(),
                projectedStimulusType = projected?.Stimulus?.Type.ToString(),
                projectedHasHttpPayload = projected?.Stimulus?.HttpRequest != null,
                projectedHasSignalRBroadcastPayload = projected?.Stimulus?.SignalRBroadcast != null,
                projectedHasDagPayload = projected?.Stimulus?.DagTrigger != null,
                projectedHasFileEventPayload = projected?.Stimulus?.FileEvent != null,
                projectedHasTimerTickPayload = projected?.Stimulus?.TimerTick != null,
                projectedHasDiInvocationPayload = projected?.Stimulus?.DiInvocation != null,
                projectedExpectationCount = projected?.Expectations?.Count ?? 0,
                projectedFirstMatcherHasExact = projected?.Expectations?.FirstOrDefault()?.Matcher?.Exact != null,
                projectedFirstMatcherHasContains = projected?.Expectations?.FirstOrDefault()?.Matcher?.Contains != null,
                projectedFirstMatcherHasRegex = projected?.Expectations?.FirstOrDefault()?.Matcher?.Regex != null,
                projectedFirstMatcherHasRange = projected?.Expectations?.FirstOrDefault()?.Matcher?.Range != null,
                projectedFirstMatcherHasExists = projected?.Expectations?.FirstOrDefault()?.Matcher?.Exists != null,
            };
        }

        // ─── Plumbing ────────────────────────────────────────────────

        private static EdogQaLlmClient.ArchitectGroundingEvidence Evidence(
            string evidenceId, string path, string side, int newLine, string reason)
        {
            return new EdogQaLlmClient.ArchitectGroundingEvidence
            {
                EvidenceId = evidenceId,
                RepoRelativePath = path,
                Side = side,
                BaseSha = "abc",
                HunkId = "h-1",
                NewLine = newLine,
                Excerpt = "snippet",
                Reason = reason,
            };
        }

        private static EdogQaLlmClient.ArchitectPlan BuildPlan(params EdogQaLlmClient.ArchitectGroundingEvidence[] evidence)
        {
            return new EdogQaLlmClient.ArchitectPlan
            {
                ZoneId = "zone-001",
                PlanOutcome = "testable",
                GroundingEvidence = new List<EdogQaLlmClient.ArchitectGroundingEvidence>(evidence),
                BehavioralChanges = new List<EdogQaLlmClient.BehavioralChange>(),
                ScenarioSketches = new List<EdogQaLlmClient.ScenarioSketch>(),
            };
        }

        private static EdogQaScenarioValidator.AcceptedScenario BuildAccepted(
            string sketchId, string stimulusType,
            EdogQaLlmClient.GeneratedStimulus stimulus,
            EdogQaLlmClient.GeneratedMatcher matcher,
            List<string> refs)
        {
            // Derive topic from topicField (e.g. "http.statusCode" → "http")
            var topic = matcher?.TopicField?.Split('.')[0] ?? "log";
            var src = new EdogQaLlmClient.GeneratedScenario
            {
                Id = sketchId,
                Title = "Sample scenario",
                Description = "Sample.",
                Category = "HappyPath",
                Priority = 2,
                ImpactZone = "zone-001",
                Technique = "EquivalencePartition",
                StimulusType = stimulusType,
                Stimulus = stimulus,
                Expectations = new List<EdogQaLlmClient.GeneratedExpectation>
                {
                    new EdogQaLlmClient.GeneratedExpectation
                    {
                        Type = "FieldMatch",
                        Topic = topic,
                        Matcher = matcher,
                        Rationale = "Test.",
                    },
                },
                TimeoutMs = 5_000,
                GroundingEvidenceRefs = refs,
                Confidence = 0.85,
            };
            return new EdogQaScenarioValidator.AcceptedScenario
            {
                Scenario = src,
                SemanticHash = "deadbeef",
                CalibratedConfidence = 0.85,
                InformationalReasons = new(),
            };
        }

        private static EdogQaLlmClient.GeneratedMatcher MakeMatcher(
            string topicField, string assertion, object value)
        {
            // Build a value JSON element with the appropriate `kind`
            // discriminator that the projector's ReadMatcherValueKind expects.
            string valueJson;
            switch (assertion)
            {
                case "Equals":
                case "NotEquals":
                    if (value is int intVal)
                        valueJson = $"{{\"kind\":\"integer_literal\",\"literal\":{intVal}}}";
                    else if (value is bool boolVal)
                        valueJson = $"{{\"kind\":\"boolean_literal\",\"literal\":{(boolVal ? "true" : "false")}}}";
                    else
                        valueJson = $"{{\"kind\":\"string_literal\",\"literal\":{JsonSerializer.Serialize(value)}}}";
                    break;
                case "Exists":
                {
                    var exp = value is bool b ? b : true;
                    valueJson = $"{{\"kind\":\"exists\",\"expected\":{(exp ? "true" : "false")}}}";
                    break;
                }
                case "Contains":
                case "ContainsAll":
                {
                    var item = value is string s ? s : JsonSerializer.Serialize(value);
                    valueJson = $"{{\"kind\":\"array_literal\",\"items\":[{JsonSerializer.Serialize(item)}]}}";
                    break;
                }
                case "Matches":
                {
                    valueJson = $"{{\"kind\":\"string_literal\",\"literal\":{JsonSerializer.Serialize(value)}}}";
                    break;
                }
                case "Range":
                case "InRange":
                {
                    var rangeJson = JsonSerializer.Serialize(value);
                    var rangeDoc = JsonDocument.Parse(rangeJson);
                    var min = rangeDoc.RootElement.TryGetProperty("min", out var minEl) ? minEl.GetRawText() : "null";
                    var max = rangeDoc.RootElement.TryGetProperty("max", out var maxEl) ? maxEl.GetRawText() : "null";
                    valueJson = $"{{\"kind\":\"range\",\"min\":{min},\"max\":{max},\"minInclusive\":true,\"maxInclusive\":true}}";
                    break;
                }
                default:
                    valueJson = JsonSerializer.Serialize(new { kind = "string_literal", literal = value?.ToString() ?? "" });
                    break;
            }

            return new EdogQaLlmClient.GeneratedMatcher
            {
                TopicField = topicField,
                Assertion = assertion,
                Value = JsonDocument.Parse(valueJson).RootElement,
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
    }
}
