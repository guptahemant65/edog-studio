// <copyright file="EdogQaRecordingSession.cs" company="Microsoft">
// Copyright (c) Microsoft Corporation. All rights reserved.
// </copyright>

#nullable disable
#pragma warning disable // DevMode-only file — suppress all warnings

namespace Microsoft.LiveTable.Service.DevMode
{
    using System;
    using System.Collections.Generic;
    using System.Linq;
    using System.Threading;

    /// <summary>
    /// Scoped recording session for QA scenario execution.
    /// Registers observer callbacks on TopicBuffer.Write() to capture events in real-time.
    /// Additive — does NOT clear or modify topic buffers (Runtime View keeps working).
    ///
    /// Lifecycle:
    ///   1. Create() — snapshots current buffer positions, registers observers
    ///   2. (stimulus fires, interceptors publish events, observers capture them)
    ///   3. GetCapturedEvents() / GetAllCapturedEvents() — read captured data
    ///   4. Dispose() — removes observers, stamps ClosedAt
    ///
    /// Thread safety: observers fire from interceptor threads concurrently.
    /// Capture uses lock(_captured) for list mutations; _totalCaptured uses Interlocked.
    ///
    /// Performance:
    ///   - Per-event overhead: less than 1μs (List.Add under lock)
    ///   - Memory: bounded by maxEvents parameter (default 50,000)
    ///   - Dispose: less than 1ms (remove observers)
    /// </summary>
    public sealed class EdogQaRecordingSession : IDisposable
    {
        /// <summary>Back-reference to the scenario being recorded.</summary>
        public string ScenarioId { get; }

        /// <summary>Back-reference to the execution run.</summary>
        public string RunId { get; }

        /// <summary>UTC timestamp when recording started (observers attached).</summary>
        public DateTimeOffset StartedAt { get; }

        /// <summary>UTC timestamp when recording closed (observers detached). Null while active.</summary>
        public DateTimeOffset? ClosedAt { get; private set; }

        /// <summary>Total number of events captured across all topics.</summary>
        public int TotalCaptured => Interlocked.CompareExchange(ref _totalCaptured, 0, 0);

        /// <summary>True after Dispose() has been called.</summary>
        public bool IsDisposed => _disposed;

        // Per-topic sequence position at session start — events at or below this are ignored
        private readonly Dictionary<string, long> _startPositions = new();

        // Per-topic captured event lists — guarded by lock(_captured)
        private readonly Dictionary<string, List<TopicEvent>> _captured = new();

        // Observer subscriptions to dispose on close
        private readonly List<IDisposable> _subscriptions = new();

        // Memory cap — observer stops capturing beyond this limit
        private readonly int _maxEvents;

        // Atomic counter for total captured events across all topics
        private int _totalCaptured;

        // Dispose guard — volatile so observer callbacks see it immediately
        private volatile bool _disposed;

        private EdogQaRecordingSession(string scenarioId, string runId, int maxEvents)
        {
            ScenarioId = scenarioId;
            RunId = runId ?? string.Empty;
            StartedAt = DateTimeOffset.UtcNow;
            _maxEvents = maxEvents;
        }

        /// <summary>
        /// Creates and starts a recording session for the given topics.
        /// Snapshots each topic buffer's current position, then attaches observers
        /// that capture all subsequent events until Dispose().
        /// </summary>
        /// <param name="scenarioId">Scenario ID — tags all captured events.</param>
        /// <param name="topics">Topic names to observe (e.g., "log", "http", "telemetry").</param>
        /// <param name="runId">Optional run ID for correlation.</param>
        /// <param name="maxEvents">Maximum total events to capture (memory cap). Default 50,000.</param>
        /// <returns>An active recording session with observers attached.</returns>
        public static EdogQaRecordingSession Create(
            string scenarioId,
            string[] topics,
            string runId = "",
            int maxEvents = 50_000)
        {
            if (string.IsNullOrEmpty(scenarioId))
                throw new ArgumentException("ScenarioId is required.", nameof(scenarioId));
            if (topics == null || topics.Length == 0)
                throw new ArgumentException("At least one topic is required.", nameof(topics));

            var session = new EdogQaRecordingSession(scenarioId, runId, maxEvents);

            foreach (var topic in topics)
            {
                if (string.IsNullOrEmpty(topic)) continue;

                var buffer = EdogTopicRouter.GetBuffer(topic);
                if (buffer == null) continue;

                // Snapshot current position — only events AFTER this point belong to us
                var snapshot = buffer.GetSnapshot();
                long lastSeqId = snapshot.Length > 0 ? snapshot[^1].SequenceId : 0;
                session._startPositions[topic] = lastSeqId;
                session._captured[topic] = new List<TopicEvent>();

                // Attach observer — fires synchronously on every Write()
                var topicCapture = topic; // closure capture
                var sub = buffer.AddObserver(evt =>
                {
                    // Session already disposed — skip to avoid race with Dispose()
                    if (session._disposed) return;

                    // Before our recording window
                    if (evt.SequenceId <= session._startPositions[topicCapture])
                        return;

                    // Memory cap reached
                    if (Interlocked.CompareExchange(ref session._totalCaptured, 0, 0) >= session._maxEvents)
                        return;

                    lock (session._captured)
                    {
                        session._captured[topicCapture].Add(evt);
                        Interlocked.Increment(ref session._totalCaptured);
                    }
                });
                session._subscriptions.Add(sub);
            }

            return session;
        }

        /// <summary>
        /// Returns captured events for a specific topic, ordered by sequence ID.
        /// Returns empty list if topic was not observed or has no events.
        /// </summary>
        /// <param name="topic">Topic name.</param>
        public IReadOnlyList<TopicEvent> GetCapturedEvents(string topic)
        {
            if (string.IsNullOrEmpty(topic)) return Array.Empty<TopicEvent>();

            lock (_captured)
            {
                return _captured.TryGetValue(topic, out var list)
                    ? list.ToList().AsReadOnly()
                    : Array.Empty<TopicEvent>();
            }
        }

        /// <summary>
        /// Returns all captured events across all topics, ordered by timestamp.
        /// </summary>
        public IReadOnlyList<TopicEvent> GetAllCapturedEvents()
        {
            lock (_captured)
            {
                return _captured.Values
                    .SelectMany(list => list)
                    .OrderBy(e => e.Timestamp)
                    .ThenBy(e => e.SequenceId)
                    .ToList()
                    .AsReadOnly();
            }
        }

        /// <summary>
        /// Returns the set of topics this session is observing.
        /// </summary>
        public IReadOnlyCollection<string> ObservedTopics
        {
            get
            {
                lock (_captured)
                {
                    return _captured.Keys.ToList().AsReadOnly();
                }
            }
        }

        /// <summary>
        /// Detaches all observers and stamps ClosedAt. Safe to call multiple times.
        /// After dispose, no more events are captured but captured data remains readable.
        /// </summary>
        public void Dispose()
        {
            if (_disposed) return;
            _disposed = true;
            ClosedAt = DateTimeOffset.UtcNow;

            foreach (var sub in _subscriptions)
                sub.Dispose();
            _subscriptions.Clear();
        }
    }
}
