// <copyright file="EdogLogModels.cs" company="Microsoft">
// Copyright (c) Microsoft Corporation. All rights reserved.
// </copyright>

#nullable disable
#pragma warning disable // DevMode-only file — suppress all warnings

namespace Microsoft.LiveTable.Service.DevMode
{
    using System;
    using System.Collections.Generic;

    /// <summary>
    /// Data model representing a log entry with associated metadata.
    /// </summary>
    public class LogEntry
    {
        public LogEntry(DateTime timestamp, string level, string message, string component, string rootActivityId, string eventId, Dictionary<string, string> customData)
        {
            this.Timestamp = timestamp;
            this.Level = level;
            this.Message = message;
            this.Component = component;
            this.RootActivityId = rootActivityId;
            this.EventId = eventId;
            this.CustomData = customData;
        }

        public DateTime Timestamp { get; }

        public string Level { get; }

        public string Message { get; }

        public string Component { get; }

        public string RootActivityId { get; }

        public string EventId { get; }

        public Dictionary<string, string> CustomData { get; }

        public string IterationId { get; set; }

        public string CodeMarkerName { get; set; }
    }

    /// <summary>
    /// Data model representing a telemetry event with performance metrics.
    /// </summary>
    public class TelemetryEvent
    {
        public TelemetryEvent(DateTime timestamp, string activityName, string activityStatus, long durationMs, string resultCode, string correlationId, Dictionary<string, string> attributes, string userId)
        {
            this.Timestamp = timestamp;
            this.ActivityName = activityName;
            this.ActivityStatus = activityStatus;
            this.DurationMs = durationMs;
            this.ResultCode = resultCode;
            this.CorrelationId = correlationId;
            this.Attributes = attributes;
            this.UserId = userId;
        }

        public DateTime Timestamp { get; }

        public string ActivityName { get; }

        public string ActivityStatus { get; }

        public long DurationMs { get; }

        public string ResultCode { get; }

        public string CorrelationId { get; }

        public Dictionary<string, string> Attributes { get; }

        public string UserId { get; }

        public string IterationId { get; set; }
    }
}
