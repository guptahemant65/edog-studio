// <copyright file="EdogQaTelemetryRedactor.cs" company="Microsoft">
// Copyright (c) Microsoft Corporation. All rights reserved.
// </copyright>

#nullable disable
#pragma warning disable // DevMode-only file — suppress all warnings

namespace Microsoft.LiveTable.Service.DevMode
{
    using System;
    using System.Security.Cryptography;
    using System.Text;

    // ═══════════════════════════════════════════════════════════════════
    // EdogQaTelemetryRedactor — hashing + truncation + sampling helper
    //
    // Centralizes redaction decisions for the contract telemetry stream.
    // All methods are static and side-effect-free.
    // ═══════════════════════════════════════════════════════════════════

    /// <summary>
    /// Centralizes hashing, truncation, reason-code normalization, and
    /// sampling decisions for the contract telemetry stream.
    /// </summary>
    internal static class EdogQaTelemetryRedactor
    {
        /// <summary>
        /// SHA-256 hash of a value, truncated to 16 hex characters.
        /// </summary>
        internal static string Hash16(string value) =>
            Convert.ToHexString(
                SHA256.HashData(Encoding.UTF8.GetBytes(value ?? string.Empty))
            ).ToLowerInvariant()[..16];

        /// <summary>
        /// Truncates a value to at most 512 characters.
        /// </summary>
        internal static string Truncate512(string value) =>
            string.IsNullOrEmpty(value) ? string.Empty : value[..Math.Min(512, value.Length)];

        /// <summary>
        /// Normalizes a reason code to a stable telemetry-safe string.
        /// Unknown/empty codes become "UNKNOWN".
        /// </summary>
        internal static string NormalizeReasonCode(string reasonCode) =>
            string.IsNullOrWhiteSpace(reasonCode)
                ? "UNKNOWN"
                : Truncate512(reasonCode.Trim().ToUpperInvariant());

        /// <summary>
        /// Determines whether an outcome event should be sampled (emitted).
        /// High-volume "pass" outcomes are downsampled 1:10 above 10K daily;
        /// all other outcomes (stale, quarantined, failed, etc.) always emit.
        /// </summary>
        internal static bool ShouldSampleOutcome(string outcome, long dailyVolume)
        {
            if (string.Equals(outcome, "pass", StringComparison.OrdinalIgnoreCase)
                && dailyVolume > 10_000)
            {
                return (dailyVolume % 10) == 0;
            }

            return true;
        }
    }
}
