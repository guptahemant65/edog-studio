// <copyright file="EdogQaFeatureFlags.cs" company="Microsoft">
// Copyright (c) Microsoft Corporation. All rights reserved.
// </copyright>

#nullable disable
#pragma warning disable // DevMode-only file — suppress all warnings

namespace Microsoft.LiveTable.Service.DevMode
{
    using System;

    // ═══════════════════════════════════════════════════════════════════
    // EdogQaFeatureFlags — central registry for QA-pipeline feature flags
    //
    // Each flag is a process-wide opt-in/opt-out read from an environment
    // variable at first access (no live re-read; restart the host to change).
    // Flags defined here are wired into the QA orchestration code paths so
    // that experimental codepaths can ship behind a kill switch and be
    // rolled out incrementally:
    //
    //   off    → legacy code path serves users (default)
    //   shadow → new code path runs alongside legacy and logs diffs;
    //            legacy still serves user-visible results
    //   on     → new code path serves users; legacy is dormant
    //
    // The shadow → on transition is the gated rollout pattern from F27 P9
    // §8 — never flip directly from off to on for a critical user-facing
    // pipeline.
    // ═══════════════════════════════════════════════════════════════════

    /// <summary>
    /// Reads QA-pipeline feature flags from environment variables. All flags
    /// are read once and cached for the lifetime of the process.
    /// </summary>
    internal static class EdogQaFeatureFlags
    {
        // ── Env-var names ──────────────────────────────────────────────

        /// <summary>
        /// F27 P9 kill switch for the production-grade LLM scenario
        /// generation pipeline. Accepts <c>off</c> (default) / <c>shadow</c>
        /// / <c>on</c>. See <see cref="LlmV2Mode"/>.
        /// </summary>
        internal const string EnvVarLlmV2 = "EDOG_QA_LLM_V2";

        // ── Public surface ─────────────────────────────────────────────

        /// <summary>
        /// Rollout mode for the F27 P9 production-grade LLM scenario
        /// generation pipeline. Defaults to <see cref="LlmV2Mode.Off"/>
        /// (legacy <see cref="EdogQaLlmProvider"/> serves users) until the
        /// capability probe + eval harness gate (P9 §8 T1 exit criteria)
        /// has passed.
        /// </summary>
        internal static LlmV2Mode LlmV2 => _llmV2.Value;

        // ── Implementation ─────────────────────────────────────────────

        private static readonly Lazy<LlmV2Mode> _llmV2 = new(() =>
            ParseLlmV2(Environment.GetEnvironmentVariable(EnvVarLlmV2)));

        internal static LlmV2Mode ParseLlmV2(string raw)
        {
            if (string.IsNullOrWhiteSpace(raw)) return LlmV2Mode.Off;
            var v = raw.Trim().ToLowerInvariant();
            return v switch
            {
                "on" or "1" or "true" or "enabled" => LlmV2Mode.On,
                "shadow" => LlmV2Mode.Shadow,
                _ => LlmV2Mode.Off,
            };
        }
    }

    /// <summary>Rollout mode for the F27 P9 LLM pipeline. See <see cref="EdogQaFeatureFlags.LlmV2"/>.</summary>
    internal enum LlmV2Mode
    {
        /// <summary>Legacy <see cref="EdogQaLlmProvider"/> serves users (default).</summary>
        Off = 0,

        /// <summary>New pipeline runs alongside legacy; legacy still serves users; diffs are logged.</summary>
        Shadow = 1,

        /// <summary>New pipeline serves users; legacy is dormant.</summary>
        On = 2,
    }
}
