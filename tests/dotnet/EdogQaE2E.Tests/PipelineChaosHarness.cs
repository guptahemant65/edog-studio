// <copyright file="PipelineChaosHarness.cs" company="Microsoft">
// Copyright (c) Microsoft Corporation. All rights reserved.
// </copyright>
//
// F27 P5 Stage 2 — End-to-end behavioural harness for HTTP chaos.
//
// Verifies that EdogHttpPipelineHandler.SendAsync now consults
// EdogHttpFaultStore.TryMatchFault before forwarding the request, and
// materializes each documented fault family:
//
//   http_error : synthesizes an HttpResponseMessage from the configured
//                StatusCode + ResponseBody. base.SendAsync is never called.
//
//   latency    : awaits the configured delay BEFORE calling base.SendAsync.
//                The real response is returned, just slower.
//
//   timeout    : throws TaskCanceledException without ever calling
//                base.SendAsync.
//
// Strategy: install EdogHttpPipelineHandler on an HttpClient whose inner
// handler is a recording stub. Push rules into EdogHttpFaultStore for
// distinct target substrings, fire requests, observe both the response
// AND whether the inner handler was invoked.
//
// Emits a single JSON block delimited by HARNESS-JSON-BEGIN / END.

#nullable disable

namespace Microsoft.LiveTable.Service.DevMode.E2ETests
{
    using System;
    using System.Diagnostics;
    using System.Net;
    using System.Net.Http;
    using System.Text.Json;
    using System.Threading;
    using System.Threading.Tasks;
    using Microsoft.LiveTable.Service.DevMode;

    internal static class PipelineChaosHarness
    {
        private const string ScenarioId = "scn-pipeline-chaos-harness";

        public static async Task<int> RunAsync(CancellationToken ct)
        {
            EdogHttpFaultStore.ResetForTesting();

            try
            {
                var noFault = await RunNoFaultAsync(ct).ConfigureAwait(false);
                var httpError = await RunHttpErrorAsync(ct).ConfigureAwait(false);
                var latency = await RunLatencyAsync(ct).ConfigureAwait(false);
                var timeout = await RunTimeoutAsync(ct).ConfigureAwait(false);
                var teardown = RunTeardownAsync();

                EmitJson(new
                {
                    ok = true,
                    harness = "pipeline-chaos",
                    noFault,
                    httpError,
                    latency,
                    timeout,
                    teardown,
                });
                return 0;
            }
            finally
            {
                EdogHttpFaultStore.ResetForTesting();
            }
        }

        // ── No-fault baseline ─────────────────────────────────────────

        private static async Task<object> RunNoFaultAsync(CancellationToken ct)
        {
            var inner = new RecordingHandler(HttpStatusCode.OK, body: "real");
            using var client = MakeClient(inner);

            using var resp = await client.GetAsync("https://contoso.example/no-fault", ct)
                .ConfigureAwait(false);
            var body = await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);

            return new
            {
                statusCode = (int)resp.StatusCode,
                body,
                innerInvocations = inner.InvocationCount,
            };
        }

        // ── http_error: synthesize fake response, never call base ─────

        private static async Task<object> RunHttpErrorAsync(CancellationToken ct)
        {
            EdogHttpFaultStore.ResetForTesting();
            EdogHttpFaultStore.AddRule(ScenarioId, new ChaosRuleSpec
            {
                Target = "fault-error",
                Fault = "http_error",
                Parameters = new System.Collections.Generic.Dictionary<string, object>
                {
                    { "statusCode", 503 },
                    { "body", "qa synthesized" },
                },
            });

            var inner = new RecordingHandler(HttpStatusCode.OK, body: "real");
            using var client = MakeClient(inner);

            using var resp = await client.GetAsync("https://contoso.example/path/fault-error/items", ct)
                .ConfigureAwait(false);
            var body = await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);

            EdogHttpFaultStore.ResetForTesting();

            return new
            {
                statusCode = (int)resp.StatusCode,
                reason = resp.ReasonPhrase,
                body,
                innerInvocations = inner.InvocationCount,
            };
        }

        // ── latency: delay then call base; real response returned ─────

        private static async Task<object> RunLatencyAsync(CancellationToken ct)
        {
            EdogHttpFaultStore.ResetForTesting();
            EdogHttpFaultStore.AddRule(ScenarioId, new ChaosRuleSpec
            {
                Target = "fault-latency",
                Fault = "latency",
                Parameters = new System.Collections.Generic.Dictionary<string, object>
                {
                    { "delayMs", 120 },
                },
            });

            var inner = new RecordingHandler(HttpStatusCode.Created, body: "real-after-delay");
            using var client = MakeClient(inner);

            var sw = Stopwatch.StartNew();
            using var resp = await client.GetAsync("https://contoso.example/api/fault-latency", ct)
                .ConfigureAwait(false);
            sw.Stop();
            var body = await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);

            EdogHttpFaultStore.ResetForTesting();

            return new
            {
                statusCode = (int)resp.StatusCode,
                body,
                innerInvocations = inner.InvocationCount,
                elapsedMs = (long)sw.Elapsed.TotalMilliseconds,
            };
        }

        // ── timeout: throw TaskCanceledException; never call base ─────

        private static async Task<object> RunTimeoutAsync(CancellationToken ct)
        {
            EdogHttpFaultStore.ResetForTesting();
            EdogHttpFaultStore.AddRule(ScenarioId, new ChaosRuleSpec
            {
                Target = "fault-timeout",
                Fault = "timeout",
            });

            var inner = new RecordingHandler(HttpStatusCode.OK, body: "real");
            using var client = MakeClient(inner);

            string exceptionType = null;
            string exceptionMessage = null;
            try
            {
                using var _ = await client.GetAsync("https://contoso.example/path/fault-timeout/x", ct)
                    .ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                exceptionType = ex.GetType().Name;
                exceptionMessage = ex.Message;
            }

            EdogHttpFaultStore.ResetForTesting();

            return new
            {
                exceptionType,
                exceptionMessageContains = exceptionMessage != null
                    && exceptionMessage.Contains("Simulated timeout", StringComparison.OrdinalIgnoreCase),
                innerInvocations = inner.InvocationCount,
            };
        }

        // ── Teardown: removing a scenario's rules disables synth ──────

        private static object RunTeardownAsync()
        {
            EdogHttpFaultStore.ResetForTesting();
            EdogHttpFaultStore.AddRule(ScenarioId, new ChaosRuleSpec
            {
                Target = "fault-teardown",
                Fault = "http_error",
                Parameters = new System.Collections.Generic.Dictionary<string, object>
                {
                    { "statusCode", 418 },
                },
            });

            var beforeCount = EdogHttpFaultStore.ActiveRuleCount;
            var matchedBefore = EdogHttpFaultStore.TryMatchFault(
                "https://contoso.example/api/fault-teardown", out _);

            EdogHttpFaultStore.RemoveRulesForScenario(ScenarioId);

            var afterCount = EdogHttpFaultStore.ActiveRuleCount;
            var matchedAfter = EdogHttpFaultStore.TryMatchFault(
                "https://contoso.example/api/fault-teardown", out _);

            return new
            {
                beforeCount,
                matchedBefore,
                afterCount,
                matchedAfter,
            };
        }

        // ── HttpClient assembly ───────────────────────────────────────

        private static HttpClient MakeClient(RecordingHandler inner)
        {
            // EdogHttpPipelineHandler is a DelegatingHandler — install it
            // in front of the recording stub so its SendAsync runs and
            // then delegates to inner.
            var pipeline = new EdogHttpPipelineHandler("test")
            {
                InnerHandler = inner,
            };
            return new HttpClient(pipeline) { Timeout = TimeSpan.FromSeconds(10) };
        }

        private sealed class RecordingHandler : HttpMessageHandler
        {
            private readonly HttpStatusCode _status;
            private readonly string _body;

            public RecordingHandler(HttpStatusCode status, string body)
            {
                _status = status;
                _body = body ?? string.Empty;
            }

            public int InvocationCount { get; private set; }

            protected override Task<HttpResponseMessage> SendAsync(
                HttpRequestMessage request, CancellationToken cancellationToken)
            {
                InvocationCount++;
                var resp = new HttpResponseMessage(_status)
                {
                    RequestMessage = request,
                    Content = new StringContent(_body),
                };
                return Task.FromResult(resp);
            }
        }

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
