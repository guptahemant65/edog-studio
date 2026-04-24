// <copyright file="EdogNexusModels.cs" company="Microsoft">
// Copyright (c) Microsoft Corporation. All rights reserved.
// </copyright>

#nullable disable
#pragma warning disable // DevMode-only file — suppress all warnings

namespace Microsoft.LiveTable.Service.DevMode
{
    using System;
    using System.Collections.Generic;
    using System.Text.RegularExpressions;

    // ──────────────────────────────────────────────
    // NexusDependencyId — Canonical dependency identifiers
    // ──────────────────────────────────────────────

    /// <summary>
    /// Canonical dependency identifiers for the Nexus dependency graph (V1).
    /// String constants — not an enum — for safe JSON serialization and forward extensibility.
    /// </summary>
    public static class NexusDependencyId
    {
        /// <summary>Spark sessions via GTS (Livy).</summary>
        public const string SparkGts = "spark-gts";

        /// <summary>Fabric public REST APIs.</summary>
        public const string FabricApi = "fabric-api";

        /// <summary>FLT service APIs via capacity relay host.</summary>
        public const string PlatformApi = "platform-api";

        /// <summary>Token acquisition (AAD/Entra/MWC).</summary>
        public const string Auth = "auth";

        /// <summary>Capacity management APIs (HTTP 430 or URL match).</summary>
        public const string Capacity = "capacity";

        /// <summary>Cache operations.</summary>
        public const string Cache = "cache";

        /// <summary>Retry telemetry (enrichment).</summary>
        public const string RetrySystem = "retry-system";

        /// <summary>File I/O via OneLake.</summary>
        public const string Filesystem = "filesystem";

        /// <summary>DAG orchestration engine (execution hooks, node scheduling).</summary>
        public const string DagOrchestrator = "dag-orchestrator";

        /// <summary>FLT operations subsystems (refresh triggers, MLV definitions, DQ reports, maintenance).</summary>
        public const string FltOperations = "flt-operations";

        /// <summary>Unmatched HTTP events.</summary>
        public const string Unknown = "unknown";

        /// <summary>All known IDs for validation and iteration.</summary>
        public static readonly string[] All = new[]
        {
            SparkGts, FabricApi, PlatformApi, Auth, Capacity,
            Cache, RetrySystem, Filesystem, DagOrchestrator, FltOperations, Unknown,
        };
    }

    // ──────────────────────────────────────────────
    // NexusHealthStatus — Edge health classification
    // ──────────────────────────────────────────────

    /// <summary>
    /// Health status for a Nexus dependency edge.
    /// String constants for JSON serialization stability.
    /// </summary>
    public static class NexusHealthStatus
    {
        /// <summary>Within baseline tolerances.</summary>
        public const string Healthy = "healthy";

        /// <summary>Latency or error rate above warning threshold.</summary>
        public const string Degraded = "degraded";

        /// <summary>Sustained errors, extreme latency, or throttle storm.</summary>
        public const string Critical = "critical";
    }

    // ──────────────────────────────────────────────
    // NexusNormalizedEvent — Internal reducer input
    // ──────────────────────────────────────────────

    /// <summary>
    /// Normalized event — internal reducer input for the Nexus aggregator.
    /// One per source-topic event, classified and flattened into a canonical shape.
    /// </summary>
    public sealed class NexusNormalizedEvent
    {
        /// <summary>Canonical dependency ID (from <see cref="NexusDependencyId"/>).</summary>
        public string DependencyId { get; set; }

        /// <summary>Originating topic name (http, spark, token, retry, cache, fileop).</summary>
        public string SourceTopic { get; set; }

        /// <summary>UTC timestamp of the original event.</summary>
        public DateTimeOffset Timestamp { get; set; }

        /// <summary>HTTP method (GET, POST, etc.) or null for non-HTTP events.</summary>
        public string Method { get; set; }

        /// <summary>HTTP status code, or 0 for non-HTTP events.</summary>
        public int StatusCode { get; set; }

        /// <summary>Latency in milliseconds. 0 if not applicable.</summary>
        public double LatencyMs { get; set; }

        /// <summary>True if the event represents an error condition.</summary>
        public bool IsError { get; set; }

        /// <summary>
        /// True if the event represents a throttling response (HTTP 429 or 430).
        /// Enables the aggregator to distinguish throttle storms from other errors.
        /// </summary>
        public bool IsThrottled { get; set; }

        /// <summary>
        /// Throttle classification: "capacity-430" for GTS capacity throttling (HTTP 430),
        /// "rate-limit-429" for standard rate limiting (HTTP 429), or null if not throttled.
        /// </summary>
        public string ThrottleType { get; set; }

        /// <summary>
        /// GTS operation phase for spark-gts events: "submit" (POST/PUT to /transforms/),
        /// "polling" (GET /transforms/{id}), "result-fetch" (GET /transforms/{id}/result),
        /// or null for non-GTS events. Enables the aggregator to track polling count per
        /// transform, average polling interval, and total polling duration.
        /// </summary>
        public string OperationPhase { get; set; }

        /// <summary>
        /// FLT error code extracted from HTTP response body (e.g., "SPARK_SESSION_ACQUISITION_FAILED",
        /// "MV_NOT_FOUND", "CONCURRENT_REFRESH"). Null if no error or error code not parseable.
        /// See <see cref="NexusErrorClassification"/> for the known error taxonomy.
        /// </summary>
        public string ErrorCode { get; set; }

        /// <summary>
        /// Severity classification of the error: "user" (no retry, user must fix),
        /// "system" (retry up to 3x, engineering attention), "transient" (exponential backoff,
        /// self-healing expected), or null if no error. Derived from ErrorCode via
        /// <see cref="NexusErrorClassification.Classify"/>.
        /// </summary>
        public string ErrorSeverity { get; set; }

        /// <summary>Retry attempt count from retry enrichment. 0 if no retry.</summary>
        public int RetryCount { get; set; }

        /// <summary>Correlation ID from HTTP headers, or null.</summary>
        public string CorrelationId { get; set; }

        /// <summary>Redacted URL path or operation descriptor for drill-through context.</summary>
        public string EndpointHint { get; set; }

        /// <summary>FLT iteration ID for DAG correlation, or null.</summary>
        public string IterationId { get; set; }
    }

    // ──────────────────────────────────────────────
    // NexusErrorClassification — FLT error code taxonomy
    // ──────────────────────────────────────────────

    /// <summary>
    /// Maps FLT error codes to severity classifications.
    /// Used by EdogNexusClassifier to populate ErrorSeverity on NexusNormalizedEvent.
    /// </summary>
    public static class NexusErrorClassification
    {
        /// <summary>Configuration error, permissions, missing artifacts — user must fix. No retry.</summary>
        public const string User = "user";

        /// <summary>Internal failure, data corruption — engineering attention needed. Retry up to 3x.</summary>
        public const string System = "system";

        /// <summary>Temporary capacity/rate issue — self-healing expected. Exponential backoff.</summary>
        public const string Transient = "transient";

        /// <summary>Known FLT error code to severity mappings.</summary>
        private static readonly Dictionary<string, string> KnownErrors = new(StringComparer.OrdinalIgnoreCase)
        {
            // User errors — no retry, user must fix
            ["MV_NOT_FOUND"] = User,
            ["SOURCE_ENTITIES_UNDEFINED"] = User,
            ["CONCURRENT_REFRESH"] = User,
            ["ACCESS_DENIED"] = User,

            // System errors — retry up to 3x, engineering attention
            ["SOURCE_ENTITIES_CORRUPTED"] = System,
            ["SOURCE_ENTITIES_MISSING"] = System,
            ["SYSTEM_ERROR"] = System,
            ["MLV_RESULTCODE_NOT_FOUND"] = System,

            // Transient errors — exponential backoff, self-healing
            ["SPARK_SESSION_ACQUISITION_FAILED"] = Transient,
            ["TOO_MANY_REQUESTS"] = Transient,
            ["SPARK_JOB_CAPACITY_THROTTLING"] = Transient,
        };

        /// <summary>
        /// Regex to extract FLT error codes from response body previews.
        /// Matches prefixed codes (FLT_xxx, FMLV_xxx, MLV_xxx) and known bare codes.
        /// </summary>
        internal static readonly Regex ErrorCodePattern = new(
            @"\b((?:FLT|FMLV|MLV)_[A-Z_]+|MV_NOT_FOUND|SOURCE_ENTITIES_\w+|CONCURRENT_REFRESH|ACCESS_DENIED|SYSTEM_ERROR|SPARK_SESSION_ACQUISITION_FAILED|SPARK_JOB_CAPACITY_THROTTLING|TOO_MANY_REQUESTS|MLV_RESULTCODE_NOT_FOUND)\b",
            RegexOptions.Compiled);

        /// <summary>
        /// Returns the severity for a known error code, or null for unrecognized codes.
        /// </summary>
        /// <param name="errorCode">FLT error code string.</param>
        /// <returns>Severity string ("user", "system", "transient") or null.</returns>
        public static string Classify(string errorCode)
        {
            if (string.IsNullOrEmpty(errorCode)) return null;
            return KnownErrors.TryGetValue(errorCode, out var severity) ? severity : null;
        }
    }

    // ──────────────────────────────────────────────
    // NexusEdgeStats — Per-edge rolling statistics
    // ──────────────────────────────────────────────

    /// <summary>
    /// Per-edge rolling statistics for a dependency in the Nexus graph.
    /// Published as part of <see cref="NexusSnapshot.Edges"/>.
    /// </summary>
    public sealed class NexusEdgeStats
    {
        /// <summary>Source node ID. Always "flt-local" in V1 (hub-spoke topology).</summary>
        public string From { get; set; }

        /// <summary>Target dependency ID (from <see cref="NexusDependencyId"/>).</summary>
        public string To { get; set; }

        /// <summary>Total event count in the current window.</summary>
        public int Volume { get; set; }

        /// <summary>Events per minute in the current window.</summary>
        public double ThroughputPerMin { get; set; }

        /// <summary>Median latency in milliseconds.</summary>
        public double P50Ms { get; set; }

        /// <summary>95th percentile latency in milliseconds.</summary>
        public double P95Ms { get; set; }

        /// <summary>99th percentile latency in milliseconds.</summary>
        public double P99Ms { get; set; }

        /// <summary>Error rate as a ratio [0.0, 1.0].</summary>
        public double ErrorRate { get; set; }

        /// <summary>Retry rate as a ratio [0.0, 1.0] (events with RetryCount > 0 / total).</summary>
        public double RetryRate { get; set; }

        /// <summary>Current p95 / baseline p95 ratio. 1.0 = at baseline.</summary>
        public double BaselineDelta { get; set; }

        /// <summary>Computed health status for this edge.</summary>
        public string Health { get; set; }
    }

    // ──────────────────────────────────────────────
    // NexusNodeInfo — Per-node metadata
    // ──────────────────────────────────────────────

    /// <summary>
    /// Per-node metadata for the Nexus dependency graph.
    /// Published as part of <see cref="NexusSnapshot.Nodes"/>.
    /// </summary>
    public sealed class NexusNodeInfo
    {
        /// <summary>Node identifier ("flt-local" or a <see cref="NexusDependencyId"/> value).</summary>
        public string Id { get; set; }

        /// <summary>Node kind: "core" for FLT local, "dependency" for external services.</summary>
        public string Kind { get; set; }

        /// <summary>Total event volume in the current window (drives node size).</summary>
        public int Volume { get; set; }
    }

    // ──────────────────────────────────────────────
    // NexusAlert — Anomaly alert
    // ──────────────────────────────────────────────

    /// <summary>
    /// Anomaly alert generated by the Nexus aggregator when a dependency's
    /// metrics cross health thresholds.
    /// </summary>
    public sealed class NexusAlert
    {
        /// <summary>Alert severity: "warning" or "critical".</summary>
        public string Severity { get; set; }

        /// <summary>Affected dependency ID.</summary>
        public string DependencyId { get; set; }

        /// <summary>Human-readable alert message for toast/UI display.</summary>
        public string Message { get; set; }

        /// <summary>UTC timestamp when the alert was generated.</summary>
        public DateTimeOffset Timestamp { get; set; }
    }

    // ──────────────────────────────────────────────
    // NexusSnapshot — Full graph snapshot for nexus topic
    // ──────────────────────────────────────────────

    /// <summary>
    /// Complete Nexus graph snapshot published to the "nexus" topic.
    /// Frontend replaces entire graph state on each received snapshot.
    /// </summary>
    public sealed class NexusSnapshot
    {
        /// <summary>UTC timestamp when this snapshot was generated.</summary>
        public DateTimeOffset GeneratedAt { get; set; }

        /// <summary>Rolling window size in seconds (e.g., 300).</summary>
        public int WindowSec { get; set; }

        /// <summary>All active nodes in the dependency graph.</summary>
        public NexusNodeInfo[] Nodes { get; set; }

        /// <summary>All active edges with per-edge statistics.</summary>
        public NexusEdgeStats[] Edges { get; set; }

        /// <summary>Active anomaly alerts (may be empty).</summary>
        public NexusAlert[] Alerts { get; set; }
    }
}
