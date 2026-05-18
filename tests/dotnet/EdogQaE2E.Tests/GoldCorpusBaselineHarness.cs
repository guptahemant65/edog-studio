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
            string fixturePath = ExtractFixturePath(args);
            if (fixturePath == null)
            {
                EmitFailure("ARG_MISSING_FIXTURE", "usage: gold-corpus-baseline --fixture <fixture-dir>");
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

            EmitPartial(prMeta, "OK", archResult, editorResult, validation, projection, diffContent);
            return 0;
        }

        private static string ExtractFixturePath(string[] args)
        {
            for (int i = 0; i < args.Length - 1; i++)
            {
                if (args[i] == "--fixture")
                {
                    return args[i + 1];
                }
            }

            return null;
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
