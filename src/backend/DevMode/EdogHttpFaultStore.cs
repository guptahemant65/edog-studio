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
    // handler:
    //   - "http_error" → synthesize HttpResponseMessage with the configured
    //                    StatusCode + ResponseBody; never call base.
    //   - "latency"    → await Task.Delay(LatencyMs) THEN call base.
    //   - "timeout"    → throw TaskCanceledException (no base call).
    //
    // The store is empty in production builds: no rule enters until the
    // QA execution engine's ChaosIntegration calls AddRule(scenarioId,...)
    // and that path is gated by EdogQaCapabilityRegistry.IsChaosFaultSupported,
    // which requires both the build-time HttpChaosPipelineWired constant
    // and the runtime EDOG_QA_CHAOS_HTTP env var.
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

        /// <summary>
        /// Target node ID for error simulator rules. When non-null, this rule only
        /// fires if <see cref="EdogNodeExecutionContext.Current"/> matches.
        /// Null = fire for any node (QA chaos or DAG-level injection).
        /// </summary>
        public string NodeId { get; init; }

        /// <summary>
        /// Unique rule identifier for mutable state lookup in <see cref="EdogHttpFaultStore._ruleStates"/>.
        /// Null for legacy QA chaos rules that don't need mutable state.
        /// </summary>
        public string RuleId { get; init; }
    }

    /// <summary>
    /// Mutable runtime state for a fault rule. Stored separately from the
    /// immutable <see cref="HttpFaultEntry"/> to preserve lock-free reads
    /// on the frozen snapshot while allowing enable/disable toggling and
    /// fire counting via atomic operations.
    /// </summary>
    internal sealed class FaultRuleState
    {
        public volatile bool Enabled = true;
        public int FireCount;
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

        // Mutable runtime state per rule — keyed by RuleId. Separate from the
        // immutable frozen snapshot so enable/disable + fire counting don't
        // require snapshot rebuilds. Atomic reads via volatile/Interlocked.
        private static readonly ConcurrentDictionary<string, FaultRuleState> _ruleStates = new();

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

            // Read AsyncLocal node context once — used for node-scoped rules.
            var nodeCtx = EdogNodeExecutionContext.Current;
            string currentNodeId = nodeCtx?.NodeId;
            string currentNodeName = nodeCtx?.NodeName;

            foreach (var rule in rules)
            {
                if (string.IsNullOrEmpty(rule.TargetSubstring)) continue;

                // Node scoping: if rule targets a specific node, skip unless context matches.
                // Primary match is on NodeId (the FLT Guid string — what the Error Code
                // Simulator frontend sends). Defensive Name fallback protects against
                // legacy/manual hub callers that may send display names instead of Guids;
                // we'd rather over-fire (with a known rule) than silently no-op.
                if (rule.NodeId != null
                    && (currentNodeId == null
                        || (!string.Equals(rule.NodeId, currentNodeId, StringComparison.OrdinalIgnoreCase)
                            && !string.Equals(rule.NodeId, currentNodeName, StringComparison.OrdinalIgnoreCase))))
                {
                    continue;
                }

                // URL substring match (existing logic)
                if (absoluteUri.IndexOf(rule.TargetSubstring, StringComparison.OrdinalIgnoreCase) < 0)
                {
                    continue;
                }

                // Mutable state: single lookup for both enabled check + fire count
                FaultRuleState ruleState = null;
                if (rule.RuleId != null)
                {
                    _ruleStates.TryGetValue(rule.RuleId, out ruleState);
                }

                if (ruleState != null && !ruleState.Enabled)
                {
                    continue;
                }

                // Track fire count
                if (ruleState != null)
                {
                    Interlocked.Increment(ref ruleState.FireCount);
                }

                match = rule;
                return true;
            }

            return false;
        }

        // ── Error Simulator integration helpers ───────────────────────
        //
        // These two helpers exist so EDOG's Error Code Simulator can:
        //   1. Detect "is this node armed?" BEFORE the executor picks a
        //      lifecycle branch — used by the patched
        //      ExecuteFileSourcedNodeAsync to force a GTS submit on
        //      file-sourced MLVs that would otherwise short-circuit on
        //      NO_NEW_DATA and never call customTransformExecution.
        //   2. Read per-rule match counters AFTER a node completes —
        //      used by EdogErrorSimEngine.OnNodeExecutionCompleted to
        //      emit ErrorSimRuleMatched / ErrorSimRuleUnmatched telemetry.
        //
        // Both helpers are lock-free (read the frozen snapshot + the
        // concurrent rule-state dictionary) and never throw.
        // ───────────────────────────────────────────────────────────────

        /// <summary>
        /// Returns <c>true</c> when the Error Simulator has at least one
        /// enabled, node-scoped GTS rule armed for the given node ID.
        /// Used as a precondition by the file-sourced execution path to
        /// decide whether to bypass change detection and force a GTS
        /// submit so the rule actually has a chance to fire.
        /// </summary>
        /// <remarks>
        /// Strict filtering: only counts rules created via
        /// <see cref="AddErrorSimRule"/> (<c>ScenarioId == "error-sim"</c>)
        /// whose <c>TargetSubstring</c> contains <c>customTransformExecution</c>
        /// (case-insensitive). DAG-level rules (<c>NodeId == null</c>) and
        /// QA chaos rules are intentionally excluded — they do not represent
        /// a specific node arm and forcing GTS for every file-sourced node
        /// on a DAG-wide rule would be too invasive.
        /// </remarks>
        public static bool HasArmedFaultForNode(string nodeId)
        {
            if (string.IsNullOrEmpty(nodeId)) return false;

            var rules = _flatRules;
            if (rules.Length == 0) return false;

            foreach (var rule in rules)
            {
                if (rule.ScenarioId != "error-sim") continue;
                if (string.IsNullOrEmpty(rule.NodeId)) continue;
                if (!string.Equals(rule.NodeId, nodeId, StringComparison.OrdinalIgnoreCase)) continue;
                if (string.IsNullOrEmpty(rule.TargetSubstring)) continue;
                if (rule.TargetSubstring.IndexOf("customTransformExecution", StringComparison.OrdinalIgnoreCase) < 0) continue;

                if (rule.RuleId != null
                    && _ruleStates.TryGetValue(rule.RuleId, out var state)
                    && !state.Enabled)
                {
                    continue;
                }

                return true;
            }

            return false;
        }

        /// <summary>
        /// Returns the number of times the rule with the given ID has matched
        /// (and been applied by <see cref="EdogHttpPipelineHandler"/>) since
        /// it was added. Zero if the rule does not exist or has not yet fired.
        /// Lock-free.
        /// </summary>
        public static int GetMatchCount(string ruleId)
        {
            if (string.IsNullOrEmpty(ruleId)) return 0;
            return _ruleStates.TryGetValue(ruleId, out var state)
                ? Volatile.Read(ref state.FireCount)
                : 0;
        }

        /// <summary>
        /// Clears all active rules. Test-only — not exposed via SignalR.
        /// </summary>
        public static void ResetForTesting()
        {
            lock (_writeLock)
            {
                CommitSnapshot(new Dictionary<string, HttpFaultEntry[]>(StringComparer.Ordinal));
                _ruleStates.Clear();
            }
        }

        /// <summary>
        /// Adds a node-scoped error simulator rule. Used by <see cref="EdogErrorSimEngine"/>
        /// for Channels 1 and 2 (GTS fault injection during node execution).
        /// </summary>
        /// <param name="ruleId">Unique rule ID for mutable state tracking.</param>
        /// <param name="nodeId">Target node ID (null = DAG-level, any node).</param>
        /// <param name="targetSubstring">URL substring to match (e.g., "customTransformExecution").</param>
        /// <param name="fault">Fault type: "http_error" or "timeout".</param>
        /// <param name="statusCode">HTTP status code for http_error faults.</param>
        /// <param name="responseBody">Response body for http_error faults.</param>
        public static void AddErrorSimRule(
            string ruleId, string nodeId, string targetSubstring,
            string fault, int statusCode = 200, string responseBody = null)
        {
            if (string.IsNullOrEmpty(ruleId)) return;

            var entry = new HttpFaultEntry
            {
                ScenarioId = "error-sim",
                RuleId = ruleId,
                NodeId = nodeId,
                TargetSubstring = targetSubstring ?? string.Empty,
                Fault = fault ?? "http_error",
                StatusCode = statusCode,
                ResponseBody = responseBody,
            };

            _ruleStates[ruleId] = new FaultRuleState();

            lock (_writeLock)
            {
                var newByScenario = new Dictionary<string, HttpFaultEntry[]>(
                    _byScenario.Count + 1, StringComparer.Ordinal);
                foreach (var kv in _byScenario) newByScenario[kv.Key] = kv.Value;

                if (newByScenario.TryGetValue("error-sim", out var existing))
                {
                    var appended = new HttpFaultEntry[existing.Length + 1];
                    Array.Copy(existing, appended, existing.Length);
                    appended[existing.Length] = entry;
                    newByScenario["error-sim"] = appended;
                }
                else
                {
                    newByScenario["error-sim"] = new[] { entry };
                }

                CommitSnapshot(newByScenario);
            }
        }

        /// <summary>
        /// Removes a specific error simulator rule by ruleId.
        /// </summary>
        public static void RemoveErrorSimRule(string ruleId)
        {
            if (string.IsNullOrEmpty(ruleId)) return;
            _ruleStates.TryRemove(ruleId, out _);

            lock (_writeLock)
            {
                if (!_byScenario.ContainsKey("error-sim")) return;

                var current = _byScenario["error-sim"];
                var filtered = current.Where(r => r.RuleId != ruleId).ToArray();

                var newByScenario = new Dictionary<string, HttpFaultEntry[]>(
                    _byScenario.Count, StringComparer.Ordinal);
                foreach (var kv in _byScenario) newByScenario[kv.Key] = kv.Value;

                if (filtered.Length > 0)
                    newByScenario["error-sim"] = filtered;
                else
                    newByScenario.Remove("error-sim");

                CommitSnapshot(newByScenario);
            }
        }

        /// <summary>
        /// Removes all error simulator rules.
        /// </summary>
        public static void ClearErrorSimRules()
        {
            lock (_writeLock)
            {
                // Clear just error-sim rules, preserve QA chaos rules
                if (!_byScenario.ContainsKey("error-sim")) return;

                var newByScenario = new Dictionary<string, HttpFaultEntry[]>(
                    _byScenario.Count, StringComparer.Ordinal);
                foreach (var kv in _byScenario)
                {
                    if (kv.Key != "error-sim") newByScenario[kv.Key] = kv.Value;
                }

                CommitSnapshot(newByScenario);
            }

            // Clear mutable state for all error-sim rules
            foreach (var key in _ruleStates.Keys.ToArray())
            {
                _ruleStates.TryRemove(key, out _);
            }
        }

        /// <summary>
        /// Gets the mutable runtime state for a rule. Returns null if no state exists.
        /// </summary>
        public static FaultRuleState GetRuleState(string ruleId)
        {
            return ruleId != null && _ruleStates.TryGetValue(ruleId, out var s) ? s : null;
        }

        // ── Internals ─────────────────────────────────────────────────

        private static HttpFaultEntry ToEntry(string scenarioId, ChaosRuleSpec rule)
        {
            if (rule == null || string.IsNullOrEmpty(rule.Fault)) return null;

            // Defaults survive any malformed input. Parse-then-validate
            // pattern: only override the default when both the parse and
            // range check succeed, so a junk "statusCode": "abc" doesn't
            // produce HttpStatusCode 0 / negative delays at Stage 2.
            int statusCode = 500;
            int latencyMs = 0;
            string body = null;

            if (rule.Parameters != null)
            {
                if (rule.Parameters.TryGetValue("statusCode", out var sc) && sc != null
                    && int.TryParse(sc.ToString(), out var parsedSc)
                    && parsedSc >= 100 && parsedSc <= 599)
                {
                    statusCode = parsedSc;
                }
                if (rule.Parameters.TryGetValue("delayMs", out var dm) && dm != null
                    && int.TryParse(dm.ToString(), out var parsedDm)
                    && parsedDm >= 0 && parsedDm <= 600_000)
                {
                    latencyMs = parsedDm;
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
