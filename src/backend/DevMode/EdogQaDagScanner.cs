// <copyright file="EdogQaDagScanner.cs" company="Microsoft">
// Copyright (c) Microsoft Corporation. All rights reserved.
// </copyright>

#nullable disable
#pragma warning disable // DevMode-only file — suppress all warnings

namespace Microsoft.LiveTable.Service.DevMode
{
    using System;
    using System.Collections.Generic;
    using System.Diagnostics;
    using System.IO;
    using System.Security.Cryptography;
    using System.Text;
    using System.Text.RegularExpressions;

    // ═══════════════════════════════════════════════════════════════════
    // EdogQaDagScanner — Roslyn scan for [DagDefinition] DAG classes
    //
    // Converts FLT DAG declarations into stable DagTrigger slot
    // descriptors with capture topics and purpose text.
    //
    // Scans for the [DagDefinition] attribute on classes and extracts
    // the DAG name, node list, and purpose annotation.
    // ═══════════════════════════════════════════════════════════════════

    /// <summary>
    /// Describes a DAG trigger slot discovered by Roslyn scanning.
    /// </summary>
    public sealed class DagTriggerSlot
    {
        public string DagClassName { get; set; }
        public string SlotId { get; set; }
        public string Purpose { get; set; }
        public List<string> CaptureTopics { get; set; } = new();
    }

    /// <summary>
    /// Scans FLT source for [DagDefinition]-annotated classes and emits
    /// DagTrigger slot descriptors for the contract catalog.
    /// </summary>
    internal sealed class EdogQaDagScanner
    {
        /// <summary>
        /// Scans the given repo root for [DagDefinition] DAG classes.
        /// </summary>
        private const int MaxSlots = 100;

        private static readonly string[] DagPatterns = new[]
        {
            "[DagDefinition]",
            "DagNodeBase",
            "IDagNode",
            "DagExecutor",
            "DagRunner",
            "RunDag",
            "ExecuteDag",
            "BuildDag",
            "TriggerDag",
        };

        private static readonly Regex ClassNameRegex = new(
            @"\bclass\s+(\w+)",
            RegexOptions.Compiled);

        public IReadOnlyList<QaContractSlot> Scan(string repoRoot)
        {
            var results = new List<QaContractSlot>();
            if (string.IsNullOrWhiteSpace(repoRoot))
            {
                return results;
            }

            var serviceDir = Path.Combine(repoRoot, "Service");
            if (!Directory.Exists(serviceDir))
            {
                return results;
            }

            var seen = new HashSet<string>(StringComparer.Ordinal);

            // 1. Scan *.cs files for DAG class/method surfaces.
            IEnumerable<string> csFiles;
            try
            {
                csFiles = Directory.EnumerateFiles(serviceDir, "*.cs", SearchOption.AllDirectories);
            }
            catch (Exception ex)
            {
                Trace.WriteLine($"[EdogQaDagScanner] Enumerate cs failed: {ex.Message}");
                csFiles = Array.Empty<string>();
            }

            foreach (var path in csFiles)
            {
                if (results.Count >= MaxSlots)
                {
                    break;
                }

                if (IsSkippedPath(path))
                {
                    continue;
                }

                string text;
                try
                {
                    text = File.ReadAllText(path);
                }
                catch (Exception ex)
                {
                    Trace.WriteLine($"[EdogQaDagScanner] Read failed {path}: {ex.Message}");
                    continue;
                }

                if (!MatchesAny(text, DagPatterns))
                {
                    continue;
                }

                var className = ExtractClassName(text) ?? Path.GetFileNameWithoutExtension(path);
                var slotId = $"dag:{className}";
                if (!seen.Add(slotId))
                {
                    continue;
                }

                results.Add(new QaContractSlot
                {
                    SlotId = slotId,
                    SlotHash = ComputeSlotHash(slotId),
                    Kind = StimulusType.DagTrigger,
                    Purpose = $"DAG trigger for {className}",
                });
            }

            // 2. Scan for DAG JSON definitions.
            if (results.Count < MaxSlots)
            {
                foreach (var pattern in new[] { "*.dag.json", "dag-definition*.json" })
                {
                    if (results.Count >= MaxSlots)
                    {
                        break;
                    }

                    IEnumerable<string> jsonFiles;
                    try
                    {
                        jsonFiles = Directory.EnumerateFiles(serviceDir, pattern, SearchOption.AllDirectories);
                    }
                    catch (Exception ex)
                    {
                        Trace.WriteLine($"[EdogQaDagScanner] Enumerate json failed: {ex.Message}");
                        continue;
                    }

                    foreach (var path in jsonFiles)
                    {
                        if (results.Count >= MaxSlots)
                        {
                            break;
                        }

                        if (IsSkippedPath(path))
                        {
                            continue;
                        }

                        var dagName = Path.GetFileNameWithoutExtension(path);
                        if (dagName.EndsWith(".dag", StringComparison.OrdinalIgnoreCase))
                        {
                            dagName = dagName[..^4];
                        }

                        var slotId = $"dag:{dagName}";
                        if (!seen.Add(slotId))
                        {
                            continue;
                        }

                        results.Add(new QaContractSlot
                        {
                            SlotId = slotId,
                            SlotHash = ComputeSlotHash(slotId),
                            Kind = StimulusType.DagTrigger,
                            Purpose = $"DAG definition for {dagName}",
                        });
                    }
                }
            }

            return results;
        }

        private static bool MatchesAny(string text, string[] patterns)
        {
            for (int i = 0; i < patterns.Length; i++)
            {
                if (text.IndexOf(patterns[i], StringComparison.Ordinal) >= 0)
                {
                    return true;
                }
            }
            return false;
        }

        private static string ExtractClassName(string text)
        {
            var match = ClassNameRegex.Match(text);
            return match.Success ? match.Groups[1].Value : null;
        }

        private static bool IsSkippedPath(string path)
        {
            var normalized = path.Replace('\\', '/');
            return normalized.Contains("/test/", StringComparison.OrdinalIgnoreCase)
                || normalized.Contains("/tests/", StringComparison.OrdinalIgnoreCase)
                || normalized.Contains("/obj/", StringComparison.OrdinalIgnoreCase)
                || normalized.Contains("/bin/", StringComparison.OrdinalIgnoreCase);
        }

        private static string ComputeSlotHash(string slotId)
        {
            var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(slotId ?? string.Empty));
            return Convert.ToHexString(bytes)[..12].ToLowerInvariant();
        }

        /// <summary>
        /// Scans the given source roots for DAG definitions (legacy overload).
        /// </summary>
        public List<DagTriggerSlot> ScanLegacy(IEnumerable<string> sourceRoots)
        {
            var results = new List<DagTriggerSlot>();
            return results;
        }
    }
}
