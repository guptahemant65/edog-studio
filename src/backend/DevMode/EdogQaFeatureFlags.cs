// <copyright file="EdogQaFeatureFlags.cs" company="Microsoft">
// Copyright (c) Microsoft Corporation. All rights reserved.
// </copyright>

#nullable disable
#pragma warning disable // DevMode-only file — suppress all warnings

namespace Microsoft.LiveTable.Service.DevMode
{
    using System;
    using System.Threading;
    using Microsoft.Extensions.Options;

    // ═══════════════════════════════════════════════════════════════════
    // EdogQaFeatureFlags — central registry for QA-pipeline feature flags
    //
    // Each flag is a process-wide opt-in/opt-out read from an environment
    // variable at first access (no live re-read; restart the host to change).
    // Flags defined here are wired into the QA orchestration code paths so
    // that experimental codepaths can ship behind a kill switch and be
    // rolled out incrementally:
    //
    //   off    → legacy code path serves users (explicit opt-out; no warning)
    //   auto   → prefer V2 when capability probe passes; transparent legacy
    //            fallback with a LEGACY_LLM_FALLBACK warning when probe
    //            fails. THIS IS THE NEW DEFAULT (unset env var).
    //   shadow → legacy serves users; V2 runs in shadow only when probe
    //            passes; diffs logged
    //   on     → require V2; hard-fail with LLM_NOT_READY if probe fails.
    //            Use for CI / strict-mode operators who want to surface
    //            misconfiguration immediately.
    //
    // Auto is the gate that closes the original F27 P9 deployment hole:
    // before this, unset defaulted to Off and the studio silently ran the
    // legacy provider even when V2 was fully functional. Now unset prefers
    // V2 transparently with a visible fallback signal.
    // ═══════════════════════════════════════════════════════════════════

    /// <summary>
    /// Reads QA-pipeline feature flags from environment variables. All flags
    /// are read once and cached for the lifetime of the process.
    /// </summary>
    internal static class EdogQaFeatureFlags
    {
        // ── Env-var names ──────────────────────────────────────────────

        /// <summary>
        /// F27 P9 rollout switch for the production-grade LLM scenario
        /// generation pipeline. Accepts <c>off</c> / <c>auto</c> (default,
        /// also the unset value) / <c>shadow</c> / <c>on</c>. See
        /// <see cref="LlmV2Mode"/>.
        /// </summary>
        internal const string EnvVarLlmV2 = "EDOG_QA_LLM_V2";

        // ── Public surface ─────────────────────────────────────────────

        /// <summary>
        /// Rollout mode for the F27 P9 production-grade LLM scenario
        /// generation pipeline. Defaults to <see cref="LlmV2Mode.Auto"/>
        /// (prefer V2 when the capability probe passes, transparent legacy
        /// fallback with a LEGACY_LLM_FALLBACK warning when it fails).
        /// </summary>
        internal static LlmV2Mode LlmV2 => _llmV2.Value;

        // ── Implementation ─────────────────────────────────────────────

        private static readonly Lazy<LlmV2Mode> _llmV2 = new(() =>
            ParseLlmV2(Environment.GetEnvironmentVariable(EnvVarLlmV2)));

        internal static LlmV2Mode ParseLlmV2(string raw)
        {
            if (string.IsNullOrWhiteSpace(raw)) return LlmV2Mode.Auto;
            var v = raw.Trim().ToLowerInvariant();
            return v switch
            {
                "on" or "1" or "true" or "enabled" => LlmV2Mode.On,
                "shadow" => LlmV2Mode.Shadow,
                "off" or "0" or "false" or "disabled" => LlmV2Mode.Off,
                "auto" => LlmV2Mode.Auto,
                _ => LlmV2Mode.Auto,
            };
        }
    }

    /// <summary>Rollout mode for the F27 P9 LLM pipeline. See <see cref="EdogQaFeatureFlags.LlmV2"/>.</summary>
    internal enum LlmV2Mode
    {
        /// <summary>Explicit opt-out: legacy <see cref="EdogQaLlmProvider"/> serves users, no probe-failure warning.</summary>
        Off = 0,

        /// <summary>Legacy serves users; V2 runs in shadow when capability probe passes; diffs logged.</summary>
        Shadow = 1,

        /// <summary>Require V2: hard-fail with LLM_NOT_READY if capability probe fails. Strict mode.</summary>
        On = 2,

        /// <summary>Default. Prefer V2 when probe passes; transparent legacy fallback with LEGACY_LLM_FALLBACK warning otherwise.</summary>
        Auto = 3,
    }

    /// <summary>
    /// Implementation of <see cref="IQaContractOptionsProvider"/> backed by
    /// <c>IOptionsMonitor&lt;QaContractOptions&gt;</c> with monotonic revision
    /// tracking. Replaces the legacy <see cref="EdogQaFeatureFlags"/> Lazy
    /// pattern for config reads.
    /// </summary>
    internal sealed class EdogQaContractOptionsProvider : IQaContractOptionsProvider
    {
        private readonly IOptionsMonitor<QaContractOptions> _monitor;
        private long _revision;

        public EdogQaContractOptionsProvider(IOptionsMonitor<QaContractOptions> monitor)
        {
            _monitor = monitor;
            _revision = 1;
            _monitor.OnChange(_ => Interlocked.Increment(ref _revision));
        }

        public QaContractOptions Current
        {
            get
            {
                var opts = _monitor.CurrentValue;
                return new QaContractOptions
                {
                    Revision = Interlocked.Read(ref _revision),
                    Enabled = opts.Enabled,
                    DisabledKinds = opts.DisabledKinds,
                    FewShotEnabled = opts.FewShotEnabled,
                    ControlToken = opts.ControlToken,
                };
            }
        }

        public QaContractOptions CaptureSnapshot() => Current;
    }
}
