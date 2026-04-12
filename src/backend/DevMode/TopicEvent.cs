// <copyright file="TopicEvent.cs" company="Microsoft">
// Copyright (c) Microsoft Corporation. All rights reserved.
// </copyright>

#nullable disable
#pragma warning disable // DevMode-only file — suppress all warnings

namespace Microsoft.LiveTable.Service.DevMode
{
    using System;

    /// <summary>
    /// Universal event envelope for all EDOG topic streams.
    /// Every interceptor publishes through this — sequenceId is monotonic per topic,
    /// enabling gap detection on the client side.
    /// </summary>
    public sealed class TopicEvent
    {
        /// <summary>Monotonic sequence number per topic (gap = dropped events).</summary>
        public long SequenceId { get; set; }

        /// <summary>UTC timestamp when the event was published.</summary>
        public DateTimeOffset Timestamp { get; set; }

        /// <summary>Topic name (log, telemetry, flag, perf, token, etc.).</summary>
        public string Topic { get; set; }

        /// <summary>Topic-specific payload (LogEntry, TelemetryEvent, anonymous object, etc.).</summary>
        public object Data { get; set; }
    }
}
