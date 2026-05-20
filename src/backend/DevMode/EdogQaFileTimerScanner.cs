// <copyright file="EdogQaFileTimerScanner.cs" company="Microsoft">
// Copyright (c) Microsoft Corporation. All rights reserved.
// </copyright>

#nullable disable
#pragma warning disable // DevMode-only file — suppress all warnings

namespace Microsoft.LiveTable.Service.DevMode
{
    using System.Collections.Generic;

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
        /// Scans the given source roots for file-event and timer seams.
        /// </summary>
        public (List<FileEventSlot> FileEvents, List<TimerTickSlot> TimerTicks) Scan(
            IEnumerable<string> sourceRoots)
        {
            var fileEvents = new List<FileEventSlot>();
            var timerTicks = new List<TimerTickSlot>();
            // Roslyn scanning placeholder — will be populated in M6
            return (fileEvents, timerTicks);
        }
    }
}
