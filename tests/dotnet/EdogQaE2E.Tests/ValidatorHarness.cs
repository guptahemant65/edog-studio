// SPDX-License-Identifier: MIT
// F27 P9 T1c-a — behavioural harness for EdogQaScenarioValidator.
//
// Mirrors LlmClientHarness in shape: drives the validator across a
// matrix of canned inputs (no LLM, no HTTP), emits a single
// HARNESS-JSON-BEGIN/END envelope that pytest assertions consume.
// Each case carries (caseId, acceptedCount, quarantinedCount,
// codes[]) so the test surface can declare exactly what behaviour
// each gate produces.
//
// All 11 cases are deterministic: same inputs ⇒ same JSON output.
// Cases that should ACCEPT use scenarios + evidence pools + diffs
// that match each other; cases that should QUARANTINE use one
// deliberately broken field per case.

namespace Microsoft.LiveTable.Service.DevMode.E2ETests
{
    using System;
    using System.Collections.Generic;
    using System.IO;
    using System.Linq;
    using System.Text;
    using System.Text.Json;
    using System.Threading;
    using System.Threading.Tasks;
    using Microsoft.LiveTable.Service.DevMode;

    internal static class ValidatorHarness
    {
        private const string CanonicalDiff =
            "--- a/src/Foo.cs\n" +
            "+++ b/src/Foo.cs\n" +
            "@@ -10,4 +10,6 @@\n" +
            " public class Foo\n" +
            " {\n" +
            "-    public int Bar() => 1;\n" +
            "+    public int Bar() => 2;\n" +
            "+\n" +
            "+    public int Baz() => 3;\n" +
            " }\n";

        // From CanonicalDiff:
        //   right (post-change) changed lines: 12, 13, 14
        //   left  (pre-change) changed lines: 12
        // newLine field is "line in the side's view" per spec §4.
        private const int RightLine12 = 12;
        private const int RightLine13 = 13;
        private const int RightLine14 = 14;
        private const int LeftLine12 = 12;
        private const string SamplePath = "src/Foo.cs";

        private static readonly List<string> StubTopics = new()
        {
            "http", "token", "flag", "perf", "spark", "log",
            "telemetry", "retry", "cache", "fileop", "catalog",
            "dag", "flt-ops", "nexus", "di", "capacity",
        };

        public static Task<int> RunAsync(CancellationToken ct)
        {
            var cases = new List<object>();
            var diffParseSamples = new List<object>();

            cases.Add(RunHappyPath());
            cases.Add(RunGroundingRefUnknown());
            cases.Add(RunGroundingLineNotInDiff());
            cases.Add(RunGroundingSideMismatch());
            cases.Add(RunGroundingMissing());
            cases.Add(RunTitleTooLong());
            cases.Add(RunPriorityOutOfRange());
            cases.Add(RunEnumValueInvalid());
            cases.Add(RunExpectationsMissing());
            cases.Add(RunTopicUnknown());
            cases.Add(RunConfidenceCappedInformational());
            cases.Add(RunDuplicateInBatch());
            cases.Add(RunMultiFailureSingleScenario());

            diffParseSamples.Add(CaptureDiffParseSample(CanonicalDiff, "canonical"));
            diffParseSamples.Add(CaptureDiffParseSample(string.Empty, "empty_diff"));
            diffParseSamples.Add(CaptureDiffParseSample("not a diff at all\n", "garbage_input"));

            var enumVocabulary = new
            {
                categories = EdogQaScenarioValidator.ValidCategories.OrderBy(s => s, StringComparer.Ordinal).ToList(),
                techniques = EdogQaScenarioValidator.ValidTechniques.OrderBy(s => s, StringComparer.Ordinal).ToList(),
                stimulusTypes = EdogQaScenarioValidator.ValidStimulusTypes.OrderBy(s => s, StringComparer.Ordinal).ToList(),
                expectationTypes = EdogQaScenarioValidator.ValidExpectationTypes.OrderBy(s => s, StringComparer.Ordinal).ToList(),
            };

            EmitJson(new
            {
                ok = true,
                harness = "validator",
                cases,
                diffParseSamples,
                enumVocabulary,
            });
            return Task.FromResult(0);
        }

        // ── Case: happy path. One scenario, one evidence ref. ────────────
        private static object RunHappyPath()
        {
            var plan = BuildPlan(
                Evidence("ev-1", SamplePath, "right", RightLine13, "Baz() => 3"));
            var scenarios = new List<EdogQaLlmClient.GeneratedScenario>
            {
                BuildValidScenario(refs: new List<string> { "ev-1" }, sketchId: "sk-1"),
            };
            return RunCase("happy_path", plan, scenarios, CanonicalDiff);
        }

        private static object RunGroundingRefUnknown()
        {
            var plan = BuildPlan(
                Evidence("ev-1", SamplePath, "right", RightLine13, "Baz() => 3"));
            var scenarios = new List<EdogQaLlmClient.GeneratedScenario>
            {
                BuildValidScenario(refs: new List<string> { "ev-2" }, sketchId: "sk-1"),
            };
            return RunCase("grounding_ref_unknown", plan, scenarios, CanonicalDiff);
        }

        private static object RunGroundingLineNotInDiff()
        {
            // Evidence points at line 99 — not a changed line in CanonicalDiff.
            var plan = BuildPlan(
                Evidence("ev-1", SamplePath, "right", 99, "phantom"));
            var scenarios = new List<EdogQaLlmClient.GeneratedScenario>
            {
                BuildValidScenario(refs: new List<string> { "ev-1" }, sketchId: "sk-1"),
            };
            return RunCase("grounding_line_not_in_diff", plan, scenarios, CanonicalDiff);
        }

        private static object RunGroundingSideMismatch()
        {
            var plan = BuildPlan(
                Evidence("ev-1", SamplePath, "north", RightLine13, "invalid side"));
            var scenarios = new List<EdogQaLlmClient.GeneratedScenario>
            {
                BuildValidScenario(refs: new List<string> { "ev-1" }, sketchId: "sk-1"),
            };
            return RunCase("grounding_side_mismatch", plan, scenarios, CanonicalDiff);
        }

        private static object RunGroundingMissing()
        {
            var plan = BuildPlan(
                Evidence("ev-1", SamplePath, "right", RightLine13, "Baz() => 3"));
            var scenarios = new List<EdogQaLlmClient.GeneratedScenario>
            {
                BuildValidScenario(refs: new List<string>(), sketchId: "sk-1"),
            };
            return RunCase("grounding_missing", plan, scenarios, CanonicalDiff);
        }

        private static object RunTitleTooLong()
        {
            var plan = BuildPlan(
                Evidence("ev-1", SamplePath, "right", RightLine13, "Baz() => 3"));
            var scen = BuildValidScenario(refs: new List<string> { "ev-1" }, sketchId: "sk-1");
            scen.Title = new string('A', EdogQaScenarioValidator.MaxTitleLength + 1);
            return RunCase("title_too_long", plan, new List<EdogQaLlmClient.GeneratedScenario> { scen }, CanonicalDiff);
        }

        private static object RunPriorityOutOfRange()
        {
            var plan = BuildPlan(
                Evidence("ev-1", SamplePath, "right", RightLine13, "Baz() => 3"));
            var scen = BuildValidScenario(refs: new List<string> { "ev-1" }, sketchId: "sk-1");
            scen.Priority = 99;
            return RunCase("priority_out_of_range", plan, new List<EdogQaLlmClient.GeneratedScenario> { scen }, CanonicalDiff);
        }

        private static object RunEnumValueInvalid()
        {
            var plan = BuildPlan(
                Evidence("ev-1", SamplePath, "right", RightLine13, "Baz() => 3"));
            var scen = BuildValidScenario(refs: new List<string> { "ev-1" }, sketchId: "sk-1");
            scen.StimulusType = "TeleportStimulus";
            return RunCase("enum_value_invalid", plan, new List<EdogQaLlmClient.GeneratedScenario> { scen }, CanonicalDiff);
        }

        private static object RunExpectationsMissing()
        {
            var plan = BuildPlan(
                Evidence("ev-1", SamplePath, "right", RightLine13, "Baz() => 3"));
            var scen = BuildValidScenario(refs: new List<string> { "ev-1" }, sketchId: "sk-1");
            scen.Expectations = new List<EdogQaLlmClient.GeneratedExpectation>();
            return RunCase("expectations_missing", plan, new List<EdogQaLlmClient.GeneratedScenario> { scen }, CanonicalDiff);
        }

        private static object RunTopicUnknown()
        {
            var plan = BuildPlan(
                Evidence("ev-1", SamplePath, "right", RightLine13, "Baz() => 3"));
            var scen = BuildValidScenario(refs: new List<string> { "ev-1" }, sketchId: "sk-1");
            scen.Expectations[0].Topic = "made-up-topic";
            return RunCase("topic_unknown", plan, new List<EdogQaLlmClient.GeneratedScenario> { scen }, CanonicalDiff);
        }

        private static object RunConfidenceCappedInformational()
        {
            // Mix of valid + invalid grounding refs. The accepted-but-capped
            // case actually requires gate 1 to FAIL (at least one bad ref) but
            // gates 2–5 to PASS. Easiest way: scenario references both ev-1
            // (valid) and ev-bogus (unknown) — gate 1 fails, scenario is
            // quarantined. We instead test the CLAMP behaviour: scenario
            // with confidence=1.7 is silently clamped to 1.0 and accepted
            // when grounding is clean.
            var plan = BuildPlan(
                Evidence("ev-1", SamplePath, "right", RightLine13, "Baz() => 3"));
            var scen = BuildValidScenario(refs: new List<string> { "ev-1" }, sketchId: "sk-1");
            scen.Confidence = 1.7;
            return RunCase("confidence_clamped", plan, new List<EdogQaLlmClient.GeneratedScenario> { scen }, CanonicalDiff);
        }

        private static object RunDuplicateInBatch()
        {
            var plan = BuildPlan(
                Evidence("ev-1", SamplePath, "right", RightLine13, "Baz() => 3"));
            var scen1 = BuildValidScenario(refs: new List<string> { "ev-1" }, sketchId: "sk-1");
            var scen2 = BuildValidScenario(refs: new List<string> { "ev-1" }, sketchId: "sk-2");
            scen2.Title = "Different title — same behaviour";
            return RunCase("duplicate_in_batch", plan,
                new List<EdogQaLlmClient.GeneratedScenario> { scen1, scen2 }, CanonicalDiff);
        }

        private static object RunMultiFailureSingleScenario()
        {
            var plan = BuildPlan(
                Evidence("ev-1", SamplePath, "right", RightLine13, "Baz() => 3"));
            var scen = BuildValidScenario(refs: new List<string> { "ev-bogus" }, sketchId: "sk-1");
            scen.Title = string.Empty;
            scen.Priority = 0;
            scen.Expectations[0].Topic = "made-up-topic";
            return RunCase("multi_failure", plan, new List<EdogQaLlmClient.GeneratedScenario> { scen }, CanonicalDiff);
        }

        // ── Test plumbing ──────────────────────────────────────────────

        private static object RunCase(
            string caseId,
            EdogQaLlmClient.ArchitectPlan plan,
            List<EdogQaLlmClient.GeneratedScenario> scenarios,
            string diff)
        {
            var ctx = new EdogQaScenarioValidator.ValidationContext { ValidTopics = StubTopics };
            var r = EdogQaScenarioValidator.Validate(plan, scenarios, diff, ctx);

            var acceptedDigests = r.Accepted
                .Select(a => new
                {
                    sketchId = a.Scenario.Id,
                    semanticHash = a.SemanticHash,
                    calibratedConfidence = a.CalibratedConfidence,
                    informationalCodes = a.InformationalReasons.Select(i => i.Code).OrderBy(s => s, StringComparer.Ordinal).ToList(),
                })
                .ToList();

            var quarantinedDigests = r.Quarantined
                .Select(q => new
                {
                    sketchId = q.Scenario.Id,
                    codes = q.Reasons.Select(rr => rr.Code).OrderBy(s => s, StringComparer.Ordinal).ToList(),
                    fieldPaths = q.Reasons.Select(rr => rr.FieldPath ?? string.Empty).OrderBy(s => s, StringComparer.Ordinal).ToList(),
                    evidenceIds = r.Quarantined
                        .First(qq => qq.Scenario == q.Scenario).Reasons
                        .Where(rr => rr.EvidenceId != null)
                        .Select(rr => rr.EvidenceId).Distinct().OrderBy(s => s, StringComparer.Ordinal).ToList(),
                })
                .ToList();

            return new
            {
                caseId,
                acceptedCount = r.Accepted.Count,
                quarantinedCount = r.Quarantined.Count,
                accepted = acceptedDigests,
                quarantined = quarantinedDigests,
                batchErrors = r.BatchErrors.Select(be => be.Code).OrderBy(s => s, StringComparer.Ordinal).ToList(),
            };
        }

        private static EdogQaLlmClient.ArchitectGroundingEvidence Evidence(
            string evidenceId, string path, string side, int newLine, string reason)
        {
            return new EdogQaLlmClient.ArchitectGroundingEvidence
            {
                EvidenceId = evidenceId,
                RepoRelativePath = path,
                Side = side,
                BaseSha = "abc123",
                HunkId = "h-1",
                NewLine = newLine,
                Excerpt = "fake snippet",
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

        private static EdogQaLlmClient.GeneratedScenario BuildValidScenario(List<string> refs, string sketchId)
        {
            return new EdogQaLlmClient.GeneratedScenario
            {
                Id = sketchId,
                Title = "Baz returns 3 on initial call",
                Description = "When Baz is invoked it must return 3 for a freshly constructed Foo.",
                Category = "HappyPath",
                Priority = 2,
                ImpactZone = "zone-001",
                Technique = "EquivalencePartition",
                StimulusType = "DirectInvoke",
                StimulusSpec = "{\"serviceType\":\"IFoo\",\"method\":\"Baz\",\"args\":[]}",
                Expectations = new List<EdogQaLlmClient.GeneratedExpectation>
                {
                    new EdogQaLlmClient.GeneratedExpectation
                    {
                        Type = "FieldMatch",
                        Topic = "log",
                        MatcherSpec = "{\"exact\":{\"returnValue\":3}}",
                        Rationale = "Direct return value must be 3.",
                    },
                },
                TimeoutMs = 5_000,
                GroundingEvidenceRefs = refs,
                Confidence = 0.85,
            };
        }

        private static object CaptureDiffParseSample(string diff, string label)
        {
            var set = EdogQaScenarioValidator.ParseChangedLines(diff);
            return new
            {
                label,
                changedLineCount = set.Count,
                rightLines = set.Where(t => t.Side == "right").Select(t => new { t.Path, t.Line })
                    .OrderBy(x => x.Line).ToList(),
                leftLines = set.Where(t => t.Side == "left").Select(t => new { t.Path, t.Line })
                    .OrderBy(x => x.Line).ToList(),
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
