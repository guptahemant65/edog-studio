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
    /// Two filter layers:
    ///   1. <see cref="IsBlocked(string)"/> — component-name patterns from the
    ///      <c>blocked</c> array. Errors/Warnings ALWAYS bypass.
    ///   2. <see cref="IsMessageBlocked(string)"/> — message-body patterns
    ///      from the <c>messageBlocked</c> array. Used as a NARROW override
    ///      for known dev-mode Warning noise (AppInsights metric init
    ///      failures, etc.) that would otherwise bypass layer 1. Every
    ///      pattern here MUST be tight enough to never match a real failure
    ///      — see tests/test_blocklist_message_pattern_drop.py for the
    ///      enforced sanity guard.
    ///
    /// Fail-open semantics:
    ///   - Missing file       → empty blocklist, allow everything (warn once).
    ///   - Malformed JSON     → empty blocklist, allow everything (warn once).
    ///   - Invalid regex entry → skip that entry, warn once with index+pattern, keep others.
    /// </summary>
    internal sealed class BlocklistFilter
    {
        private const string BlocklistFileName = "edog-blocklist.json";

        private static readonly Lazy<BlocklistFilter> InstanceHolder =
            new Lazy<BlocklistFilter>(Load, LazyThreadSafetyMode.ExecutionAndPublication);

        private readonly IReadOnlyList<BlocklistEntry> entries;
        private readonly IReadOnlyList<Regex> patterns;
        private readonly IReadOnlyList<BlocklistEntry> messageEntries;
        private readonly IReadOnlyList<Regex> messagePatterns;

        private BlocklistFilter(
            IReadOnlyList<BlocklistEntry> entries,
            IReadOnlyList<Regex> patterns,
            IReadOnlyList<BlocklistEntry> messageEntries,
            IReadOnlyList<Regex> messagePatterns,
            int version,
            string sourcePath)
        {
            this.entries = entries;
            this.patterns = patterns;
            this.messageEntries = messageEntries;
            this.messagePatterns = messagePatterns;
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

        /// <summary>Gets the parsed message-blocklist entries for UI display.</summary>
        public IReadOnlyList<BlocklistEntry> MessageEntries => this.messageEntries;

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

        /// <summary>
        /// Returns true if the supplied message body matches any message-blocklist
        /// pattern. Used as a NARROW override for known platform Warning noise
        /// (e.g. AppInsights metric-init failures) that would otherwise bypass
        /// the component-level filter via the "Errors/Warnings always pass" rule.
        ///
        /// EVERY pattern in <c>messageBlocked</c> is sanity-guarded by
        /// tests/test_blocklist_message_pattern_drop.py against a corpus of
        /// real FLT failure messages — do not add a pattern here without
        /// extending that test set first.
        /// </summary>
        /// <param name="message">Raw message body from the log entry.</param>
        /// <returns>True if the log should be dropped even when it is an Error/Warning.</returns>
        public bool IsMessageBlocked(string message)
        {
            if (this.messagePatterns.Count == 0)
            {
                return false;
            }

            string body = message ?? string.Empty;
            for (int i = 0; i < this.messagePatterns.Count; i++)
            {
                if (this.messagePatterns[i].IsMatch(body))
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
                return new BlocklistFilter(
                    Array.Empty<BlocklistEntry>(), Array.Empty<Regex>(),
                    Array.Empty<BlocklistEntry>(), Array.Empty<Regex>(),
                    0, null);
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

                var entries = ParseArray(root, "blocked");
                var messageEntries = ParseArray(root, "messageBlocked");

                Console.WriteLine(
                    $"[EDOG] Loaded {entries.Item1.Count} component blocklist entries and " +
                    $"{messageEntries.Item1.Count} message blocklist entries from {path} (version={version}).");

                return new BlocklistFilter(
                    entries.Item1, entries.Item2,
                    messageEntries.Item1, messageEntries.Item2,
                    version, path);
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[EDOG] Failed to load {BlocklistFileName} from {path}: {ex.Message}. Allowing all components.");
                return new BlocklistFilter(
                    Array.Empty<BlocklistEntry>(), Array.Empty<Regex>(),
                    Array.Empty<BlocklistEntry>(), Array.Empty<Regex>(),
                    0, path);
            }
        }

        /// <summary>
        /// Parses a named JSON array of <c>{pattern, reason}</c> objects into
        /// a parallel pair of entries and compiled regexes. Invalid entries
        /// are warned-and-skipped (fail-open). Missing array returns empties.
        /// </summary>
        private static (List<BlocklistEntry>, List<Regex>) ParseArray(JsonElement root, string arrayKey)
        {
            var entries = new List<BlocklistEntry>();
            var patterns = new List<Regex>();

            if (!root.TryGetProperty(arrayKey, out var arrayProp) || arrayProp.ValueKind != JsonValueKind.Array)
            {
                return (entries, patterns);
            }

            int index = 0;
            foreach (var item in arrayProp.EnumerateArray())
            {
                string pattern = item.TryGetProperty("pattern", out var p) ? p.GetString() : null;
                string reason = item.TryGetProperty("reason", out var r) ? r.GetString() : null;

                if (string.IsNullOrWhiteSpace(pattern))
                {
                    Console.WriteLine($"[EDOG] {BlocklistFileName} {arrayKey}[{index}] has empty pattern — skipped.");
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
                    Console.WriteLine($"[EDOG] {BlocklistFileName} {arrayKey}[{index}] pattern '{pattern}' is invalid regex: {ex.Message}");
                }

                index++;
            }

            return (entries, patterns);
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
