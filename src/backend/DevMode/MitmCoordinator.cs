// <copyright file="MitmCoordinator.cs" company="Microsoft">
// Copyright (c) Microsoft Corporation. All rights reserved.
// </copyright>

#nullable disable
#pragma warning disable // DevMode-only file — suppress all warnings

namespace Microsoft.LiveTable.Service.DevMode
{
    using System;
    using System.Collections.Concurrent;
    using System.Collections.Generic;
    using System.Net.Http;
    using System.Threading;
    using System.Threading.Tasks;

    // ═══════════════════════════════════════════════════════════════════
    // MitmCoordinator — TCS-based HTTP MITM suspend/resume coordinator
    //                   (F28 C01, see architecture.md §2)
    //
    // Sits between EdogHttpPipelineHandler.SendAsync and the SignalR
    // hub layer:
    //
    //   pipeline ─► ShouldPauseRequest  ─► (snap) ─► AwaitDecisionAsync
    //                                                   │
    //                                                   ▼
    //                                              TaskCompletionSource
    //                                                   ▲
    //   hub ─────► SubmitDecision ────► TryResolve ─────┘
    //
    // Hot-path guarantees:
    //   - When _interceptionEnabled is false OR MitmRuleStore.Count == 0,
    //     ShouldPause* returns false after a single volatile read.
    //   - Capacity guard (MaxConcurrentBreakpoints = 64) prevents a
    //     runaway frontend from parking unbounded handler threads.
    //
    // Safety:
    //   - Every public method has an outer try/catch. The hot path
    //     prefers to forward the request unchanged over any other
    //     failure mode (cf. §4.6 — "never crash the host").
    //   - Every TCS is paired with a CancellationTokenSource(timeoutMs)
    //     so no suspension can leak; the invariant
    //     "_pending.Count → 0 within MaxTimeoutMs + 1s of the last
    //     AwaitDecisionAsync call" is testable.
    // ═══════════════════════════════════════════════════════════════════

    /// <summary>
    /// Public diagnostic view of a paused intercept. Used by <c>MitmListPending</c>.
    /// Does <b>not</b> expose the underlying TCS — those stay private.
    /// </summary>
    internal sealed class MitmPendingIntercept
    {
        /// <summary>Intercept identifier (matches the snapshot the frontend received).</summary>
        public string InterceptId { get; init; }

        /// <summary>SignalR connection id of the rule owner.</summary>
        public string OwnerConnectionId { get; init; }

        /// <summary>Rule that fired and parked this request.</summary>
        public string RuleId { get; init; }

        /// <summary>Suspension point: request or response.</summary>
        public MitmPhase Phase { get; init; }

        /// <summary>UTC timestamp when the intercept was created.</summary>
        public DateTimeOffset CreatedAtUtc { get; init; }

        /// <summary>UTC deadline after which the coordinator auto-forwards.</summary>
        public DateTimeOffset DeadlineUtc { get; init; }
    }

    /// <summary>
    /// HTTP MITM suspend/resume coordinator. Static singleton — there is exactly
    /// one MITM coordinator per process, mirroring <see cref="EdogTopicRouter"/>
    /// and <see cref="EdogHttpFaultStore"/>.
    /// </summary>
    internal static class MitmCoordinator
    {
        // ── Tunables (mirrored in MitmCapabilityReport.limits) ───────────
        private const int DefaultTimeoutMs = 30_000;
        private const int MinTimeoutMs = 1_000;
        private const int MaxTimeoutMs = 60_000;
        private const int MaxConcurrentBreakpoints = 64;
        private const int MaxBodyEditorBytes = 10 * 1024 * 1024;   // 10 MB
        private const int MaxRuleBodyBytes = 1_048_576;            // 1 MB
        private const int MaxRulesPerConnection = 50;
        private const int MaxRulesGlobal = 500;
        private const string ServerVersion = "f28-v1";
        private const string TopicName = "mitm";

        // ── State ────────────────────────────────────────────────────────
        private static readonly ConcurrentDictionary<string, PendingIntercept> _pending
            = new(StringComparer.Ordinal);

        /// <summary>connectionId → set of interceptIds owned by that connection.</summary>
        private static readonly ConcurrentDictionary<string, HashSet<string>> _byOwner
            = new(StringComparer.Ordinal);

        private static long _revision;
        private static volatile bool _interceptionEnabled = true;

        private static readonly string _sessionId
            = "mitm-" + Guid.NewGuid().ToString("N").Substring(0, 8);

        /// <summary>True while the coordinator is actively intercepting traffic.</summary>
        public static bool InterceptionEnabled => _interceptionEnabled;

        /// <summary>Monotonic counter; bumps on toggle, resume, timeout, and clear-all.</summary>
        public static long Revision => Interlocked.Read(ref _revision);

        /// <summary>
        /// Private bookkeeping for one paused intercept.
        /// </summary>
        private sealed class PendingIntercept
        {
            public string InterceptId;
            public TaskCompletionSource<MitmDecision> Tcs;
            public CancellationTokenSource TimeoutCts;
            public CancellationTokenSource LinkedCts;
            public CancellationTokenRegistration LinkedReg;
            public string OwnerConnectionId;
            public MitmPhase Phase;
            public MitmRule MatchedRule;
            public DateTimeOffset CreatedAtUtc;
            public DateTimeOffset DeadlineUtc;
        }

        // ──────────────────────────────────────────────────────────────
        // Hot-path predicates
        // ──────────────────────────────────────────────────────────────

        /// <summary>
        /// True when the request should be paused. The matched rule is returned
        /// via <paramref name="matchedRule"/> for both the pause and the inline
        /// (non-breakpoint) action branch — see §2.3 / §2.8.
        /// </summary>
        public static bool ShouldPauseRequest(HttpRequestMessage req, string httpClientName, out MitmRule matchedRule)
        {
            matchedRule = null;
            try
            {
                if (!_interceptionEnabled) return false;
                if (MitmRuleStore.Count == 0) return false;
                if (_pending.Count >= MaxConcurrentBreakpoints) return false;

                var ctx = MitmMatchContext.From(req, httpClientName, MitmPhase.Request);
                if (!MitmRuleStore.TryMatch(in ctx, MitmPhase.Request, out var match)) return false;

                matchedRule = match;
                return match.Action != null && match.Action.Type == MitmActionType.Breakpoint;
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"[EDOG] MitmCoordinator.ShouldPauseRequest error: {ex.Message}");
                matchedRule = null;
                return false;
            }
        }

        /// <summary>
        /// True when the response should be paused. Per §2.4, non-breakpoint
        /// response-phase rules are not allowed — <see cref="MitmRuleStore.AddOrReplace"/>
        /// rejects them at insert time, so a non-breakpoint match here is impossible.
        /// </summary>
        public static bool ShouldPauseResponse(HttpResponseMessage rsp, MitmRule requestPhaseMatch,
                                                HttpRequestMessage req, string httpClientName,
                                                out MitmRule matchedRule)
        {
            matchedRule = null;
            try
            {
                if (!_interceptionEnabled) return false;
                if (MitmRuleStore.Count == 0) return false;
                if (_pending.Count >= MaxConcurrentBreakpoints) return false;

                var ctx = MitmMatchContext.From(req, httpClientName, MitmPhase.Response);
                if (!MitmRuleStore.TryMatch(in ctx, MitmPhase.Response, out var match)) return false;

                matchedRule = match;
                return match.Action != null && match.Action.Type == MitmActionType.Breakpoint;
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"[EDOG] MitmCoordinator.ShouldPauseResponse error: {ex.Message}");
                matchedRule = null;
                return false;
            }
        }

        // ──────────────────────────────────────────────────────────────
        // Suspend / Resume
        // ──────────────────────────────────────────────────────────────

        /// <summary>
        /// Parks the calling handler thread until the frontend submits a decision,
        /// the timeout expires, or the handler's <see cref="CancellationToken"/>
        /// fires. On timeout or cancellation the returned decision is
        /// <c>MitmDecision.ForwardUnchanged(reason)</c> — the request proceeds
        /// unchanged. Never throws.
        /// </summary>
        public static Task<MitmDecision> AwaitDecisionAsync(string interceptId,
                                                            MitmInterceptSnapshot snap,
                                                            MitmRule matchedRule,
                                                            CancellationToken handlerCt)
        {
            try
            {
                if (string.IsNullOrEmpty(interceptId) || matchedRule == null || snap == null)
                    return Task.FromResult(MitmDecision.ForwardUnchanged("snap-error"));

                int timeoutMs = ResolveTimeoutMs(matchedRule);
                var nowUtc = DateTimeOffset.UtcNow;
                var deadlineUtc = nowUtc.AddMilliseconds(timeoutMs);

                var tcs = new TaskCompletionSource<MitmDecision>(TaskCreationOptions.RunContinuationsAsynchronously);
                var timeoutCts = new CancellationTokenSource(timeoutMs);
                var linkedCts = CancellationTokenSource.CreateLinkedTokenSource(handlerCt, timeoutCts.Token);

                var pending = new PendingIntercept
                {
                    InterceptId = interceptId,
                    Tcs = tcs,
                    TimeoutCts = timeoutCts,
                    LinkedCts = linkedCts,
                    OwnerConnectionId = snap.OwnerConnectionId ?? string.Empty,
                    Phase = snap.Phase,
                    MatchedRule = matchedRule,
                    CreatedAtUtc = nowUtc,
                    DeadlineUtc = deadlineUtc,
                };

                // BE-001: Add to _pending BEFORE registering the cancellation callback.
                // If the token is already cancelled, Register fires the callback synchronously
                // — and the callback calls TryResolve, which requires the entry to be present.
                if (!_pending.TryAdd(interceptId, pending))
                {
                    // ULID collision — exceedingly unlikely. Tear down and forward.
                    SafeDisposePending(pending);
                    return Task.FromResult(MitmDecision.ForwardUnchanged("intercept-id-collision"));
                }

                pending.LinkedReg = linkedCts.Token.Register(static state =>
                {
                    var p = (PendingIntercept)state;
                    try
                    {
                        bool timedOut = p.TimeoutCts != null && p.TimeoutCts.IsCancellationRequested;
                        string reason = timedOut ? "timeout" : "cancelled";
                        var decision = MitmDecision.ForwardUnchanged(reason);
                        if (TryResolve(p.InterceptId, decision))
                        {
                            string evtType = timedOut ? "breakpointTimedOut" : "breakpointCancelled";
                            SafePublish(new
                            {
                                type = evtType,
                                interceptId = p.InterceptId,
                                ruleId = p.MatchedRule?.Id,
                                phase = p.Phase.ToString().ToLowerInvariant(),
                                ownerConnectionId = p.OwnerConnectionId,
                                reason,
                            });
                        }
                    }
                    catch (Exception ex)
                    {
                        System.Diagnostics.Debug.WriteLine($"[EDOG] MitmCoordinator timeout/cancel callback error: {ex.Message}");
                    }
                }, pending);

                // BE-001: Guard against a token that was already cancelled before Register.
                // In that case Register schedules (or has already run) the callback, but if the
                // CT was cancelled before the linked CTS was constructed the callback may have
                // raced with TryAdd above and missed the entry. Re-check and resolve inline.
                if (linkedCts.IsCancellationRequested)
                {
                    bool timedOut = timeoutCts.IsCancellationRequested;
                    string reason = timedOut ? "timeout" : "cancelled";
                    var decision = MitmDecision.ForwardUnchanged(reason);
                    if (TryResolve(interceptId, decision))
                    {
                        SafePublish(new
                        {
                            type = timedOut ? "breakpointTimedOut" : "breakpointCancelled",
                            interceptId,
                            ruleId = matchedRule.Id,
                            phase = snap.Phase.ToString().ToLowerInvariant(),
                            ownerConnectionId = pending.OwnerConnectionId,
                            reason,
                        });
                    }
                    return tcs.Task;
                }

                _byOwner.AddOrUpdate(
                    pending.OwnerConnectionId,
                    _ => new HashSet<string>(StringComparer.Ordinal) { interceptId },
                    (_, set) =>
                    {
                        lock (set) { set.Add(interceptId); }
                        return set;
                    });

                Interlocked.Increment(ref _revision);

                SafePublish(new
                {
                    type = "breakpointHit",
                    interceptId,
                    ruleId = matchedRule.Id,
                    ruleName = matchedRule.Name,
                    phase = snap.Phase.ToString().ToLowerInvariant(),
                    ownerConnectionId = pending.OwnerConnectionId,
                    timeoutMs,
                    deadlineUtc,
                    createdAtUtc = nowUtc,
                    request = snap.Request,
                    response = snap.Response,
                });

                return tcs.Task;
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"[EDOG] MitmCoordinator.AwaitDecisionAsync error: {ex.Message}");
                return Task.FromResult(MitmDecision.ForwardUnchanged("snap-error"));
            }
        }

        /// <summary>
        /// Validates the supplied decision shape against the parked intercept's
        /// phase, records the rule firing, resolves the TCS, and publishes a
        /// <c>breakpointResumed</c> topic event. Owner-locked — only the
        /// SignalR connection that owns the rule can submit a decision.
        /// </summary>
        public static MitmResumeResult SubmitDecision(string interceptId, MitmDecision decision, string callerConnectionId)
        {
            try
            {
                if (string.IsNullOrEmpty(interceptId)) return MitmResumeResult.NotFound;
                if (decision == null) return MitmResumeResult.Invalid("decision required");

                if (!_pending.TryGetValue(interceptId, out var p))
                    return MitmResumeResult.NotFound;

                if (!string.Equals(p.OwnerConnectionId, callerConnectionId, StringComparison.Ordinal))
                    return MitmResumeResult.NotOwned;

                var validation = ValidateDecision(p, decision);
                if (!validation.Success) return validation;

                decision.SubmittedByConnectionId = callerConnectionId;

                if (!TryResolve(interceptId, decision))
                    return MitmResumeResult.AlreadyResolved;

                // Stamp the rule fire-count. Independent of resolve success so
                // ListRules-side counters reflect actually-applied decisions.
                try
                {
                    var runtime = MitmRuleStore.GetRuntime(p.MatchedRule?.Id);
                    runtime?.RecordFiring();
                }
                catch (Exception ex)
                {
                    System.Diagnostics.Debug.WriteLine($"[EDOG] MitmCoordinator runtime-stamp error: {ex.Message}");
                }

                double durationMsPaused = (DateTimeOffset.UtcNow - p.CreatedAtUtc).TotalMilliseconds;
                SafePublish(new
                {
                    type = "breakpointResumed",
                    interceptId,
                    verdict = decision.Verdict,
                    ruleId = p.MatchedRule?.Id,
                    phase = p.Phase.ToString().ToLowerInvariant(),
                    durationMsPaused,
                    appliedBy = "user",
                    submittedByConnectionId = callerConnectionId,
                });

                return MitmResumeResult.Ok;
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"[EDOG] MitmCoordinator.SubmitDecision error: {ex.Message}");
                return MitmResumeResult.Invalid(ex.Message);
            }
        }

        // ──────────────────────────────────────────────────────────────
        // Owner cleanup / kill switch
        // ──────────────────────────────────────────────────────────────

        /// <summary>
        /// Cancels every intercept owned by the named connection. Used both
        /// from <c>OnDisconnectedAsync</c> (reason="disconnect") and as part
        /// of <see cref="ClearAllPending"/>.
        /// </summary>
        /// <returns>Number of intercepts resolved.</returns>
        public static int CancelOwner(string connectionId, string reason)
        {
            if (string.IsNullOrEmpty(connectionId)) return 0;
            try
            {
                if (!_byOwner.TryRemove(connectionId, out var set) || set == null) return 0;

                List<string> ids;
                lock (set) { ids = new List<string>(set); }

                int count = 0;
                foreach (var interceptId in ids)
                {
                    if (!_pending.TryGetValue(interceptId, out var p)) continue;

                    var decision = MitmDecision.ForwardUnchanged(reason ?? "cancelled");
                    if (TryResolve(interceptId, decision))
                    {
                        count++;
                        SafePublish(new
                        {
                            type = "breakpointCancelled",
                            interceptId,
                            ruleId = p.MatchedRule?.Id,
                            phase = p.Phase.ToString().ToLowerInvariant(),
                            ownerConnectionId = connectionId,
                            reason = reason ?? "cancelled",
                        });
                    }
                }
                return count;
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"[EDOG] MitmCoordinator.CancelOwner error: {ex.Message}");
                return 0;
            }
        }

        /// <summary>
        /// Kill-switch resume. Resolves every pending intercept with
        /// <c>verdict="block"</c> + a synthetic "kill-switch" payload so
        /// destructive in-flight requests aren't accidentally forwarded.
        /// </summary>
        /// <returns>Number of intercepts resolved.</returns>
        public static int ClearAllPending(string reason)
        {
            try
            {
                var keys = new List<string>(_pending.Keys);
                int count = 0;
                foreach (var interceptId in keys)
                {
                    if (!_pending.TryGetValue(interceptId, out var p)) continue;

                    var decision = new MitmDecision
                    {
                        Verdict = "block",
                        Block = new MitmForgePayload
                        {
                            StatusCode = 503,
                            ReasonPhrase = "MITM Kill Switch",
                            Body = "{\"error\":\"MITM kill switch engaged\"}",
                            Headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
                            {
                                ["Content-Type"] = "application/json",
                            },
                        },
                        NoteForAudit = $"auto:{reason ?? "kill-switch"}",
                    };

                    if (TryResolve(interceptId, decision))
                    {
                        count++;
                        SafePublish(new
                        {
                            type = "breakpointCancelled",
                            interceptId,
                            ruleId = p.MatchedRule?.Id,
                            phase = p.Phase.ToString().ToLowerInvariant(),
                            ownerConnectionId = p.OwnerConnectionId,
                            reason = reason ?? "kill-switch",
                        });
                    }
                }

                // Drop owner index — TryResolve already removed entries, but
                // ensure no stale empty sets remain.
                _byOwner.Clear();
                Interlocked.Increment(ref _revision);
                return count;
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"[EDOG] MitmCoordinator.ClearAllPending error: {ex.Message}");
                return 0;
            }
        }

        // ──────────────────────────────────────────────────────────────
        // Toggles & diagnostics
        // ──────────────────────────────────────────────────────────────

        /// <summary>
        /// Globally enables or disables interception. When disabled, the hot
        /// path short-circuits at <c>!_interceptionEnabled</c> and no rule
        /// can fire — but existing rules remain in the store.
        /// </summary>
        public static void SetInterceptionEnabled(bool enabled, string callerConnectionId)
        {
            try
            {
                bool prev = _interceptionEnabled;
                _interceptionEnabled = enabled;
                Interlocked.Increment(ref _revision);
                if (prev != enabled)
                {
                    SafePublish(new
                    {
                        type = "interceptionToggled",
                        enabled,
                        byConnectionId = callerConnectionId,
                    });
                }
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"[EDOG] MitmCoordinator.SetInterceptionEnabled error: {ex.Message}");
            }
        }

        /// <summary>
        /// Capability report — the single source of truth the UI gates its
        /// MITM surface on. <see cref="MitmCapabilityReport.Enabled"/> reflects
        /// the build-time <c>HttpChaosPipelineWired</c> constant AND the
        /// runtime <c>EDOG_MITM_INTERACTIVE</c> env var.
        /// </summary>
        public static MitmCapabilityReport GetCapabilities(string connectionId)
        {
            try
            {
                bool envEnabled = string.Equals(
                    Environment.GetEnvironmentVariable("EDOG_MITM_INTERACTIVE"),
                    "1", StringComparison.Ordinal);

                string reason = envEnabled ? null : "EDOG_MITM_INTERACTIVE not set to 1";

                return new MitmCapabilityReport
                {
                    Available = true,
                    Enabled = envEnabled,
                    SessionId = _sessionId,
                    Reason = reason,
                    SupportedActions = new[] { "breakpoint", "block", "forge", "modify", "passthrough" },
                    SupportedPhases = new[] { "request", "response" },
                    SupportedUrlMatchers = new[] { "substring", "regex", "exact" },
                    Limits = new MitmCapabilityLimits
                    {
                        MaxRulesPerConnection = MaxRulesPerConnection,
                        MaxRulesGlobal = MaxRulesGlobal,
                        MaxConcurrentBreakpoints = MaxConcurrentBreakpoints,
                        MaxBodyEditorBytes = MaxBodyEditorBytes,
                        MaxRuleBodyBytes = MaxRuleBodyBytes,
                        BreakpointTimeoutMsDefault = DefaultTimeoutMs,
                        BreakpointTimeoutMsMax = MaxTimeoutMs,
                    },
                    InterceptionEnabled = _interceptionEnabled,
                    ServerVersion = ServerVersion,
                };
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"[EDOG] MitmCoordinator.GetCapabilities error: {ex.Message}");
                return new MitmCapabilityReport
                {
                    Available = false,
                    Enabled = false,
                    SessionId = _sessionId,
                    Reason = "internal error",
                    ServerVersion = ServerVersion,
                };
            }
        }

        /// <summary>Snapshot of currently-paused intercepts. Diagnostic use only.</summary>
        public static IReadOnlyList<MitmPendingIntercept> ListPending()
        {
            try
            {
                var list = new List<MitmPendingIntercept>(_pending.Count);
                foreach (var kv in _pending)
                {
                    var p = kv.Value;
                    if (p == null) continue;
                    list.Add(new MitmPendingIntercept
                    {
                        InterceptId = p.InterceptId,
                        OwnerConnectionId = p.OwnerConnectionId,
                        RuleId = p.MatchedRule?.Id,
                        Phase = p.Phase,
                        CreatedAtUtc = p.CreatedAtUtc,
                        DeadlineUtc = p.DeadlineUtc,
                    });
                }
                return list;
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"[EDOG] MitmCoordinator.ListPending error: {ex.Message}");
                return Array.Empty<MitmPendingIntercept>();
            }
        }

        /// <summary>Test-only: drop all pending state.</summary>
        internal static void ResetForTesting()
        {
            try
            {
                foreach (var kv in _pending)
                {
                    SafeDisposePending(kv.Value);
                }
                _pending.Clear();
                _byOwner.Clear();
                _interceptionEnabled = true;
                Interlocked.Exchange(ref _revision, 0);
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"[EDOG] MitmCoordinator.ResetForTesting error: {ex.Message}");
            }
        }

        // ──────────────────────────────────────────────────────────────
        // Internals
        // ──────────────────────────────────────────────────────────────

        private static int ResolveTimeoutMs(MitmRule rule)
        {
            int t = DefaultTimeoutMs;
            if (rule?.Action is MitmBreakpointAction bp && bp.TimeoutMs > 0)
                t = bp.TimeoutMs;
            if (t < MinTimeoutMs) t = MinTimeoutMs;
            if (t > MaxTimeoutMs) t = MaxTimeoutMs;
            return t;
        }

        private static MitmResumeResult ValidateDecision(PendingIntercept p, MitmDecision decision)
        {
            string verdict = decision.Verdict ?? string.Empty;
            switch (verdict)
            {
                case "forward":
                    return MitmResumeResult.Ok;

                case "modify":
                    if (decision.Modifications == null)
                        return MitmResumeResult.Invalid("modifications required");
                    if (p.Phase == MitmPhase.Response && decision.Modifications.Body != null)
                        return MitmResumeResult.Invalid("response modify body not supported in v1");
                    if (!string.IsNullOrEmpty(decision.Modifications.Body) &&
                        System.Text.Encoding.UTF8.GetByteCount(decision.Modifications.Body) > MaxBodyEditorBytes)
                        return MitmResumeResult.Invalid("body > 10MB");
                    return MitmResumeResult.Ok;

                case "block":
                    if (p.Phase == MitmPhase.Response)
                        return MitmResumeResult.Invalid("use modify on response phase");
                    if (decision.Block == null)
                        return MitmResumeResult.Invalid("block payload required");
                    if (decision.Block.StatusCode < 100 || decision.Block.StatusCode > 599)
                        return MitmResumeResult.Invalid("statusCode must be 100-599");
                    return MitmResumeResult.Ok;

                case "forge":
                    if (p.Phase == MitmPhase.Response)
                        return MitmResumeResult.Invalid("use modify on response phase");
                    if (decision.Forge == null)
                        return MitmResumeResult.Invalid("forge payload required");
                    if (decision.Forge.StatusCode < 100 || decision.Forge.StatusCode > 599)
                        return MitmResumeResult.Invalid("statusCode must be 100-599");
                    return MitmResumeResult.Ok;

                default:
                    return MitmResumeResult.Invalid($"unknown verdict: {verdict}");
            }
        }

        private static bool TryResolve(string interceptId, MitmDecision decision)
        {
            if (!_pending.TryRemove(interceptId, out var p) || p == null) return false;

            // Detach from owner index first so a concurrent CancelOwner
            // doesn't double-resolve.
            if (!string.IsNullOrEmpty(p.OwnerConnectionId) &&
                _byOwner.TryGetValue(p.OwnerConnectionId, out var set) && set != null)
            {
                lock (set) { set.Remove(interceptId); }
            }

            bool delivered;
            try
            {
                delivered = p.Tcs.TrySetResult(decision ?? MitmDecision.ForwardUnchanged("missing-decision"));
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"[EDOG] MitmCoordinator TCS.TrySetResult error: {ex.Message}");
                delivered = false;
            }
            finally
            {
                SafeDisposePending(p);
            }

            Interlocked.Increment(ref _revision);
            return delivered;
        }

        private static void SafeDisposePending(PendingIntercept p)
        {
            if (p == null) return;
            try { p.LinkedReg.Dispose(); } catch { }
            try { p.LinkedCts?.Dispose(); } catch { }
            try { p.TimeoutCts?.Dispose(); } catch { }
        }

        private static void SafePublish(object payload)
        {
            try { EdogTopicRouter.Publish(TopicName, payload); }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"[EDOG] MitmCoordinator SafePublish error: {ex.Message}");
            }
        }
    }
}
