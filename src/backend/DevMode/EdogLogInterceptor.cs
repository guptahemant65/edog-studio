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
    using Microsoft.ServicePlatform.Telemetry;
    /// <summary>
    /// Intercepts all Tracer.LogSanitized* calls and forwards them to EdogLogServer for dev-time analysis.
    /// Also writes colored console output so developers see logs in their terminal.
    /// Provides error storm protection via dedup (same error within 2s window is suppressed).
    /// No server-side content filtering — ALL logs are forwarded. Frontend component presets
    /// (filters.js) handle user-controlled filtering. This default-allow design prevents
    /// the silent log-dropping bugs that plagued the previous allowlist-based approach.
    /// </summary>
    internal sealed class EdogLogInterceptor : IStructuredTestLogger
    {
        private static readonly Regex IterationIdRegex = new Regex(
            @"(?:\[IterationId\s+|\bIterationId[=: ]+)([0-9a-fA-F-]{36})\b",
            RegexOptions.Compiled);

        // Strategy 2: Extract node name from log messages
        // Matches: "for Node silver.mlv_noref", "metrics for silver.mlv_noref",
        //          "Updated in-memory node metrics for silver.mlv_incr_join"
        private static readonly Regex NodeNameRegex = new Regex(
            @"(?:for Node |metrics for |node metrics for |Node name: )([a-zA-Z_][a-zA-Z0-9_./-]+)",
            RegexOptions.Compiled);

        // Strategy 3: Extract artifactId (lakehouse ID) from URL paths in messages
        // Matches: "/lakehouses/2b3c9fa5-3199-4256-9c65-93fc8e3b6c45"
        //          "/artifacts/2b3c9fa5-3199-4256-9c65-93fc8e3b6c45"
        private static readonly Regex ArtifactInUrlRegex = new Regex(
            @"(?:/lakehouses/|/artifacts/)([0-9a-fA-F-]{36})",
            RegexOptions.Compiled);

        // Strategy 1: rootActivityId → iterationId reverse index
        // When a telemetry event carries correlationId = "rootId|iterationId",
        // we cache that mapping so log entries with the same rootActivityId
        // can inherit the iterationId.
        private static readonly System.Collections.Concurrent.ConcurrentDictionary<string, string>
            _rootActivityToIteration = new(StringComparer.OrdinalIgnoreCase);

        /// <summary>
        /// Called by EdogTelemetryInterceptor to register a rootActivityId → iterationId
        /// mapping whenever a telemetry event with a correlationId is processed.
        /// </summary>
        public static void RegisterRootActivityMapping(string correlationId, string iterationId)
        {
            if (string.IsNullOrEmpty(correlationId) || string.IsNullOrEmpty(iterationId)) return;
            // Extract rootActivityId from correlation: "rootId|iterationId" or "rootId-iterationId"
            var pipeIdx = correlationId.IndexOf('|');
            if (pipeIdx > 0)
            {
                _rootActivityToIteration[correlationId.Substring(0, pipeIdx)] = iterationId;
            }
            else if (correlationId.Length >= 73 && correlationId[36] == '-')
            {
                _rootActivityToIteration[correlationId.Substring(0, 36)] = iterationId;
            }
            // Cap at 500 entries (FIFO is complex for ConcurrentDictionary — just let it grow slowly)
            // In practice, a session has <50 distinct rootActivityIds
        }

        // Error dedup: suppress duplicate errors within a 2-second window (storm protection)
        private const int ErrorDedupWindowMs = 2000;
        private const int MaxDedupEntries = 200;
        private const int PruneAgeMs = 10000; // 5x dedup window

        private readonly ConcurrentDictionary<string, long> recentErrors = new ConcurrentDictionary<string, long>();

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
        /// Intercepts trace events from the telemetry system and forwards them to EdogLogServer.
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
                var component = ExtractComponent(MonitoredScope.CurrentCodeMarkerName, message);
                var rootActivityId = MonitoredScope.RootActivityId.ToString();
                var eventId = testLogEvent.EventId;

                // Error storm protection: dedup repeated errors/warnings within 2s window.
                // Applied universally — prevents UI flood from any component.
                var upperLevel = level.ToUpperInvariant();
                if (upperLevel == "ERROR" || upperLevel == "WARNING")
                {
                    if (this.IsDuplicateError(level, component, message, eventId))
                    {
                        return;
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

                // Extract IterationId using 3-strategy enrichment.
                // Strategy 1 (Definite): CustomData["IterationId"] from MonitoredScope
                // Strategy 2 (Strong): Regex match in message body
                // Strategy 3 (Strong): rootActivityId → iterationId reverse index
                string extractedIterationId = null;
                string iterationIdSource = null;

                if (customData.TryGetValue("IterationId", out var iidFromCustom) && IsValidGuid(iidFromCustom))
                {
                    extractedIterationId = iidFromCustom;
                    iterationIdSource = "customData";
                }
                else
                {
                    var iterMatch = IterationIdRegex.Match(message);
                    if (iterMatch.Success)
                    {
                        extractedIterationId = iterMatch.Groups[1].Value;
                        iterationIdSource = "regex";
                    }
                    else if (_rootActivityToIteration.TryGetValue(rootActivityId, out var chainedIterId))
                    {
                        extractedIterationId = chainedIterId;
                        iterationIdSource = "rootActivityId-chain";
                    }
                }

                if (!string.IsNullOrEmpty(extractedIterationId))
                {
                    entry.IterationId = extractedIterationId;
                    entry.IterationIdSource = iterationIdSource;
                }

                // Extract NodeName from message (Strategy 2 for cross-tab linking)
                var nodeMatch = NodeNameRegex.Match(message);
                if (nodeMatch.Success)
                {
                    entry.NodeName = nodeMatch.Groups[1].Value.Trim();
                }

                // Extract ArtifactId from URL patterns (Strategy 3 for request chain grouping)
                var artMatch = ArtifactInUrlRegex.Match(message);
                if (artMatch.Success)
                {
                    entry.ArtifactId = artMatch.Groups[1].Value;
                }

                this.edogLogServer.AddLog(entry);

                // Write colored console output for developer visibility
                this.WriteColoredConsoleOutput(level, component, rootActivityId, message);
            }
            catch
            {
                // Never throw from telemetry interceptor - silently handle any errors
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
        /// Returns true if the value looks like a non-empty, non-default GUID (36 chars, hyphenated).
        /// </summary>
        private static bool IsValidGuid(string value)
        {
            if (string.IsNullOrEmpty(value) || value.Length != 36)
            {
                return false;
            }

            if (value == "00000000-0000-0000-0000-000000000000")
            {
                return false;
            }

            return Guid.TryParse(value, out _);
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
        /// Used as display metadata for the frontend — no filtering decisions depend on this.
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

        /// <summary>
        /// Error storm protection: returns true if this error was already seen within the dedup window.
        /// Uses level + component + eventId + message hash as the dedup key.
        /// </summary>
        private bool IsDuplicateError(string level, string component, string message, string eventId)
        {
            // Use full message hash for precision — avoids collisions from truncation
            var msgHash = message.GetHashCode().ToString();
            var key = string.Concat(level, ":", component, ":", eventId ?? "", ":", msgHash);
            var nowTicks = DateTime.UtcNow.Ticks;
            var nowMs = nowTicks / TimeSpan.TicksPerMillisecond;

            if (this.recentErrors.TryGetValue(key, out var lastSeenMs))
            {
                if (nowMs - lastSeenMs < ErrorDedupWindowMs)
                {
                    this.recentErrors[key] = nowMs; // Refresh timestamp
                    return true; // Duplicate within window
                }
            }

            this.recentErrors[key] = nowMs;

            // Prune old entries if map is getting large
            if (this.recentErrors.Count > MaxDedupEntries)
            {
                this.PruneRecentErrors(nowMs);
            }

            return false;
        }

        /// <summary>
        /// Removes stale entries from the dedup map (older than PruneAgeMs).
        /// </summary>
        private void PruneRecentErrors(long nowMs)
        {
            var keysToRemove = this.recentErrors
                .Where(kvp => nowMs - kvp.Value > PruneAgeMs)
                .Select(kvp => kvp.Key)
                .ToList();
            foreach (var key in keysToRemove)
            {
                this.recentErrors.TryRemove(key, out _);
            }
        }
    }
}