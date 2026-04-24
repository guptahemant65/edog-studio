// <copyright file="EdogNexusClassifier.cs" company="Microsoft">
// Copyright (c) Microsoft Corporation. All rights reserved.
// </copyright>

#nullable disable
#pragma warning disable // DevMode-only file — suppress all warnings

namespace Microsoft.LiveTable.Service.DevMode
{
    using System;
    using System.Diagnostics;
    using System.Text.Json;
    using System.Text.RegularExpressions;

    // ──────────────────────────────────────────────
    // ClassificationResult — Classify() return value
    // ──────────────────────────────────────────────

    /// <summary>
    /// Result of classifying a single event into a canonical dependency.
    /// Readonly struct — stack-allocated, zero GC pressure on the hot path.
    /// </summary>
    public readonly struct ClassificationResult
    {
        /// <summary>Canonical dependency ID (from <see cref="NexusDependencyId"/>).</summary>
        public string DependencyId { get; init; }

        /// <summary>Redacted URL path or operation descriptor for drill-through context.</summary>
        public string EndpointHint { get; init; }

        /// <summary>True if this dependency is internal (e.g., filesystem — hidden by default).</summary>
        public bool IsInternal { get; init; }

        /// <summary>True if the event represents a throttling response (HTTP 429 or 430).</summary>
        public bool IsThrottled { get; init; }

        /// <summary>
        /// Throttle classification: "capacity-430", "rate-limit-429", or null.
        /// </summary>
        public string ThrottleType { get; init; }

        /// <summary>FLT error code extracted from response body, or null.</summary>
        public string ErrorCode { get; init; }

        /// <summary>Severity of the error code ("user", "system", "transient"), or null.</summary>
        public string ErrorSeverity { get; init; }
    }

    // ──────────────────────────────────────────────
    // EdogNexusClassifier — Pure stateless classifier
    // ──────────────────────────────────────────────

    /// <summary>
    /// Pure classifier: maps raw topic events to canonical dependency IDs.
    /// Stateless — safe to call from any thread without synchronization.
    /// </summary>
    public static class EdogNexusClassifier
    {
        // ── URL patterns (compiled, static) ──
        // Order in UrlRules matters — more specific patterns first.

        // 1. Auth / token endpoints
        private static readonly Regex AuthPattern = new(
            @"/(generatemwctoken|oauth2/v2\.0/token|token)(\?|$|/)",
            RegexOptions.Compiled | RegexOptions.IgnoreCase);

        // 2. Spark/GTS — Livy session management
        private static readonly Regex SparkGtsPattern = new(
            @"/(livy|livysessions|spark|sparkSessions)/",
            RegexOptions.Compiled | RegexOptions.IgnoreCase);

        // 3. Notebook execution (Jupyter/Livy — sub-category of spark-gts)
        private static readonly Regex NotebookPattern = new(
            @"/(notebooks?|jupyter)/",
            RegexOptions.Compiled | RegexOptions.IgnoreCase);

        // 4. Platform APIs via capacity relay host (FLT service endpoints)
        private static readonly Regex PlatformApiPattern = new(
            @"(pbidedicated|powerbi-df).*/(webapi|liveTable|liveTableSchedule)/",
            RegexOptions.Compiled | RegexOptions.IgnoreCase);

        // 5. Capacity management
        private static readonly Regex CapacityPattern = new(
            @"/capacities/[0-9a-fA-F-]+/(workloads|)",
            RegexOptions.Compiled | RegexOptions.IgnoreCase);

        // 6. Fabric public REST APIs
        private static readonly Regex FabricApiPattern = new(
            @"(api\.fabric\.microsoft\.com|/api/fabric)/(v1/)?(workspaces|lakehouses|notebooks|environments|items)",
            RegexOptions.Compiled | RegexOptions.IgnoreCase);

        // URL rules: evaluated in order — first match wins
        private static readonly (Regex Pattern, string DependencyId)[] UrlRules =
        {
            (AuthPattern, NexusDependencyId.Auth),
            (SparkGtsPattern, NexusDependencyId.SparkGts),
            (NotebookPattern, NexusDependencyId.SparkGts),
            (PlatformApiPattern, NexusDependencyId.PlatformApi),
            (CapacityPattern, NexusDependencyId.Capacity),
            (FabricApiPattern, NexusDependencyId.FabricApi),
        };

        // ── GTS phase detection patterns ──

        // Result fetch: GET /transforms/{id}/result or /livysessions/{id}/result
        private static readonly Regex GtsResultPattern = new(
            @"/(transforms|livysessions)/[^/]+/result",
            RegexOptions.Compiled | RegexOptions.IgnoreCase);

        // Status poll: GET /transforms/{guid} or /livysessions/{id}/statements/{n}
        private static readonly Regex GtsPollPattern = new(
            @"/(transforms|livysessions)/[0-9a-fA-F-]+(/statements/\d+)?$",
            RegexOptions.Compiled | RegexOptions.IgnoreCase);

        // ── URL signature normalization patterns ──

        // GUID pattern: 8-4-4-4-12 hex or 32 hex (no dashes)
        private static readonly Regex GuidPattern = new(
            @"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|[0-9a-fA-F]{32}",
            RegexOptions.Compiled);

        // Numeric path segments (e.g., /statements/123)
        private static readonly Regex NumericSegment = new(
            @"(?<=/)(\d{2,})(?=/|$|\?)",
            RegexOptions.Compiled);

        private const int MaxSignatureLength = 256;

        // ────────────────────────────────────────
        // Public API
        // ────────────────────────────────────────

        /// <summary>
        /// Classifies an event from any topic into a canonical dependency.
        /// Never throws — returns "unknown" on any unexpected failure.
        /// </summary>
        /// <param name="topic">Source topic name ("http", "token", "spark", etc.).</param>
        /// <param name="eventData">Raw event payload from TopicEvent.Data.</param>
        /// <returns>Classification result with dependency ID, endpoint hint, and flags.</returns>
        public static ClassificationResult Classify(string topic, object eventData)
        {
            try
            {
                if (string.IsNullOrEmpty(topic))
                {
                    return new ClassificationResult
                    {
                        DependencyId = NexusDependencyId.Unknown,
                        EndpointHint = string.Empty,
                    };
                }

                if (topic == "http")
                    return ClassifyHttp(eventData);

                return ClassifyByTopic(topic, eventData);
            }
            catch (Exception ex)
            {
                Debug.WriteLine($"[EDOG] NexusClassifier error: {ex.Message}");
                return new ClassificationResult
                {
                    DependencyId = NexusDependencyId.Unknown,
                    EndpointHint = topic ?? "error",
                };
            }
        }

        /// <summary>
        /// Extracts a normalized URL signature for unknown-bucket tracking.
        /// Replaces GUIDs and numeric IDs with placeholders.
        /// Example: "/v1/workspaces/{id}/items/{n}" from a real URL.
        /// </summary>
        /// <param name="url">Raw URL string.</param>
        /// <returns>Normalized path signature, or "empty" for null/empty input.</returns>
        internal static string ExtractUrlSignature(string url)
        {
            if (string.IsNullOrEmpty(url)) return "empty";

            try
            {
                // Strip query string
                var pathOnly = url.Contains('?') ? url[..url.IndexOf('?')] : url;

                // Strip protocol + host
                var pathStart = pathOnly.IndexOf("//");
                if (pathStart >= 0)
                {
                    var hostEnd = pathOnly.IndexOf('/', pathStart + 2);
                    pathOnly = hostEnd >= 0 ? pathOnly[hostEnd..] : "/";
                }

                // Replace GUIDs and numeric IDs
                pathOnly = GuidPattern.Replace(pathOnly, "{id}");
                pathOnly = NumericSegment.Replace(pathOnly, "{n}");

                // Truncate to max length
                if (pathOnly.Length > MaxSignatureLength)
                    pathOnly = pathOnly[..MaxSignatureLength];

                return pathOnly;
            }
            catch
            {
                return "empty";
            }
        }

        /// <summary>
        /// Extracts error code and severity from an HTTP event with status >= 400.
        /// Best-effort — returns (null, null) if no FLT error code is found.
        /// </summary>
        /// <param name="json">Cached JSON string of the event data.</param>
        /// <param name="statusCode">HTTP status code.</param>
        /// <returns>Tuple of (errorCode, errorSeverity) or (null, null).</returns>
        internal static (string ErrorCode, string ErrorSeverity) ExtractErrorInfo(string json, int statusCode)
        {
            if (statusCode < 400) return (null, null);

            var bodyPreview = ExtractFieldFromJson(json, "responseBodyPreview");
            if (string.IsNullOrEmpty(bodyPreview)) return (null, null);

            var match = NexusErrorClassification.ErrorCodePattern.Match(bodyPreview);
            if (!match.Success) return (null, null);

            var errorCode = match.Groups[1].Value;
            var severity = NexusErrorClassification.Classify(errorCode);
            return (errorCode, severity);
        }

        // ────────────────────────────────────────
        // HTTP classification
        // ────────────────────────────────────────

        private static ClassificationResult ClassifyHttp(object eventData)
        {
            // Serialize once — reuse cached JSON for all field extractions
            var json = SerializeToJson(eventData);
            var url = ExtractFieldFromJson(json, "url") ?? string.Empty;
            var statusCode = ExtractIntFieldFromJson(json, "statusCode");
            var method = ExtractFieldFromJson(json, "method") ?? string.Empty;
            var endpointHint = ExtractPathOnly(url);

            // ── PRIORITY 0: HTTP 430 = capacity throttling (before URL patterns) ──
            // HTTP 430 is FLT's canonical "Spark Job Capacity Throttling" signal.
            // When GTS returns 430, it means the capacity management system rejected
            // the request — regardless of what URL was called.
            if (statusCode == 430)
            {
                var (errCode430, errSev430) = ExtractErrorInfo(json, statusCode);
                return new ClassificationResult
                {
                    DependencyId = NexusDependencyId.Capacity,
                    EndpointHint = endpointHint,
                    IsInternal = false,
                    IsThrottled = true,
                    ThrottleType = "capacity-430",
                    ErrorCode = errCode430,
                    ErrorSeverity = errSev430,
                };
            }

            // ── URL pattern matching (first match wins) ──
            foreach (var (pattern, depId) in UrlRules)
            {
                if (pattern.IsMatch(url))
                {
                    var result = new ClassificationResult
                    {
                        DependencyId = depId,
                        EndpointHint = endpointHint,
                        IsInternal = false,
                    };

                    // Enrich with throttle info for 429 (rate limiting on any dependency)
                    if (statusCode == 429)
                    {
                        result = result with
                        {
                            IsThrottled = true,
                            ThrottleType = "rate-limit-429",
                        };
                    }

                    // Enrich spark-gts events with GTS polling phase detection
                    if (depId == NexusDependencyId.SparkGts)
                    {
                        result = result with
                        {
                            EndpointHint = DeriveGtsPhaseHint(method, url, endpointHint),
                        };
                    }

                    // Enrich error events with error code extraction
                    if (statusCode >= 400)
                    {
                        var (errCode, errSev) = ExtractErrorInfo(json, statusCode);
                        result = result with
                        {
                            ErrorCode = errCode,
                            ErrorSeverity = errSev,
                        };
                    }

                    return result;
                }
            }

            // No match — falls to unknown
            var (unknownErrCode, unknownErrSev) = statusCode >= 400
                ? ExtractErrorInfo(json, statusCode)
                : (null, null);

            return new ClassificationResult
            {
                DependencyId = NexusDependencyId.Unknown,
                EndpointHint = ExtractUrlSignature(url),
                IsInternal = false,
                IsThrottled = statusCode == 429,
                ThrottleType = statusCode == 429 ? "rate-limit-429" : null,
                ErrorCode = unknownErrCode,
                ErrorSeverity = unknownErrSev,
            };
        }

        // ────────────────────────────────────────
        // Topic-based classification
        // ────────────────────────────────────────

        private static ClassificationResult ClassifyByTopic(string topic, object eventData)
        {
            var (depId, isInternal) = topic switch
            {
                "token" => (NexusDependencyId.Auth, false),
                "spark" => (NexusDependencyId.SparkGts, false),
                "cache" => (NexusDependencyId.Cache, false),
                "retry" => (NexusDependencyId.RetrySystem, false),
                "fileop" => (NexusDependencyId.Filesystem, true),
                "capacity" => (NexusDependencyId.Capacity, false),
                _ => (NexusDependencyId.Unknown, false),
            };

            return new ClassificationResult
            {
                DependencyId = depId,
                EndpointHint = ExtractTopicHint(topic, eventData),
                IsInternal = isInternal,
            };
        }

        // ────────────────────────────────────────
        // GTS polling phase detection (Gap 5)
        // ────────────────────────────────────────

        private static string DeriveGtsPhaseHint(string method, string url, string defaultHint)
        {
            var upperMethod = method?.ToUpperInvariant();

            // POST/PUT to /transforms/ or /livysessions/ = submit
            if (upperMethod is "POST" or "PUT")
                return "gts:submit";

            if (upperMethod == "GET")
            {
                // GET /transforms/{id}/result = result fetch
                if (GtsResultPattern.IsMatch(url))
                    return "gts:result";

                // GET /transforms/{id} (status poll)
                if (GtsPollPattern.IsMatch(url))
                    return "gts:poll";
            }

            return defaultHint;
        }

        // ────────────────────────────────────────
        // Topic hint extraction
        // ────────────────────────────────────────

        private static string ExtractTopicHint(string topic, object eventData)
        {
            if (eventData == null) return topic;

            var json = SerializeToJson(eventData);
            if (json == null) return topic;

            return topic switch
            {
                "token" => ExtractFieldFromJson(json, "endpoint") ?? "token-acquisition",
                "spark" => ExtractFieldFromJson(json, "sessionTrackingId") ?? "spark-session",
                "cache" => ExtractFieldFromJson(json, "cacheName") ?? "cache-op",
                "retry" => ExtractFieldFromJson(json, "endpoint") ?? "retry",
                "fileop" => BuildFileopHint(json),
                _ => topic,
            };
        }

        private static string BuildFileopHint(string json)
        {
            var operation = ExtractFieldFromJson(json, "operation") ?? "unknown";
            var path = TruncatePath(ExtractFieldFromJson(json, "path"));
            return operation + ":" + path;
        }

        private static string TruncatePath(string path)
        {
            if (string.IsNullOrEmpty(path)) return string.Empty;
            // Show last 2 segments
            var lastSlash = path.LastIndexOf('/');
            if (lastSlash <= 0) return path;
            var secondLast = path.LastIndexOf('/', lastSlash - 1);
            return secondLast >= 0 ? "..." + path[secondLast..] : path;
        }

        // ────────────────────────────────────────
        // URL path extraction
        // ────────────────────────────────────────

        private static string ExtractPathOnly(string url)
        {
            if (string.IsNullOrEmpty(url)) return string.Empty;

            try
            {
                // Strip query string
                var pathOnly = url.Contains('?') ? url[..url.IndexOf('?')] : url;

                // Strip protocol + host
                var pathStart = pathOnly.IndexOf("//");
                if (pathStart >= 0)
                {
                    var hostEnd = pathOnly.IndexOf('/', pathStart + 2);
                    pathOnly = hostEnd >= 0 ? pathOnly[hostEnd..] : "/";
                }

                return pathOnly;
            }
            catch
            {
                return url;
            }
        }

        // ────────────────────────────────────────
        // Field extraction from anonymous objects via System.Text.Json
        // ────────────────────────────────────────

        private static string SerializeToJson(object data)
        {
            if (data == null) return null;
            try
            {
                return JsonSerializer.Serialize(data);
            }
            catch
            {
                return null;
            }
        }

        private static string ExtractFieldFromJson(string json, string fieldName)
        {
            if (string.IsNullOrEmpty(json)) return null;
            try
            {
                using var doc = JsonDocument.Parse(json);
                if (doc.RootElement.TryGetProperty(fieldName, out var prop))
                {
                    if (prop.ValueKind == JsonValueKind.Null)
                        return null;
                    if (prop.ValueKind == JsonValueKind.String)
                        return prop.GetString();
                    return prop.ToString();
                }
            }
            catch { }

            return null;
        }

        private static int ExtractIntFieldFromJson(string json, string fieldName)
        {
            if (string.IsNullOrEmpty(json)) return 0;
            try
            {
                using var doc = JsonDocument.Parse(json);
                if (doc.RootElement.TryGetProperty(fieldName, out var prop))
                {
                    if (prop.ValueKind == JsonValueKind.Number && prop.TryGetInt32(out var val))
                        return val;
                }
            }
            catch { }

            return 0;
        }
    }
}
