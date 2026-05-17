// <copyright file="LlmClassifyHarness.cs" company="Microsoft">
// Copyright (c) Microsoft Corporation. All rights reserved.
// </copyright>
//
// F27 P4 - LLM provider exception classifier matrix.
//
// Exercises LlmProviderExceptionClassifier against a synthetic exception
// matrix (auth, rate_limit, timeout, parse, network, transport, unknown)
// plus a user-cancellation case. Emits the resulting kind/code/retryable
// triples so the pytest wrapper can assert the classification contract is
// stable without binding to a port or hitting real Azure OpenAI.

#nullable disable

namespace Microsoft.LiveTable.Service.DevMode.E2ETests
{
    using System;
    using System.Collections.Generic;
    using System.Net;
    using System.Net.Http;
    using System.Text.Json;
    using System.Threading;
    using System.Threading.Tasks;
    using Microsoft.LiveTable.Service.DevMode;

    internal static class LlmClassifyHarness
    {
        public static Task<int> RunAsync()
        {
            var notCancelled = CancellationToken.None;
            using var cancelledCts = new CancellationTokenSource();
            cancelledCts.Cancel();

            var cases = new List<object>
            {
                Classify("auth_401", new HttpRequestException("Unauthorized", null, HttpStatusCode.Unauthorized), notCancelled),
                Classify("auth_403", new HttpRequestException("Forbidden", null, HttpStatusCode.Forbidden), notCancelled),
                Classify("rate_limit_429", new HttpRequestException("Too many", null, HttpStatusCode.TooManyRequests), notCancelled),
                Classify("network_500", new HttpRequestException("Server", null, HttpStatusCode.InternalServerError), notCancelled),
                Classify("network_503", new HttpRequestException("Bad gateway", null, HttpStatusCode.ServiceUnavailable), notCancelled),
                Classify("client_400", new HttpRequestException("Bad request", null, HttpStatusCode.BadRequest), notCancelled),
                Classify("transport_no_status", new HttpRequestException("Connection refused"), notCancelled),
                Classify("timeout_taskcancel", new TaskCanceledException("HttpClient timeout"), notCancelled),
                Classify("parse_jsonexception", new JsonException("Unexpected token"), notCancelled),
                Classify("unknown_invalidop", new InvalidOperationException("Boom"), notCancelled),
                ClassifyUserCancel("user_cancel", cancelledCts.Token),
            };

            EmitJson(new
            {
                ok = true,
                harness = "llm-classify",
                cases,
            });

            return Task.FromResult(0);
        }

        private static object Classify(string caseId, Exception ex, CancellationToken ct)
        {
            var typed = LlmProviderExceptionClassifier.Classify(ex, ct);
            return new
            {
                caseId,
                inputType = ex.GetType().Name,
                kindCode = typed.KindCode,
                errorCode = typed.ErrorCode,
                retryable = typed.Retryable,
                hasStatusCode = typed.StatusCode.HasValue,
                statusCode = typed.StatusCode.HasValue ? (int?)typed.StatusCode.Value : null,
                hasInner = typed.InnerException != null,
            };
        }

        // When the user cancellation token IS cancelled, a TaskCanceledException
        // must NOT be reclassified as timeout — the classifier should still tag
        // it appropriately (we expect the caller's `catch (OperationCanceledException)
        // when (ct.IsCancellationRequested)` to short-circuit before classify is
        // ever invoked, but the harness still exercises classify in that state
        // to pin the behaviour).
        private static object ClassifyUserCancel(string caseId, CancellationToken ct)
        {
            var ex = new TaskCanceledException("user pressed cancel");
            var typed = LlmProviderExceptionClassifier.Classify(ex, ct);
            return new
            {
                caseId,
                inputType = ex.GetType().Name,
                userCancelled = ct.IsCancellationRequested,
                kindCode = typed.KindCode,
                errorCode = typed.ErrorCode,
                retryable = typed.Retryable,
            };
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
