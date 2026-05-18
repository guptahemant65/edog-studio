// <copyright file="EdogRetryInterceptor.cs" company="Microsoft">
// Copyright (c) Microsoft Corporation. All rights reserved.
// </copyright>

#nullable disable
#pragma warning disable // DevMode-only file — suppress all warnings

namespace Microsoft.LiveTable.Service.DevMode
{
    using System;
    using System.Collections.Generic;
    using System.Text.RegularExpressions;
    using System.Threading;
    using System.Threading.Tasks;

    /// <summary>
    /// Extracts structured retry events from the "log" topic stream.
    ///
    /// <para><b>Why log-parsing?</b> <c>RetryPolicyProviderV2</c> is a concrete class with
    /// non-virtual methods returning complex Polly generic types. Subclassing or decorating
    /// would require mirroring every overload and generic constraint. Instead, every Polly
    /// <c>onRetryAsync</c> callback already logs via <c>Tracer.LogSanitizedMessage</c>,
    /// which flows through <c>EdogLogInterceptor</c> → <c>EdogLogServer.AddLog</c> →
    /// <c>EdogTopicRouter.Publish("log", logEntry)</c>. We subscribe to that stream,
    /// pattern-match retry messages, and publish structured <c>RetryEvent</c>s to the
    /// "retry" topic — zero coupling to Polly generics.</para>
    ///
    /// <para><b>Threading:</b> Background task reads from the live channel. All regex
    /// operations are on the consumer thread — no contention with FLT.</para>
    /// </summary>
    public static class EdogRetryInterceptor
    {
        private static bool _started;
        private static CancellationTokenSource _cts;

        // Matches: "Retry attempt 2/3 for node [Artifact: ..., Iteration: ..., Name: ...]"
        // Also: "SparkTransformSubmit Retry attempt 2/3 for node [...]"
        // Also: "Retry attempt: 2, Delay: 00:00:05 - Encountered ..."
        // Also: "[Cancellation] Retry attempt 2 encountered an error: ..."
        private static readonly Regex RetryAttemptRegex = new Regex(
            @"[Rr]etry attempt[:\s]+(\d+)(?:\s*/\s*(\d+))?",
            RegexOptions.Compiled);

        // Matches: "will be retried after 5.2 seconds"
        private static readonly Regex RetryDelayRegex = new Regex(
            @"retried? (?:in|after)\s+([\d.]+)\s*seconds",
            RegexOptions.Compiled | RegexOptions.IgnoreCase);

        // Matches: "Retry-After hint found. Retrying ... in 12 seconds"
        private static readonly Regex RetryAfterHintRegex = new Regex(
            @"Retry-After hint found.*?in\s+([\d.]+)\s*seconds",
            RegexOptions.Compiled | RegexOptions.IgnoreCase);

        // Matches: "[Artifact: guid, Iteration: guid, TransformationId: guid, Name: nodeName]"
        // or "[Artifact: guid, iteration: guid, name: nodeName]"
        private static readonly Regex NodeDetailsRegex = new Regex(
            @"\[Artifact:\s*([0-9a-fA-F-]+).*?[Ii]teration:\s*([0-9a-fA-F-]+).*?[Nn]ame:\s*([^\]]+)\]",
            RegexOptions.Compiled);

        // Matches: "Notebook content retry attempt 2 for [Workspace: guid, Notebook: guid]"
        private static readonly Regex NotebookRetryRegex = new Regex(
            @"[Nn]otebook content retry attempt\s+(\d+).*?\[Workspace:\s*([0-9a-fA-F-]+).*?Notebook:\s*([0-9a-fA-F-]+)\]",
            RegexOptions.Compiled);

        /// <summary>
        /// Starts the background log-stream monitor. Idempotent — safe to call multiple times.
        /// </summary>
        public static void Start()
        {
            if (_started) return;
            _started = true;

            _cts = new CancellationTokenSource();
            _ = Task.Run(() => MonitorLogStreamAsync(_cts.Token));

            Console.WriteLine("[EDOG] ✓ Retry interceptor started (log-stream parser)");
        }

        private static async Task MonitorLogStreamAsync(CancellationToken ct)
        {
            try
            {
                var logBuffer = EdogTopicRouter.GetBuffer("log");
                if (logBuffer == null) return;

                await foreach (var evt in logBuffer.ReadLiveAsync(ct))
                {
                    try
                    {
                        ProcessLogEvent(evt);
                    }
                    catch
                    {
                        // Never propagate — interceptor failures are non-fatal
                    }
                }
            }
            catch (OperationCanceledException)
            {
                // Expected on shutdown
            }
            catch
            {
                // Never propagate
            }
        }

        private static void ProcessLogEvent(TopicEvent evt)
        {
            if (evt?.Data is not LogEntry logEntry) return;
            if (string.IsNullOrEmpty(logEntry.Message)) return;

            var msg = logEntry.Message;

            // Only process messages that mention "retry" (case-insensitive fast check)
            if (msg.IndexOf("retry", StringComparison.OrdinalIgnoreCase) < 0
                && msg.IndexOf("Retry", StringComparison.Ordinal) < 0)
            {
                return;
            }

            var attemptMatch = RetryAttemptRegex.Match(msg);
            if (!attemptMatch.Success)
            {
                // Also check notebook retry pattern
                var notebookMatch = NotebookRetryRegex.Match(msg);
                if (notebookMatch.Success)
                {
                    PublishNotebookRetryEvent(notebookMatch, msg, logEntry);
                }

                return;
            }

            int retryAttempt = int.Parse(attemptMatch.Groups[1].Value);
            int totalAttempts = attemptMatch.Groups[2].Success
                ? int.Parse(attemptMatch.Groups[2].Value)
                : 0;

            // Extract delay
            double waitDurationMs = 0;
            var delayMatch = RetryDelayRegex.Match(msg);
            if (delayMatch.Success)
            {
                waitDurationMs = double.Parse(delayMatch.Groups[1].Value) * 1000;
            }

            // Extract retry-after hint
            double retryAfterMs = 0;
            bool isThrottle = false;
            var retryAfterMatch = RetryAfterHintRegex.Match(msg);
            if (retryAfterMatch.Success)
            {
                retryAfterMs = double.Parse(retryAfterMatch.Groups[1].Value) * 1000;
                isThrottle = true;
            }

            // Determine strategy name from message context
            string strategyName = DetermineStrategyName(msg);
            string reason = ExtractReason(msg);

            // Extract node details for endpoint context
            string endpoint = string.Empty;
            string iterationId = logEntry.IterationId;
            var nodeMatch = NodeDetailsRegex.Match(msg);
            if (nodeMatch.Success)
            {
                endpoint = $"Artifact:{nodeMatch.Groups[1].Value}/Node:{nodeMatch.Groups[3].Value.Trim()}";
                if (string.IsNullOrEmpty(iterationId))
                {
                    iterationId = nodeMatch.Groups[2].Value;
                }
            }

            // Check for throttle indicators (from config)
            foreach (var sub in _throttleSubstrings)
            {
                if (msg.IndexOf(sub, StringComparison.OrdinalIgnoreCase) >= 0)
                    isThrottle = true;
            }

            int statusCode = 0;
            foreach (var code in _throttleCodes)
            {
                if (msg.Contains(code.ToString()))
                {
                    isThrottle = true;
                    if (statusCode == 0) statusCode = code;
                }
            }

            var eventData = new
            {
                endpoint,
                statusCode,
                retryAttempt,
                totalAttempts,
                waitDurationMs,
                strategyName,
                reason,
                isThrottle,
                retryAfterMs,
                iterationId,
            };

            EdogTopicRouter.Publish("retry", eventData);
        }

        private static void PublishNotebookRetryEvent(Match match, string msg, LogEntry logEntry)
        {
            int attempt = int.Parse(match.Groups[1].Value);
            string workspaceId = match.Groups[2].Value;
            string notebookId = match.Groups[3].Value;

            double waitDurationMs = 0;
            var delayMatch = RetryDelayRegex.Match(msg);
            if (delayMatch.Success)
            {
                waitDurationMs = double.Parse(delayMatch.Groups[1].Value) * 1000;
            }

            double retryAfterMs = 0;
            var retryAfterMatch = RetryAfterHintRegex.Match(msg);
            if (retryAfterMatch.Success)
            {
                retryAfterMs = double.Parse(retryAfterMatch.Groups[1].Value) * 1000;
            }

            var eventData = new
            {
                endpoint = $"Notebook:{notebookId}/Workspace:{workspaceId}",
                statusCode = 0,
                retryAttempt = attempt,
                totalAttempts = 0,
                waitDurationMs,
                strategyName = "NotebookContentRetry",
                reason = ExtractReason(msg),
                isThrottle = retryAfterMs > 0,
                retryAfterMs,
                iterationId = logEntry.IterationId ?? string.Empty,
            };

            EdogTopicRouter.Publish("retry", eventData);
        }

        // ── Strategy classification — loaded from data/retry-patterns.json ───
        // At startup, we load the classifier rules from the JSON config.
        // This avoids hardcoding FLT-specific strategy names in C# code.
        // If the file is missing, we fall back to the embedded defaults.

        private static List<StrategyRule> _strategyRules;
        private static int[] _throttleCodes;
        private static string[] _throttleSubstrings;

        private class StrategyRule
        {
            public string Contains;
            public string[] ContainsAll;
            public bool[] CaseInsensitive;   // per-element flag for ContainsAll
            public string Strategy;
            public bool IsDefault;
        }

        static EdogRetryInterceptor()
        {
            LoadPatternConfig();
        }

        private static void LoadPatternConfig()
        {
            _strategyRules = new List<StrategyRule>();
            _throttleCodes = new[] { 429, 430 };
            _throttleSubstrings = new[] { "TooManyRequests" };

            try
            {
                // Walk up from the executing assembly to find the repo root
                var dir = new System.IO.DirectoryInfo(AppDomain.CurrentDomain.BaseDirectory);
                string configPath = null;
                while (dir != null)
                {
                    var candidate = System.IO.Path.Combine(dir.FullName, "data", "retry-patterns.json");
                    if (System.IO.File.Exists(candidate)) { configPath = candidate; break; }
                    // Also check the edog-studio repo root marker
                    candidate = System.IO.Path.Combine(dir.FullName, "edog-studio", "data", "retry-patterns.json");
                    if (System.IO.File.Exists(candidate)) { configPath = candidate; break; }
                    dir = dir.Parent;
                }

                if (configPath == null)
                {
                    // Try relative to current directory
                    var cwd = System.IO.Path.Combine(System.IO.Directory.GetCurrentDirectory(), "data", "retry-patterns.json");
                    if (System.IO.File.Exists(cwd)) configPath = cwd;
                }

                if (configPath != null)
                {
                    var json = System.IO.File.ReadAllText(configPath);
                    var doc = System.Text.Json.JsonDocument.Parse(json);

                    // Load strategy classifier rules
                    if (doc.RootElement.TryGetProperty("strategyClassifiers", out var classifiers)
                        && classifiers.TryGetProperty("rules", out var rules))
                    {
                        foreach (var rule in rules.EnumerateArray())
                        {
                            var sr = new StrategyRule();
                            sr.Strategy = rule.TryGetProperty("strategy", out var s) ? s.GetString() : "StandardRetry";

                            if (rule.TryGetProperty("default", out var def) && def.GetBoolean())
                            {
                                sr.IsDefault = true;
                            }
                            else if (rule.TryGetProperty("containsAll", out var ca))
                            {
                                var items = new List<string>();
                                var ciFlags = new List<bool>();
                                var ciSet = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                                if (rule.TryGetProperty("caseInsensitive", out var ciArr))
                                    foreach (var ci in ciArr.EnumerateArray()) ciSet.Add(ci.GetString());

                                foreach (var item in ca.EnumerateArray())
                                {
                                    var v = item.GetString();
                                    items.Add(v);
                                    ciFlags.Add(ciSet.Contains(v));
                                }
                                sr.ContainsAll = items.ToArray();
                                sr.CaseInsensitive = ciFlags.ToArray();
                            }
                            else if (rule.TryGetProperty("contains", out var c))
                            {
                                sr.Contains = c.GetString();
                                // Check if this keyword is case-insensitive
                                var ciSet2 = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                                if (rule.TryGetProperty("caseInsensitive", out var ciArr2))
                                    foreach (var ci in ciArr2.EnumerateArray()) ciSet2.Add(ci.GetString());
                                if (ciSet2.Contains(sr.Contains))
                                    sr.CaseInsensitive = new[] { true };
                            }

                            _strategyRules.Add(sr);
                        }
                    }

                    // Load throttle indicators
                    if (doc.RootElement.TryGetProperty("throttleIndicators", out var throttle))
                    {
                        if (throttle.TryGetProperty("statusCodes", out var codes))
                        {
                            var codeList = new List<int>();
                            foreach (var c in codes.EnumerateArray()) codeList.Add(c.GetInt32());
                            _throttleCodes = codeList.ToArray();
                        }
                        if (throttle.TryGetProperty("substrings", out var subs))
                        {
                            var subList = new List<string>();
                            foreach (var sub in subs.EnumerateArray()) subList.Add(sub.GetString());
                            _throttleSubstrings = subList.ToArray();
                        }
                    }

                    Console.WriteLine($"[EDOG] Retry patterns loaded from {configPath} ({_strategyRules.Count} rules)");
                    return;
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[EDOG] Retry patterns config load failed, using defaults: {ex.Message}");
            }

            // Fallback defaults — same as the previously hardcoded values
            _strategyRules.AddRange(new[]
            {
                new StrategyRule { Contains = "SparkTransformSubmit", Strategy = "SparkTransformSubmitRetry" },
                new StrategyRule { ContainsAll = new[] { "Node", "execution" }, CaseInsensitive = new[] { false, true }, Strategy = "NodeExecutionRetry" },
                new StrategyRule { Contains = "Cancellation", Strategy = "NodeCancellationRetry" },
                new StrategyRule { Contains = "CDF", Strategy = "CdfEnablementRetry" },
                new StrategyRule { Contains = "Notebook", CaseInsensitive = new[] { true }, Strategy = "NotebookContentRetry" },
                new StrategyRule { IsDefault = true, Strategy = "StandardRetry" },
            });
        }

        private static string DetermineStrategyName(string msg)
        {
            foreach (var rule in _strategyRules)
            {
                if (rule.IsDefault) return rule.Strategy;

                if (rule.ContainsAll != null)
                {
                    bool allMatch = true;
                    for (int i = 0; i < rule.ContainsAll.Length; i++)
                    {
                        var cmp = (rule.CaseInsensitive != null && i < rule.CaseInsensitive.Length && rule.CaseInsensitive[i])
                            ? StringComparison.OrdinalIgnoreCase
                            : StringComparison.Ordinal;
                        if (msg.IndexOf(rule.ContainsAll[i], cmp) < 0) { allMatch = false; break; }
                    }
                    if (allMatch) return rule.Strategy;
                }
                else if (rule.Contains != null)
                {
                    var cmp = (rule.CaseInsensitive != null && rule.CaseInsensitive.Length > 0 && rule.CaseInsensitive[0])
                        ? StringComparison.OrdinalIgnoreCase
                        : StringComparison.Ordinal;
                    if (msg.IndexOf(rule.Contains, cmp) >= 0) return rule.Strategy;
                }
            }
            return "StandardRetry";
        }

        private static string ExtractReason(string msg)
        {
            // Extract error details if present
            int errorIdx = msg.IndexOf("Encountered an error:", StringComparison.OrdinalIgnoreCase);
            if (errorIdx >= 0)
            {
                string tail = msg.Substring(errorIdx + "Encountered an error:".Length).Trim();
                // Truncate to reasonable length
                return tail.Length > 200 ? tail.Substring(0, 200) + "..." : tail;
            }

            int issuesIdx = msg.IndexOf("Encountered retriable issues", StringComparison.OrdinalIgnoreCase);
            if (issuesIdx >= 0) return "Retriable issue";

            if (msg.IndexOf("Retry-After hint", StringComparison.OrdinalIgnoreCase) >= 0)
                return "Server requested retry-after";

            return "Retry triggered";
        }
    }
}
