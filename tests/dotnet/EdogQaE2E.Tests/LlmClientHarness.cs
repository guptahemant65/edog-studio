// <copyright file="LlmClientHarness.cs" company="Microsoft">
// Copyright (c) Microsoft Corporation. All rights reserved.
// </copyright>
//
// F27 P9 T1b — Behavioural harness for EdogQaLlmClient.
//
// Exercises Architect + Editor paths via an injected FakeHandler that
// returns canned Azure OpenAI Responses-API envelopes, proving:
//
// Architect:
//   happy_path                  200 + valid plan envelope ⇒ Plan populated.
//   config_missing              empty endpoint/key ⇒ CLIENT_CONFIG_MISSING_ARCHITECT.
//   network_error               handler throws ⇒ ARCHITECT_NETWORK_ERROR.
//   response_unparseable        200 + bad JSON ⇒ ARCHITECT_RESPONSE_UNPARSEABLE.
//   truncated_status            200 + status="incomplete" ⇒ ARCHITECT_RESPONSE_UNPARSEABLE.
//   plan_invalid_zero_sketches  200 + planOutcome=testable + sketches=[] ⇒ ARCHITECT_PLAN_INVALID.
//   no_testable_changes         200 + planOutcome=no_testable_changes ⇒ Status=NoTestableChanges.
//
// Editor:
//   happy_path                  200 + scenarios with evidence subset ⇒ Scenarios populated.
//   config_missing              empty endpoint/key ⇒ CLIENT_CONFIG_MISSING_EDITOR.
//   network_error               handler throws ⇒ EDITOR_NETWORK_ERROR.
//   schema_violation            200 + scenario with title >120 chars ⇒ EDITOR_SCHEMA_VIOLATION.
//   grounding_violation         200 + scenario refs evidence not in plan ⇒ EDITOR_GROUNDING_VIOLATION.
//   response_unparseable        200 + bad JSON ⇒ EDITOR_RESPONSE_UNPARSEABLE.
//
// Wire shape (Architect + Editor request capture):
//   - hits /openai/responses with ?api-version= present
//   - has api-key header
//   - has strict json_schema in text.format
//   - Architect: effort=high + max_output_tokens=96000 + prompt_cache_key=edog-qa-architect-v2
//   - Editor:    effort=low  + max_output_tokens=32000 + prompt_cache_key=edog-qa-editor-v2
//
// Schema-strictness (recursive walk):
//   - Architect plan schema and scenario batch schema both pass
//     FindStrictSchemaViolations with zero violations.

#nullable disable

namespace Microsoft.LiveTable.Service.DevMode.E2ETests
{
    using System;
    using System.Collections.Generic;
    using System.Linq;
    using System.Net;
    using System.Net.Http;
    using System.Text.Json;
    using System.Threading;
    using System.Threading.Tasks;
    using Microsoft.LiveTable.Service.DevMode;

    internal static class LlmClientHarness
    {
        public static async Task<int> RunAsync(CancellationToken ct)
        {
            var architectCases = new List<object>
            {
                await RunArchitectHappyPathAsync(ct).ConfigureAwait(false),
                RunArchitectConfigMissing(),
                await RunArchitectNetworkErrorAsync(ct).ConfigureAwait(false),
                await RunArchitectResponseUnparseableAsync(ct).ConfigureAwait(false),
                await RunArchitectTruncatedStatusAsync(ct).ConfigureAwait(false),
                await RunArchitectPlanInvalidZeroSketchesAsync(ct).ConfigureAwait(false),
                await RunArchitectNoTestableChangesAsync(ct).ConfigureAwait(false),
            };

            var editorCases = new List<object>
            {
                await RunEditorHappyPathAsync(ct).ConfigureAwait(false),
                RunEditorConfigMissing(),
                await RunEditorNetworkErrorAsync(ct).ConfigureAwait(false),
                await RunEditorSchemaViolationAsync(ct).ConfigureAwait(false),
                await RunEditorGroundingViolationAsync(ct).ConfigureAwait(false),
                await RunEditorResponseUnparseableAsync(ct).ConfigureAwait(false),
            };

            var architectShape = await CaptureArchitectRequestShapeAsync(ct).ConfigureAwait(false);
            var editorShape = await CaptureEditorRequestShapeAsync(ct).ConfigureAwait(false);

            // Schema strictness — recursive walk of both schemas.
            var architectSchemaJson = JsonSerializer.Serialize(EdogQaLlmClient.BuildArchitectPlanSchema());
            var scenarioSchemaJson = JsonSerializer.Serialize(EdogQaLlmClient.BuildScenarioBatchSchema());
            var architectViolations = EdogQaLlmClient.FindStrictSchemaViolations(architectSchemaJson);
            var scenarioViolations = EdogQaLlmClient.FindStrictSchemaViolations(scenarioSchemaJson);

            EmitJson(new
            {
                ok = true,
                harness = "llm-client",
                architectCases,
                editorCases,
                architectRequestShape = architectShape,
                editorRequestShape = editorShape,
                schemaStrictness = new
                {
                    architectViolations,
                    scenarioViolations,
                },
                wireContract = new
                {
                    errorCodes = new[]
                    {
                        EdogQaLlmClient.ErrorCodeConfigMissingArchitect,
                        EdogQaLlmClient.ErrorCodeConfigMissingEditor,
                        EdogQaLlmClient.ErrorCodeArchitectNetworkError,
                        EdogQaLlmClient.ErrorCodeArchitectResponseUnparseable,
                        EdogQaLlmClient.ErrorCodeArchitectPlanInvalid,
                        EdogQaLlmClient.ErrorCodeEditorNetworkError,
                        EdogQaLlmClient.ErrorCodeEditorResponseUnparseable,
                        EdogQaLlmClient.ErrorCodeEditorSchemaViolation,
                        EdogQaLlmClient.ErrorCodeEditorGroundingViolation,
                    },
                    promptCacheKeyArchitect = EdogQaLlmClient.PromptCacheKeyArchitect,
                    promptCacheKeyEditor = EdogQaLlmClient.PromptCacheKeyEditor,
                    architectMaxOutputTokens = EdogQaLlmClient.ArchitectMaxOutputTokens,
                    editorMaxOutputTokens = EdogQaLlmClient.EditorMaxOutputTokens,
                },
            });
            return 0;
        }

        // ── Architect cases ───────────────────────────────────────────

        private static async Task<object> RunArchitectHappyPathAsync(CancellationToken ct)
        {
            var responseBody = ValidArchitectResponse(zoneId: "zone-001");
            var handler = new FakeHandler(_ => MakeResponse(HttpStatusCode.OK, responseBody));
            var result = await ArchitectOnce(handler, ct, endpoint: "https://aoai.example.test/", key: "test-key").ConfigureAwait(false);
            return SerializeArchitect("happy_path", result, handler);
        }

        private static object RunArchitectConfigMissing()
        {
            var handler = new FakeHandler(_ => throw new InvalidOperationException("must not call"));
            var result = ArchitectOnce(handler, default, endpoint: string.Empty, key: "test-key")
                .GetAwaiter().GetResult();
            return SerializeArchitect("config_missing", result, handler);
        }

        private static async Task<object> RunArchitectNetworkErrorAsync(CancellationToken ct)
        {
            var handler = new FakeHandler(_ => throw new HttpRequestException("simulated DNS failure"));
            var result = await ArchitectOnce(handler, ct, endpoint: "https://aoai.example.test/", key: "test-key").ConfigureAwait(false);
            return SerializeArchitect("network_error", result, handler);
        }

        private static async Task<object> RunArchitectResponseUnparseableAsync(CancellationToken ct)
        {
            var handler = new FakeHandler(_ => MakeResponse(HttpStatusCode.OK, "<html>not json</html>"));
            var result = await ArchitectOnce(handler, ct, endpoint: "https://aoai.example.test/", key: "test-key").ConfigureAwait(false);
            return SerializeArchitect("response_unparseable", result, handler);
        }

        private static async Task<object> RunArchitectTruncatedStatusAsync(CancellationToken ct)
        {
            // Azure OpenAI returns status="incomplete" when max_output_tokens is exhausted.
            // The client must reject that as unparseable rather than parse the partial output.
            const string body = "{\"status\":\"incomplete\",\"output\":[]}";
            var handler = new FakeHandler(_ => MakeResponse(HttpStatusCode.OK, body));
            var result = await ArchitectOnce(handler, ct, endpoint: "https://aoai.example.test/", key: "test-key").ConfigureAwait(false);
            return SerializeArchitect("truncated_status", result, handler);
        }

        private static async Task<object> RunArchitectPlanInvalidZeroSketchesAsync(CancellationToken ct)
        {
            // planOutcome=testable but zero sketches violates the post-decode invariant.
            var planJson = "{"
                + "\"zoneId\":\"zone-001\","
                + "\"zoneSummary\":\"changed thing\","
                + "\"planOutcome\":\"testable\","
                + "\"behavioralChanges\":[],"
                + "\"groundingEvidence\":[],"
                + "\"scenarioSketches\":[]"
                + "}";
            var responseBody = WrapAsResponsesEnvelope(planJson, reasoningTokens: 12);
            var handler = new FakeHandler(_ => MakeResponse(HttpStatusCode.OK, responseBody));
            var result = await ArchitectOnce(handler, ct, endpoint: "https://aoai.example.test/", key: "test-key").ConfigureAwait(false);
            return SerializeArchitect("plan_invalid_zero_sketches", result, handler);
        }

        private static async Task<object> RunArchitectNoTestableChangesAsync(CancellationToken ct)
        {
            var planJson = "{"
                + "\"zoneId\":\"zone-002\","
                + "\"zoneSummary\":\"comment-only edit\","
                + "\"planOutcome\":\"no_testable_changes\","
                + "\"behavioralChanges\":[],"
                + "\"groundingEvidence\":[],"
                + "\"scenarioSketches\":[]"
                + "}";
            var responseBody = WrapAsResponsesEnvelope(planJson, reasoningTokens: 3);
            var handler = new FakeHandler(_ => MakeResponse(HttpStatusCode.OK, responseBody));
            var result = await ArchitectOnce(handler, ct, endpoint: "https://aoai.example.test/", key: "test-key").ConfigureAwait(false);
            return SerializeArchitect("no_testable_changes", result, handler);
        }

        // ── Editor cases ──────────────────────────────────────────────

        private static async Task<object> RunEditorHappyPathAsync(CancellationToken ct)
        {
            var plan = BuildSamplePlan();
            var batchJson = ValidScenarioBatchJson(refIds: new[] { "ev-1", "ev-2" });
            var responseBody = WrapAsResponsesEnvelope(batchJson, reasoningTokens: 0);
            var handler = new FakeHandler(_ => MakeResponse(HttpStatusCode.OK, responseBody));
            var result = await EditorOnce(handler, ct, plan, endpoint: "https://aoai.example.test/", key: "test-key").ConfigureAwait(false);
            return SerializeEditor("happy_path", result, handler);
        }

        private static object RunEditorConfigMissing()
        {
            var plan = BuildSamplePlan();
            var handler = new FakeHandler(_ => throw new InvalidOperationException("must not call"));
            var result = EditorOnce(handler, default, plan, endpoint: "https://aoai.example.test/", key: string.Empty)
                .GetAwaiter().GetResult();
            return SerializeEditor("config_missing", result, handler);
        }

        private static async Task<object> RunEditorNetworkErrorAsync(CancellationToken ct)
        {
            var plan = BuildSamplePlan();
            var handler = new FakeHandler(_ => throw new HttpRequestException("simulated TLS failure"));
            var result = await EditorOnce(handler, ct, plan, endpoint: "https://aoai.example.test/", key: "test-key").ConfigureAwait(false);
            return SerializeEditor("network_error", result, handler);
        }

        private static async Task<object> RunEditorSchemaViolationAsync(CancellationToken ct)
        {
            var plan = BuildSamplePlan();
            // Title longer than 120 chars violates a post-decode bound.
            var longTitle = new string('A', 130);
            var batchJson = OneScenarioJson(
                id: "scn-bad-title-1",
                title: longTitle,
                description: "ok",
                priority: 2,
                timeoutMs: 5000,
                confidence: 0.8,
                evidenceRefs: new[] { "ev-1" });
            var responseBody = WrapAsResponsesEnvelope(batchJson, reasoningTokens: 0);
            var handler = new FakeHandler(_ => MakeResponse(HttpStatusCode.OK, responseBody));
            var result = await EditorOnce(handler, ct, plan, endpoint: "https://aoai.example.test/", key: "test-key").ConfigureAwait(false);
            return SerializeEditor("schema_violation", result, handler);
        }

        private static async Task<object> RunEditorGroundingViolationAsync(CancellationToken ct)
        {
            var plan = BuildSamplePlan(); // exposes evidenceIds: ev-1, ev-2
            // Editor references ev-99 which isn't in the plan ⇒ binding violation.
            var batchJson = OneScenarioJson(
                id: "scn-fabricated-1",
                title: "fabricated scenario",
                description: "this references evidence the architect did not surface",
                priority: 2,
                timeoutMs: 5000,
                confidence: 0.7,
                evidenceRefs: new[] { "ev-99" });
            var responseBody = WrapAsResponsesEnvelope(batchJson, reasoningTokens: 0);
            var handler = new FakeHandler(_ => MakeResponse(HttpStatusCode.OK, responseBody));
            var result = await EditorOnce(handler, ct, plan, endpoint: "https://aoai.example.test/", key: "test-key").ConfigureAwait(false);
            return SerializeEditor("grounding_violation", result, handler);
        }

        private static async Task<object> RunEditorResponseUnparseableAsync(CancellationToken ct)
        {
            var plan = BuildSamplePlan();
            var handler = new FakeHandler(_ => MakeResponse(HttpStatusCode.OK, "<html>not json</html>"));
            var result = await EditorOnce(handler, ct, plan, endpoint: "https://aoai.example.test/", key: "test-key").ConfigureAwait(false);
            return SerializeEditor("response_unparseable", result, handler);
        }

        // ── Wire-shape capture ────────────────────────────────────────

        private static async Task<object> CaptureArchitectRequestShapeAsync(CancellationToken ct)
        {
            var responseBody = ValidArchitectResponse(zoneId: "zone-001");
            var handler = new FakeHandler(_ => MakeResponse(HttpStatusCode.OK, responseBody));
            await ArchitectOnce(handler, ct, endpoint: "https://aoai.example.test/", key: "test-key").ConfigureAwait(false);

            var url = handler.LastUrl ?? string.Empty;
            var body = handler.LastBody ?? string.Empty;

            return new
            {
                url,
                hitsResponsesEndpoint = url.Contains("/openai/responses", StringComparison.OrdinalIgnoreCase)
                    && url.Contains("api-version=", StringComparison.OrdinalIgnoreCase),
                hasApiKeyHeader = handler.LastRequest?.Headers.Contains("api-key") == true,
                hasStrictJsonSchema = body.Contains("\"type\":\"json_schema\"", StringComparison.Ordinal)
                    && body.Contains("\"strict\":true", StringComparison.Ordinal),
                hasReasoningEffortHigh = body.Contains("\"effort\":\"high\"", StringComparison.Ordinal),
                hasMaxOutputTokens = body.Contains("\"max_output_tokens\":128000", StringComparison.Ordinal),
                hasPromptCacheKey = body.Contains("\"prompt_cache_key\":\"" + EdogQaLlmClient.PromptCacheKeyArchitect + "\"", StringComparison.Ordinal),
                modelMentioned = body.Contains("\"model\":\"gpt-5.4\"", StringComparison.Ordinal),
                schemaNamePinned = body.Contains("\"name\":\"" + EdogQaLlmClient.ArchitectSchemaName + "\"", StringComparison.Ordinal),
            };
        }

        private static async Task<object> CaptureEditorRequestShapeAsync(CancellationToken ct)
        {
            var plan = BuildSamplePlan();
            var batchJson = ValidScenarioBatchJson(refIds: new[] { "ev-1", "ev-2" });
            var responseBody = WrapAsResponsesEnvelope(batchJson, reasoningTokens: 0);
            var handler = new FakeHandler(_ => MakeResponse(HttpStatusCode.OK, responseBody));
            await EditorOnce(handler, ct, plan, endpoint: "https://aoai.example.test/", key: "test-key").ConfigureAwait(false);

            var url = handler.LastUrl ?? string.Empty;
            var body = handler.LastBody ?? string.Empty;

            return new
            {
                url,
                hitsResponsesEndpoint = url.Contains("/openai/responses", StringComparison.OrdinalIgnoreCase)
                    && url.Contains("api-version=", StringComparison.OrdinalIgnoreCase),
                hasApiKeyHeader = handler.LastRequest?.Headers.Contains("api-key") == true,
                hasStrictJsonSchema = body.Contains("\"type\":\"json_schema\"", StringComparison.Ordinal)
                    && body.Contains("\"strict\":true", StringComparison.Ordinal),
                hasReasoningEffortLow = body.Contains("\"effort\":\"low\"", StringComparison.Ordinal),
                hasMaxOutputTokens = body.Contains("\"max_output_tokens\":32000", StringComparison.Ordinal),
                hasPromptCacheKey = body.Contains("\"prompt_cache_key\":\"" + EdogQaLlmClient.PromptCacheKeyEditor + "\"", StringComparison.Ordinal),
                modelMentioned = body.Contains("\"model\":\"gpt-5.4-mini\"", StringComparison.Ordinal),
                schemaNamePinned = body.Contains("\"name\":\"" + EdogQaLlmClient.EditorSchemaName + "\"", StringComparison.Ordinal),
                planInPrompt = body.Contains("ARCHITECT PLAN", StringComparison.Ordinal),
                diffMarkedUntrusted = body.Contains("UNTRUSTED DIFF", StringComparison.Ordinal),
            };
        }

        // ── Plumbing ──────────────────────────────────────────────────

        private static async Task<EdogQaLlmClient.LlmClientResult> ArchitectOnce(
            FakeHandler handler,
            CancellationToken ct,
            string endpoint,
            string key)
        {
            using var client = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(10) };
            var cfg = new EdogQaLlmClient.ArchitectConfig
            {
                Endpoint = endpoint,
                ApiKey = key,
                Deployment = "gpt-5.4",
                ApiVersion = "2025-04-01-preview",
            };
            var zone = new EdogQaLlmClient.ZoneContext
            {
                ZoneId = "zone-001",
                ZoneSummary = "changed insights date contract to v2",
                UntrustedRedactedDiff = "--- a/Service/Insights.cs\n+++ b/Service/Insights.cs\n@@ -1,3 +1,3 @@\n-old\n+new\n",
                BaseSha = "abc123",
                HeadSha = "def456",
            };
            return await EdogQaLlmClient.ArchitectOnceAsync(client, cfg, zone, ct).ConfigureAwait(false);
        }

        private static async Task<EdogQaLlmClient.LlmClientResult> EditorOnce(
            FakeHandler handler,
            CancellationToken ct,
            EdogQaLlmClient.ArchitectPlan plan,
            string endpoint,
            string key)
        {
            using var client = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(10) };
            var cfg = new EdogQaLlmClient.EditorConfig
            {
                Endpoint = endpoint,
                ApiKey = key,
                Deployment = "gpt-5.4-mini",
                ApiVersion = "2025-04-01-preview",
            };
            var zone = new EdogQaLlmClient.ZoneContext
            {
                ZoneId = "zone-001",
                ZoneSummary = "changed insights date contract to v2",
                UntrustedRedactedDiff = "--- a/Service/Insights.cs\n+++ b/Service/Insights.cs\n@@ -1,3 +1,3 @@\n-old\n+new\n",
                BaseSha = "abc123",
                HeadSha = "def456",
            };
            return await EdogQaLlmClient.EditorOnceAsync(client, cfg, plan, zone, ct).ConfigureAwait(false);
        }

        private static HttpResponseMessage MakeResponse(HttpStatusCode status, string body)
        {
            return new HttpResponseMessage(status)
            {
                Content = new StringContent(body ?? string.Empty),
            };
        }

        // ── Canned bodies ─────────────────────────────────────────────

        private static string ValidArchitectResponse(string zoneId)
        {
            var planJson = "{"
                + $"\"zoneId\":\"{zoneId}\","
                + "\"zoneSummary\":\"changed Insights date contract\","
                + "\"planOutcome\":\"testable\","
                + "\"behavioralChanges\":["
                + "{\"summary\":\"date format flipped to ISO-8601\",\"evidenceRefs\":[\"ev-1\"]}"
                + "],"
                + "\"groundingEvidence\":["
                + "{\"evidenceId\":\"ev-1\",\"repoRelativePath\":\"Service/Insights.cs\",\"side\":\"right\",\"baseSha\":\"abc123\",\"hunkId\":\"h-1\",\"newLine\":42,\"excerpt\":\"return DateTime.UtcNow.ToString(\\\"O\\\");\",\"reason\":\"replaced format string\"},"
                + "{\"evidenceId\":\"ev-2\",\"repoRelativePath\":\"Service/Insights.cs\",\"side\":\"right\",\"baseSha\":\"abc123\",\"hunkId\":\"h-2\",\"newLine\":58,\"excerpt\":\"DateOnly.FromDateTime(...)\",\"reason\":\"replaced helper\"}"
                + "],"
                + "\"scenarioSketches\":["
                + "{\"sketchId\":\"sk-1\",\"title\":\"happy path emits ISO-8601\",\"category\":\"HappyPath\",\"technique\":\"HappyPath\",\"rationale\":\"verify new format\",\"evidenceRefs\":[\"ev-1\"]}"
                + "]"
                + "}";

            return WrapAsResponsesEnvelope(planJson, reasoningTokens: 200);
        }

        private static string WrapAsResponsesEnvelope(string innerJson, int reasoningTokens)
        {
            var escaped = innerJson.Replace("\\", "\\\\").Replace("\"", "\\\"");
            return "{"
                + "\"status\":\"completed\","
                + "\"model\":\"gpt-5.4-2026-03-05\","
                + "\"usage\":{"
                + "\"input_tokens\":1024,"
                + "\"output_tokens\":256,"
                + "\"output_tokens_details\":{\"reasoning_tokens\":" + reasoningTokens + "}"
                + "},"
                + "\"output\":["
                + "{\"type\":\"reasoning\",\"content\":[]},"
                + "{\"type\":\"message\",\"content\":[{\"type\":\"output_text\",\"text\":\"" + escaped + "\"}]}"
                + "]"
                + "}";
        }

        private static EdogQaLlmClient.ArchitectPlan BuildSamplePlan()
        {
            return new EdogQaLlmClient.ArchitectPlan
            {
                ZoneId = "zone-001",
                ZoneSummary = "changed Insights date contract",
                PlanOutcome = EdogQaLlmClient.PlanOutcomeTestable,
                BehavioralChanges = new List<EdogQaLlmClient.BehavioralChange>
                {
                    new() { Summary = "date format flipped", EvidenceRefs = new() { "ev-1" } },
                },
                GroundingEvidence = new List<EdogQaLlmClient.ArchitectGroundingEvidence>
                {
                    new()
                    {
                        EvidenceId = "ev-1",
                        RepoRelativePath = "Service/Insights.cs",
                        Side = "right",
                        BaseSha = "abc123",
                        HunkId = "h-1",
                        NewLine = 42,
                        Excerpt = "return DateTime.UtcNow.ToString(...);",
                        Reason = "format-string replacement",
                    },
                    new()
                    {
                        EvidenceId = "ev-2",
                        RepoRelativePath = "Service/Insights.cs",
                        Side = "right",
                        BaseSha = "abc123",
                        HunkId = "h-2",
                        NewLine = 58,
                        Excerpt = "DateOnly.FromDateTime(...)",
                        Reason = "helper replacement",
                    },
                },
                ScenarioSketches = new List<EdogQaLlmClient.ScenarioSketch>
                {
                    new()
                    {
                        SketchId = "sk-1",
                        Title = "happy path emits ISO-8601",
                        Category = "HappyPath",
                        Technique = "HappyPath",
                        Rationale = "verify new format",
                        EvidenceRefs = new() { "ev-1" },
                    },
                },
            };
        }

        private static string ValidScenarioBatchJson(string[] refIds)
        {
            var refsJson = "[" + string.Join(",", refIds.Select(r => "\"" + r + "\"")) + "]";
            return "{"
                + "\"scenarios\":["
                + "{"
                + "\"id\":\"scn-happy-1\","
                + "\"title\":\"happy path emits ISO-8601\","
                + "\"description\":\"calls insights and verifies ISO-8601 date format\","
                + "\"category\":\"HappyPath\","
                + "\"priority\":2,"
                + "\"impactZone\":\"zone-001\","
                + "\"technique\":\"HappyPath\","
                + "\"stimulusType\":\"HttpRequest\","
                + "\"stimulusSpec\":\"{\\\"method\\\":\\\"GET\\\",\\\"path\\\":\\\"/api/insights\\\"}\","
                + "\"expectations\":["
                + "{\"type\":\"FieldMatch\",\"topic\":\"http\",\"matcherSpec\":\"{\\\"path\\\":\\\"$.body.date\\\",\\\"regex\\\":\\\"^\\\\\\\\d{4}-\\\\\\\\d{2}-\\\\\\\\d{2}T.*$\\\"}\",\"rationale\":\"ISO-8601\"}"
                + "],"
                + "\"timeoutMs\":15000,"
                + "\"groundingEvidenceRefs\":" + refsJson + ","
                + "\"confidence\":0.85"
                + "}"
                + "]"
                + "}";
        }

        private static string OneScenarioJson(
            string id,
            string title,
            string description,
            int priority,
            int timeoutMs,
            double confidence,
            string[] evidenceRefs)
        {
            var refsJson = "[" + string.Join(",", evidenceRefs.Select(r => "\"" + r + "\"")) + "]";
            var titleEscaped = title.Replace("\\", "\\\\").Replace("\"", "\\\"");
            var descEscaped = description.Replace("\\", "\\\\").Replace("\"", "\\\"");
            return "{"
                + "\"scenarios\":["
                + "{"
                + $"\"id\":\"{id}\","
                + $"\"title\":\"{titleEscaped}\","
                + $"\"description\":\"{descEscaped}\","
                + "\"category\":\"HappyPath\","
                + $"\"priority\":{priority},"
                + "\"impactZone\":\"zone-001\","
                + "\"technique\":\"HappyPath\","
                + "\"stimulusType\":\"HttpRequest\","
                + "\"stimulusSpec\":\"{}\","
                + "\"expectations\":["
                + "{\"type\":\"EventPresent\",\"topic\":\"http\",\"matcherSpec\":\"{}\",\"rationale\":\"baseline\"}"
                + "],"
                + $"\"timeoutMs\":{timeoutMs},"
                + $"\"groundingEvidenceRefs\":{refsJson},"
                + $"\"confidence\":{confidence.ToString(System.Globalization.CultureInfo.InvariantCulture)}"
                + "}"
                + "]"
                + "}";
        }

        // ── Serialisation ─────────────────────────────────────────────

        private static object SerializeArchitect(string caseId, EdogQaLlmClient.LlmClientResult r, FakeHandler handler)
        {
            return new
            {
                caseId,
                status = r.Status.ToString(),
                planNonNull = r.Plan != null,
                planOutcome = r.Plan?.PlanOutcome,
                sketchCount = r.Plan?.ScenarioSketches?.Count ?? 0,
                evidenceCount = r.Plan?.GroundingEvidence?.Count ?? 0,
                architectInputTokens = r.ArchitectInputTokens,
                architectOutputTokens = r.ArchitectOutputTokens,
                architectReasoningTokens = r.ArchitectReasoningTokens,
                errorCodes = r.Errors
                    .Select(e => (e.Split(' ', 2)[0] ?? string.Empty).Trim())
                    .Where(c => !string.IsNullOrEmpty(c))
                    .ToArray(),
                errorCount = r.Errors.Count,
                handlerInvocations = handler.InvocationCount,
            };
        }

        private static object SerializeEditor(string caseId, EdogQaLlmClient.LlmClientResult r, FakeHandler handler)
        {
            return new
            {
                caseId,
                status = r.Status.ToString(),
                scenarioCount = r.Scenarios?.Count ?? 0,
                editorInputTokens = r.EditorInputTokens,
                editorOutputTokens = r.EditorOutputTokens,
                errorCodes = r.Errors
                    .Select(e => (e.Split(' ', 2)[0] ?? string.Empty).Trim())
                    .Where(c => !string.IsNullOrEmpty(c))
                    .ToArray(),
                errorCount = r.Errors.Count,
                handlerInvocations = handler.InvocationCount,
            };
        }

        // ── Fake handler ──────────────────────────────────────────────

        private sealed class FakeHandler : HttpMessageHandler
        {
            private readonly Func<HttpRequestMessage, HttpResponseMessage> _responder;

            public FakeHandler(Func<HttpRequestMessage, HttpResponseMessage> responder)
            {
                _responder = responder;
            }

            public int InvocationCount { get; private set; }

            public HttpRequestMessage LastRequest { get; private set; }

            public string LastUrl { get; private set; }

            public string LastBody { get; private set; }

            protected override async Task<HttpResponseMessage> SendAsync(
                HttpRequestMessage request, CancellationToken cancellationToken)
            {
                InvocationCount++;
                LastRequest = request;
                LastUrl = request.RequestUri?.ToString();
                if (request.Content != null)
                {
                    LastBody = await request.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
                }
                else
                {
                    LastBody = string.Empty;
                }

                var resp = _responder(request);
                if (resp != null) resp.RequestMessage = request;

                // T4-D streaming bridge: when the caller asked for stream:true
                // (Architect post-streaming), repackage the canned response
                // envelope as a single-event SSE feed (event: response.completed)
                // so the production SSE parser can unwrap it. Editor calls do
                // not set stream:true, so their responses pass through.
                if (resp != null
                    && resp.IsSuccessStatusCode
                    && resp.Content != null
                    && LastBody.IndexOf("\"stream\":true", StringComparison.Ordinal) >= 0)
                {
                    var envelope = await resp.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
                    var sse = "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":" + envelope + "}\n\n";
                    resp.Content = new StringContent(sse, System.Text.Encoding.UTF8, "text/event-stream");
                }

                return resp;
            }
        }

        // ── JSON output ───────────────────────────────────────────────

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
