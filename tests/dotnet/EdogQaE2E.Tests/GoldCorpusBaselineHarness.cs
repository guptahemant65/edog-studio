// <copyright file="GoldCorpusBaselineHarness.cs" company="Microsoft">
// Copyright (c) Microsoft Corporation. All rights reserved.
// </copyright>
//
// F27 P9 T1c-c — Gold-corpus baseline harness.
//
// Drives the **real** V2 pipeline (EdogQaLlmClient.Architect →
// EdogQaLlmClient.Editor → EdogQaScenarioValidator → EdogQaScenarioProjector)
// against a single fixture from tests/qa-eval/ground-truth/, captures
// token / latency / scenario-count / violation-count metrics, and emits a
// single JSON envelope on stdout under the HARNESS-JSON-BEGIN/END markers.
//
// Usage:
//   dotnet <harness-dll> gold-corpus-baseline --fixture <path-to-fixture-dir>
//
// Required env (read once at start; emits CONFIG_MISSING if absent):
//   AZURE_OPENAI_ENDPOINT  + AZURE_OPENAI_API_KEY  (or the *_ARCHITECT /
//   *_EDITOR / *_PRO fallbacks read by EdogQaLlmClient.ReadXxxConfigFromEnv).
//
// This harness makes **real outbound HTTPS calls** to Azure OpenAI and
// **spends real money** — the user has authorised live capture against
// the 3-PR gold corpus. It is invoked explicitly by tests/qa-eval/capture_baseline.py
// during the T1c-c capture pass and is NOT exercised by the default
// pytest gauntlet (the test in tests/test_qa_e2e.py only pins the
// resulting baseline.json shape, not the harness behaviour).
//
// Honest framing for the captured numbers: this is the V2 pipeline's
// per-fixture snapshot (the **floor V2 must beat** in future tuning).
// recall / precision are intentionally NOT computed here — those require
// the ground-truth expected.json files to complete human grading (T2),
// and recording fake recall/precision before that would lie to the
// regression detector.

#nullable disable

namespace Microsoft.LiveTable.Service.DevMode.E2ETests
{
    using System;
    using System.Collections.Generic;
    using System.Diagnostics;
    using System.IO;
    using System.Linq;
    using System.Net.Http;
    using System.Text.Json;
    using System.Threading;
    using System.Threading.Tasks;
    using Microsoft.LiveTable.Service.DevMode;

    internal static class GoldCorpusBaselineHarness
    {
        // Matches EdogQaCodeAnalyzer.ValidTopics — the production list the
        // validator's topic gate compares against. Kept in sync manually;
        // a drift here means the harness over- or under-counts TOPIC_UNKNOWN
        // violations vs what the real analyzer would.
        private static readonly List<string> ValidTopics = new()
        {
            "http", "token", "flag", "perf", "spark", "log",
            "telemetry", "retry", "cache", "fileop", "catalog",
            "dag", "flt-ops", "nexus", "di", "capacity",
        };

        public static async Task<int> RunAsync(string[] args, CancellationToken ct)
        {
            string fixturePath = ExtractArg(args, "--fixture");
            string writeActualPath = ExtractArg(args, "--write-actual");
            string writePlanPath = ExtractArg(args, "--write-plan");
            if (fixturePath == null)
            {
                EmitFailure("ARG_MISSING_FIXTURE", "usage: gold-corpus-baseline --fixture <fixture-dir> [--write-actual <path>] [--write-plan <path>]");
                return 2;
            }

            if (!Directory.Exists(fixturePath))
            {
                EmitFailure("FIXTURE_NOT_FOUND", $"fixture directory not found: {fixturePath}");
                return 2;
            }

            string prJsonPath = Path.Combine(fixturePath, "pr.json");
            string diffPath = Path.Combine(fixturePath, "diff.patch");
            if (!File.Exists(prJsonPath) || !File.Exists(diffPath))
            {
                EmitFailure("FIXTURE_INCOMPLETE", $"missing pr.json or diff.patch under {fixturePath}");
                return 2;
            }

            PrMetadata prMeta;
            try
            {
                var prText = await File.ReadAllTextAsync(prJsonPath, ct).ConfigureAwait(false);
                prMeta = JsonSerializer.Deserialize<PrMetadata>(prText, new JsonSerializerOptions
                {
                    PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
                });
            }
            catch (Exception ex)
            {
                EmitFailure("PR_METADATA_UNPARSEABLE", $"{ex.GetType().Name}: {ex.Message}");
                return 2;
            }

            string diffContent = await File.ReadAllTextAsync(diffPath, ct).ConfigureAwait(false);

            // Cap the diff to a sane size to avoid blowing through the
            // model context window — the orchestrator does the same trim
            // in production. 60 KB is the largest fixture we have today.
            const int MaxDiffBytes = 80 * 1024;
            if (diffContent.Length > MaxDiffBytes)
            {
                diffContent = diffContent.Substring(0, MaxDiffBytes)
                    + "\n[diff truncated at 80 KB by gold-corpus-baseline harness]\n";
            }

            var archConfig = EdogQaLlmClient.ReadArchitectConfigFromEnv();
            var editorConfig = EdogQaLlmClient.ReadEditorConfigFromEnv();
            if (string.IsNullOrWhiteSpace(archConfig.Endpoint) || string.IsNullOrWhiteSpace(archConfig.ApiKey))
            {
                EmitFailure("CONFIG_MISSING", "AZURE_OPENAI_ENDPOINT or AZURE_OPENAI_API_KEY (or *_ARCHITECT_*) not set");
                return 2;
            }

            var zone = new EdogQaLlmClient.ZoneContext
            {
                ZoneId = $"PR-{prMeta.PrNumber ?? "unknown"}-full-diff",
                ZoneSummary = prMeta.Description ?? prMeta.Title ?? string.Empty,
                UntrustedRedactedDiff = diffContent,
                BaseSha = prMeta.BaseSha ?? string.Empty,
                HeadSha = prMeta.HeadSha ?? string.Empty,
            };

            // Real HttpClient — no fake handler. EdogQaLlmClient handles
            // its own per-call timeouts via the CancellationToken; we
            // wrap with a generous outer timeout so a stuck call cannot
            // wedge the capture indefinitely.
            using var httpClient = new HttpClient
            {
                Timeout = TimeSpan.FromMinutes(10),
            };
            using var linkedCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            linkedCts.CancelAfter(TimeSpan.FromMinutes(12));

            // ── Architect ─────────────────────────────────────────────
            var archResult = await EdogQaLlmClient
                .ArchitectOnceAsync(httpClient, archConfig, zone, linkedCts.Token)
                .ConfigureAwait(false);

            // T1h: dump the architect plan JSON for diagnostic triage if requested.
            // We do this BEFORE the architect-failed bail so a failure case (no
            // sketches / invalid plan) still surfaces what was attempted.
            if (!string.IsNullOrWhiteSpace(writePlanPath) && archResult?.Plan != null)
            {
                try
                {
                    WriteArchitectPlanJson(writePlanPath, prMeta, archResult.Plan);
                }
                catch (Exception ex)
                {
                    EmitFailure("PLAN_WRITE_FAILED", $"{ex.GetType().Name}: {ex.Message}");
                    return 2;
                }
            }

            if (archResult.Status == EdogQaLlmClient.LlmClientStatus.Failed)
            {
                EmitPartial(prMeta, "ARCHITECT_FAILED", archResult, editor: null,
                    validation: null, projection: null, diffContent);
                return 0;
            }

            if (archResult.Status == EdogQaLlmClient.LlmClientStatus.NoTestableChanges)
            {
                EmitPartial(prMeta, "NO_TESTABLE_CHANGES", archResult, editor: null,
                    validation: null, projection: null, diffContent);
                return 0;
            }

            // ── Editor ────────────────────────────────────────────────
            var editorResult = await EdogQaLlmClient
                .EditorOnceAsync(httpClient, editorConfig, archResult.Plan, zone, linkedCts.Token)
                .ConfigureAwait(false);

            if (editorResult.Status == EdogQaLlmClient.LlmClientStatus.Failed)
            {
                EmitPartial(prMeta, "EDITOR_FAILED", archResult, editorResult,
                    validation: null, projection: null, diffContent);
                return 0;
            }

            // ── Validator ─────────────────────────────────────────────
            var validationCtx = new EdogQaScenarioValidator.ValidationContext
            {
                ValidTopics = ValidTopics,
                ConfidenceCapIsInformational = true,
            };
            var validation = EdogQaScenarioValidator.Validate(
                archResult.Plan,
                editorResult.Scenarios,
                diffContent,
                validationCtx);

            // ── Projector ─────────────────────────────────────────────
            var projection = EdogQaScenarioProjector.Project(
                archResult.Plan,
                validation.Accepted);

            // T1f-b: optionally emit actuals payload for score_eval.py.
            if (!string.IsNullOrWhiteSpace(writeActualPath))
            {
                try
                {
                    WriteActualJson(
                        writeActualPath,
                        prMeta,
                        archResult.Plan,
                        editorResult.Scenarios,
                        validation.Accepted,
                        projection.Projected);
                }
                catch (Exception ex)
                {
                    EmitFailure("ACTUAL_WRITE_FAILED", $"{ex.GetType().Name}: {ex.Message}");
                    return 2;
                }
            }

            EmitPartial(prMeta, "OK", archResult, editorResult, validation, projection, diffContent);
            return 0;
        }

        private static string ExtractArg(string[] args, string name)
        {
            for (int i = 0; i < args.Length - 1; i++)
            {
                if (args[i] == name)
                {
                    return args[i + 1];
                }
            }

            return null;
        }

        // ── T1f-b: actuals shape that score_eval.py consumes ──────────
        // We emit each scenario at its highest-reached pipeline stage:
        //   emitted   = Editor returned it (raw Editor output)
        //   validated = passed EdogQaScenarioValidator (subset of emitted)
        //   projected = passed EdogQaScenarioProjector (subset of validated)
        // The scorer uses (category, verb, changed-line-overlap) as the
        // match key and reports precision per stage independently.
        private static void WriteActualJson(
            string outPath,
            PrMetadata prMeta,
            EdogQaLlmClient.ArchitectPlan plan,
            List<EdogQaLlmClient.GeneratedScenario> emittedScenarios,
            List<EdogQaScenarioValidator.AcceptedScenario> validatedScenarios,
            List<Scenario> projectedScenarios)
        {
            var evidenceById = new Dictionary<string, EdogQaLlmClient.ArchitectGroundingEvidence>(StringComparer.Ordinal);
            if (plan?.GroundingEvidence != null)
            {
                foreach (var ev in plan.GroundingEvidence)
                {
                    if (!string.IsNullOrWhiteSpace(ev?.EvidenceId))
                    {
                        evidenceById[ev.EvidenceId] = ev;
                    }
                }
            }

            var actuals = new List<Dictionary<string, object>>();
            var emittedIds = new HashSet<string>(StringComparer.Ordinal);
            var validatedIds = new HashSet<string>(StringComparer.Ordinal);
            var projectedIds = new HashSet<string>(StringComparer.Ordinal);

            if (projectedScenarios != null)
            {
                foreach (var s in projectedScenarios)
                {
                    if (s == null) continue;
                    projectedIds.Add(s.Id ?? string.Empty);
                    actuals.Add(BuildProjectedActual(s));
                }
            }

            if (validatedScenarios != null)
            {
                foreach (var accepted in validatedScenarios)
                {
                    var s = accepted?.Scenario;
                    if (s == null) continue;
                    validatedIds.Add(s.Id ?? string.Empty);
                    if (projectedIds.Contains(s.Id ?? string.Empty)) continue;
                    actuals.Add(BuildGeneratedActual(s, evidenceById, stage: "validated"));
                }
            }

            if (emittedScenarios != null)
            {
                foreach (var s in emittedScenarios)
                {
                    if (s == null) continue;
                    emittedIds.Add(s.Id ?? string.Empty);
                    var sid = s.Id ?? string.Empty;
                    if (projectedIds.Contains(sid) || validatedIds.Contains(sid)) continue;
                    actuals.Add(BuildGeneratedActual(s, evidenceById, stage: "emitted"));
                }
            }

            var payload = new
            {
                schema_version = "1.0",
                captured_at = DateTimeOffset.UtcNow.ToString("o"),
                pipeline = "v2_architect_editor",
                pr_number = prMeta?.PrNumber,
                counts = new
                {
                    emitted = emittedIds.Count,
                    validated = validatedIds.Count,
                    projected = projectedIds.Count,
                },
                scenarios = actuals,
            };

            var json = JsonSerializer.Serialize(payload, new JsonSerializerOptions
            {
                WriteIndented = true,
                DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.Never,
            });

            string dir = Path.GetDirectoryName(outPath);
            if (!string.IsNullOrWhiteSpace(dir) && !Directory.Exists(dir))
            {
                Directory.CreateDirectory(dir);
            }

            File.WriteAllText(outPath, json);
        }

        // T1h: serialize the architect plan as-is for diagnostic triage. We
        // project to plain dictionaries so curators can diff the plan
        // structure across iterations without binding to internal C# types.
        private static void WriteArchitectPlanJson(
            string outPath,
            PrMetadata prMeta,
            EdogQaLlmClient.ArchitectPlan plan)
        {
            var behavioralChanges = new List<Dictionary<string, object>>();
            if (plan.BehavioralChanges != null)
            {
                foreach (var bc in plan.BehavioralChanges)
                {
                    if (bc == null) continue;
                    behavioralChanges.Add(new Dictionary<string, object>
                    {
                        ["summary"] = bc.Summary,
                        ["evidence_refs"] = bc.EvidenceRefs ?? new List<string>(),
                    });
                }
            }

            var groundingEvidence = new List<Dictionary<string, object>>();
            if (plan.GroundingEvidence != null)
            {
                foreach (var ev in plan.GroundingEvidence)
                {
                    if (ev == null) continue;
                    groundingEvidence.Add(new Dictionary<string, object>
                    {
                        ["evidence_id"] = ev.EvidenceId,
                        ["repo_relative_path"] = ev.RepoRelativePath,
                        ["side"] = ev.Side,
                        ["base_sha"] = ev.BaseSha,
                        ["hunk_id"] = ev.HunkId,
                        ["new_line"] = ev.NewLine,
                        ["excerpt"] = ev.Excerpt,
                        ["reason"] = ev.Reason,
                    });
                }
            }

            var scenarioSketches = new List<Dictionary<string, object>>();
            if (plan.ScenarioSketches != null)
            {
                foreach (var sk in plan.ScenarioSketches)
                {
                    if (sk == null) continue;
                    scenarioSketches.Add(new Dictionary<string, object>
                    {
                        ["sketch_id"] = sk.SketchId,
                        ["title"] = sk.Title,
                        ["category"] = sk.Category,
                        ["technique"] = sk.Technique,
                        ["rationale"] = sk.Rationale,
                        ["evidence_refs"] = sk.EvidenceRefs ?? new List<string>(),
                    });
                }
            }

            var payload = new
            {
                schema_version = "1.0",
                captured_at = DateTimeOffset.UtcNow.ToString("o"),
                pipeline = "v2_architect_editor",
                pr_number = prMeta?.PrNumber,
                zone_id = plan.ZoneId,
                zone_summary = plan.ZoneSummary,
                plan_outcome = plan.PlanOutcome,
                counts = new
                {
                    behavioral_changes = behavioralChanges.Count,
                    grounding_evidence = groundingEvidence.Count,
                    scenario_sketches = scenarioSketches.Count,
                },
                behavioral_changes = behavioralChanges,
                grounding_evidence = groundingEvidence,
                scenario_sketches = scenarioSketches,
            };

            var json = JsonSerializer.Serialize(payload, new JsonSerializerOptions
            {
                WriteIndented = true,
                DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.Never,
            });

            string dir = Path.GetDirectoryName(outPath);
            if (!string.IsNullOrWhiteSpace(dir) && !Directory.Exists(dir))
            {
                Directory.CreateDirectory(dir);
            }

            File.WriteAllText(outPath, json);
        }

        private static Dictionary<string, object> BuildProjectedActual(Scenario s)
        {
            var grounding = new List<Dictionary<string, object>>();
            if (s.GroundingEvidence != null)
            {
                foreach (var ev in s.GroundingEvidence)
                {
                    if (ev == null || string.IsNullOrWhiteSpace(ev.File)) continue;
                    var lines = new List<int>();
                    int start = ev.StartLine > 0 ? ev.StartLine : 0;
                    int end = ev.EndLine >= start ? ev.EndLine : start;
                    for (int n = start; n <= end; n++)
                    {
                        if (n > 0) lines.Add(n);
                    }
                    if (lines.Count == 0) continue;
                    grounding.Add(new Dictionary<string, object>
                    {
                        ["path"] = ev.File,
                        ["side"] = "right",
                        ["lines"] = lines,
                    });
                }
            }

            return new Dictionary<string, object>
            {
                ["id"] = s.Id,
                ["topic"] = s.ImpactZone,
                ["category"] = s.Category.ToString(),
                ["verb"] = PrimaryExpectationType(s.Expectations),
                ["stage"] = "projected",
                ["grounding_changed_lines"] = grounding,
            };
        }

        private static Dictionary<string, object> BuildGeneratedActual(
            EdogQaLlmClient.GeneratedScenario s,
            IReadOnlyDictionary<string, EdogQaLlmClient.ArchitectGroundingEvidence> evidenceById,
            string stage)
        {
            var grounding = new List<Dictionary<string, object>>();
            if (s.GroundingEvidenceRefs != null)
            {
                foreach (var refId in s.GroundingEvidenceRefs)
                {
                    if (string.IsNullOrWhiteSpace(refId)) continue;
                    if (!evidenceById.TryGetValue(refId, out var ev) || ev == null) continue;
                    if (string.IsNullOrWhiteSpace(ev.RepoRelativePath) || ev.NewLine <= 0) continue;
                    grounding.Add(new Dictionary<string, object>
                    {
                        ["path"] = ev.RepoRelativePath,
                        ["side"] = string.Equals(ev.Side, "left", StringComparison.OrdinalIgnoreCase) ? "left" : "right",
                        ["lines"] = new List<int> { ev.NewLine },
                    });
                }
            }

            string verb = "EventPresent";
            if (s.Expectations != null && s.Expectations.Count > 0 && !string.IsNullOrWhiteSpace(s.Expectations[0].Type))
            {
                verb = s.Expectations[0].Type;
            }

            return new Dictionary<string, object>
            {
                ["id"] = s.Id,
                ["topic"] = s.ImpactZone,
                ["category"] = s.Category,
                ["verb"] = verb,
                ["stage"] = stage,
                ["grounding_changed_lines"] = grounding,
            };
        }

        private static string PrimaryExpectationType(List<Expectation> expectations)
        {
            if (expectations == null || expectations.Count == 0)
            {
                return "EventPresent";
            }

            return expectations[0].Type.ToString();
        }

        private static void EmitFailure(string status, string message)
        {
            EmitJson(new
            {
                ok = false,
                harness = "gold-corpus-baseline",
                status,
                message,
            });
        }

        private static void EmitPartial(
            PrMetadata prMeta,
            string status,
            EdogQaLlmClient.LlmClientResult arch,
            EdogQaLlmClient.LlmClientResult editor,
            EdogQaScenarioValidator.ValidationResult validation,
            EdogQaScenarioProjector.ProjectionResult projection,
            string diffContent)
        {
            var quarantineReasonCounts = validation == null
                ? new Dictionary<string, int>()
                : validation.Quarantined
                    .SelectMany(q => q.Reasons ?? new List<EdogQaScenarioValidator.QuarantineReason>())
                    .Where(r => !string.IsNullOrWhiteSpace(r.Code))
                    .GroupBy(r => r.Code, StringComparer.Ordinal)
                    .ToDictionary(g => g.Key, g => g.Count(), StringComparer.Ordinal);

            var projectorReasonCounts = projection == null
                ? new Dictionary<string, int>()
                : projection.Rejected
                    .SelectMany(q => q.Reasons ?? new List<EdogQaScenarioValidator.QuarantineReason>())
                    .Where(r => !string.IsNullOrWhiteSpace(r.Code))
                    .GroupBy(r => r.Code, StringComparer.Ordinal)
                    .ToDictionary(g => g.Key, g => g.Count(), StringComparer.Ordinal);

            // Grounding violations = the four GROUNDING_* codes (spec §3.3).
            int groundingViolations = quarantineReasonCounts
                .Where(kv => kv.Key != null && kv.Key.StartsWith("GROUNDING_", StringComparison.Ordinal))
                .Sum(kv => kv.Value);

            // Schema violations = the strict-mode-uncatchable codes from
            // T1c-a-1 (gate 2 + gate 3 + gate 5).
            string[] schemaCodes =
            {
                "FIELD_EMPTY", "FIELD_TOO_LONG", "FIELD_OUT_OF_RANGE",
                "ENUM_VALUE_INVALID", "EXPECTATIONS_MISSING", "TOPIC_UNKNOWN",
                "DUPLICATE_IN_BATCH",
            };
            int schemaViolations = quarantineReasonCounts
                .Where(kv => Array.IndexOf(schemaCodes, kv.Key) >= 0)
                .Sum(kv => kv.Value);

            var payload = new
            {
                ok = true,
                harness = "gold-corpus-baseline",
                pr_number = prMeta?.PrNumber,
                status,
                diff_bytes = diffContent?.Length ?? 0,
                architect = arch == null ? null : new
                {
                    elapsed_ms = arch.ArchitectElapsedMs,
                    input_tokens = arch.ArchitectInputTokens,
                    output_tokens = arch.ArchitectOutputTokens,
                    reasoning_tokens = arch.ArchitectReasoningTokens,
                    plan_outcome = arch.Plan?.PlanOutcome,
                    behavioral_changes = arch.Plan?.BehavioralChanges?.Count ?? 0,
                    evidence_count = arch.Plan?.GroundingEvidence?.Count ?? 0,
                    scenario_sketches = arch.Plan?.ScenarioSketches?.Count ?? 0,
                    errors = arch.Errors?.ToArray() ?? Array.Empty<string>(),
                },
                editor = editor == null ? null : new
                {
                    elapsed_ms = editor.EditorElapsedMs,
                    input_tokens = editor.EditorInputTokens,
                    output_tokens = editor.EditorOutputTokens,
                    scenarios_emitted = editor.Scenarios?.Count ?? 0,
                    errors = editor.Errors?.ToArray() ?? Array.Empty<string>(),
                },
                validator = validation == null ? null : new
                {
                    accepted = validation.Accepted?.Count ?? 0,
                    quarantined = validation.Quarantined?.Count ?? 0,
                    batch_errors = validation.BatchErrors?.Count ?? 0,
                    reason_counts = quarantineReasonCounts,
                },
                projector = projection == null ? null : new
                {
                    projected = projection.Projected?.Count ?? 0,
                    rejected = projection.Rejected?.Count ?? 0,
                    reason_counts = projectorReasonCounts,
                },
                summary = new
                {
                    scenario_count_final = projection?.Projected?.Count ?? 0,
                    grounding_violations = groundingViolations,
                    schema_violations = schemaViolations,
                },
            };

            EmitJson(payload);
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

        // ── Fixture pr.json shape (subset we read) ────────────────────
        private sealed class PrMetadata
        {
            public string PrNumber { get; set; }

            public string Title { get; set; }

            public string Description { get; set; }

            public string BaseSha { get; set; }

            public string HeadSha { get; set; }
        }
    }
}
