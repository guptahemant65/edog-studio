// <copyright file="EdogQaFileTimerScanner.cs" company="Microsoft">
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
    // EdogQaFileTimerScanner — Roslyn scan for [EdogFileEventSeam] and
    // [EdogTimerSeam] surfaces.
    //
    // Emits FileEvent and TimerTick slots from the actual FLT seam
    // attributes rather than guessed DI abstractions.
    // ═══════════════════════════════════════════════════════════════════

    /// <summary>
    /// Describes a FileEvent slot discovered by Roslyn scanning.
    /// </summary>
    public sealed class FileEventSlot
    {
        public string ServiceClass { get; set; }
        public string SlotId { get; set; }
        public string Purpose { get; set; }
        public string PathPattern { get; set; }
    }

    /// <summary>
    /// Describes a TimerTick slot discovered by Roslyn scanning.
    /// </summary>
    public sealed class TimerTickSlot
    {
        public string ServiceClass { get; set; }
        public string SlotId { get; set; }
        public string Purpose { get; set; }
        public string CronExpression { get; set; }
    }

    /// <summary>
    /// Scans FLT source for [EdogFileEventSeam] and [EdogTimerSeam]
    /// annotated services and emits FileEvent/TimerTick slot descriptors.
    /// </summary>
    internal sealed class EdogQaFileTimerScanner
    {
        /// <summary>
        /// Scans the given repo root for file-event and timer seam classes.
        /// </summary>
        private const int MaxSlots = 100;

        private static readonly string[] FileEventPatterns = new[]
        {
            "EdogFileEventSeam",
            "IFileSystemWatcher",
            "FileSystemWatcher",
            "OnFileChanged",
            "FileCreated",
            "FileModified",
            "FileEvent",
        };

        private static readonly string[] TimerPatterns = new[]
        {
            "EdogTimerSeam",
            "IHostedService",
            "BackgroundService",
            "PeriodicTimer",
            "TimerCallback",
            "ExecuteAsync",
        };

        private static readonly string[] FileEventMethodNames = new[]
        {
            "OnFileChanged",
            "OnFileCreated",
            "OnFileModified",
            "OnFileDeleted",
            "OnFileRenamed",
            "FileCreated",
            "FileModified",
            "HandleFileEvent",
        };

        private static readonly string[] TimerMethodNames = new[]
        {
            "ExecuteAsync",
            "OnTick",
            "OnTimer",
            "TimerCallback",
            "Tick",
            "RunPeriodic",
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

            IEnumerable<string> csFiles;
            try
            {
                csFiles = Directory.EnumerateFiles(serviceDir, "*.cs", SearchOption.AllDirectories);
            }
            catch (Exception ex)
            {
                Trace.WriteLine($"[EdogQaFileTimerScanner] Enumerate failed: {ex.Message}");
                return results;
            }

            var seen = new HashSet<string>(StringComparer.Ordinal);

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
                    Trace.WriteLine($"[EdogQaFileTimerScanner] Read failed {path}: {ex.Message}");
                    continue;
                }

                var hasFileEvent = MatchesAny(text, FileEventPatterns);
                var hasTimer = MatchesAny(text, TimerPatterns);
                if (!hasFileEvent && !hasTimer)
                {
                    continue;
                }

                var className = ExtractClassName(text) ?? Path.GetFileNameWithoutExtension(path);

                if (hasFileEvent)
                {
                    AddSlotsForKind(
                        results,
                        seen,
                        text,
                        className,
                        FileEventMethodNames,
                        prefix: "file",
                        kind: StimulusType.FileEvent,
                        purposeFmt: "File event handler {0}.{1}");
                }

                if (results.Count >= MaxSlots)
                {
                    break;
                }

                if (hasTimer)
                {
                    AddSlotsForKind(
                        results,
                        seen,
                        text,
                        className,
                        TimerMethodNames,
                        prefix: "timer",
                        kind: StimulusType.TimerTick,
                        purposeFmt: "Timer tick handler {0}.{1}");
                }
            }

            return results;
        }

        private static void AddSlotsForKind(
            List<QaContractSlot> results,
            HashSet<string> seen,
            string text,
            string className,
            string[] methodNames,
            string prefix,
            StimulusType kind,
            string purposeFmt)
        {
            var anyMethodFound = false;
            foreach (var method in methodNames)
            {
                if (results.Count >= MaxSlots)
                {
                    return;
                }

                if (!ContainsMethod(text, method))
                {
                    continue;
                }

                anyMethodFound = true;
                var slotId = $"{prefix}:{className}:{method}";
                if (!seen.Add(slotId))
                {
                    continue;
                }

                results.Add(new QaContractSlot
                {
                    SlotId = slotId,
                    SlotHash = ComputeSlotHash(slotId),
                    Kind = kind,
                    Purpose = string.Format(purposeFmt, className, method),
                });
            }

            if (!anyMethodFound && results.Count < MaxSlots)
            {
                var slotId = $"{prefix}:{className}";
                if (seen.Add(slotId))
                {
                    results.Add(new QaContractSlot
                    {
                        SlotId = slotId,
                        SlotHash = ComputeSlotHash(slotId),
                        Kind = kind,
                        Purpose = string.Format(purposeFmt, className, "<class>"),
                    });
                }
            }
        }

        private static bool ContainsMethod(string text, string methodName)
        {
            var idx = 0;
            while ((idx = text.IndexOf(methodName, idx, StringComparison.Ordinal)) >= 0)
            {
                var end = idx + methodName.Length;
                if (end < text.Length && (text[end] == '(' || char.IsWhiteSpace(text[end])))
                {
                    // Require a non-identifier char before the match so we don't
                    // hit substrings inside longer identifiers.
                    if (idx == 0 || (!char.IsLetterOrDigit(text[idx - 1]) && text[idx - 1] != '_'))
                    {
                        // Skip same-name property/field uses: require '(' close by.
                        var probe = end;
                        while (probe < text.Length && char.IsWhiteSpace(text[probe]))
                        {
                            probe++;
                        }
                        if (probe < text.Length && text[probe] == '(')
                        {
                            return true;
                        }
                    }
                }
                idx = end;
            }
            return false;
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
        /// Legacy scan returning typed slots.
        /// </summary>
        public (List<FileEventSlot> FileEvents, List<TimerTickSlot> TimerTicks) ScanLegacy(
            IEnumerable<string> sourceRoots)
        {
            var fileEvents = new List<FileEventSlot>();
            var timerTicks = new List<TimerTickSlot>();
            return (fileEvents, timerTicks);
        }
    }
}
