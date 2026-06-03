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
    using System.IO;
    using System.Linq;
    using System.Text.Json;
    using System.Text.RegularExpressions;
    using Microsoft.ServicePlatform.Telemetry;
    /// <summary>
    /// Intercepts all Tracer.LogSanitized* calls and forwards them to EdogLogServer for dev-time analysis.
    /// Also writes colored console output so developers see logs in their terminal.
    /// Provides error storm protection via dedup (same error within 2s window is suppressed).
    /// Optionally filters noise from non-FLT components using a dynamically-generated allowlist.
    /// </summary>
    internal sealed class EdogLogInterceptor : IStructuredTestLogger
    {
        // Strategy for ExtractComponent: PascalCase class-name prefix convention.
        // FLT internal logs pervasively use "ClassName: message" (80+ call sites, 16 files).
        // Platform/WCL logs never use this convention — they use [BracketTag] or CodeMarkers.
        // Requires: starts uppercase, has at least one lowercase (excludes "WARNING:", "ERROR:"),
        // minimum 6 chars total, followed by ": " (colon+space).
        private static readonly Regex ClassPrefixRegex = new Regex(
            @"^([A-Z][a-z][a-zA-Z0-9]{4,})\s*:\s",
            RegexOptions.Compiled);

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
        private const int ErrorMessageKeyLength = 120;
        private const int MaxDedupEntries = 200;
        private const int PruneAgeMs = 10000; // 5x dedup window

        private readonly ConcurrentDictionary<string, long> recentErrors = new ConcurrentDictionary<string, long>();

        // Dynamic FLT component allowlist (loaded from edog-flt-components.json at startup)
        private readonly HashSet<string> fltComponentPrefixes;
        private readonly bool hasAllowlist;

        private readonly EdogLogServer edogLogServer;

        /// <summary>
        /// Initializes a new instance of the <see cref="EdogLogInterceptor"/> class.
        /// </summary>
        /// <param name="server">The EdogLogServer instance to forward logs to.</param>
        public EdogLogInterceptor(EdogLogServer server)
        {
            this.edogLogServer = server ?? throw new ArgumentNullException(nameof(server));
            this.fltComponentPrefixes = LoadComponentAllowlist();
            this.hasAllowlist = this.fltComponentPrefixes.Count > 0;
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
                var component = ExtractComponent(MonitoredScope.CurrentCodeMarkerName, message, out bool fromClassPrefix);
                var rootActivityId = MonitoredScope.RootActivityId.ToString();
                var eventId = testLogEvent.EventId;

                var isFlt = this.IsFltComponent(component);

                // Noise filter: non-FLT logs are dropped when allowlist is active.
                // Logs with a PascalCase class-name prefix (e.g., "InsightsOboTokenProvider: ...")
                // are FLT-internal by convention — platform/WCL never uses this pattern —
                // so they bypass the allowlist check entirely.
                if (this.hasAllowlist && !isFlt && !fromClassPrefix)
                {
                    if (!message.Contains("MLV_") && !message.Contains("FLT_") && !message.Contains("SPARK_"))
                    {
                        return;
                    }
                }

                // Error storm protection: dedup non-FLT errors/warnings within 2s window
                if (!isFlt)
                {
                    var upperLevel = level.ToUpperInvariant();
                    if (upperLevel == "ERROR" || upperLevel == "WARNING")
                    {
                        if (this.IsDuplicateError(level, component, message))
                        {
                            return;
                        }
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
        /// Strips WCL- prefixes and extracts FLT-specific tags from messages.
        ///
        /// Three extraction strategies (in priority order):
        ///   1. [BracketTag] prefix — used by both FLT and platform, checked against allowlist
        ///   2. PascalCaseClassName: prefix — FLT-internal convention (80+ call sites), bypasses allowlist
        ///   3. MonitoredScope CodeMarker — fallback, checked against allowlist
        /// </summary>
        private static string ExtractComponent(string codeMarkerName, string message, out bool fromClassPrefix)
        {
            fromClassPrefix = false;

            if (!string.IsNullOrEmpty(message))
            {
                // Strategy 1: [BracketedComponent] from message — most informative
                int start = message.IndexOf('[');
                int end = message.IndexOf(']');
                if (start == 0 && end > 1 && end < 60)
                {
                    return message.Substring(1, end - 1);
                }

                // Strategy 2: PascalCaseClassName: prefix — FLT-internal convention.
                // Platform/WCL logs never use this pattern; it's exclusive to FLT internals
                // (InsightsOboTokenProvider, RefreshTriggersHandler, DagExecutionStore, etc.).
                var m = ClassPrefixRegex.Match(message);
                if (m.Success)
                {
                    fromClassPrefix = true;
                    return m.Groups[1].Value;
                }
            }

            // Strategy 3: MonitoredScope code marker
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
        /// Checks if a component is a known FLT component based on the dynamic allowlist.
        /// Returns true if no allowlist is loaded (allow-all fallback).
        ///
        /// Special case for "Unknown" component (post-mortem 2026-05-26):
        ///   The allowlist exists to filter logs from *explicitly tagged* third-party
        ///   components ("WCL-PlatformRelay", "Security-Audit", etc.). When a log
        ///   has no bracket prefix AND no useful MonitoredScope (so component=="Unknown"),
        ///   it's overwhelmingly an FLT internal call (WorkloadApp.cs, FeatureFlighter.cs,
        ///   etc., which use bare `Tracer.LogSanitizedMessage(...)` without a tag).
        ///   Treating Unknown as not-FLT here was hard-dropping every untagged internal
        ///   log the moment the allowlist file was generated. Restore the pre-allowlist
        ///   behavior for the Unknown bucket: allow it through. The dedup-and-error-storm
        ///   protection below still applies, so genuine third-party Unknown errors don't
        ///   flood the UI.
        /// </summary>
        private bool IsFltComponent(string component)
        {
            if (!this.hasAllowlist)
            {
                return true; // No allowlist = allow all
            }

            if (string.IsNullOrEmpty(component))
            {
                return false;
            }

            if (component == "Unknown")
            {
                // See doc comment above — Unknown is treated as FLT-internal in DevMode.
                return true;
            }

            foreach (var prefix in this.fltComponentPrefixes)
            {
                if (component.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) ||
                    component.Equals(prefix, StringComparison.OrdinalIgnoreCase))
                {
                    return true;
                }
            }

            return false;
        }

        /// <summary>
        /// Error storm protection: returns true if this error was already seen within the dedup window.
        /// Uses level + component + first N chars of message as the dedup key.
        /// </summary>
        private bool IsDuplicateError(string level, string component, string message)
        {
            var keyMsg = message.Length > ErrorMessageKeyLength
                ? message.Substring(0, ErrorMessageKeyLength)
                : message;
            var key = string.Concat(level, ":", component, ":", keyMsg);
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

        /// <summary>
        /// Loads the FLT component allowlist from edog-flt-components.json in the DevMode directory.
        /// The file is generated by edog.py at deploy time by scanning the FLT codebase.
        /// Returns empty set if file not found (safe fallback: allow all).
        /// </summary>
        private static HashSet<string> LoadComponentAllowlist()
        {
            var result = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            try
            {
                // Look for the components file next to this assembly
                var assemblyDir = AppDomain.CurrentDomain.BaseDirectory;
                var candidates = new[]
                {
                    Path.Combine(assemblyDir, "DevMode", "edog-flt-components.json"),
                    Path.Combine(assemblyDir, "edog-flt-components.json"),
                };

                string filePath = null;
                foreach (var c in candidates)
                {
                    if (File.Exists(c))
                    {
                        filePath = c;
                        break;
                    }
                }

                if (filePath == null)
                {
                    return result; // No file = allow all
                }

                var json = File.ReadAllText(filePath);
                var doc = JsonDocument.Parse(json);
                if (doc.RootElement.TryGetProperty("components", out var arr) && arr.ValueKind == JsonValueKind.Array)
                {
                    foreach (var item in arr.EnumerateArray())
                    {
                        var val = item.GetString();
                        if (!string.IsNullOrWhiteSpace(val))
                        {
                            result.Add(val);
                        }
                    }
                }

                Console.WriteLine($"[EDOG] Loaded {result.Count} FLT component prefixes from allowlist");
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[EDOG] Could not load component allowlist: {ex.Message} — allowing all");
            }

            return result;
        }
    }
}