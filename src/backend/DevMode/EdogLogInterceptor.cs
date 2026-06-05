// <copyright file="EdogLogInterceptor.cs" company="Microsoft">
// Copyright (c) Microsoft Corporation. All rights reserved.
// </copyright>

#nullable disable
#pragma warning disable // DevMode-only file — suppress all warnings

namespace Microsoft.LiveTable.Service.DevMode
{
    using System;
    using System.Collections.Concurrent;
    using System.Collections.Generic;
    using System.Linq;
    using System.Text.RegularExpressions;
    using System.Threading;
    using Microsoft.ServicePlatform.Telemetry;

    /// <summary>
    /// Intercepts Tracer.LogSanitized* calls and forwards FLT-relevant logs to EdogLogServer.
    ///
    /// Two-layer defence (filter at source + handle pressure on what survives):
    ///   Layer 1 — Component BLOCKLIST: drop logs whose CodeMarkerName matches any
    ///             pattern in <c>edog-blocklist.json</c> (loaded by <see cref="BlocklistFilter"/>).
    ///             Errors and Warnings always pass — even if blocklisted — so failures
    ///             are never hidden. Default content covers known noisy platform
    ///             components (WCL-*, Microsoft.AspNetCore, Kestrel, System.*, etc.).
    ///   Layer 2 — Error dedup: identical errors within a 2s window are collapsed so
    ///             relay-timeout-storms don't flood the pipeline.
    ///
    /// Why blocklist (not allowlist):
    ///   The prior allowlist was a hardcoded set of ~30 regex patterns enumerating FLT
    ///   bracket-tags and code-marker namespaces. Two failure modes:
    ///     1. ~63% of FLT logs are plain (no [Bracket] tag, no MonitoredScope) and were
    ///        being silently dropped.
    ///     2. Every new bracket tag (e.g. [DeltaLogReader], [DeltaSnapshotCache]) required
    ///        editing both this file AND the frontend preset — easy to forget.
    ///   A blocklist of noisy platform components is bounded and slow-moving; FLT churn
    ///   is constant. Defaulting to "allow" surfaces new FLT logs automatically.
    ///
    /// Pressure handling (truncation, dedup batching, adaptive flush, backpressure)
    /// lives in EdogLogServer.cs.
    /// </summary>
    internal sealed class EdogLogInterceptor : IStructuredTestLogger
    {
        private static readonly Regex IterationIdRegex = new Regex(
            @"(?:\[IterationId\s+|\bIterationId[=: ]+)([0-9a-fA-F-]{36})\b",
            RegexOptions.Compiled);

        // rootActivityId → iterationId reverse index for log enrichment.
        // When a telemetry event carries correlationId = "rootId|iterationId",
        // we cache that mapping so log entries with the same rootActivityId
        // can inherit the iterationId.
        private static readonly ConcurrentDictionary<string, string>
            _rootActivityToIteration = new(StringComparer.OrdinalIgnoreCase);

        /// <summary>
        /// Called by EdogTelemetryInterceptor to register a rootActivityId → iterationId
        /// mapping whenever a telemetry event with a correlationId is processed.
        /// </summary>
        public static void RegisterRootActivityMapping(string correlationId, string iterationId)
        {
            if (string.IsNullOrEmpty(correlationId) || string.IsNullOrEmpty(iterationId)) return;
            var pipeIdx = correlationId.IndexOf('|');
            if (pipeIdx > 0)
            {
                _rootActivityToIteration[correlationId.Substring(0, pipeIdx)] = iterationId;
            }
            else if (correlationId.Length >= 73 && correlationId[36] == '-')
            {
                _rootActivityToIteration[correlationId.Substring(0, 36)] = iterationId;
            }
        }

        // ── Error dedup — prevents relay-timeout-storm floods ────────────
        private const int ErrorDedupWindowMs = 2000;
        private const int ErrorMessageKeyLength = 120;
        private readonly ConcurrentDictionary<string, long> recentErrors = new();

        private readonly EdogLogServer edogLogServer;

        /// <summary>
        /// Initializes a new instance of the <see cref="EdogLogInterceptor"/> class.
        /// </summary>
        /// <param name="server">The EdogLogServer instance to forward logs to.</param>
        public EdogLogInterceptor(EdogLogServer server)
        {
            this.edogLogServer = server ?? throw new ArgumentNullException(nameof(server));
        }

        /// <summary>
        /// Intercepts trace events from the telemetry system. Only FLT-relevant logs
        /// and errors pass through. Everything else is dropped at the source.
        /// </summary>
        /// <param name="testLogEvent">The test log event containing telemetry data.</param>
        public void TraceEvent(TestLogEvent testLogEvent)
        {
            try
            {
                if (testLogEvent?.Message == null)
                {
                    return;
                }

                // Extract core data
                var timestamp = DateTime.UtcNow;
                var level = NormalizeLevel(testLogEvent.Level.ToString());
                var message = testLogEvent.Message;
                var rawCodeMarker = MonitoredScope.CurrentCodeMarkerName;
                var component = ExtractComponent(rawCodeMarker, message);
                var rootActivityId = MonitoredScope.RootActivityId.ToString();
                var eventId = testLogEvent.EventId;

                var isError = level.Equals("Error", StringComparison.OrdinalIgnoreCase)
                           || level.Equals("Warning", StringComparison.OrdinalIgnoreCase);

                // ── Layer 1: Blocklist — drop known platform-noise components ───
                // Errors/Warnings always bypass so failures are never hidden.
                if (!isError && BlocklistFilter.Instance.IsBlocked(rawCodeMarker))
                {
                    return;
                }

                // ── Layer 2: Error dedup — suppress duplicate error storms ─
                // Dedup applies to errors/warnings whose component is itself blocklisted
                // (i.e. they only got through because of the always-pass rule, and could
                // arrive in storms). FLT-source errors are NOT deduped — every one matters.
                if (isError && BlocklistFilter.Instance.IsBlocked(rawCodeMarker))
                {
                    var key = message.Length > ErrorMessageKeyLength
                        ? message.Substring(0, ErrorMessageKeyLength)
                        : message;
                    var nowTicks = Environment.TickCount64;

                    if (recentErrors.TryGetValue(key, out var lastTick) &&
                        (nowTicks - lastTick) < ErrorDedupWindowMs)
                    {
                        return;
                    }

                    recentErrors[key] = nowTicks;

                    if (recentErrors.Count > 200)
                    {
                        PruneRecentErrors(nowTicks);
                    }
                }

                // Parse custom data into dictionary
                var customData = new Dictionary<string, string>();
                if (testLogEvent.CustomData != null)
                {
                    foreach (var kvp in testLogEvent.CustomData)
                    {
                        customData[kvp.Key] = kvp.Value?.ToString() ?? string.Empty;
                    }
                }

                // Create log entry and forward to server
                var entry = new LogEntry(timestamp, level, message, component, rootActivityId, eventId, customData);
                entry.CodeMarkerName = MonitoredScope.CurrentCodeMarkerName;

                var iterMatch = IterationIdRegex.Match(message);
                if (iterMatch.Success)
                {
                    entry.IterationId = iterMatch.Groups[1].Value;
                }

                this.edogLogServer.AddLog(entry);

                // Console also filtered — no point printing noise to stdout
                this.WriteColoredConsoleOutput(level, component, rootActivityId, message);
            }
            catch
            {
                // Never throw from telemetry interceptor - silently handle any errors
            }
        }

        private void PruneRecentErrors(long nowTicks)
        {
            foreach (var kvp in recentErrors)
            {
                if (nowTicks - kvp.Value > ErrorDedupWindowMs * 5)
                {
                    recentErrors.TryRemove(kvp.Key, out _);
                }
            }
        }

        /// <summary>
        /// Writes colored console output based on log level for developer visibility.
        /// </summary>
        private void WriteColoredConsoleOutput(string level, string component, string rootActivityId, string message)
        {
            try
            {
                var timestamp = DateTime.UtcNow.ToString("yyyy'-'MM'-'dd'T'HH':'mm':'ss.fffffffK");
                var formattedMessage = $"{timestamp} {level}: {component} : {rootActivityId} {message}";

                var originalColor = Console.ForegroundColor;
                
                Console.ForegroundColor = level.ToUpperInvariant() switch
                {
                    "MESSAGE" => ConsoleColor.Cyan,
                    "WARNING" => ConsoleColor.Yellow,
                    "ERROR" => ConsoleColor.Red,
                    "VERBOSE" => ConsoleColor.Gray,
                    _ => ConsoleColor.White
                };

                Console.WriteLine(formattedMessage);
                Console.ForegroundColor = originalColor;
            }
            catch
            {
                // Ignore console output errors - don't break logging pipeline
            }
        }

        /// <summary>
        /// Normalizes ServicePlatform TraceLevel enum names to the display names used by the frontend.
        /// The platform uses "Informational" but the UI expects "Message".
        /// </summary>
        private static string NormalizeLevel(string level)
        {
            return level switch
            {
                "Informational" => "Message",
                "Info" => "Message",
                _ => level
            };
        }

        /// <summary>
        /// Extracts a clean component name from the MonitoredScope code marker name.
        /// Strips WCL- prefixes and extracts FLT-specific bracket tags from messages.
        /// </summary>
        private static string ExtractComponent(string codeMarkerName, string message)
        {
            // Try to extract [BracketedComponent] from message first — most informative
            if (!string.IsNullOrEmpty(message))
            {
                int start = message.IndexOf('[');
                int end = message.IndexOf(']');
                if (start == 0 && end > 1 && end < 60)
                {
                    return message.Substring(1, end - 1);
                }
            }

            if (string.IsNullOrEmpty(codeMarkerName) || codeMarkerName == "Unknown")
            {
                return "Unknown";
            }

            // Clean up WCL- prefix and take meaningful suffix
            if (codeMarkerName.StartsWith("WCL-"))
            {
                return codeMarkerName.Substring(4);
            }

            return codeMarkerName;
        }
    }
}