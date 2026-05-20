// <copyright file="EdogQaDagScanner.cs" company="Microsoft">
// Copyright (c) Microsoft Corporation. All rights reserved.
// </copyright>

#nullable disable
#pragma warning disable // DevMode-only file — suppress all warnings

namespace Microsoft.LiveTable.Service.DevMode
{
    using System.Collections.Generic;

    // ═══════════════════════════════════════════════════════════════════
    // EdogQaDagScanner — Roslyn scan for [DagDefinition] DAG classes
    //
    // Converts FLT DAG declarations into stable DagTrigger slot
    // descriptors with capture topics and purpose text.
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
        /// Scans the given source roots for DAG definitions.
        /// </summary>
        public List<DagTriggerSlot> Scan(IEnumerable<string> sourceRoots)
        {
            var results = new List<DagTriggerSlot>();
            // Roslyn scanning placeholder — will be populated in M6
            return results;
        }
    }
}
