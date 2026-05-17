// <copyright file="EdogQaFallbackPolicy.cs" company="Microsoft">
// Copyright (c) Microsoft Corporation. All rights reserved.
// </copyright>

#nullable disable
#pragma warning disable // DevMode-only file — suppress all warnings

namespace Microsoft.LiveTable.Service.DevMode
{
    using System;
    using System.Collections.Generic;
    using System.Net;
    using System.Net.Http;
    using System.Text.Json;
    using System.Threading;

    // ──────────────────────────────────────────────────────────────────
    // F27 P4 — Kill Silent Fallbacks
    //
    // Two responsibilities live here:
    //
    //   1. LlmProviderException + LlmProviderExceptionClassifier — the
    //      single source of truth for turning a transport / parse failure
    //      from EdogQaLlmProvider into a typed, actionable error that
    //      bubbles all the way up to the hub. Before P4 every failure
    //      was caught and converted to an empty scenario list, which
    //      then triggered the synthetic fallback at the hub layer with
    //      no signal as to *why* the real path failed.
    //
    //   2. QaAnalysisFallbackPolicy — the explicit-opt-in gate for the
    //      hard-coded synthetic scenarios. Setting EDOG_QA_DEMO_FALLBACK=1
    //      makes them available for demos / screenshots; otherwise the
    //      pipeline fails loudly with an actionable QaError so operators
    //      cannot silently ship a build that lies to users.
    //
    // Keeping both concerns in one file because they are paired: the
    // policy gate consumes the typed error to decide whether to abort
    // or to tag a demo scenario with the [DEMO] prefix.
    // ──────────────────────────────────────────────────────────────────

    /// <summary>
    /// Classification of an LLM provider failure used for both the
    /// SignalR error payload and the retry / fallback decisions.
    /// </summary>
    internal enum LlmProviderErrorKind
    {
        /// <summary>Unclassified / unexpected exception.</summary>
        Unknown = 0,

        /// <summary>401 / 403 — credentials missing, invalid, or revoked.</summary>
        Auth = 1,

        /// <summary>429 — rate limit / quota exceeded. Retryable after backoff.</summary>
        RateLimit = 2,

        /// <summary>HttpClient timeout / TaskCanceled not driven by user cancel.</summary>
        Timeout = 3,

        /// <summary>
        /// Response was unparseable JSON, missing the required scenarios
        /// array, or every scenario entry failed to deserialize. The
        /// network layer worked but the LLM contract was violated.
        /// </summary>
        Parse = 4,

        /// <summary>Generic transport / connection failure.</summary>
        Network = 5,
    }

    /// <summary>
    /// Typed exception raised by <c>EdogQaLlmProvider</c> when scenario
    /// generation fails. Carries the wire-stable <see cref="ErrorCode"/>
    /// used by both <c>PublishQaErrorAsync</c> and the studio UI so the
    /// frontend can render an actionable message + optional retry CTA.
    /// </summary>
    internal sealed class LlmProviderException : Exception
    {
        public LlmProviderException(
            LlmProviderErrorKind kind,
            string message,
            bool retryable,
            HttpStatusCode? statusCode = null,
            Exception innerException = null)
            : base(message, innerException)
        {
            this.Kind = kind;
            this.Retryable = retryable;
            this.StatusCode = statusCode;
        }

        public LlmProviderErrorKind Kind { get; }

        public bool Retryable { get; }

        public HttpStatusCode? StatusCode { get; }

        /// <summary>
        /// Wire-stable error code for the <c>QaError</c> SignalR payload.
        /// Frontend keys off this constant — do not rename without also
        /// updating <c>qa-analysis.js</c> and the contract-lock test.
        /// </summary>
        public string ErrorCode
        {
            get
            {
                switch (this.Kind)
                {
                    case LlmProviderErrorKind.Auth: return "LLM_PROVIDER_AUTH";
                    case LlmProviderErrorKind.RateLimit: return "LLM_PROVIDER_RATE_LIMIT";
                    case LlmProviderErrorKind.Timeout: return "LLM_PROVIDER_TIMEOUT";
                    case LlmProviderErrorKind.Parse: return "LLM_PROVIDER_PARSE";
                    case LlmProviderErrorKind.Network: return "LLM_PROVIDER_NETWORK";
                    default: return "LLM_PROVIDER_UNKNOWN";
                }
            }
        }

        /// <summary>
        /// Short snake_case kind suitable for the SignalR payload's
        /// <c>kind</c> field. Mirrors <see cref="LlmProviderErrorKind"/>
        /// minus the implementation-internal casing.
        /// </summary>
        public string KindCode
        {
            get
            {
                switch (this.Kind)
                {
                    case LlmProviderErrorKind.Auth: return "auth";
                    case LlmProviderErrorKind.RateLimit: return "rate_limit";
                    case LlmProviderErrorKind.Timeout: return "timeout";
                    case LlmProviderErrorKind.Parse: return "parse";
                    case LlmProviderErrorKind.Network: return "network";
                    default: return "unknown";
                }
            }
        }
    }

    /// <summary>
    /// Pure-function classifier that turns the underlying transport /
    /// parse exception into a typed <see cref="LlmProviderException"/>.
    /// Isolated so the P4 E2E harness can test the classification
    /// matrix without instantiating <c>EdogQaLlmProvider</c> or making
    /// real HTTP calls.
    /// </summary>
    internal static class LlmProviderExceptionClassifier
    {
        /// <summary>
        /// Classify a raw exception caught by <c>GenerateScenariosAsync</c>.
        /// </summary>
        /// <param name="ex">The exception caught from the LLM call.</param>
        /// <param name="userCancellationToken">
        /// The token passed in by the caller. Used to distinguish
        /// transport timeouts (HttpClient cancelled internally) from
        /// user-initiated cancellation (token signalled).
        /// </param>
        public static LlmProviderException Classify(Exception ex, CancellationToken userCancellationToken)
        {
            if (ex == null)
            {
                return new LlmProviderException(
                    LlmProviderErrorKind.Unknown,
                    "Unknown LLM provider failure (null exception)",
                    retryable: false);
            }

            // HttpClient surfaces transport timeouts as TaskCanceledException
            // (or plain OperationCanceledException) with the token *not*
            // cancelled. User cancellation should bubble up as
            // OperationCanceledException without being reclassified;
            // we leave that decision to the caller's catch ordering.
            if (ex is OperationCanceledException oce && !userCancellationToken.IsCancellationRequested)
            {
                return new LlmProviderException(
                    LlmProviderErrorKind.Timeout,
                    $"LLM request timed out: {oce.Message}",
                    retryable: true,
                    statusCode: null,
                    innerException: oce);
            }

            if (ex is HttpRequestException httpEx)
            {
                var status = httpEx.StatusCode;
                if (status.HasValue)
                {
                    var code = (int)status.Value;
                    if (code == 401 || code == 403)
                    {
                        return new LlmProviderException(
                            LlmProviderErrorKind.Auth,
                            $"LLM provider rejected credentials ({code}). " +
                            "Check AZURE_OPENAI_API_KEY / AZURE_OPENAI_PRO_API_KEY environment variables.",
                            retryable: false,
                            statusCode: status,
                            innerException: httpEx);
                    }

                    if (code == 429)
                    {
                        return new LlmProviderException(
                            LlmProviderErrorKind.RateLimit,
                            $"LLM provider rate-limit / quota exceeded ({code}). Retry after backoff.",
                            retryable: true,
                            statusCode: status,
                            innerException: httpEx);
                    }

                    if (code >= 500)
                    {
                        return new LlmProviderException(
                            LlmProviderErrorKind.Network,
                            $"LLM provider server error ({code}): {httpEx.Message}",
                            retryable: true,
                            statusCode: status,
                            innerException: httpEx);
                    }

                    // Other 4xx — treat as non-retryable network/protocol error.
                    return new LlmProviderException(
                        LlmProviderErrorKind.Network,
                        $"LLM provider client error ({code}): {httpEx.Message}",
                        retryable: false,
                        statusCode: status,
                        innerException: httpEx);
                }

                // No status code — pure transport failure (DNS, connection
                // refused, TLS handshake, etc.).
                return new LlmProviderException(
                    LlmProviderErrorKind.Network,
                    $"LLM provider transport failure: {httpEx.Message}",
                    retryable: true,
                    statusCode: null,
                    innerException: httpEx);
            }

            if (ex is JsonException jex)
            {
                return new LlmProviderException(
                    LlmProviderErrorKind.Parse,
                    $"LLM response was not valid JSON: {jex.Message}",
                    retryable: false,
                    statusCode: null,
                    innerException: jex);
            }

            return new LlmProviderException(
                LlmProviderErrorKind.Unknown,
                $"Unexpected LLM provider failure ({ex.GetType().Name}): {ex.Message}",
                retryable: false,
                statusCode: null,
                innerException: ex);
        }

        /// <summary>
        /// Build a typed <see cref="LlmProviderException"/> directly,
        /// used when the provider detects a contract violation (missing
        /// scenarios array, all-fail mapping, empty content) where there
        /// is no underlying exception to classify.
        /// </summary>
        public static LlmProviderException Parse(string detail)
        {
            return new LlmProviderException(
                LlmProviderErrorKind.Parse,
                detail,
                retryable: false);
        }
    }

    /// <summary>
    /// Policy gate for the synthetic-scenarios fallback in
    /// <c>EdogPlaygroundHub.RunAnalysisPipelineAsync</c>. Before P4 the
    /// hub silently invoked <c>GenerateSyntheticScenarios</c> whenever
    /// the real pipeline produced zero scenarios; now it must consult
    /// this policy and either tag the output as demo content or refuse
    /// to render anything at all.
    /// </summary>
    internal static class QaAnalysisFallbackPolicy
    {
        /// <summary>Environment variable that opts a process into demo mode.</summary>
        public const string DemoFallbackEnvVar = "EDOG_QA_DEMO_FALLBACK";

        /// <summary>
        /// Scenario metadata tag applied to every demo-mode synthetic
        /// scenario so the UI badge and downstream filters can recognise
        /// them. Keep this in sync with the value asserted by the studio
        /// curation UI ("demo_synthetic" matches <c>qa-curation.js</c>'s
        /// placeholder-badge check).
        /// </summary>
        public const string DemoGeneratedBy = "demo_synthetic";

        /// <summary>
        /// Visible title prefix applied to demo-mode synthetic scenarios.
        /// </summary>
        public const string DemoTitlePrefix = "[DEMO] ";

        /// <summary>
        /// Returns true when the current process opts in to the demo
        /// fallback via <c>EDOG_QA_DEMO_FALLBACK=1</c>. Any other value
        /// (including "true", "yes", unset) is treated as off — the env
        /// var is deliberately strict so accidental defaults cannot
        /// resurrect the silent-fallback behaviour.
        /// </summary>
        public static bool IsDemoFallbackEnabled()
        {
            var value = Environment.GetEnvironmentVariable(DemoFallbackEnvVar);
            return string.Equals(value, "1", StringComparison.Ordinal);
        }

        /// <summary>
        /// Mutates the supplied scenario list so that every entry is
        /// clearly marked as demo content: title gets the
        /// <see cref="DemoTitlePrefix"/>, and metadata's
        /// <c>GeneratedBy</c> is set to <see cref="DemoGeneratedBy"/>.
        /// Idempotent — calling twice does not double-prefix.
        /// </summary>
        public static void TagAsDemo(List<Scenario> scenarios)
        {
            if (scenarios == null) return;
            foreach (var scn in scenarios)
            {
                if (scn == null) continue;

                if (scn.Title != null && !scn.Title.StartsWith(DemoTitlePrefix, StringComparison.Ordinal))
                {
                    scn.Title = DemoTitlePrefix + scn.Title;
                }

                scn.Metadata ??= new ScenarioMetadata();
                scn.Metadata.GeneratedBy = DemoGeneratedBy;
            }
        }
    }
}
