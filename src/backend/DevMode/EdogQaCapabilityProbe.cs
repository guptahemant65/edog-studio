// <copyright file="EdogQaCapabilityProbe.cs" company="Microsoft">
// Copyright (c) Microsoft Corporation. All rights reserved.
// </copyright>

#nullable disable
#pragma warning disable // DevMode-only file — suppress all warnings

namespace Microsoft.LiveTable.Service.DevMode
{
    using System;
    using System.Collections.Generic;
    using System.Net.Http;
    using System.Threading;
    using System.Threading.Tasks;

    // ═══════════════════════════════════════════════════════════════════
    // EdogQaCapabilityProbe — F27 P9 §3.6 startup capability probe
    //
    // The production-grade LLM scenario generation pipeline depends on
    // four Azure OpenAI deployment capabilities that are NOT universal:
    //
    //   1. Deployment exists and is reachable
    //   2. Responses API (vs Chat Completions only)
    //   3. JSON Schema strict-mode constrained decoding
    //   4. Reasoning effort parameter accepted
    //
    // Different tenants / regions / SKUs expose different subsets. We
    // refuse to flip <see cref="EdogQaFeatureFlags.LlmV2"/> from
    // <see cref="LlmV2Mode.Off"/> to <see cref="LlmV2Mode.Shadow"/> or
    // <see cref="LlmV2Mode.On"/> unless all four are confirmed.
    //
    // The probe runs at most once per process and the result is cached.
    // <see cref="IsAzureOpenAiReadyForV2"/> is the single boolean the
    // orchestrator + hub consult before honouring the feature flag.
    //
    // ── Implementation status ─────────────────────────────────────────
    // T0 (this commit): the class, types, and cache are wired. The
    //   <see cref="ProbeAsync"/> body is a deterministic stub that
    //   records "PROBE_STUB_T0" and returns IsReady=false. The hub
    //   therefore behaves as today — V2 is dormant.
    //
    // T1: ProbeAsync performs a real minimal-request handshake to the
    //   configured deployment and populates each capability flag from
    //   the response. T1 exit gate: probe returns IsReady=true against
    //   the Azure deployment in CI and against operator-supplied prod
    //   tenants.
    // ═══════════════════════════════════════════════════════════════════

    /// <summary>
    /// Process-wide capability probe for the Azure OpenAI deployment that
    /// backs the F27 P9 LLM scenario generation pipeline. Gates the rollout
    /// of <see cref="EdogQaFeatureFlags.LlmV2"/>.
    /// </summary>
    internal static class EdogQaCapabilityProbe
    {
        // ── Error codes ────────────────────────────────────────────────

        /// <summary>Emitted when the configured deployment name resolves to no model.</summary>
        internal const string ErrorCodeDeploymentNotFound = "AOAI_DEPLOYMENT_NOT_FOUND";

        /// <summary>Emitted when /openai/responses returns 404 / unsupported version.</summary>
        internal const string ErrorCodeResponsesApiUnavailable = "AOAI_RESPONSES_API_UNAVAILABLE";

        /// <summary>Emitted when <c>text.format.type = "json_schema"</c> is rejected.</summary>
        internal const string ErrorCodeJsonSchemaStrictUnsupported = "AOAI_JSON_SCHEMA_STRICT_UNSUPPORTED";

        /// <summary>Emitted when <c>reasoning.effort</c> is rejected or silently ignored.</summary>
        internal const string ErrorCodeReasoningUnsupported = "AOAI_REASONING_UNSUPPORTED";

        /// <summary>Sentinel error written by the T0 stub. Replaced by real errors in T1.</summary>
        internal const string ErrorCodeStubT0 = "PROBE_STUB_T0";

        // ── Result type ────────────────────────────────────────────────

        /// <summary>Outcome of a single probe attempt.</summary>
        internal sealed class ProbeResult
        {
            /// <summary>True only when all four capabilities below are confirmed.</summary>
            public bool IsReady { get; set; }

            /// <summary>Deployment name probed.</summary>
            public string Deployment { get; set; }

            /// <summary>Endpoint URL probed (host only, never logged with key).</summary>
            public string EndpointHost { get; set; }

            /// <summary>API version probed.</summary>
            public string ApiVersion { get; set; }

            /// <summary>True if /openai/responses returned a usable response.</summary>
            public bool ResponsesApiAvailable { get; set; }

            /// <summary>True if a strict json_schema request was honoured (output matched schema).</summary>
            public bool JsonSchemaStrictSupported { get; set; }

            /// <summary>True if <c>reasoning_tokens &gt; 0</c> was reported in usage.</summary>
            public bool ReasoningSupported { get; set; }

            /// <summary>Largest <c>max_output_tokens</c> the deployment accepted without rejection.</summary>
            public int MaxOutputTokensVerified { get; set; }

            /// <summary>Stable error codes accumulated during this probe.</summary>
            public List<string> Errors { get; set; } = new();

            /// <summary>Wall-clock time when probe completed.</summary>
            public DateTimeOffset ProbedAt { get; set; }

            /// <summary>Round-trip duration of the probe request, milliseconds.</summary>
            public long ElapsedMilliseconds { get; set; }
        }

        // ── Cache ──────────────────────────────────────────────────────

        private static ProbeResult _cached;
        private static readonly SemaphoreSlim _gate = new(1, 1);

        /// <summary>The cached probe result if <see cref="ProbeAsync"/> has run; otherwise null.</summary>
        internal static ProbeResult LastResult => Volatile.Read(ref _cached);

        /// <summary>
        /// True only when the probe has run AND all four required capabilities
        /// are confirmed. Until the probe runs (or while it returns false), the
        /// hub MUST treat <see cref="EdogQaFeatureFlags.LlmV2"/> as
        /// <see cref="LlmV2Mode.Off"/> regardless of the env var value.
        /// </summary>
        internal static bool IsAzureOpenAiReadyForV2 => Volatile.Read(ref _cached)?.IsReady == true;

        /// <summary>
        /// Clears the cached result. Tests only — production must not call this.
        /// </summary>
        internal static void ResetForTest()
        {
            Volatile.Write(ref _cached, null);
        }

        // ── Probe ──────────────────────────────────────────────────────

        /// <summary>
        /// Runs the capability probe at most once per process and returns
        /// the cached result. T0 stub: records ErrorCodeStubT0 and returns
        /// IsReady=false without making any network call. T1 fills in a real
        /// handshake.
        /// </summary>
        /// <param name="httpClient">Shared HttpClient — supplied by the registrar.</param>
        /// <param name="ct">Cancellation token (typically host shutdown).</param>
        internal static async Task<ProbeResult> ProbeAsync(HttpClient httpClient, CancellationToken ct)
        {
            var cached = Volatile.Read(ref _cached);
            if (cached != null) return cached;

            await _gate.WaitAsync(ct).ConfigureAwait(false);
            try
            {
                cached = Volatile.Read(ref _cached);
                if (cached != null) return cached;

                var deployment = Environment.GetEnvironmentVariable("AZURE_OPENAI_PRO_DEPLOYMENT")
                    ?? Environment.GetEnvironmentVariable("AZURE_OPENAI_DEPLOYMENT")
                    ?? "gpt-5.4";

                var endpoint = Environment.GetEnvironmentVariable("AZURE_OPENAI_PRO_ENDPOINT")
                    ?? Environment.GetEnvironmentVariable("AZURE_OPENAI_ENDPOINT")
                    ?? "";

                var apiVersion = Environment.GetEnvironmentVariable("AZURE_OPENAI_PRO_API_VERSION")
                    ?? Environment.GetEnvironmentVariable("AZURE_OPENAI_API_VERSION")
                    ?? "2025-04-01-preview";

                var result = new ProbeResult
                {
                    IsReady = false,
                    Deployment = deployment,
                    EndpointHost = SafeHost(endpoint),
                    ApiVersion = apiVersion,
                    ResponsesApiAvailable = false,
                    JsonSchemaStrictSupported = false,
                    ReasoningSupported = false,
                    MaxOutputTokensVerified = 0,
                    Errors = { ErrorCodeStubT0 + " — capability probe not yet implemented (F27 P9 T1)" },
                    ProbedAt = DateTimeOffset.UtcNow,
                    ElapsedMilliseconds = 0,
                };

                Volatile.Write(ref _cached, result);
                return result;
            }
            finally
            {
                _gate.Release();
            }
        }

        // ── Helpers ────────────────────────────────────────────────────

        private static string SafeHost(string endpoint)
        {
            if (string.IsNullOrWhiteSpace(endpoint)) return "";
            try
            {
                var u = new Uri(endpoint.TrimEnd('/') + "/");
                return u.Host;
            }
            catch
            {
                return "";
            }
        }
    }
}
