// <copyright file="BlocklistFilter.cs" company="Microsoft">
// Copyright (c) Microsoft Corporation. All rights reserved.
// </copyright>

#nullable disable
#pragma warning disable // DevMode-only file — suppress all warnings

namespace Microsoft.LiveTable.Service.DevMode
{
    using System;
    using System.Collections.Generic;
    using System.IO;
    using System.Linq;
    using System.Text.Json;
    using System.Text.RegularExpressions;
    using System.Threading;

    /// <summary>
    /// Singleton, thread-safe blocklist that decides whether a given code-marker
    /// name should be dropped at the EDOG source.
    ///
    /// Loaded lazily from <c>edog-blocklist.json</c> located alongside the
    /// running assembly (the same convention as <c>edog-logs.html</c>).
    ///
    /// Fail-open semantics:
    ///   - Missing file       → empty blocklist, allow everything (warn once).
    ///   - Malformed JSON     → empty blocklist, allow everything (warn once).
    ///   - Invalid regex entry → skip that entry, warn once with index+pattern, keep others.
    ///
    /// Errors and Warnings ALWAYS bypass this filter in the interceptor; the
    /// filter is only consulted for Verbose/Message-level logs.
    /// </summary>
    internal sealed class BlocklistFilter
    {
        private const string BlocklistFileName = "edog-blocklist.json";

        private static readonly Lazy<BlocklistFilter> InstanceHolder =
            new Lazy<BlocklistFilter>(Load, LazyThreadSafetyMode.ExecutionAndPublication);

        private readonly IReadOnlyList<BlocklistEntry> entries;
        private readonly IReadOnlyList<Regex> patterns;

        private BlocklistFilter(IReadOnlyList<BlocklistEntry> entries, IReadOnlyList<Regex> patterns, int version, string sourcePath)
        {
            this.entries = entries;
            this.patterns = patterns;
            this.Version = version;
            this.SourcePath = sourcePath;
        }

        /// <summary>
        /// Gets the singleton instance, loading the blocklist on first access.
        /// </summary>
        public static BlocklistFilter Instance => InstanceHolder.Value;

        /// <summary>Gets the schema version declared in the JSON file (0 if defaulted).</summary>
        public int Version { get; }

        /// <summary>Gets the absolute path the blocklist was loaded from, or null if defaulted.</summary>
        public string SourcePath { get; }

        /// <summary>Gets the parsed blocklist entries for UI display.</summary>
        public IReadOnlyList<BlocklistEntry> Entries => this.entries;

        /// <summary>
        /// Returns true if the supplied code-marker name matches any blocklist pattern.
        /// Empty, null, or "Unknown" code markers are NOT blocked by default — they
        /// only get blocked if a pattern explicitly matches (e.g. <c>^Unknown$</c>).
        /// </summary>
        /// <param name="codeMarkerName">Raw code marker name from <c>MonitoredScope.CurrentCodeMarkerName</c>.</param>
        /// <returns>True if the log should be dropped at the source.</returns>
        public bool IsBlocked(string codeMarkerName)
        {
            if (this.patterns.Count == 0)
            {
                return false;
            }

            string name = codeMarkerName ?? string.Empty;
            for (int i = 0; i < this.patterns.Count; i++)
            {
                if (this.patterns[i].IsMatch(name))
                {
                    return true;
                }
            }

            return false;
        }

        private static BlocklistFilter Load()
        {
            string path = ResolveBlocklistPath();

            if (path == null)
            {
                Console.WriteLine($"[EDOG] {BlocklistFileName} not found — allowing all components.");
                return new BlocklistFilter(Array.Empty<BlocklistEntry>(), Array.Empty<Regex>(), 0, null);
            }

            try
            {
                string json = File.ReadAllText(path);
                using var doc = JsonDocument.Parse(json);
                var root = doc.RootElement;

                int version = 0;
                if (root.TryGetProperty("version", out var versionProp) && versionProp.ValueKind == JsonValueKind.Number)
                {
                    version = versionProp.GetInt32();
                }

                if (!root.TryGetProperty("blocked", out var blockedProp) || blockedProp.ValueKind != JsonValueKind.Array)
                {
                    Console.WriteLine($"[EDOG] {BlocklistFileName} missing 'blocked' array — allowing all components.");
                    return new BlocklistFilter(Array.Empty<BlocklistEntry>(), Array.Empty<Regex>(), version, path);
                }

                var entries = new List<BlocklistEntry>();
                var patterns = new List<Regex>();
                int index = 0;
                foreach (var item in blockedProp.EnumerateArray())
                {
                    string pattern = item.TryGetProperty("pattern", out var p) ? p.GetString() : null;
                    string reason = item.TryGetProperty("reason", out var r) ? r.GetString() : null;

                    if (string.IsNullOrWhiteSpace(pattern))
                    {
                        Console.WriteLine($"[EDOG] {BlocklistFileName} entry #{index} has empty pattern — skipped.");
                        index++;
                        continue;
                    }

                    try
                    {
                        var rx = new Regex(
                            pattern,
                            RegexOptions.Compiled | RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
                        patterns.Add(rx);
                        entries.Add(new BlocklistEntry(pattern, reason ?? string.Empty));
                    }
                    catch (ArgumentException ex)
                    {
                        Console.WriteLine($"[EDOG] {BlocklistFileName} entry #{index} pattern '{pattern}' is invalid regex: {ex.Message}");
                    }

                    index++;
                }

                Console.WriteLine($"[EDOG] Loaded {entries.Count} blocklist entries from {path} (version={version}).");
                return new BlocklistFilter(entries, patterns, version, path);
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[EDOG] Failed to load {BlocklistFileName} from {path}: {ex.Message}. Allowing all components.");
                return new BlocklistFilter(Array.Empty<BlocklistEntry>(), Array.Empty<Regex>(), 0, path);
            }
        }

        /// <summary>
        /// Mirrors the runtime search used by EdogLogServer for edog-logs.html:
        ///   1. <c>{AssemblyDir}/DevMode/edog-blocklist.json</c>
        ///   2. <c>{AppContext.BaseDirectory}/DevMode/edog-blocklist.json</c>
        ///   3. <c>{AssemblyDir}/../../../../Microsoft.LiveTable.Service/DevMode/edog-blocklist.json</c>
        ///      (dev iteration when running from bin output)
        /// Returns null if none exist.
        /// </summary>
        private static string ResolveBlocklistPath()
        {
            try
            {
                string assemblyDir = Path.GetDirectoryName(typeof(BlocklistFilter).Assembly.Location);

                var candidates = new List<string>();
                if (!string.IsNullOrEmpty(assemblyDir))
                {
                    candidates.Add(Path.Combine(assemblyDir, "DevMode", BlocklistFileName));
                    candidates.Add(Path.Combine(assemblyDir, "..", "..", "..", "..", "Microsoft.LiveTable.Service", "DevMode", BlocklistFileName));
                }

                candidates.Add(Path.Combine(AppContext.BaseDirectory, "DevMode", BlocklistFileName));

                foreach (var candidate in candidates)
                {
                    if (File.Exists(candidate))
                    {
                        return Path.GetFullPath(candidate);
                    }
                }
            }
            catch
            {
                // Probing must never throw.
            }

            return null;
        }

        /// <summary>
        /// Parsed blocklist entry exposed via <c>/api/blocklist</c>.
        /// </summary>
        internal sealed class BlocklistEntry
        {
            public BlocklistEntry(string pattern, string reason)
            {
                this.Pattern = pattern;
                this.Reason = reason;
            }

            public string Pattern { get; }

            public string Reason { get; }
        }
    }
}
