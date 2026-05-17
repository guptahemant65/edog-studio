// <copyright file="EdogHttpFaultStore.cs" company="Microsoft">
// Copyright (c) Microsoft Corporation. All rights reserved.
// </copyright>

#nullable disable
#pragma warning disable // DevMode-only file — suppress all warnings

namespace Microsoft.LiveTable.Service.DevMode
{
    using System;
    using System.Collections.Concurrent;
    using System.Collections.Frozen;
    using System.Collections.Generic;
    using System.Linq;
    using System.Net;
    using System.Net.Http;
    using System.Threading;
    using System.Threading.Tasks;

    // ═══════════════════════════════════════════════════════════════════
    // EdogHttpFaultStore — process-wide HTTP fault injection store (F27 P5)
    //
    // The store backs <see cref="EdogHttpPipelineHandler"/>'s ability to
    // synthesize fake HTTP responses for QA scenarios that exercise
    // failure-path assertions.
    //
    // Pattern mirrors <see cref="EdogFeatureOverrideStore"/>:
    //   - FrozenDictionary snapshot replaced atomically via Volatile.Write.
    //   - Readers (the HTTP pipeline handler) never block.
    //   - Writers (the QA execution engine's ChaosIntegration) take a write
    //     lock for the read-merge-write sequence.
    //
    // Rule lookup contract: TryMatchFault(absoluteUri) returns the FIRST
    // rule whose Target appears as a case-insensitive substring of the
    // request URL. The fault payload is interpreted by the HTTP pipeline
    // handler (Stage 2).
    //
    // Stage 1 (this commit): store is a structural placeholder. AddRule /
    // RemoveRulesForScenario do nothing; TryMatchFault always returns false.
    // The QA capability registry reports HTTP chaos as unsupported so the
    // engine never actually invokes these write methods. The empty store
    // is observable evidence that Stage 1 ships no behavior change for
    // chaos scenarios — they are skipped, not lied about.
    //
    // Stage 2 (follow-on commit): store becomes a real lock-free snapshot
    // and EdogHttpPipelineHandler consults TryMatchFault before
    // base.SendAsync to synthesize the configured fault.
    // ═══════════════════════════════════════════════════════════════════

    /// <summary>
    /// Snapshot of an HTTP fault rule. Immutable after construction so
    /// the lock-free reader path can stash references safely.
    /// </summary>
    internal sealed class HttpFaultEntry
    {
        /// <summary>Owning scenario ID. Used for per-scenario cleanup.</summary>
        public string ScenarioId { get; init; }

        /// <summary>Substring matched (case-insensitive) against the request's absolute URI.</summary>
        public string TargetSubstring { get; init; }

        /// <summary>
        /// Fault family. One of <c>http_error</c>, <c>latency</c>, <c>timeout</c>.
        /// Other values are rejected at <see cref="EdogHttpFaultStore.AddRule"/>.
        /// </summary>
        public string Fault { get; init; }

        /// <summary>Status code synthesized for <c>http_error</c>. Defaults to 500.</summary>
        public int StatusCode { get; init; }

        /// <summary>Response body returned for <c>http_error</c>. Optional.</summary>
        public string ResponseBody { get; init; }

        /// <summary>Delay applied before the call for <c>latency</c>, in milliseconds.</summary>
        public int LatencyMs { get; init; }
    }

    /// <summary>
    /// Process-wide store of active HTTP fault rules. Empty in Stage 1.
    /// </summary>
    internal static class EdogHttpFaultStore
    {
        private static volatile FrozenDictionary<string, HttpFaultEntry[]> _byScenario
            = FrozenDictionary<string, HttpFaultEntry[]>.Empty;

        private static volatile HttpFaultEntry[] _flatRules = Array.Empty<HttpFaultEntry>();

        private static readonly object _writeLock = new();
        private static long _revision; // monotonic; Interlocked.Increment

        /// <summary>
        /// Gets the current snapshot revision. Bumps on every successful
        /// <see cref="AddRule"/> / <see cref="RemoveRulesForScenario"/>.
        /// </summary>
        public static long Revision => Interlocked.Read(ref _revision);

        /// <summary>
        /// Gets the total number of active rules across all scenarios.
        /// Diagnostic use only.
        /// </summary>
        public static int ActiveRuleCount => _flatRules.Length;

        /// <summary>
        /// Adds a fault rule for the given scenario. Stage 1 stub: stores
        /// the rule so revision bumps and the count is observable, but the
        /// HTTP pipeline handler does not consult the store until Stage 2.
        /// </summary>
        /// <param name="scenarioId">Owning scenario ID.</param>
        /// <param name="rule">Chaos rule from the scenario setup step.</param>
        public static void AddRule(string scenarioId, ChaosRuleSpec rule)
        {
            if (string.IsNullOrEmpty(scenarioId) || rule == null) return;

            var entry = ToEntry(scenarioId, rule);
            if (entry == null) return;

            lock (_writeLock)
            {
                var newByScenario = new Dictionary<string, HttpFaultEntry[]>(
                    _byScenario.Count + 1, StringComparer.Ordinal);
                foreach (var kv in _byScenario) newByScenario[kv.Key] = kv.Value;

                if (newByScenario.TryGetValue(scenarioId, out var existing))
                {
                    var appended = new HttpFaultEntry[existing.Length + 1];
                    Array.Copy(existing, appended, existing.Length);
                    appended[existing.Length] = entry;
                    newByScenario[scenarioId] = appended;
                }
                else
                {
                    newByScenario[scenarioId] = new[] { entry };
                }

                CommitSnapshot(newByScenario);
            }
        }

        /// <summary>
        /// Removes all fault rules for the given scenario. Called by
        /// ChaosIntegration during teardown.
        /// </summary>
        /// <param name="scenarioId">Scenario ID whose rules should be removed.</param>
        public static void RemoveRulesForScenario(string scenarioId)
        {
            if (string.IsNullOrEmpty(scenarioId)) return;

            lock (_writeLock)
            {
                if (!_byScenario.ContainsKey(scenarioId)) return;

                var newByScenario = new Dictionary<string, HttpFaultEntry[]>(
                    _byScenario.Count, StringComparer.Ordinal);
                foreach (var kv in _byScenario)
                {
                    if (!StringComparer.Ordinal.Equals(kv.Key, scenarioId))
                    {
                        newByScenario[kv.Key] = kv.Value;
                    }
                }

                CommitSnapshot(newByScenario);
            }
        }

        /// <summary>
        /// Returns <c>true</c> when an active fault rule matches the given
        /// absolute URI. Stage 1: always returns <c>false</c> because the
        /// capability registry refuses HTTP chaos and no rules ever enter
        /// the store. Stage 2: real matching is performed by the HTTP
        /// pipeline handler.
        /// </summary>
        /// <param name="absoluteUri">The request's absolute URI.</param>
        /// <param name="match">Receives the matching rule on success.</param>
        public static bool TryMatchFault(string absoluteUri, out HttpFaultEntry match)
        {
            match = null;
            if (string.IsNullOrEmpty(absoluteUri)) return false;

            // Snapshot read is lock-free.
            var rules = _flatRules;
            if (rules.Length == 0) return false;

            foreach (var rule in rules)
            {
                if (string.IsNullOrEmpty(rule.TargetSubstring)) continue;
                if (absoluteUri.IndexOf(rule.TargetSubstring, StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    match = rule;
                    return true;
                }
            }

            return false;
        }

        /// <summary>
        /// Clears all active rules. Test-only — not exposed via SignalR.
        /// </summary>
        public static void ResetForTesting()
        {
            lock (_writeLock)
            {
                CommitSnapshot(new Dictionary<string, HttpFaultEntry[]>(StringComparer.Ordinal));
            }
        }

        // ── Internals ─────────────────────────────────────────────────

        private static HttpFaultEntry ToEntry(string scenarioId, ChaosRuleSpec rule)
        {
            if (rule == null || string.IsNullOrEmpty(rule.Fault)) return null;

            int statusCode = 500;
            int latencyMs = 0;
            string body = null;

            if (rule.Parameters != null)
            {
                if (rule.Parameters.TryGetValue("statusCode", out var sc) && sc != null)
                {
                    int.TryParse(sc.ToString(), out statusCode);
                }
                if (rule.Parameters.TryGetValue("delayMs", out var dm) && dm != null)
                {
                    int.TryParse(dm.ToString(), out latencyMs);
                }
                if (rule.Parameters.TryGetValue("body", out var b) && b != null)
                {
                    body = b.ToString();
                }
            }

            return new HttpFaultEntry
            {
                ScenarioId = scenarioId,
                TargetSubstring = rule.Target ?? string.Empty,
                Fault = rule.Fault,
                StatusCode = statusCode,
                LatencyMs = latencyMs,
                ResponseBody = body,
            };
        }

        private static void CommitSnapshot(Dictionary<string, HttpFaultEntry[]> next)
        {
            var frozen = next.Count == 0
                ? FrozenDictionary<string, HttpFaultEntry[]>.Empty
                : next.ToFrozenDictionary(
                    kv => kv.Key, kv => kv.Value, StringComparer.Ordinal);

            var flat = next.Count == 0
                ? Array.Empty<HttpFaultEntry>()
                : next.Values.SelectMany(arr => arr).ToArray();

            Volatile.Write(ref _byScenario, frozen);
            Volatile.Write(ref _flatRules, flat);
            Interlocked.Increment(ref _revision);
        }
    }
}
