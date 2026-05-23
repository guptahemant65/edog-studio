// <copyright file="MitmDecision.cs" company="Microsoft">
// Copyright (c) Microsoft Corporation. All rights reserved.
// </copyright>

#nullable disable
#pragma warning disable // DevMode-only file — suppress all warnings

namespace Microsoft.LiveTable.Service.DevMode
{
    using System.Collections.Generic;
    using System.Net;
    using System.Net.Http;

    // ──────────────────────────────────────────────
    // MitmDecision — Frontend → backend resume payload
    // ──────────────────────────────────────────────

    /// <summary>
    /// The user's decision for a paused breakpoint. Sent via <c>MitmResumeBreakpoint</c> RPC.
    /// Exactly one of <see cref="Modifications"/>/<see cref="Forge"/>/<see cref="Block"/> is populated
    /// depending on <see cref="Verdict"/>.
    /// </summary>
    public sealed class MitmDecision
    {
        /// <summary>The verdict: forward | modify | block | forge.</summary>
        public string Verdict { get; init; }

        /// <summary>Request modifications. Populated when Verdict == "modify".</summary>
        public MitmModifications Modifications { get; init; }

        /// <summary>Forged response payload. Populated when Verdict == "forge".</summary>
        public MitmForgePayload Forge { get; init; }

        /// <summary>Block response payload. Populated when Verdict == "block".</summary>
        public MitmForgePayload Block { get; init; }

        /// <summary>Audit note from the user (optional).</summary>
        public string NoteForAudit { get; init; }

        /// <summary>Connection ID of the user who submitted this decision. Set server-side.</summary>
        public string SubmittedByConnectionId { get; set; }

        /// <summary>Creates a forward-unchanged decision for timeout/disconnect auto-resolution.</summary>
        internal static MitmDecision ForwardUnchanged(string reason)
            => new() { Verdict = "forward", NoteForAudit = $"auto:{reason}" };
    }

    // ──────────────────────────────────────────────
    // MitmModifications — Request mutation payload
    // ──────────────────────────────────────────────

    /// <summary>
    /// Describes how to mutate a request before forwarding. Null fields are unchanged.
    /// </summary>
    public sealed class MitmModifications
    {
        /// <summary>Replacement HTTP method. Null = unchanged.</summary>
        public string Method { get; init; }

        /// <summary>Replacement URL. Null = unchanged.</summary>
        public string Url { get; init; }

        /// <summary>Headers to set (add or overwrite).</summary>
        public Dictionary<string, string> SetHeaders { get; init; }

        /// <summary>Header names to remove.</summary>
        public string[] RemoveHeaders { get; init; }

        /// <summary>Replacement body content. Null = unchanged.</summary>
        public string Body { get; init; }
    }

    // ──────────────────────────────────────────────
    // MitmForgePayload — Fabricated response shape
    // ──────────────────────────────────────────────

    /// <summary>
    /// A fabricated HTTP response. Used by both "forge" and "block" verdicts,
    /// and by <see cref="MitmForgeAction"/>/<see cref="MitmBlockAction"/> rule configs.
    /// </summary>
    public sealed class MitmForgePayload
    {
        /// <summary>HTTP status code (100-599).</summary>
        public int StatusCode { get; init; }

        /// <summary>HTTP reason phrase. Null = auto-generated.</summary>
        public string ReasonPhrase { get; init; }

        /// <summary>Response headers to set.</summary>
        public Dictionary<string, string> Headers { get; init; }

        /// <summary>Response body content.</summary>
        public string Body { get; init; }

        /// <summary>Materializes this payload into an <see cref="HttpResponseMessage"/>.</summary>
        internal HttpResponseMessage Materialize(HttpRequestMessage req)
        {
            var msg = new HttpResponseMessage((HttpStatusCode)StatusCode)
            {
                RequestMessage = req,
                ReasonPhrase = ReasonPhrase ?? $"MITM forged {StatusCode}",
                Content = new StringContent(Body ?? string.Empty),
            };
            if (Headers != null)
            {
                foreach (var (k, v) in Headers)
                {
                    if (!msg.Headers.TryAddWithoutValidation(k, v))
                        msg.Content.Headers.TryAddWithoutValidation(k, v);
                }
            }
            return msg;
        }
    }

    // ──────────────────────────────────────────────
    // MitmInterceptSnapshot — What frontend receives on pause
    // ──────────────────────────────────────────────

    /// <summary>
    /// Published as the payload of the <c>mitm.breakpointHit</c> topic event.
    /// Built by <see cref="MitmCoordinator"/> before parking the handler thread.
    /// </summary>
    internal sealed class MitmInterceptSnapshot
    {
        public string InterceptId { get; init; }
        public string RuleId { get; init; }
        public string RuleName { get; init; }
        public MitmPhase Phase { get; init; }
        public string OwnerConnectionId { get; init; }
        public System.DateTimeOffset CreatedAtUtc { get; init; }
        public System.DateTimeOffset DeadlineUtc { get; init; }
        public int TimeoutMs { get; init; }
        public MitmRequestSnapshot Request { get; init; }
        public MitmResponseSnapshot Response { get; init; }
    }

    /// <summary>Request snapshot with redacted auth and SAS tokens.</summary>
    internal sealed class MitmRequestSnapshot
    {
        public string Method { get; init; }
        public string Url { get; init; }
        public Dictionary<string, string> Headers { get; init; }
        public string Body { get; init; }
        public long BodyBytes { get; init; }
        public bool BodyTruncated { get; init; }
        public string HttpClientName { get; init; }
        public string CorrelationId { get; init; }
    }

    /// <summary>Response snapshot (populated only for response-phase breakpoints).</summary>
    internal sealed class MitmResponseSnapshot
    {
        public int StatusCode { get; init; }
        public Dictionary<string, string> Headers { get; init; }
        public string Body { get; init; }
        public long BodyBytes { get; init; }
        public bool BodyTruncated { get; init; }
        public double DurationMs { get; init; }
    }

    // ──────────────────────────────────────────────
    // MitmResumeResult — Response from SubmitDecision
    // ──────────────────────────────────────────────

    /// <summary>Result of a <c>MitmResumeBreakpoint</c> call.</summary>
    internal sealed class MitmResumeResult
    {
        public bool Success { get; init; }
        public string Error { get; init; }
        public string InterceptId { get; init; }
        public string Verdict { get; init; }

        public static MitmResumeResult Ok => new() { Success = true };
        public static MitmResumeResult NotFound => new() { Success = false, Error = "intercept not found" };
        public static MitmResumeResult NotOwned => new() { Success = false, Error = "not owned by caller" };
        public static MitmResumeResult AlreadyResolved => new() { Success = false, Error = "already resolved" };
        public static MitmResumeResult Invalid(string reason) => new() { Success = false, Error = reason };
    }

    // ──────────────────────────────────────────────
    // MitmCapabilityReport — Capabilities discovery
    // ──────────────────────────────────────────────

    /// <summary>Returned by <c>MitmGetCapabilities</c> RPC.</summary>
    public sealed class MitmCapabilityReport
    {
        public bool Available { get; init; }
        public bool Enabled { get; init; }
        public bool InterceptionEnabled { get; init; }
        public string SessionId { get; init; }
        public string Reason { get; init; }
        public string[] SupportedActions { get; init; }
        public string[] SupportedPhases { get; init; }
        public string[] SupportedUrlMatchers { get; init; }
        public string ServerVersion { get; init; }
        public MitmCapabilityLimits Limits { get; init; }
    }

    /// <summary>Numeric limits for the MITM subsystem.</summary>
    public sealed class MitmCapabilityLimits
    {
        public int MaxConcurrentBreakpoints { get; init; }
        public int MaxRulesPerConnection { get; init; }
        public int MaxRulesGlobal { get; init; }
        public int DefaultTimeoutMs { get; init; }
        public int MaxTimeoutMs { get; init; }
        public int MaxBodyBytes { get; init; }
        public int MaxBodyEditorBytes { get; init; }
        public int MaxRuleBodyBytes { get; init; }
        public int BreakpointTimeoutMsDefault { get; init; }
        public int BreakpointTimeoutMsMax { get; init; }
    }

}
