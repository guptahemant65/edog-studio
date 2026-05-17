// <copyright file="EdogQaCapabilityRegistry.cs" company="Microsoft">
// Copyright (c) Microsoft Corporation. All rights reserved.
// </copyright>

#nullable disable
#pragma warning disable // DevMode-only file — suppress all warnings

namespace Microsoft.LiveTable.Service.DevMode
{
    using System;
    using System.Collections.Generic;
    using System.Threading;

    // ═══════════════════════════════════════════════════════════════════
    // EdogQaCapabilityRegistry — process-wide capability probe (F27 P5)
    //
    // The QA Testing scenario schema (EdogQaModels.cs) declares Setup steps
    // that depend on runtime capabilities the host may or may not provide:
    //
    //   - FlagOverride  → requires a feature-flag override surface
    //   - ChaosRule     → requires fault-injection (HTTP rewrite, latency, …)
    //   - StateSeed     → requires an HTTP loopback (always available)
    //   - Wait          → trivially available
    //
    // Before P5, the execution engine treated ChaosRule and FlagOverride as
    // FUNCTIONAL STUBS — it logged the request, incremented a "NoOp" counter,
    // and proceeded as if the fault had been injected. A scenario that
    // relied on chaos to fail would therefore PASS its assertions silently.
    //
    // This registry is the truth layer. The execution engine consults it
    // before applying each setup step; if a required capability is not
    // available, the engine throws <see cref="CapabilityUnavailableException"/>
    // and the scenario is marked <c>Skipped</c> with an explicit reason.
    // No scenario can silently pass because its required fault wasn't
    // actually performed.
    //
    // Capability state is resolved from:
    //   - <see cref="EdogFeatureOverrideStore.ControlTokenConfigured"/> → flag overrides
    //   - <see cref="EdogHttpFaultStore.IsEnabled"/> (Stage 2) → HTTP chaos
    //   - Environment variable EDOG_QA_CHAOS_HTTP=1 → opt-in for HTTP chaos
    //
    // Pure, deterministic, no I/O on the hot path. Probe results are cached
    // for the lifetime of the process (capabilities are bound at startup).
    // ═══════════════════════════════════════════════════════════════════

    /// <summary>
    /// Process-wide capability probe consulted by the QA execution engine
    /// before applying setup steps that depend on host-provided primitives.
    /// </summary>
    internal static class EdogQaCapabilityRegistry
    {
        // ── Constants ─────────────────────────────────────────────────

        /// <summary>Stable error code emitted when a chaos fault is requested but unavailable.</summary>
        internal const string ErrorCodeChaosUnavailable = "CAPABILITY_UNAVAILABLE_CHAOS";

        /// <summary>Stable error code emitted when a flag override is requested but unavailable.</summary>
        internal const string ErrorCodeFlagOverrideUnavailable = "CAPABILITY_UNAVAILABLE_FLAG";

        /// <summary>Env var that opts in to HTTP chaos fault injection (Stage 2).</summary>
        internal const string EnvVarHttpChaos = "EDOG_QA_CHAOS_HTTP";

        // Stage-1 ⇄ Stage-2 wire-gate. Stage 2 has shipped: the pipeline
        // interceptor (EdogHttpPipelineHandler.SendAsync) now consults
        // EdogHttpFaultStore.TryMatchFault before base.SendAsync and
        // materializes the configured fault. Set to true to authorize
        // IsChaosFaultSupported to return true when the env var is set.
        private const bool HttpChaosPipelineWired = true;

        // HTTP-chaos fault families that Stage 2 will support. Listed here
        // so the linter / hub / engine all agree on the catalog. Stage 1
        // accepts none; Stage 2 flips this on.
        private static readonly HashSet<string> SupportedHttpFaults = new(StringComparer.OrdinalIgnoreCase)
        {
            "http_error",
            "latency",
            "timeout",
        };

        // ── Flag override capability ──────────────────────────────────

        /// <summary>
        /// Returns <c>true</c> when the host can apply feature-flag overrides
        /// for the given spec. Requires the override store to be wired and
        /// the requested value to be supported (force-ON only in V1).
        /// </summary>
        /// <param name="spec">The flag override the scenario wants to apply.</param>
        public static bool IsFlagOverrideSupported(FlagOverrideSpec spec)
        {
            if (spec == null || string.IsNullOrEmpty(spec.FlagName)) return false;

            // V1: force-OFF is not supported by EdogFeatureOverrideStore.
            // A scenario that asks for it must be skipped, not silently lied to.
            if (!spec.Value) return false;

            return true;
        }

        /// <summary>
        /// Returns a human-readable reason why <paramref name="spec"/> cannot
        /// be applied, or <c>null</c> if it can. Used to populate the
        /// scenario's <c>ErrorMessage</c> when it is skipped.
        /// </summary>
        public static string GetFlagOverrideUnavailableReason(FlagOverrideSpec spec)
        {
            if (spec == null) return "FlagOverrideSpec is null.";
            if (string.IsNullOrEmpty(spec.FlagName)) return "FlagOverrideSpec.FlagName is empty.";
            if (!spec.Value)
            {
                return $"Force-OFF overrides are not supported in V1 (flag '{spec.FlagName}'). " +
                       "EdogFeatureOverrideStore is force-ON only.";
            }

            return null;
        }

        // ── HTTP chaos capability ─────────────────────────────────────

        /// <summary>
        /// Returns <c>true</c> when the host can inject the chaos fault
        /// described by <paramref name="rule"/>. Stage 1: always returns
        /// <c>false</c> for every fault. Stage 2 will flip this on for
        /// HTTP fault types once <c>EdogHttpFaultStore</c> ships.
        /// </summary>
        public static bool IsChaosFaultSupported(ChaosRuleSpec rule)
        {
            if (rule == null || string.IsNullOrEmpty(rule.Fault)) return false;

            // Stage 1 honesty gate: the pipeline interceptor that converts
            // a fault rule into an actual HTTP behaviour change has not
            // shipped yet. Until it does, even an env-var-enabled host
            // cannot satisfy a chaos request — and a scenario that asks
            // for chaos MUST be marked Skipped rather than silently
            // passing on an inert rule.
            if (!HttpChaosPipelineWired) return false;

            // HTTP chaos is opt-in. The runtime check is deferred to a
            // helper so Stage 2 can flip the source of truth without
            // touching call sites.
            if (!IsHttpChaosBackendEnabled()) return false;

            return SupportedHttpFaults.Contains(rule.Fault);
        }

        /// <summary>
        /// Returns a human-readable reason why <paramref name="rule"/>
        /// cannot be applied, or <c>null</c> if it can.
        /// </summary>
        public static string GetChaosUnavailableReason(ChaosRuleSpec rule)
        {
            if (rule == null) return "ChaosRuleSpec is null.";
            if (string.IsNullOrEmpty(rule.Fault)) return "ChaosRuleSpec.Fault is empty.";

            if (!HttpChaosPipelineWired)
            {
                return "HTTP chaos pipeline is not wired in this build (Stage 1). " +
                       "EdogHttpPipelineHandler does not yet consult EdogHttpFaultStore, " +
                       "so any fault rule would be silently inert. Ship F27 P5 Stage 2 to enable.";
            }

            if (!IsHttpChaosBackendEnabled())
            {
                return $"HTTP chaos injection is disabled in this build. " +
                       $"Set {EnvVarHttpChaos}=1 to enable.";
            }

            if (!SupportedHttpFaults.Contains(rule.Fault))
            {
                return $"Chaos fault type '{rule.Fault}' is not implemented. " +
                       $"Supported: {string.Join(", ", SupportedHttpFaults)}.";
            }

            return null;
        }

        /// <summary>
        /// True when the HTTP-chaos backend (Stage 2) is enabled for this
        /// process. Reads the opt-in env var lazily — caching is the
        /// caller's responsibility if needed.
        /// </summary>
        public static bool IsHttpChaosBackendEnabled()
        {
            try
            {
                var value = Environment.GetEnvironmentVariable(EnvVarHttpChaos);
                return string.Equals(value, "1", StringComparison.Ordinal)
                    || string.Equals(value, "true", StringComparison.OrdinalIgnoreCase);
            }
            catch
            {
                return false;
            }
        }

        // ── Capability report (wire) ──────────────────────────────────

        /// <summary>
        /// Builds an immutable snapshot of the current capability state.
        /// Returned by the <c>QaGetCapabilities</c> hub method so the
        /// curation UI can render capability badges before submission.
        /// </summary>
        public static QaCapabilityReport BuildReport()
        {
            var pipelineWired = HttpChaosPipelineWired;
            var envOn = IsHttpChaosBackendEnabled();
            var chaosSupported = pipelineWired && envOn;
            string chaosReason;
            if (!pipelineWired)
            {
                chaosReason = "HTTP chaos pipeline not yet wired (F27 P5 Stage 1).";
            }
            else if (!envOn)
            {
                chaosReason = "Disabled. Set " + EnvVarHttpChaos + "=1 to enable HTTP fault injection.";
            }
            else
            {
                chaosReason = "EdogHttpFaultStore enabled via " + EnvVarHttpChaos + ".";
            }

            var report = new QaCapabilityReport
            {
                CapturedAt = DateTimeOffset.UtcNow,
                FlagOverrideSupported = true,
                FlagOverrideForceOffSupported = false,
                FlagOverrideReason = "EdogFeatureOverrideStore (force-ON only).",
                HttpChaosSupported = chaosSupported,
                HttpChaosReason = chaosReason,
                SupportedChaosFaults = chaosSupported
                    ? new List<string>(SupportedHttpFaults)
                    : new List<string>(),
            };
            return report;
        }
    }

    /// <summary>
    /// Raised by <c>ChaosIntegration</c> when a scenario requests a chaos
    /// rule that the host cannot satisfy. The execution engine catches this
    /// and marks the scenario <see cref="ScenarioVerdict.Skipped"/>.
    /// </summary>
    [Serializable]
    internal sealed class ChaosUnavailableException : InvalidOperationException
    {
        public ChaosUnavailableException(string message) : base(message) { }
        public ChaosUnavailableException(string message, Exception inner) : base(message, inner) { }
    }

    /// <summary>
    /// Raised by <c>FlagOverrideStore</c> when a scenario requests a flag
    /// override the host cannot satisfy (e.g. force-OFF in V1).
    /// </summary>
    [Serializable]
    internal sealed class FlagOverrideUnavailableException : InvalidOperationException
    {
        public FlagOverrideUnavailableException(string message) : base(message) { }
        public FlagOverrideUnavailableException(string message, Exception inner) : base(message, inner) { }
    }
}
