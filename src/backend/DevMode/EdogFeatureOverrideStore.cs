// <copyright file="EdogFeatureOverrideStore.cs" company="Microsoft">
// Copyright (c) Microsoft Corporation. All rights reserved.
// </copyright>

#nullable disable
#pragma warning disable // DevMode-only file — suppress all warnings

namespace Microsoft.LiveTable.Service.DevMode
{
    using System;
    using System.Collections.Frozen;
    using System.Collections.Generic;
    using System.Linq;
    using System.Security.Cryptography;
    using System.Text;
    using System.Threading;

    /// <summary>
    /// Process-wide, lock-free feature-flag override store. The wrapper
    /// (<see cref="EdogFeatureFlighterWrapper"/>) reads from here before
    /// delegating to the inner <c>IFeatureFlighter</c>. Dev-server writes
    /// here via the HTTP control plane on <see cref="EdogLogServer"/>.
    ///
    /// Design (per <c>F11/architecture.md §3</c>):
    ///   - <see cref="FrozenDictionary{TKey,TValue}"/> snapshot, replaced
    ///     atomically via <see cref="Volatile.Write"/>. Readers never block.
    ///   - Force-ON only. <see cref="ReplaceAll"/> rejects entries with
    ///     <c>value == false</c>; HTTP layer also rejects but defense in
    ///     depth keeps the invariant local.
    ///   - <see cref="StringComparer.Ordinal"/>. FLT flag names are
    ///     case-sensitive (verified via <c>FeatureNames.cs</c>).
    ///   - Per-revision SHA-256 hash exposed for verify-on-replay.
    ///   - Per-session control token validated with
    ///     <see cref="CryptographicOperations.FixedTimeEquals"/>.
    /// </summary>
    public static class EdogFeatureOverrideStore
    {
        private static volatile FrozenDictionary<string, bool> _snapshot
            = FrozenDictionary<string, bool>.Empty;

        private static volatile string _hash = EmptyHash();
        private static long _revision; // monotonic; Interlocked.Increment.
        private static readonly object _writeLock = new();

        private static readonly byte[] _controlTokenBytes = LoadControlToken();

        /// <summary>
        /// Gets the current snapshot revision. Monotonically increases on
        /// every successful write.
        /// </summary>
        public static long Revision => Interlocked.Read(ref _revision);

        /// <summary>
        /// Gets the SHA-256 hash of the current snapshot's canonical
        /// serialization. Lower-case hex. Used for verify-on-replay.
        /// </summary>
        public static string Hash => _hash;

        /// <summary>
        /// Gets the number of override entries currently in effect.
        /// </summary>
        public static int Count => _snapshot.Count;

        /// <summary>
        /// Returns whether the FLT-side control token was configured at
        /// startup. When false, all write endpoints must reject with 503.
        /// </summary>
        public static bool ControlTokenConfigured => _controlTokenBytes != null;

        /// <summary>
        /// Lock-free override lookup. Hot path — called on every
        /// <c>IsEnabled</c> call through the wrapper. Budget: &lt; 1 µs p99.
        /// </summary>
        /// <param name="flagName">Wire key (e.g. <c>EnableFMLVQMAPartitionPruning</c>).</param>
        /// <param name="value">Receives the override value when found.</param>
        /// <returns><c>true</c> if an override exists for <paramref name="flagName"/>.</returns>
        public static bool TryGet(string flagName, out bool value)
        {
            if (string.IsNullOrEmpty(flagName))
            {
                value = default;
                return false;
            }

            return _snapshot.TryGetValue(flagName, out value);
        }

        /// <summary>
        /// Atomically replaces the entire override snapshot. Force-OFF
        /// entries (<c>value == false</c>) are rejected at this layer
        /// (defense in depth — HTTP also rejects). Returns the new revision
        /// number and hash.
        /// </summary>
        /// <param name="overrides">New override map. Null is treated as empty.</param>
        /// <returns>Tuple of (revision, hash, count) after the write.</returns>
        public static (long revision, string hash, int count) ReplaceAll(
            IReadOnlyDictionary<string, bool> overrides)
        {
            lock (_writeLock)
            {
                FrozenDictionary<string, bool> next;
                string nextHash;

                if (overrides == null || overrides.Count == 0)
                {
                    next = FrozenDictionary<string, bool>.Empty;
                    nextHash = EmptyHash();
                }
                else
                {
                    foreach (var kvp in overrides)
                    {
                        if (kvp.Value != true)
                        {
                            throw new ArgumentException(
                                $"Force-OFF is not supported in V1. Flag '{kvp.Key}' was set to {kvp.Value}.",
                                nameof(overrides));
                        }
                    }

                    next = overrides.ToFrozenDictionary(
                        kvp => kvp.Key,
                        kvp => kvp.Value,
                        StringComparer.Ordinal);

                    nextHash = ComputeHash(next);
                }

                Volatile.Write(ref _snapshot, next);
                _hash = nextHash;
                var newRev = Interlocked.Increment(ref _revision);
                return (newRev, nextHash, next.Count);
            }
        }

        /// <summary>
        /// Resets the snapshot to empty. Equivalent to
        /// <c>ReplaceAll(empty)</c> but explicit for clarity at call sites.
        /// </summary>
        /// <returns>Tuple of (revision, hash) after the reset.</returns>
        public static (long revision, string hash) Reset()
        {
            var (rev, h, _) = ReplaceAll(null);
            return (rev, h);
        }

        /// <summary>
        /// Returns a stable, materialized copy of the current snapshot for
        /// serialization. Reads <see cref="_snapshot"/> once; safe under
        /// concurrent writes.
        /// </summary>
        public static IReadOnlyDictionary<string, bool> GetSnapshot()
        {
            var current = _snapshot;
            return current;
        }

        /// <summary>
        /// Validates a request's <c>X-EDOG-Control-Token</c> header against
        /// the per-session token configured via <c>EDOG_CONTROL_TOKEN</c>
        /// env var. Uses
        /// <see cref="CryptographicOperations.FixedTimeEquals(ReadOnlySpan{byte}, ReadOnlySpan{byte})"/>
        /// to avoid timing-side-channel leakage.
        /// </summary>
        /// <param name="presented">Token value from the request header. May be null.</param>
        /// <returns><c>true</c> when the token matches the configured value byte-for-byte.</returns>
        public static bool ValidateControlToken(string presented)
        {
            if (_controlTokenBytes == null) return false;
            if (string.IsNullOrEmpty(presented)) return false;

            byte[] presentedBytes;
            try
            {
                presentedBytes = Encoding.UTF8.GetBytes(presented);
            }
            catch
            {
                return false;
            }

            if (presentedBytes.Length != _controlTokenBytes.Length) return false;
            return CryptographicOperations.FixedTimeEquals(presentedBytes, _controlTokenBytes);
        }

        private static byte[] LoadControlToken()
        {
            try
            {
                var token = Environment.GetEnvironmentVariable("EDOG_CONTROL_TOKEN");
                if (string.IsNullOrEmpty(token)) return null;
                return Encoding.UTF8.GetBytes(token);
            }
            catch
            {
                return null;
            }
        }

        private static string ComputeHash(FrozenDictionary<string, bool> map)
        {
            // Canonical form: sorted "key=true\n" lines, UTF-8, SHA-256, hex.
            // Force-ON only so we only emit "true" values.
            var sb = new StringBuilder(map.Count * 32);
            foreach (var kvp in map.OrderBy(k => k.Key, StringComparer.Ordinal))
            {
                sb.Append(kvp.Key).Append('=').Append(kvp.Value ? "true" : "false").Append('\n');
            }

            var bytes = Encoding.UTF8.GetBytes(sb.ToString());
            var hash = SHA256.HashData(bytes);
            return Convert.ToHexString(hash).ToLowerInvariant();
        }

        private static string EmptyHash()
        {
            // SHA-256 of empty string, computed lazily once.
            var hash = SHA256.HashData(Array.Empty<byte>());
            return Convert.ToHexString(hash).ToLowerInvariant();
        }
    }
}
