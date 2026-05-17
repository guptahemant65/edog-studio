// <copyright file="CapabilityProbeHarness.cs" company="Microsoft">
// Copyright (c) Microsoft Corporation. All rights reserved.
// </copyright>
//
// F27 P9 T1a — Behavioural harness for EdogQaCapabilityProbe.
//
// Exercises every branch of ProbeOnceAsync with a FakeHandler that
// returns canned Azure OpenAI responses, proving:
//
//   happy_path                 200 + valid envelope ⇒ IsReady=true, all 4 caps set.
//   config_missing             empty endpoint or key ⇒ PROBE_CONFIG_MISSING.
//   network_error              FakeHandler throws ⇒ PROBE_NETWORK_ERROR.
//   deployment_not_found       404 with "DeploymentNotFound" ⇒ AOAI_DEPLOYMENT_NOT_FOUND.
//   responses_api_unavailable  404 without DeploymentNotFound ⇒ AOAI_RESPONSES_API_UNAVAILABLE.
//   json_schema_unsupported    400 with "text.format" ⇒ AOAI_JSON_SCHEMA_STRICT_UNSUPPORTED.
//   reasoning_unsupported      200 without reasoning_tokens ⇒ AOAI_REASONING_UNSUPPORTED.
//   response_unparseable       200 with bad JSON ⇒ PROBE_RESPONSE_UNPARSEABLE.
//
// Emits a single JSON block delimited by HARNESS-JSON-BEGIN / END.

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

    internal static class CapabilityProbeHarness
    {
        public static async Task<int> RunAsync(CancellationToken ct)
        {
            var cases = new List<object>
            {
                await RunHappyPathAsync(ct).ConfigureAwait(false),
                RunConfigMissingNoEndpoint(),
                RunConfigMissingNoKey(),
                await RunNetworkErrorAsync(ct).ConfigureAwait(false),
                await RunDeploymentNotFoundAsync(ct).ConfigureAwait(false),
                await RunResponsesApiUnavailableAsync(ct).ConfigureAwait(false),
                await RunJsonSchemaUnsupportedAsync(ct).ConfigureAwait(false),
                await RunReasoningUnsupportedAsync(ct).ConfigureAwait(false),
                await RunResponseUnparseableAsync(ct).ConfigureAwait(false),
            };

            // Sanity: the request shape we emit must include strict json_schema
            // + reasoning.effort=low — those are the wire-level promises the
            // probe makes to the orchestrator and we want a regression guard.
            var captured = await CaptureRequestShapeAsync(ct).ConfigureAwait(false);

            EmitJson(new
            {
                ok = true,
                harness = "capability-probe",
                cases,
                requestShape = captured,
                wireContract = new
                {
                    errorCodes = new[]
                    {
                        EdogQaCapabilityProbe.ErrorCodeDeploymentNotFound,
                        EdogQaCapabilityProbe.ErrorCodeResponsesApiUnavailable,
                        EdogQaCapabilityProbe.ErrorCodeJsonSchemaStrictUnsupported,
                        EdogQaCapabilityProbe.ErrorCodeReasoningUnsupported,
                        EdogQaCapabilityProbe.ErrorCodeConfigMissing,
                        EdogQaCapabilityProbe.ErrorCodeNetworkError,
                        EdogQaCapabilityProbe.ErrorCodeResponseUnparseable,
                    },
                },
            });
            return 0;
        }

        // ── Cases ──────────────────────────────────────────────────────

        private static async Task<object> RunHappyPathAsync(CancellationToken ct)
        {
            var responseBody = ValidResponseBody(reasoningTokens: 42);
            var handler = new FakeHandler(_ => MakeResponse(HttpStatusCode.OK, responseBody));
            var result = await ProbeWithHandler(handler, ct, endpoint: "https://aoai.example.test/", key: "test-key", deployment: "gpt-5.4").ConfigureAwait(false);
            return Serialize("happy_path", result, handler);
        }

        private static object RunConfigMissingNoEndpoint()
        {
            // Endpoint blank — probe must short-circuit before touching the handler.
            var handler = new FakeHandler(_ => throw new InvalidOperationException("must not call"));
            var result = ProbeWithHandler(handler, default, endpoint: "", key: "test-key", deployment: "gpt-5.4")
                .GetAwaiter().GetResult();
            return Serialize("config_missing_no_endpoint", result, handler);
        }

        private static object RunConfigMissingNoKey()
        {
            var handler = new FakeHandler(_ => throw new InvalidOperationException("must not call"));
            var result = ProbeWithHandler(handler, default, endpoint: "https://aoai.example.test/", key: "", deployment: "gpt-5.4")
                .GetAwaiter().GetResult();
            return Serialize("config_missing_no_key", result, handler);
        }

        private static async Task<object> RunNetworkErrorAsync(CancellationToken ct)
        {
            var handler = new FakeHandler(_ => throw new HttpRequestException("simulated DNS failure"));
            var result = await ProbeWithHandler(handler, ct, endpoint: "https://aoai.example.test/", key: "test-key", deployment: "gpt-5.4").ConfigureAwait(false);
            return Serialize("network_error", result, handler);
        }

        private static async Task<object> RunDeploymentNotFoundAsync(CancellationToken ct)
        {
            // Real Azure 404 body: {"error":{"code":"DeploymentNotFound","message":"..."}}
            const string body = "{\"error\":{\"code\":\"DeploymentNotFound\",\"message\":\"The API deployment for this resource does not exist.\"}}";
            var handler = new FakeHandler(_ => MakeResponse(HttpStatusCode.NotFound, body));
            var result = await ProbeWithHandler(handler, ct, endpoint: "https://aoai.example.test/", key: "test-key", deployment: "gpt-bogus").ConfigureAwait(false);
            return Serialize("deployment_not_found", result, handler);
        }

        private static async Task<object> RunResponsesApiUnavailableAsync(CancellationToken ct)
        {
            // 404 not signalling deployment-missing ⇒ Responses API absent.
            const string body = "{\"error\":{\"code\":\"NotFound\",\"message\":\"Resource not found\"}}";
            var handler = new FakeHandler(_ => MakeResponse(HttpStatusCode.NotFound, body));
            var result = await ProbeWithHandler(handler, ct, endpoint: "https://aoai.example.test/", key: "test-key", deployment: "gpt-5.4").ConfigureAwait(false);
            return Serialize("responses_api_unavailable", result, handler);
        }

        private static async Task<object> RunJsonSchemaUnsupportedAsync(CancellationToken ct)
        {
            // 400 rejecting strict json_schema.
            const string body = "{\"error\":{\"code\":\"BadRequest\",\"message\":\"Unsupported value for text.format.type: 'json_schema'\"}}";
            var handler = new FakeHandler(_ => MakeResponse(HttpStatusCode.BadRequest, body));
            var result = await ProbeWithHandler(handler, ct, endpoint: "https://aoai.example.test/", key: "test-key", deployment: "gpt-5.4").ConfigureAwait(false);
            return Serialize("json_schema_unsupported", result, handler);
        }

        private static async Task<object> RunReasoningUnsupportedAsync(CancellationToken ct)
        {
            // 200 envelope but usage.output_tokens_details absent ⇒ not reasoning-capable.
            const string body = "{\"status\":\"completed\",\"model\":\"gpt-4o\","
                + "\"usage\":{\"input_tokens\":11,\"output_tokens\":7},"
                + "\"output\":[{\"type\":\"message\",\"content\":[{\"type\":\"output_text\",\"text\":\"{\\\"ok\\\":true}\"}]}]}";
            var handler = new FakeHandler(_ => MakeResponse(HttpStatusCode.OK, body));
            var result = await ProbeWithHandler(handler, ct, endpoint: "https://aoai.example.test/", key: "test-key", deployment: "gpt-4o").ConfigureAwait(false);
            return Serialize("reasoning_unsupported", result, handler);
        }

        private static async Task<object> RunResponseUnparseableAsync(CancellationToken ct)
        {
            // 200 with body that is not JSON at all.
            var handler = new FakeHandler(_ => MakeResponse(HttpStatusCode.OK, "<html>oops</html>"));
            var result = await ProbeWithHandler(handler, ct, endpoint: "https://aoai.example.test/", key: "test-key", deployment: "gpt-5.4").ConfigureAwait(false);
            return Serialize("response_unparseable", result, handler);
        }

        private static async Task<object> CaptureRequestShapeAsync(CancellationToken ct)
        {
            // Send back a happy-path envelope so the probe doesn't error
            // before we get to inspect the request body.
            var responseBody = ValidResponseBody(reasoningTokens: 1);
            var handler = new FakeHandler(_ => MakeResponse(HttpStatusCode.OK, responseBody));
            await ProbeWithHandler(handler, ct, endpoint: "https://aoai.example.test/", key: "test-key", deployment: "gpt-5.4").ConfigureAwait(false);

            var url = handler.LastUrl ?? string.Empty;
            var body = handler.LastBody ?? string.Empty;
            var hasApiKeyHeader = handler.LastRequest?.Headers.Contains("api-key") == true;
            var hasStrictJsonSchema =
                body.Contains("\"type\":\"json_schema\"", StringComparison.Ordinal)
                && body.Contains("\"strict\":true", StringComparison.Ordinal);
            var hasReasoningEffort = body.Contains("\"effort\":\"low\"", StringComparison.Ordinal);
            var hasMaxOutputTokens = body.Contains("\"max_output_tokens\":2048", StringComparison.Ordinal);
            var hitsResponsesEndpoint =
                url.Contains("/openai/responses", StringComparison.OrdinalIgnoreCase)
                && url.Contains("api-version=", StringComparison.OrdinalIgnoreCase);

            return new
            {
                url,
                hasApiKeyHeader,
                hasStrictJsonSchema,
                hasReasoningEffort,
                hasMaxOutputTokens,
                hitsResponsesEndpoint,
            };
        }

        // ── Plumbing ──────────────────────────────────────────────────

        private static async Task<EdogQaCapabilityProbe.ProbeResult> ProbeWithHandler(
            FakeHandler handler,
            CancellationToken ct,
            string endpoint,
            string key,
            string deployment)
        {
            EdogQaCapabilityProbe.ResetForTest();
            using var client = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(10) };
            var cfg = new EdogQaCapabilityProbe.ProbeConfig
            {
                Endpoint = endpoint,
                ApiKey = key,
                Deployment = deployment,
                ApiVersion = "2025-04-01-preview",
            };
            return await EdogQaCapabilityProbe.ProbeOnceAsync(client, cfg, ct).ConfigureAwait(false);
        }

        private static HttpResponseMessage MakeResponse(HttpStatusCode status, string body)
        {
            return new HttpResponseMessage(status)
            {
                Content = new StringContent(body ?? string.Empty),
            };
        }

        private static string ValidResponseBody(int reasoningTokens)
        {
            // Mirrors a real Azure OpenAI Responses-API completion against
            // a reasoning model (gpt-5.4 et al.). The schema-payload text
            // here is the model's strict-mode JSON output for the probe
            // prompt — {"ok": true}.
            return "{"
                + "\"status\":\"completed\","
                + "\"model\":\"gpt-5.4-2026-03-05\","
                + "\"usage\":{"
                + "\"input_tokens\":33,"
                + "\"output_tokens\":12,"
                + "\"output_tokens_details\":{\"reasoning_tokens\":" + reasoningTokens + "}"
                + "},"
                + "\"output\":["
                + "{\"type\":\"reasoning\",\"content\":[]},"
                + "{\"type\":\"message\",\"content\":[{\"type\":\"output_text\",\"text\":\"{\\\"ok\\\":true}\"}]}"
                + "]"
                + "}";
        }

        private static object Serialize(string caseId, EdogQaCapabilityProbe.ProbeResult r, FakeHandler handler)
        {
            return new
            {
                caseId,
                isReady = r.IsReady,
                deployment = r.Deployment,
                endpointHost = r.EndpointHost,
                apiVersion = r.ApiVersion,
                responsesApiAvailable = r.ResponsesApiAvailable,
                jsonSchemaStrictSupported = r.JsonSchemaStrictSupported,
                reasoningSupported = r.ReasoningSupported,
                maxOutputTokensVerified = r.MaxOutputTokensVerified,
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
