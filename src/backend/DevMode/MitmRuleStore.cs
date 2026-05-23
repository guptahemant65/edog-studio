// <copyright file="MitmRuleStore.cs" company="Microsoft">
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
    using System.Net.Http;
    using System.Text.RegularExpressions;
    using System.Threading;

    // ═══════════════════════════════════════════════════════════════════
    // MitmRuleStore — process-wide HTTP MITM rule store (F28 C02)
    //
    // Pattern mirrors EdogHttpFaultStore line-for-line:
    //   - Two FrozenDictionary snapshots replaced atomically via Volatile.Write.
    //   - Readers (MitmCoordinator on the HTTP hot path) never block.
    //   - Writers (SignalR hub methods) take a write lock for read-merge-write.
    //
    // Two snapshots:
    //   - _orderedFlat : pre-sorted (Priority asc, CreatedAtUtc asc) array
    //                    scanned by TryMatch for first-match-wins semantics.
    //   - _byOwner     : connectionId → rule[] for O(1) owner-scoped purge
    //                    on SignalR disconnect.
    //
    // Reader hot-path contract:
    //   if (MitmRuleStore.Count == 0) return false;   // single volatile read
    //   MitmRuleStore.TryMatch(ctx, phase, out rule)   // first match wins
    //
    // Writer contract:
    //   - All mutations validate inputs, compile regex exactly once,
    //     normalise (uppercase methods, clamp timeouts, default arrays),
    //     and call CommitSnapshot under _writeLock.
    //   - AddOrReplace rejects (Phase=Response, Action != Breakpoint) at
    //     insert time — see §2.4 of the architecture spec.
    //
    // Safety: every public method is wrapped in try/catch at its outermost
    // frame. On exception the store is left untouched and a safe default
    // is returned. Pattern mirrors EdogTopicRouter.Publish.
    // ═══════════════════════════════════════════════════════════════════

    /// <summary>
    /// Predicate input for <see cref="MitmRuleStore.TryMatch"/>. Built once per
    /// HTTP call at the suspension point; never escapes the stack frame.
    /// </summary>
    internal readonly struct MitmMatchContext
    {
        /// <summary>Absolute request URI (post-redaction is fine — matching is case-insensitive).</summary>
        public readonly string Url;

        /// <summary>HTTP method, uppercased.</summary>
        public readonly string Method;

        /// <summary>Named-HttpClient identifier (<see cref="EdogHttpPipelineHandler._httpClientName"/>).</summary>
        public readonly string HttpClientName;

        /// <summary>Suspension point this context represents.</summary>
        public readonly MitmPhase Phase;

        private MitmMatchContext(string url, string method, string httpClientName, MitmPhase phase)
        {
            this.Url = url;
            this.Method = method;
            this.HttpClientName = httpClientName;
            this.Phase = phase;
        }

        /// <summary>Construct from a live <see cref="HttpRequestMessage"/>.</summary>
        public static MitmMatchContext From(HttpRequestMessage req, string httpClientName, MitmPhase phase)
        {
            string url = req?.RequestUri?.AbsoluteUri ?? string.Empty;
            string method = req?.Method?.Method?.ToUpperInvariant() ?? "GET";
            return new MitmMatchContext(url, method, httpClientName, phase);
        }
    }

    /// <summary>
    /// Validation outcome from <see cref="MitmRuleStore.AddOrReplace"/>. The store
    /// rejects malformed rules rather than coercing — the SignalR layer surfaces
    /// the message as <c>RULE_VALIDATION_FAILED</c>.
    /// </summary>
    internal sealed class MitmValidationResult
    {
        /// <summary>True when the rule was accepted and is now live.</summary>
        public bool Success { get; init; }

        /// <summary>Server-assigned (or echoed) rule id. Null on failure.</summary>
        public string RuleId { get; init; }

        /// <summary>Diagnostic message — empty on success, human-readable on failure.</summary>
        public string Message { get; init; }

        /// <summary>Snapshot revision after this operation; useful for ETag-style sync.</summary>
        public long Revision { get; init; }

        internal static MitmValidationResult Ok(string ruleId, long revision)
            => new() { Success = true, RuleId = ruleId, Message = string.Empty, Revision = revision };

        internal static MitmValidationResult Invalid(string message)
            => new() { Success = false, Message = message ?? "validation failed" };
    }

    /// <summary>
    /// Process-wide store of active MITM rules. Empty until a SignalR client
    /// successfully invokes <c>MitmCreateRule</c>.
    /// </summary>
    internal static class MitmRuleStore
    {
        // ── Tunables (mirrored in MitmCapabilityReport.limits) ───────────
        private const int MaxRulesGlobal = 500;
        private const int MaxRulesPerConnection = 50;
        private const int MaxRuleBodyBytes = 1_048_576;          // 1 MB (forge/block payloads)
        private const int MinTimeoutMs = 1_000;
        private const int MaxTimeoutMs = 60_000;
        private const int DefaultTimeoutMs = 30_000;
        private const int RegexTimeoutMs = 50;

        // ── State ────────────────────────────────────────────────────────
        private static volatile FrozenDictionary<string /*ownerConnectionId*/, RuleEntry[]> _byOwner
            = FrozenDictionary<string, RuleEntry[]>.Empty;

        private static volatile RuleEntry[] _orderedFlat = Array.Empty<RuleEntry>();

        private static readonly object _writeLock = new();
        private static long _revision;

        /// <summary>Monotonic snapshot revision; bumps on every successful mutation.</summary>
        public static long Revision => Interlocked.Read(ref _revision);

        /// <summary>Total active rules across all owners. Hot-path short-circuit reads this.</summary>
        public static int Count => _orderedFlat.Length;

        /// <summary>
        /// Internal store entry — pairs the immutable rule snapshot with its mutable
        /// runtime counters so the reader hot path can mutate fire-count without
        /// allocating a new <see cref="MitmRule"/>.
        /// </summary>
        internal sealed class RuleEntry
        {
            public MitmRule Rule;
            public MitmRuleRuntime Runtime;
        }

        // ── Reads ────────────────────────────────────────────────────────

        /// <summary>
        /// First-match-wins rule lookup. Lock-free: reads the volatile
        /// <c>_orderedFlat</c> snapshot once. The array is pre-sorted by
        /// (<see cref="MitmRule.Priority"/> asc, <see cref="MitmRule.CreatedAtUtc"/> asc),
        /// so the first matching entry is the winner.
        /// </summary>
        /// <param name="ctx">Match context built once per HTTP call.</param>
        /// <param name="phase">Suspension point the caller is evaluating.</param>
        /// <param name="match">Receives the matching immutable rule on success.</param>
        /// <returns>True when a rule matched; false otherwise.</returns>
        public static bool TryMatch(in MitmMatchContext ctx, MitmPhase phase, out MitmRule match)
        {
            match = null;
            try
            {
                var snapshot = _orderedFlat;
                if (snapshot.Length == 0) return false;

                string url = ctx.Url ?? string.Empty;
                string method = ctx.Method ?? string.Empty;
                string clientName = ctx.HttpClientName;

                for (int i = 0; i < snapshot.Length; i++)
                {
                    var e = snapshot[i];
                    var r = e.Rule;
                    if (r == null || !r.Enabled) continue;
                    if (r.Match == null) continue;
                    if (r.Match.Phase != phase) continue;
                    if (!UrlMatches(r.Match.UrlPattern, url)) continue;

                    var methods = r.Match.Methods;
                    if (methods != null && methods.Length > 0)
                    {
                        bool found = false;
                        for (int m = 0; m < methods.Length; m++)
                        {
                            if (string.Equals(methods[m], method, StringComparison.OrdinalIgnoreCase))
                            {
                                found = true;
                                break;
                            }
                        }
                        if (!found) continue;
                    }

                    if (!string.IsNullOrEmpty(r.Match.HttpClientName) &&
                        !string.Equals(r.Match.HttpClientName, clientName, StringComparison.OrdinalIgnoreCase))
                        continue;

                    match = r;
                    return true;
                }
                return false;
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"[EDOG] MitmRuleStore.TryMatch error: {ex.Message}");
                match = null;
                return false;
            }
        }

        /// <summary>
        /// Snapshot of all rules across all owners. Used by <c>MitmListRules</c>
        /// and diagnostics. Allocates a fresh list; safe to enumerate.
        /// </summary>
        public static IReadOnlyList<MitmRule> GetAll()
        {
            try
            {
                var snapshot = _orderedFlat;
                if (snapshot.Length == 0) return Array.Empty<MitmRule>();

                var list = new List<MitmRule>(snapshot.Length);
                for (int i = 0; i < snapshot.Length; i++)
                {
                    var r = snapshot[i]?.Rule;
                    if (r != null) list.Add(r);
                }
                return list;
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"[EDOG] MitmRuleStore.GetAll error: {ex.Message}");
                return Array.Empty<MitmRule>();
            }
        }

        /// <summary>
        /// Returns the mutable runtime counters for the given rule id, or
        /// <c>null</c> if the rule no longer exists. Used by
        /// <see cref="MitmCoordinator.SubmitDecision"/> to record fire counts.
        /// </summary>
        internal static MitmRuleRuntime GetRuntime(string ruleId)
        {
            if (string.IsNullOrEmpty(ruleId)) return null;
            try
            {
                var snapshot = _orderedFlat;
                for (int i = 0; i < snapshot.Length; i++)
                {
                    var e = snapshot[i];
                    if (e?.Rule != null && string.Equals(e.Rule.Id, ruleId, StringComparison.Ordinal))
                        return e.Runtime;
                }
                return null;
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"[EDOG] MitmRuleStore.GetRuntime error: {ex.Message}");
                return null;
            }
        }

        // ── Writes ───────────────────────────────────────────────────────

        /// <summary>
        /// Validates, compiles regex, normalises, and inserts the rule. Same
        /// <see cref="MitmRule.Id"/> ⇒ last-writer-wins (overwrite in place).
        /// Rejects <c>(Phase=Response, Action != Breakpoint)</c> per §2.4.
        /// </summary>
        public static MitmValidationResult AddOrReplace(MitmRule rule)
        {
            try
            {
                var validation = ValidateAndNormalise(rule, out var normalised);
                if (!validation.Success) return validation;

                lock (_writeLock)
                {
                    var ownerKey = normalised.OwnerConnectionId ?? string.Empty;

                    // Capacity guards. Global cap is hard; per-connection cap excludes
                    // a same-id overwrite (which doesn't grow the set).
                    int globalCount = _orderedFlat.Length;
                    bool isOverwrite = false;
                    int perOwnerCount = 0;
                    if (_byOwner.TryGetValue(ownerKey, out var existingForOwner))
                    {
                        perOwnerCount = existingForOwner.Length;
                        for (int i = 0; i < existingForOwner.Length; i++)
                        {
                            if (string.Equals(existingForOwner[i].Rule.Id, normalised.Id, StringComparison.Ordinal))
                            {
                                isOverwrite = true;
                                break;
                            }
                        }
                    }

                    if (!isOverwrite)
                    {
                        if (globalCount >= MaxRulesGlobal)
                            return MitmValidationResult.Invalid($"global rule limit reached ({MaxRulesGlobal})");
                        if (perOwnerCount >= MaxRulesPerConnection)
                            return MitmValidationResult.Invalid($"per-connection rule limit reached ({MaxRulesPerConnection})");
                    }

                    var next = CloneByOwnerForWrite();

                    if (next.TryGetValue(ownerKey, out var arr))
                    {
                        // Replace by id, else append.
                        int replaceIdx = -1;
                        for (int i = 0; i < arr.Length; i++)
                        {
                            if (string.Equals(arr[i].Rule.Id, normalised.Id, StringComparison.Ordinal))
                            {
                                replaceIdx = i;
                                break;
                            }
                        }
                        if (replaceIdx >= 0)
                        {
                            var copy = new RuleEntry[arr.Length];
                            Array.Copy(arr, copy, arr.Length);
                            copy[replaceIdx] = new RuleEntry { Rule = normalised, Runtime = arr[replaceIdx].Runtime ?? new MitmRuleRuntime() };
                            next[ownerKey] = copy;
                        }
                        else
                        {
                            var appended = new RuleEntry[arr.Length + 1];
                            Array.Copy(arr, appended, arr.Length);
                            appended[arr.Length] = new RuleEntry { Rule = normalised, Runtime = new MitmRuleRuntime() };
                            next[ownerKey] = appended;
                        }
                    }
                    else
                    {
                        next[ownerKey] = new[] { new RuleEntry { Rule = normalised, Runtime = new MitmRuleRuntime() } };
                    }

                    CommitSnapshot(next);
                    return MitmValidationResult.Ok(normalised.Id, Revision);
                }
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"[EDOG] MitmRuleStore.AddOrReplace error: {ex.Message}");
                return MitmValidationResult.Invalid($"internal error: {ex.Message}");
            }
        }

        /// <summary>
        /// Removes the rule with the given id. Idempotent — returns <c>false</c>
        /// when the id was not present.
        /// </summary>
        public static bool Remove(string ruleId)
        {
            if (string.IsNullOrEmpty(ruleId)) return false;
            try
            {
                lock (_writeLock)
                {
                    string ownerKey = null;
                    int idxInOwner = -1;
                    foreach (var kv in _byOwner)
                    {
                        for (int i = 0; i < kv.Value.Length; i++)
                        {
                            if (string.Equals(kv.Value[i].Rule.Id, ruleId, StringComparison.Ordinal))
                            {
                                ownerKey = kv.Key;
                                idxInOwner = i;
                                break;
                            }
                        }
                        if (ownerKey != null) break;
                    }

                    if (ownerKey == null) return false;

                    var next = CloneByOwnerForWrite();
                    var arr = next[ownerKey];
                    if (arr.Length == 1)
                    {
                        next.Remove(ownerKey);
                    }
                    else
                    {
                        var shrunk = new RuleEntry[arr.Length - 1];
                        if (idxInOwner > 0) Array.Copy(arr, 0, shrunk, 0, idxInOwner);
                        if (idxInOwner < arr.Length - 1) Array.Copy(arr, idxInOwner + 1, shrunk, idxInOwner, arr.Length - idxInOwner - 1);
                        next[ownerKey] = shrunk;
                    }

                    CommitSnapshot(next);
                    return true;
                }
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"[EDOG] MitmRuleStore.Remove error: {ex.Message}");
                return false;
            }
        }

        /// <summary>
        /// Toggles the <see cref="MitmRule.Enabled"/> flag on the named rule.
        /// Builds a new immutable snapshot — the prior <see cref="MitmRule"/>
        /// reference is never mutated.
        /// </summary>
        public static bool SetEnabled(string ruleId, bool enabled)
        {
            if (string.IsNullOrEmpty(ruleId)) return false;
            try
            {
                lock (_writeLock)
                {
                    string ownerKey = null;
                    int idxInOwner = -1;
                    RuleEntry existing = null;
                    foreach (var kv in _byOwner)
                    {
                        for (int i = 0; i < kv.Value.Length; i++)
                        {
                            if (string.Equals(kv.Value[i].Rule.Id, ruleId, StringComparison.Ordinal))
                            {
                                ownerKey = kv.Key;
                                idxInOwner = i;
                                existing = kv.Value[i];
                                break;
                            }
                        }
                        if (ownerKey != null) break;
                    }

                    if (existing == null) return false;
                    if (existing.Rule.Enabled == enabled) return true;

                    var replaced = new MitmRule
                    {
                        Id = existing.Rule.Id,
                        Name = existing.Rule.Name,
                        OwnerConnectionId = existing.Rule.OwnerConnectionId,
                        Enabled = enabled,
                        Priority = existing.Rule.Priority,
                        Match = existing.Rule.Match,
                        Action = existing.Rule.Action,
                        CreatedAtUtc = existing.Rule.CreatedAtUtc,
                    };

                    var next = CloneByOwnerForWrite();
                    var arr = next[ownerKey];
                    var copy = new RuleEntry[arr.Length];
                    Array.Copy(arr, copy, arr.Length);
                    copy[idxInOwner] = new RuleEntry { Rule = replaced, Runtime = existing.Runtime };
                    next[ownerKey] = copy;

                    CommitSnapshot(next);
                    return true;
                }
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"[EDOG] MitmRuleStore.SetEnabled error: {ex.Message}");
                return false;
            }
        }

        /// <summary>
        /// Bulk-removes every rule owned by the given SignalR connection.
        /// Called from <c>EdogPlaygroundHub.OnDisconnectedAsync</c>.
        /// </summary>
        /// <returns>Number of rules purged.</returns>
        public static int PurgeByOwner(string connectionId)
        {
            if (string.IsNullOrEmpty(connectionId)) return 0;
            try
            {
                lock (_writeLock)
                {
                    if (!_byOwner.TryGetValue(connectionId, out var purged) || purged.Length == 0)
                        return 0;

                    int purgedCount = purged.Length;
                    var next = new Dictionary<string, RuleEntry[]>(
                        Math.Max(0, _byOwner.Count - 1), StringComparer.Ordinal);
                    foreach (var kv in _byOwner)
                    {
                        if (!string.Equals(kv.Key, connectionId, StringComparison.Ordinal))
                            next[kv.Key] = kv.Value;
                    }
                    CommitSnapshot(next);
                    return purgedCount;
                }
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"[EDOG] MitmRuleStore.PurgeByOwner error: {ex.Message}");
                return 0;
            }
        }

        /// <summary>
        /// Removes every rule from every owner. Kill switch (<c>Ctrl+Shift+K</c>).
        /// </summary>
        public static void ClearAll()
        {
            try
            {
                lock (_writeLock)
                {
                    CommitSnapshot(new Dictionary<string, RuleEntry[]>(StringComparer.Ordinal));
                }
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"[EDOG] MitmRuleStore.ClearAll error: {ex.Message}");
            }
        }

        /// <summary>Test-only: wipe state. Not exposed via SignalR.</summary>
        internal static void ResetForTesting() => ClearAll();

        // ── Internals ────────────────────────────────────────────────────

        private static bool UrlMatches(MitmUrlPattern p, string url)
        {
            if (p == null) return true; // null pattern = wildcard
            if (string.IsNullOrEmpty(p.Value) && p.Kind != MitmUrlMatchKind.Substring) return false;
            switch (p.Kind)
            {
                case MitmUrlMatchKind.Substring:
                    if (string.IsNullOrEmpty(p.Value)) return true; // empty substring = wildcard
                    return url.IndexOf(p.Value, StringComparison.OrdinalIgnoreCase) >= 0;
                case MitmUrlMatchKind.Exact:
                    return string.Equals(url, p.Value, StringComparison.OrdinalIgnoreCase);
                case MitmUrlMatchKind.Regex:
                    if (p.Compiled == null) return false;
                    try { return p.Compiled.IsMatch(url); }
                    catch (RegexMatchTimeoutException) { return false; }
                default:
                    return false;
            }
        }

        private static MitmValidationResult ValidateAndNormalise(MitmRule rule, out MitmRule normalised)
        {
            normalised = null;
            if (rule == null) return MitmValidationResult.Invalid("rule is null");
            if (rule.Match == null) return MitmValidationResult.Invalid("match block required");
            if (rule.Action == null) return MitmValidationResult.Invalid("action block required");

            // §2.4 — response-phase rules must be breakpoints.
            if (rule.Match.Phase == MitmPhase.Response && rule.Action.Type != MitmActionType.Breakpoint)
                return MitmValidationResult.Invalid("INVALID_RESPONSE_RULE: response-phase rules must be breakpoints");

            // URL pattern.
            var pattern = rule.Match.UrlPattern;
            Regex compiled = null;
            if (pattern != null)
            {
                if (pattern.Kind == MitmUrlMatchKind.Regex)
                {
                    if (string.IsNullOrEmpty(pattern.Value))
                        return MitmValidationResult.Invalid("regex pattern value required");
                    try
                    {
                        compiled = new Regex(
                            pattern.Value,
                            RegexOptions.Compiled | RegexOptions.IgnoreCase | RegexOptions.CultureInvariant,
                            TimeSpan.FromMilliseconds(RegexTimeoutMs));
                    }
                    catch (Exception)
                    {
                        return MitmValidationResult.Invalid("regex compile failed");
                    }
                }
            }

            // Methods normalisation — uppercase, dedupe, null→empty.
            string[] methods;
            if (rule.Match.Methods == null || rule.Match.Methods.Length == 0)
            {
                methods = Array.Empty<string>();
            }
            else
            {
                methods = rule.Match.Methods
                    .Where(m => !string.IsNullOrWhiteSpace(m))
                    .Select(m => m.Trim().ToUpperInvariant())
                    .Distinct(StringComparer.Ordinal)
                    .ToArray();
            }

            // Action-specific validation + clamp.
            MitmAction action = rule.Action;
            switch (action.Type)
            {
                case MitmActionType.Breakpoint:
                {
                    var bp = action as MitmBreakpointAction ?? new MitmBreakpointAction();
                    int t = bp.TimeoutMs <= 0 ? DefaultTimeoutMs : bp.TimeoutMs;
                    if (t < MinTimeoutMs) t = MinTimeoutMs;
                    if (t > MaxTimeoutMs) t = MaxTimeoutMs;
                    action = new MitmBreakpointAction { Type = MitmActionType.Breakpoint, TimeoutMs = t };
                    break;
                }
                case MitmActionType.Block:
                {
                    var blk = action as MitmBlockAction;
                    if (blk == null) return MitmValidationResult.Invalid("block action payload required");
                    int sc = blk.StatusCode;
                    if (sc < 100 || sc > 599) sc = 503;
                    if (blk.Body != null && System.Text.Encoding.UTF8.GetByteCount(blk.Body) > MaxRuleBodyBytes)
                        return MitmValidationResult.Invalid($"block body > {MaxRuleBodyBytes} bytes");
                    action = new MitmBlockAction
                    {
                        Type = MitmActionType.Block,
                        StatusCode = sc,
                        Body = blk.Body,
                        Headers = blk.Headers,
                    };
                    break;
                }
                case MitmActionType.Forge:
                {
                    var fg = action as MitmForgeAction;
                    if (fg == null) return MitmValidationResult.Invalid("forge action payload required");
                    int sc = fg.StatusCode;
                    if (sc < 100 || sc > 599) sc = 200;
                    if (fg.Body != null && System.Text.Encoding.UTF8.GetByteCount(fg.Body) > MaxRuleBodyBytes)
                        return MitmValidationResult.Invalid($"forge body > {MaxRuleBodyBytes} bytes");
                    action = new MitmForgeAction
                    {
                        Type = MitmActionType.Forge,
                        StatusCode = sc,
                        Body = fg.Body,
                        Headers = fg.Headers,
                        ReasonPhrase = fg.ReasonPhrase,
                    };
                    break;
                }
                case MitmActionType.Modify:
                {
                    var md = action as MitmModifyAction;
                    if (md == null) return MitmValidationResult.Invalid("modify action payload required");
                    if (md.ReplacementBody != null && System.Text.Encoding.UTF8.GetByteCount(md.ReplacementBody) > MaxRuleBodyBytes)
                        return MitmValidationResult.Invalid($"modify body > {MaxRuleBodyBytes} bytes");
                    action = md;
                    break;
                }
                case MitmActionType.Passthrough:
                    action = new MitmPassthroughAction { Type = MitmActionType.Passthrough };
                    break;
                default:
                    return MitmValidationResult.Invalid($"unknown action type: {action.Type}");
            }

            // Name guard — UI-only field, but cap it to keep wire payloads sane.
            string name = rule.Name;
            if (!string.IsNullOrEmpty(name) && name.Length > 80) name = name.Substring(0, 80);

            normalised = new MitmRule
            {
                Id = string.IsNullOrEmpty(rule.Id) ? ("rule-" + Guid.NewGuid().ToString("N")) : rule.Id,
                Name = name ?? string.Empty,
                OwnerConnectionId = rule.OwnerConnectionId ?? string.Empty,
                Enabled = rule.Enabled,
                Priority = rule.Priority,
                Match = new MitmMatch
                {
                    UrlPattern = pattern == null ? null : new MitmUrlPattern
                    {
                        Kind = pattern.Kind,
                        Value = pattern.Value ?? string.Empty,
                        Compiled = compiled,
                    },
                    Methods = methods,
                    HttpClientName = string.IsNullOrWhiteSpace(rule.Match.HttpClientName) ? null : rule.Match.HttpClientName.Trim(),
                    Phase = rule.Match.Phase,
                },
                Action = action,
                CreatedAtUtc = rule.CreatedAtUtc == default ? DateTimeOffset.UtcNow : rule.CreatedAtUtc,
            };

            return MitmValidationResult.Ok(normalised.Id, 0);
        }

        private static Dictionary<string, RuleEntry[]> CloneByOwnerForWrite()
        {
            var next = new Dictionary<string, RuleEntry[]>(
                _byOwner.Count + 1, StringComparer.Ordinal);
            foreach (var kv in _byOwner) next[kv.Key] = kv.Value;
            return next;
        }

        private static void CommitSnapshot(Dictionary<string, RuleEntry[]> next)
        {
            var frozen = next.Count == 0
                ? FrozenDictionary<string, RuleEntry[]>.Empty
                : next.ToFrozenDictionary(kv => kv.Key, kv => kv.Value, StringComparer.Ordinal);

            var flat = next.Count == 0
                ? Array.Empty<RuleEntry>()
                : next.Values
                      .SelectMany(arr => arr)
                      .OrderBy(e => e.Rule.Priority)
                      .ThenBy(e => e.Rule.CreatedAtUtc)
                      .ToArray();

            Volatile.Write(ref _byOwner, frozen);
            Volatile.Write(ref _orderedFlat, flat);
            Interlocked.Increment(ref _revision);
        }
    }
}
