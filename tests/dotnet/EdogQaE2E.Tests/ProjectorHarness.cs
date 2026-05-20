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
                stimulusSpec: "{\"method\":\"POST\",\"path\":\"/api/insights\",\"contentType\":\"application/json\",\"body\":{\"days\":7},\"headers\":{\"X-Trace\":\"abc\"}}",
                matcherSpec: "{\"exact\":{\"statusCode\":200}}");

        private static object RunHappySignalRBroadcast() =>
            RunCase("happy_signalr_broadcast",
                stimulusType: "SignalRBroadcast",
                stimulusSpec: "{\"hub\":\"playground\",\"method\":\"Ping\",\"args\":[\"hello\",42]}",
                matcherSpec: "{\"exists\":[\"connectionId\"]}");

        private static object RunHappyDagTrigger() =>
            RunCase("happy_dag_trigger",
                stimulusType: "DagTrigger",
                stimulusSpec: "{\"iterationId\":\"current\",\"nodeFilter\":[\"node-1\",\"node-2\"]}",
                matcherSpec: "{\"contains\":{\"phase\":\"complete\"}}");

        private static object RunHappyFileEvent() =>
            RunCase("happy_file_event",
                stimulusType: "FileEvent",
                stimulusSpec: "{\"path\":\"/lake/foo.parquet\",\"content\":\"hello\",\"encoding\":\"utf8\",\"cleanup\":true}",
                matcherSpec: "{\"regex\":{\"path\":\"^/lake/.+\\\\.parquet$\"}}");

        private static object RunHappyTimerTick() =>
            RunCase("happy_timer_tick",
                stimulusType: "TimerTick",
                stimulusSpec: "{\"tickSource\":\"EvictionManager\",\"topic\":\"perf\",\"maxWaitMs\":15000}",
                matcherSpec: "{\"range\":{\"latencyMs\":{\"min\":0,\"max\":100}}}");

        private static object RunHappyDiInvocation() =>
            RunCase("happy_di_invocation",
                stimulusType: "DiInvocation",
                stimulusSpec: "{\"serviceType\":\"IOneLakeWriter\",\"method\":\"WriteFileAsync\",\"args\":[\"path\",\"content\"]}",
                matcherSpec: "{\"exact\":{\"returnedTrue\":true}}");

        // ─── Failure cases ───────────────────────────────────────────

        private static object RunStimulusSpecMalformed() =>
            RunCase("stimulus_spec_malformed",
                stimulusType: "HttpRequest",
                stimulusSpec: "{this is not json",
                matcherSpec: "{\"exact\":{\"statusCode\":200}}");

        private static object RunStimulusSpecMissingField() =>
            RunCase("stimulus_spec_missing_field",
                stimulusType: "HttpRequest",
                stimulusSpec: "{\"method\":\"GET\"}",  // path missing
                matcherSpec: "{\"exact\":{\"statusCode\":200}}");

        private static object RunMatcherSpecMalformed() =>
            RunCase("matcher_spec_malformed",
                stimulusType: "DiInvocation",
                stimulusSpec: "{\"serviceType\":\"IFoo\",\"method\":\"Bar\"}",
                matcherSpec: "{not even json");

        private static object RunMatcherSpecEmpty() =>
            RunCase("matcher_spec_empty",
                stimulusType: "DiInvocation",
                stimulusSpec: "{\"serviceType\":\"IFoo\",\"method\":\"Bar\"}",
                matcherSpec: "{}");

        // ─── Audit-trail forward-carry ───────────────────────────────

        private static object RunSourceEvidenceIdForwarded()
        {
            var plan = BuildPlan(
                Evidence("ev-trail-1", "src/Foo.cs", "right", 12, "added Baz() => 3"));
            var accepted = BuildAccepted("sk-1", "DiInvocation",
                "{\"serviceType\":\"IFoo\",\"method\":\"Baz\"}",
                "{\"exact\":{\"returnedTrue\":true}}",
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
                "{\"serviceType\":\"IFoo\",\"method\":\"Bar\"}",
                "{\"exact\":{\"v\":1}}", refs: new List<string> { "ev-1" });
            var bad = BuildAccepted("sk-bad", "HttpRequest",
                "{\"method\":\"GET\"}",  // missing path
                "{\"exact\":{\"v\":1}}", refs: new List<string> { "ev-1" });

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
            string caseId, string stimulusType, string stimulusSpec, string matcherSpec)
        {
            var plan = BuildPlan(
                Evidence("ev-1", "src/Foo.cs", "right", 12, "added"));
            var accepted = BuildAccepted("sk-1", stimulusType, stimulusSpec, matcherSpec,
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
            string sketchId, string stimulusType, string stimulusSpec, string matcherSpec,
            List<string> refs)
        {
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
                StimulusSpec = stimulusSpec,
                Expectations = new List<EdogQaLlmClient.GeneratedExpectation>
                {
                    new EdogQaLlmClient.GeneratedExpectation
                    {
                        Type = "FieldMatch",
                        Topic = "log",
                        MatcherSpec = matcherSpec,
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
