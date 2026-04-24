// <copyright file="EdogNexusAggregator.cs" company="Microsoft">
// Copyright (c) Microsoft Corporation. All rights reserved.
// </copyright>

#nullable disable
#pragma warning disable // DevMode-only file — suppress all warnings

namespace Microsoft.LiveTable.Service.DevMode
{
    using System;
    using System.Collections.Concurrent;
    using System.Collections.Generic;
    using System.Diagnostics;
    using System.Linq;
    using System.Text.Json;
    using System.Threading;
    using System.Threading.Tasks;

    // ──────────────────────────────────────────────
    // EdgeAccumulator — per-dependency rolling state
    // ──────────────────────────────────────────────

    /// <summary>
    /// Per-dependency rolling window accumulator for Nexus edge statistics.
    /// One instance per dependency edge, keyed by <see cref="NexusDependencyId"/>.
    /// All hot-path mutations via <see cref="Interlocked"/> or append-only
    /// <see cref="ConcurrentQueue{T}"/>. No locks.
    /// </summary>
    internal sealed class EdgeAccumulator
    {
        /// <summary>Canonical dependency ID for this edge.</summary>
        public readonly string DependencyId;

        // ── Rolling window latency samples (bounded circular buffer) ──

        /// <summary>Pre-allocated sample buffer (size = MaxSamplesPerWindow).</summary>
        internal readonly double[] LatencySamples;

        /// <summary>Monotonically increasing write cursor. Slot = (WriteIndex-1) % max.</summary>
        internal int WriteIndex;

        // ── Counters (all mutated via Interlocked) ──

        /// <summary>Total primary requests in current window (excludes enrichment events).</summary>
        internal long TotalRequests;

        /// <summary>Requests with error status (4xx/5xx or exception) in current window.</summary>
        internal long ErrorCount;

        /// <summary>Events with retry context in current window.</summary>
        internal long RetryCount;

        /// <summary>Events flagged as throttled (HTTP 429/430) in current window.</summary>
        internal long ThrottleCount;

        // ── Timestamp bounds ──

        /// <summary>Start of the current rolling window.</summary>
        public DateTimeOffset WindowStart;

        /// <summary>Timestamp of most recent event ingested for this edge.</summary>
        public DateTimeOffset LastEventTime;

        // ── Baselines (updated by timer thread at window rotation) ──

        /// <summary>Exponential moving average of p50 latency across windows.</summary>
        public double BaselineP50Ms;

        /// <summary>Exponential moving average of error rate across windows.</summary>
        public double BaselineErrorRate;

        // ── Correlation ID tracking (bounded FIFO for drill-through) ──

        private readonly ConcurrentQueue<string> _recentCorrelationIds = new();
        private const int MaxCorrelationIds = 50;

        /// <summary>
        /// Initializes a new <see cref="EdgeAccumulator"/> with a pre-allocated sample buffer.
        /// </summary>
        /// <param name="dependencyId">Canonical dependency ID.</param>
        /// <param name="maxSamples">Size of the circular latency sample buffer.</param>
        public EdgeAccumulator(string dependencyId, int maxSamples)
        {
            DependencyId = dependencyId;
            LatencySamples = new double[maxSamples];
            WindowStart = DateTimeOffset.UtcNow;
            LastEventTime = DateTimeOffset.UtcNow;
        }

        /// <summary>
        /// Records a correlation ID for drill-through. Bounded FIFO — oldest evicted.
        /// Thread-safe via <see cref="ConcurrentQueue{T}"/>.
        /// </summary>
        /// <param name="correlationId">Correlation or tracking ID. Null/empty is no-op.</param>
        public void RecordCorrelationId(string correlationId)
        {
            if (string.IsNullOrEmpty(correlationId)) return;

            _recentCorrelationIds.Enqueue(correlationId);
            while (_recentCorrelationIds.Count > MaxCorrelationIds)
                _recentCorrelationIds.TryDequeue(out _);
        }

        /// <summary>
        /// Returns a snapshot of recent correlation IDs for drill-through queries.
        /// </summary>
        public string[] GetRecentCorrelationIds()
        {
            return _recentCorrelationIds.ToArray();
        }
    }

    // ──────────────────────────────────────────────
    // EdogNexusAggregator — core aggregation engine
    // ──────────────────────────────────────────────

    /// <summary>
    /// Core Nexus aggregation engine. Fuses seven source topic streams
    /// (<c>http</c>, <c>spark</c>, <c>token</c>, <c>retry</c>, <c>cache</c>,
    /// <c>fileop</c>, <c>capacity</c>) into a unified dependency-health model.
    /// Publishes <see cref="NexusSnapshot"/> to the <c>nexus</c> topic at ~1 Hz.
    /// <para>
    /// Threading model: one consumer task per source topic drains into a shared
    /// <see cref="ConcurrentDictionary{TKey, TValue}"/> of <see cref="EdgeAccumulator"/>.
    /// A dedicated timer thread computes snapshots. No lock contention on the hot path —
    /// all shared state uses lock-free concurrent collections or <see cref="Interlocked"/>.
    /// </para>
    /// <para>
    /// Lifecycle: registered in <see cref="EdogDevModeRegistrar.RegisterAll()"/>,
    /// started after <see cref="EdogTopicRouter.Initialize()"/>.
    /// Stopped via <see cref="CancellationToken"/> on server shutdown.
    /// </para>
    /// </summary>
    public static class EdogNexusAggregator
    {
        // ────────────────────────────────────────
        // Configuration constants
        // ────────────────────────────────────────

        /// <summary>Source topics the aggregator subscribes to.</summary>
        private static readonly string[] SourceTopics =
            { "http", "spark", "token", "retry", "cache", "fileop", "capacity" };

        /// <summary>Max latency samples per edge per window. Caps memory at ~16 KB/edge.</summary>
        private const int MaxSamplesPerWindow = 2000;

        /// <summary>Rolling window duration in seconds (5 minutes).</summary>
        private const int WindowDurationSec = 300;

        /// <summary>EMA smoothing factor for baseline updates at window rotation.</summary>
        private const double BaselineAlpha = 0.3;

        /// <summary>Ring buffer size for the <c>nexus</c> output topic.</summary>
        private const int NexusBufferSize = 200;

        // ── Anomaly detection thresholds ──

        private const double LatencyWarningMultiplier = 3.0;
        private const double LatencyCriticalMultiplier = 5.0;
        private const double ErrorRateWarningDelta = 0.10;
        private const double ErrorRateCriticalAbsolute = 0.50;
        private static readonly TimeSpan AlertDebounceInterval = TimeSpan.FromSeconds(30);

        // ── Health derivation thresholds (S05) ──

        private const double HealthDegradedErrorRate = 0.05;
        private const double HealthCriticalErrorRate = 0.25;
        private const double HealthDegradedBaselineDelta = 2.0;
        private const double HealthCriticalBaselineDelta = 5.0;

        /// <summary>
        /// Topics whose events are enrichment-only — they augment existing edges
        /// (retry/cache counters) without contributing to latency samples or volume.
        /// </summary>
        private static readonly HashSet<string> EnrichmentTopics =
            new(StringComparer.OrdinalIgnoreCase) { "retry", "cache" };

        // ────────────────────────────────────────
        // Shared mutable state
        // ────────────────────────────────────────

        /// <summary>Per-dependency edge accumulators. Keyed by dependency ID.</summary>
        private static readonly ConcurrentDictionary<string, EdgeAccumulator> _edges = new();

        /// <summary>Per-dependency last alert time for debounce.</summary>
        private static readonly ConcurrentDictionary<string, DateTimeOffset> _lastAlertTime = new();

        private static CancellationTokenSource _cts;
        private static Timer _snapshotTimer;
        private static bool _started;

        // ────────────────────────────────────────
        // Public API
        // ────────────────────────────────────────

        /// <summary>
        /// Starts the Nexus aggregator. Called from <see cref="EdogDevModeRegistrar"/>.
        /// Registers the <c>nexus</c> topic, spawns consumer tasks for all source topics,
        /// and starts the 1 Hz snapshot timer. Idempotent — first call wins.
        /// </summary>
        public static void Start()
        {
            if (_started) return;
            _started = true;

            try
            {
                // Register nexus output topic (idempotent — TryAdd semantics)
                EdogTopicRouter.RegisterTopic("nexus", NexusBufferSize);

                _cts = new CancellationTokenSource();
                var ct = _cts.Token;

                // Spawn one consumer task per source topic
                foreach (var topic in SourceTopics)
                {
                    _ = Task.Run(() => ConsumeTopicAsync(topic, ct), ct);
                }

                // Start snapshot timer (~1 Hz, non-reentrant by design)
                _snapshotTimer = new Timer(
                    _ => EmitSnapshot(),
                    state: null,
                    dueTime: TimeSpan.FromSeconds(1),
                    period: TimeSpan.FromSeconds(1));

                Console.WriteLine("[EDOG] Nexus aggregator started");
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[EDOG] Nexus aggregator start error: {ex.Message}");
                _started = false;
            }
        }

        /// <summary>
        /// Stops the Nexus aggregator. Cancels all consumer tasks via
        /// <see cref="CancellationTokenSource"/>, disposes the snapshot timer,
        /// and publishes a final snapshot. Idempotent.
        /// </summary>
        public static void Stop()
        {
            if (!_started) return;

            try
            {
                // Signal all consumers to stop
                _cts?.Cancel();

                // Dispose snapshot timer
                _snapshotTimer?.Dispose();
                _snapshotTimer = null;

                // Publish final snapshot before shutdown (best-effort)
                try { EmitSnapshot(); }
                catch { /* swallow — shutdown must proceed */ }

                Console.WriteLine("[EDOG] Nexus aggregator stopped");
            }
            catch (Exception ex)
            {
                Debug.WriteLine($"[EDOG] Nexus aggregator stop error: {ex.Message}");
            }
            finally
            {
                _cts?.Dispose();
                _cts = null;
                _started = false;
            }
        }

        /// <summary>
        /// Builds a snapshot of current dependency state without publishing.
        /// Exposed as <c>internal</c> for unit test validation.
        /// </summary>
        /// <returns>Current <see cref="NexusSnapshot"/>.</returns>
        internal static NexusSnapshot BuildSnapshot()
        {
            return BuildSnapshotCore();
        }

        // ────────────────────────────────────────
        // Consumer loop (one per source topic)
        // ────────────────────────────────────────

        /// <summary>
        /// Long-running consumer loop for a single source topic. Reads live events
        /// from the topic buffer, classifies and normalizes each event, and feeds
        /// into the shared <see cref="EdgeAccumulator"/> map.
        /// </summary>
        private static async Task ConsumeTopicAsync(string topic, CancellationToken ct)
        {
            while (!ct.IsCancellationRequested)
            {
                // Topic buffer may not be registered yet — retry with backoff
                var buffer = EdogTopicRouter.GetBuffer(topic);
                if (buffer == null)
                {
                    try { await Task.Delay(1000, ct); }
                    catch (OperationCanceledException) { break; }
                    continue;
                }

                try
                {
                    await foreach (var topicEvent in buffer.ReadLiveAsync(ct))
                    {
                        try
                        {
                            ProcessEvent(topic, topicEvent);
                        }
                        catch (Exception ex)
                        {
                            Debug.WriteLine($"[EDOG] Nexus event error ({topic}): {ex.Message}");
                        }
                    }
                }
                catch (OperationCanceledException) { break; }
                catch (Exception ex)
                {
                    Debug.WriteLine($"[EDOG] Nexus consumer '{topic}' error: {ex.Message}");
                    try { await Task.Delay(500, ct); }
                    catch (OperationCanceledException) { break; }
                }
            }
        }

        /// <summary>
        /// Processes a single topic event: classify → normalize → ingest.
        /// </summary>
        private static void ProcessEvent(string topic, TopicEvent topicEvent)
        {
            if (topicEvent?.Data == null) return;

            var classification = EdogNexusClassifier.Classify(topic, topicEvent.Data);
            if (string.IsNullOrEmpty(classification.DependencyId)) return;

            var normalized = NormalizeEvent(topic, topicEvent, classification);
            IngestNormalizedEvent(normalized);
        }

        // ────────────────────────────────────────
        // Event normalization
        // ────────────────────────────────────────

        /// <summary>
        /// Builds a <see cref="NexusNormalizedEvent"/> by combining classifier output
        /// with raw metric fields extracted from the event payload via JSON.
        /// </summary>
        private static NexusNormalizedEvent NormalizeEvent(
            string topic, TopicEvent topicEvent, ClassificationResult classification)
        {
            // Serialize event data once for all field extractions
            string json = null;
            try { json = JsonSerializer.Serialize(topicEvent.Data); }
            catch { /* fields will default to null/0 */ }

            var statusCode = ExtractJsonInt(json, "statusCode");
            var latencyMs = ExtractJsonDouble(json, "durationMs");

            // Latency fallback: some events use "waitDurationMs" (retry) or "elapsedMs"
            if (latencyMs <= 0)
                latencyMs = ExtractJsonDouble(json, "waitDurationMs");
            if (latencyMs <= 0)
                latencyMs = ExtractJsonDouble(json, "elapsedMs");

            // Error derivation: HTTP status >= 400 OR explicit error event
            bool isError = statusCode >= 400
                || string.Equals(ExtractJsonField(json, "event"), "Error", StringComparison.OrdinalIgnoreCase);

            // GTS operation phase from classifier endpoint hint
            string operationPhase = null;
            if (classification.EndpointHint != null && classification.EndpointHint.StartsWith("gts:"))
            {
                operationPhase = classification.EndpointHint.Substring(4) switch
                {
                    "submit" => "submit",
                    "poll" => "polling",
                    "result" => "result-fetch",
                    _ => null,
                };
            }

            return new NexusNormalizedEvent
            {
                DependencyId = classification.DependencyId,
                SourceTopic = topic,
                Timestamp = topicEvent.Timestamp,
                Method = ExtractJsonField(json, "method"),
                StatusCode = statusCode,
                LatencyMs = latencyMs,
                IsError = isError,
                IsThrottled = classification.IsThrottled || ExtractJsonBool(json, "isThrottle"),
                ThrottleType = classification.ThrottleType,
                OperationPhase = operationPhase,
                ErrorCode = classification.ErrorCode,
                ErrorSeverity = classification.ErrorSeverity,
                RetryCount = ExtractJsonInt(json, "retryAttempt"),
                CorrelationId = ExtractJsonField(json, "correlationId")
                    ?? ExtractJsonField(json, "sessionTrackingId")
                    ?? ExtractJsonField(json, "requestId"),
                EndpointHint = classification.EndpointHint,
                IterationId = ExtractJsonField(json, "iterationId"),
            };
        }

        // ────────────────────────────────────────
        // Event ingestion (hot path — lock-free)
        // ────────────────────────────────────────

        /// <summary>
        /// Feeds a normalized event into the per-dependency <see cref="EdgeAccumulator"/>.
        /// Lock-free: all mutations via <see cref="Interlocked"/> or concurrent collections.
        /// Enrichment-only events (retry/cache) update enrichment counters without
        /// contributing to latency samples or volume.
        /// </summary>
        private static void IngestNormalizedEvent(NexusNormalizedEvent evt)
        {
            var acc = _edges.GetOrAdd(evt.DependencyId,
                id => new EdgeAccumulator(id, MaxSamplesPerWindow));

            bool isEnrichment = EnrichmentTopics.Contains(evt.SourceTopic);

            if (!isEnrichment)
            {
                // Record latency sample into circular buffer
                if (evt.LatencyMs > 0)
                {
                    int idx = Interlocked.Increment(ref acc.WriteIndex) - 1;
                    int slot = ((idx % MaxSamplesPerWindow) + MaxSamplesPerWindow) % MaxSamplesPerWindow;
                    acc.LatencySamples[slot] = evt.LatencyMs;
                }

                Interlocked.Increment(ref acc.TotalRequests);

                if (evt.IsError)
                    Interlocked.Increment(ref acc.ErrorCount);
            }

            // Retry/throttle counters apply to both primary and enrichment events
            if (evt.RetryCount > 0 || evt.SourceTopic == "retry")
                Interlocked.Increment(ref acc.RetryCount);

            if (evt.IsThrottled)
                Interlocked.Increment(ref acc.ThrottleCount);

            // Record correlation ID for drill-through
            if (!string.IsNullOrEmpty(evt.CorrelationId))
                acc.RecordCorrelationId(evt.CorrelationId);

            // Volatile write — acceptable for approximate timestamp tracking
            acc.LastEventTime = DateTimeOffset.UtcNow;
        }

        // ────────────────────────────────────────
        // Snapshot emission (1 Hz timer callback)
        // ────────────────────────────────────────

        /// <summary>
        /// Timer callback: builds and publishes a <see cref="NexusSnapshot"/>,
        /// plus out-of-band alert events for fast frontend reaction.
        /// All exceptions swallowed — snapshot failures never crash the aggregator.
        /// </summary>
        private static void EmitSnapshot()
        {
            try
            {
                var snapshot = BuildSnapshotCore();
                EdogTopicRouter.Publish("nexus", snapshot);

                // Out-of-band alerts for immediate frontend toast display
                if (snapshot.Alerts != null && snapshot.Alerts.Length > 0)
                {
                    foreach (var alert in snapshot.Alerts)
                    {
                        EdogTopicRouter.Publish("nexus", new
                        {
                            type = "alert",
                            data = new
                            {
                                alert.Severity,
                                alert.DependencyId,
                                alert.Message,
                                detectedAt = alert.Timestamp.ToString("o"),
                            }
                        });
                    }
                }
            }
            catch (Exception ex)
            {
                Debug.WriteLine($"[EDOG] Nexus snapshot error: {ex.Message}");
            }
        }

        /// <summary>
        /// Core snapshot assembly. Iterates all edge accumulators, rotates windows,
        /// computes percentiles, derives health, detects anomalies, and assembles
        /// nodes + edges + alerts into a <see cref="NexusSnapshot"/>.
        /// </summary>
        private static NexusSnapshot BuildSnapshotCore()
        {
            var now = DateTimeOffset.UtcNow;
            var nodes = new List<NexusNodeInfo>
            {
                new NexusNodeInfo { Id = "flt-local", Kind = "core", Volume = 0 },
            };
            var edges = new List<NexusEdgeStats>();
            var allAlerts = new List<NexusAlert>();
            long totalVolume = 0;

            foreach (var kvp in _edges)
            {
                var acc = kvp.Value;

                try
                {
                    // Check and perform window rotation if due
                    MaybeRotateWindow(acc, now);

                    // Compute percentiles from rolling latency samples
                    var (p50, p95, p99) = ComputePercentiles(acc);

                    // Read counters (atomic reads)
                    long total = Interlocked.Read(ref acc.TotalRequests);
                    long errors = Interlocked.Read(ref acc.ErrorCount);
                    long retries = Interlocked.Read(ref acc.RetryCount);

                    // Derived metrics
                    double errorRate = total > 0 ? (double)errors / total : 0;
                    double retryRate = total > 0 ? (double)retries / total : 0;
                    double baselineDelta = acc.BaselineP50Ms > 0
                        ? p50 / acc.BaselineP50Ms : 1.0;
                    string health = DeriveHealth(errorRate, baselineDelta);

                    // Throughput: events per minute within current window span
                    double windowMinutes = Math.Max((now - acc.WindowStart).TotalMinutes, 0.001);
                    double throughput = total / windowMinutes;

                    // Build node
                    nodes.Add(new NexusNodeInfo
                    {
                        Id = acc.DependencyId,
                        Kind = "dependency",
                        Volume = (int)Math.Min(total, int.MaxValue),
                    });

                    // Build edge stats
                    edges.Add(new NexusEdgeStats
                    {
                        From = "flt-local",
                        To = acc.DependencyId,
                        Volume = (int)Math.Min(total, int.MaxValue),
                        ThroughputPerMin = Math.Round(throughput, 1),
                        P50Ms = Math.Round(p50, 1),
                        P95Ms = Math.Round(p95, 1),
                        P99Ms = Math.Round(p99, 1),
                        ErrorRate = Math.Round(errorRate, 4),
                        RetryRate = Math.Round(retryRate, 4),
                        Health = health,
                        BaselineDelta = Math.Round(baselineDelta, 2),
                    });

                    totalVolume += total;

                    // Anomaly detection against rolling baselines
                    var alerts = DetectAnomalies(
                        acc.DependencyId, p50, acc.BaselineP50Ms,
                        errorRate, acc.BaselineErrorRate);
                    allAlerts.AddRange(alerts);
                }
                catch (Exception ex)
                {
                    // Per-edge error — other edges still computed
                    Debug.WriteLine($"[EDOG] Nexus edge error ({acc.DependencyId}): {ex.Message}");
                }
            }

            // Update flt-local core node volume (sum of all edge volumes)
            nodes[0].Volume = (int)Math.Min(totalVolume, int.MaxValue);

            return new NexusSnapshot
            {
                GeneratedAt = now,
                WindowSec = WindowDurationSec,
                Nodes = nodes.ToArray(),
                Edges = edges.ToArray(),
                Alerts = allAlerts.ToArray(),
            };
        }

        // ────────────────────────────────────────
        // Percentile computation (sorted array, nearest-rank)
        // ────────────────────────────────────────

        /// <summary>
        /// Computes p50, p95, p99 latency percentiles from the edge's rolling sample buffer.
        /// Copies the valid portion of the circular buffer, sorts, and applies nearest-rank.
        /// O(n log n) where n &lt;= <see cref="MaxSamplesPerWindow"/> (2000).
        /// </summary>
        private static (double p50, double p95, double p99) ComputePercentiles(EdgeAccumulator acc)
        {
            int head = Volatile.Read(ref acc.WriteIndex);
            int count = Math.Min(Math.Max(head, 0), MaxSamplesPerWindow);
            if (count == 0)
                return (0, 0, 0);

            // Snapshot the circular buffer into a local array (point-in-time read)
            var samples = new double[count];
            for (int i = 0; i < count; i++)
            {
                int slot = ((head - count + i) % MaxSamplesPerWindow + MaxSamplesPerWindow)
                    % MaxSamplesPerWindow;
                samples[i] = acc.LatencySamples[slot];
            }

            Array.Sort(samples);

            return (
                samples[NearestRank(count, 0.50)],
                samples[NearestRank(count, 0.95)],
                samples[NearestRank(count, 0.99)]
            );
        }

        /// <summary>
        /// Nearest-rank percentile index. Returns 0-based index into a sorted array.
        /// </summary>
        private static int NearestRank(int count, double percentile)
        {
            int rank = (int)Math.Ceiling(percentile * count) - 1;
            return Math.Clamp(rank, 0, count - 1);
        }

        // ────────────────────────────────────────
        // Health derivation (threshold-based)
        // ────────────────────────────────────────

        /// <summary>
        /// Derives edge health status from error rate and latency baseline deviation.
        /// Thresholds: critical >= 0.25 error OR >= 5x baseline; degraded >= 0.05 error OR >= 2x baseline.
        /// </summary>
        /// <param name="errorRate">Error rate [0.0, 1.0].</param>
        /// <param name="baselineDelta">Current p50 / baseline p50 ratio (1.0 = normal).</param>
        /// <returns>Health status string from <see cref="NexusHealthStatus"/>.</returns>
        internal static string DeriveHealth(double errorRate, double baselineDelta)
        {
            if (errorRate >= HealthCriticalErrorRate || baselineDelta >= HealthCriticalBaselineDelta)
                return NexusHealthStatus.Critical;
            if (errorRate >= HealthDegradedErrorRate || baselineDelta >= HealthDegradedBaselineDelta)
                return NexusHealthStatus.Degraded;
            return NexusHealthStatus.Healthy;
        }

        // ────────────────────────────────────────
        // Anomaly detection (baseline-relative + debounce)
        // ────────────────────────────────────────

        /// <summary>
        /// Detects latency spikes and error-rate deviations against rolling baselines.
        /// Returns alerts to embed in the snapshot. Implements 30-second per-dependency debounce.
        /// </summary>
        private static List<NexusAlert> DetectAnomalies(
            string dependencyId, double currentP50, double baselineP50,
            double currentErrorRate, double baselineErrorRate)
        {
            var alerts = new List<NexusAlert>();
            var now = DateTimeOffset.UtcNow;

            // Debounce: suppress alerts for the same dependency within 30 seconds
            if (_lastAlertTime.TryGetValue(dependencyId, out var lastTime)
                && now - lastTime < AlertDebounceInterval)
                return alerts;

            // ── Latency spike detection ──
            if (baselineP50 > 0)
            {
                double ratio = currentP50 / baselineP50;
                if (ratio >= LatencyCriticalMultiplier)
                {
                    alerts.Add(new NexusAlert
                    {
                        Severity = "critical",
                        DependencyId = dependencyId,
                        Message = $"Latency {ratio:F1}x above baseline ({currentP50:F0}ms vs {baselineP50:F0}ms avg)",
                        Timestamp = now,
                    });
                }
                else if (ratio >= LatencyWarningMultiplier)
                {
                    alerts.Add(new NexusAlert
                    {
                        Severity = "warning",
                        DependencyId = dependencyId,
                        Message = $"Latency {ratio:F1}x above baseline ({currentP50:F0}ms vs {baselineP50:F0}ms avg)",
                        Timestamp = now,
                    });
                }
            }

            // ── Error rate deviation ──
            if (currentErrorRate >= ErrorRateCriticalAbsolute)
            {
                alerts.Add(new NexusAlert
                {
                    Severity = "critical",
                    DependencyId = dependencyId,
                    Message = $"Error rate {currentErrorRate:P0} \u2014 majority of requests failing",
                    Timestamp = now,
                });
            }
            else if (currentErrorRate - baselineErrorRate >= ErrorRateWarningDelta)
            {
                alerts.Add(new NexusAlert
                {
                    Severity = "warning",
                    DependencyId = dependencyId,
                    Message = $"Error rate increased to {currentErrorRate:P0} (baseline {baselineErrorRate:P0})",
                    Timestamp = now,
                });
            }

            // Update debounce timestamp if alerts were generated
            if (alerts.Count > 0)
                _lastAlertTime[dependencyId] = now;

            return alerts;
        }

        // ────────────────────────────────────────
        // Window rotation (5-minute EMA baseline update)
        // ────────────────────────────────────────

        /// <summary>
        /// Checks if the rolling window for an edge has expired (>= 5 minutes).
        /// If so, updates baselines via exponential moving average and resets counters.
        /// Called from the snapshot timer thread — single-writer for baseline fields.
        /// </summary>
        private static void MaybeRotateWindow(EdgeAccumulator acc, DateTimeOffset now)
        {
            if ((now - acc.WindowStart).TotalSeconds < WindowDurationSec)
                return;

            // Capture outgoing window stats before reset
            var (currentP50, _, _) = ComputePercentiles(acc);
            long total = Interlocked.Read(ref acc.TotalRequests);
            long errors = Interlocked.Read(ref acc.ErrorCount);
            double currentErrorRate = total > 0 ? (double)errors / total : 0;

            // Update p50 baseline (EMA: alpha * current + (1-alpha) * baseline)
            if (acc.BaselineP50Ms <= 0)
                acc.BaselineP50Ms = currentP50; // first window: bootstrap from initial data
            else
                acc.BaselineP50Ms = BaselineAlpha * currentP50
                    + (1 - BaselineAlpha) * acc.BaselineP50Ms;

            // Update error rate baseline
            if (acc.BaselineErrorRate <= 0 && currentErrorRate > 0)
                acc.BaselineErrorRate = currentErrorRate;
            else if (total > 0)
                acc.BaselineErrorRate = BaselineAlpha * currentErrorRate
                    + (1 - BaselineAlpha) * acc.BaselineErrorRate;

            // Reset all counters for the new window (atomic exchanges)
            Interlocked.Exchange(ref acc.TotalRequests, 0);
            Interlocked.Exchange(ref acc.ErrorCount, 0);
            Interlocked.Exchange(ref acc.RetryCount, 0);
            Interlocked.Exchange(ref acc.ThrottleCount, 0);
            Interlocked.Exchange(ref acc.WriteIndex, 0);

            acc.WindowStart = now;
        }

        // ────────────────────────────────────────
        // JSON field extraction helpers
        // Lightweight extraction from serialized event data.
        // Mirrors EdogNexusClassifier's extraction pattern.
        // ────────────────────────────────────────

        private static string ExtractJsonField(string json, string fieldName)
        {
            if (string.IsNullOrEmpty(json)) return null;
            try
            {
                using var doc = JsonDocument.Parse(json);
                if (doc.RootElement.TryGetProperty(fieldName, out var prop))
                {
                    if (prop.ValueKind == JsonValueKind.Null) return null;
                    if (prop.ValueKind == JsonValueKind.String) return prop.GetString();
                    return prop.ToString();
                }
            }
            catch { /* swallow — field extraction is best-effort */ }
            return null;
        }

        private static int ExtractJsonInt(string json, string fieldName)
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
            catch { /* swallow */ }
            return 0;
        }

        private static double ExtractJsonDouble(string json, string fieldName)
        {
            if (string.IsNullOrEmpty(json)) return 0;
            try
            {
                using var doc = JsonDocument.Parse(json);
                if (doc.RootElement.TryGetProperty(fieldName, out var prop))
                {
                    if (prop.ValueKind == JsonValueKind.Number && prop.TryGetDouble(out var val))
                        return val;
                }
            }
            catch { /* swallow */ }
            return 0;
        }

        private static bool ExtractJsonBool(string json, string fieldName)
        {
            if (string.IsNullOrEmpty(json)) return false;
            try
            {
                using var doc = JsonDocument.Parse(json);
                if (doc.RootElement.TryGetProperty(fieldName, out var prop))
                {
                    if (prop.ValueKind == JsonValueKind.True) return true;
                    if (prop.ValueKind == JsonValueKind.False) return false;
                }
            }
            catch { /* swallow */ }
            return false;
        }
    }
}
