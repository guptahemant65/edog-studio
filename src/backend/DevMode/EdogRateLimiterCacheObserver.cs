// <copyright file="EdogRateLimiterCacheObserver.cs" company="Microsoft">
// Copyright (c) Microsoft Corporation. All rights reserved.
// </copyright>

#nullable disable
#pragma warning disable // DevMode-only file — suppress all warnings

namespace Microsoft.LiveTable.Service.DevMode
{
    using System;
    using System.Diagnostics;
    using System.Text.RegularExpressions;
    using System.Threading;
    using System.Threading.Tasks;

    /// <summary>
    /// Surfaces <c>TokenBucketRateLimiterCache</c> activity as structured cache events.
    ///
    /// <para><b>Why log-stream parsing?</b> <c>TokenBucketRateLimiterCache</c> is a static
    /// singleton (<c>Instance</c> property is a readonly auto-initialised field). We cannot
    /// replace it through DI, and subclassing/wrapping would require touching every call
    /// site in FLT. However, the class already emits verbose <c>Tracer.LogSanitizedVerbose</c>
    /// / <c>Tracer.LogSanitizedWarning</c> messages of the form:</para>
    /// <code>
    ///   [Cache] REUSED EXISTING limiter on instance {id} for key='{k}', AvailableTokens=...
    ///   [Cache] CREATED NEW limiter on instance {id} for key='{k}', TotalCacheSize=...
    ///   [Cache] EVICTED limiter on instance {id} for key='{k}', Reason=...
    /// </code>
    /// <para>These flow through <c>EdogLogInterceptor</c> → the "log" topic. We subscribe,
    /// pattern-match, and republish to the "cache" topic — same shape as
    /// <see cref="EdogRetryInterceptor"/>.</para>
    ///
    /// <para>Threading: a single background <see cref="Task"/> reads from the live channel.
    /// All regex work is on the consumer thread and never blocks the producer.</para>
    /// </summary>
    public static class EdogRateLimiterCacheObserver
    {
        private const string CacheName = "TokenBucketRateLimiterCache";

        private static bool _started;
        private static CancellationTokenSource _cts;

        // [Cache] REUSED|CREATED|EVICTED ... on instance {instanceId} for key='{key}' ...
        private static readonly Regex CacheLineRegex = new Regex(
            @"\[Cache\]\s+(REUSED(?:\s+EXISTING)?|CREATED(?:\s+NEW)?|EVICTED)\b" +
            @".*?(?:on instance\s+([^\s,]+))?" +
            @".*?for key='([^']*)'" +
            @"(?:.*?Reason=([A-Za-z]+))?",
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

            Console.WriteLine("[EDOG] ✓ RateLimiterCache observer started (log-stream parser)");
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
                        // Never propagate — observer failures are non-fatal.
                    }
                }
            }
            catch (OperationCanceledException)
            {
                // Expected on shutdown.
            }
            catch
            {
                // Never propagate.
            }
        }

        private static void ProcessLogEvent(TopicEvent evt)
        {
            if (evt?.Data is not LogEntry logEntry) return;
            if (string.IsNullOrEmpty(logEntry.Message)) return;

            var msg = logEntry.Message;

            // Fast pre-filter: only messages that look like rate-limiter cache lines.
            // We accept either the Component being TokenBucketRateLimiterCache OR the
            // canonical "[Cache] REUSED|CREATED|EVICTED" marker present in the body.
            bool componentMatches = logEntry.Component != null
                && logEntry.Component.IndexOf("TokenBucketRateLimiterCache", StringComparison.OrdinalIgnoreCase) >= 0;
            bool bodyMatches = msg.IndexOf("[Cache]", StringComparison.Ordinal) >= 0
                && (msg.IndexOf("REUSED", StringComparison.Ordinal) >= 0
                    || msg.IndexOf("CREATED", StringComparison.Ordinal) >= 0
                    || msg.IndexOf("EVICTED", StringComparison.Ordinal) >= 0);

            if (!componentMatches && !bodyMatches) return;

            var match = CacheLineRegex.Match(msg);
            if (!match.Success) return;

            var opRaw = match.Groups[1].Value;       // REUSED EXISTING / CREATED NEW / EVICTED
            var instanceId = match.Groups[2].Success ? match.Groups[2].Value : string.Empty;
            var key = match.Groups[3].Value;
            var reason = match.Groups[4].Success ? match.Groups[4].Value : null;

            string operation;
            string hitOrMiss = null;
            string evictionReason = reason;

            if (opRaw.StartsWith("REUSED", StringComparison.Ordinal))
            {
                operation = "Get";
                hitOrMiss = "Hit";
            }
            else if (opRaw.StartsWith("CREATED", StringComparison.Ordinal))
            {
                // First-time creation = miss followed by Set. Surface as Set so the
                // caches tab can show "new limiter created".
                operation = "Set";
                hitOrMiss = "Miss";
            }
            else
            {
                operation = "Evict";
                if (string.IsNullOrEmpty(evictionReason)) evictionReason = "Expired";
            }

            try
            {
                EdogCacheInterceptor.RecordCacheEvent(
                    CacheName,
                    operation,
                    string.IsNullOrEmpty(instanceId) ? key : $"{instanceId}/{key}",
                    hitOrMiss: hitOrMiss,
                    durationMs: 0,
                    evictionReason: evictionReason);
            }
            catch
            {
                // Telemetry must never break FLT.
            }
        }
    }
}
