// <copyright file="EdogRetryInterceptor.cs" company="Microsoft">
// Copyright (c) Microsoft Corporation. All rights reserved.
// </copyright>

#nullable disable
#pragma warning disable // DevMode-only file — suppress all warnings

namespace Microsoft.LiveTable.Service.DevMode
{
    using System;
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

            // Check for throttle indicators
            if (msg.IndexOf("429", StringComparison.Ordinal) >= 0
                || msg.IndexOf("430", StringComparison.Ordinal) >= 0
                || msg.IndexOf("TooManyRequests", StringComparison.OrdinalIgnoreCase) >= 0)
            {
                isThrottle = true;
            }

            int statusCode = 0;
            if (msg.Contains("429")) statusCode = 429;
            else if (msg.Contains("430")) statusCode = 430;

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

        private static string DetermineStrategyName(string msg)
        {
            if (msg.IndexOf("SparkTransformSubmit", StringComparison.Ordinal) >= 0)
                return "SparkTransformSubmitRetry";
            if (msg.IndexOf("Node", StringComparison.Ordinal) >= 0
                && msg.IndexOf("execution", StringComparison.OrdinalIgnoreCase) >= 0)
                return "NodeExecutionRetry";
            if (msg.IndexOf("Cancellation", StringComparison.Ordinal) >= 0)
                return "NodeCancellationRetry";
            if (msg.IndexOf("CDF", StringComparison.Ordinal) >= 0)
                return "CdfEnablementRetry";
            if (msg.IndexOf("Notebook", StringComparison.OrdinalIgnoreCase) >= 0)
                return "NotebookContentRetry";
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
