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
    // ═══════════════════════════════════════════════════════════════════

    /// <summary>
    /// Centralizes hashing, truncation, reason-code normalization, and
    /// sampling decisions for the contract telemetry stream.
    /// </summary>
    internal sealed class EdogQaTelemetryRedactor
    {
        private const int DefaultMaxLength = 256;
        private const int HashPrefixLength = 8;

        /// <summary>
        /// Hashes a value using SHA-256 and returns a truncated hex prefix.
        /// </summary>
        public string HashValue(string value)
        {
            if (string.IsNullOrEmpty(value)) return string.Empty;
            var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(value));
            return Convert.ToHexString(bytes)[..HashPrefixLength].ToLowerInvariant();
        }

        /// <summary>
        /// Truncates a value to the maximum allowed length.
        /// </summary>
        public string Truncate(string value, int maxLength = DefaultMaxLength)
        {
            if (string.IsNullOrEmpty(value)) return string.Empty;
            return value.Length <= maxLength ? value : value[..maxLength] + "...";
        }

        /// <summary>
        /// Normalizes a reason code to a stable telemetry-safe string.
        /// </summary>
        public string NormalizeReasonCode(string reason)
        {
            if (string.IsNullOrEmpty(reason)) return "unknown";
            return reason.Trim().ToLowerInvariant().Replace(' ', '_');
        }

        /// <summary>
        /// Determines whether an event should be sampled (emitted) based on
        /// a sampling rate. Rate of 1.0 means always emit; 0.0 means never.
        /// </summary>
        public bool ShouldSample(double samplingRate)
        {
            if (samplingRate >= 1.0) return true;
            if (samplingRate <= 0.0) return false;
            return Random.Shared.NextDouble() < samplingRate;
        }
    }
}
