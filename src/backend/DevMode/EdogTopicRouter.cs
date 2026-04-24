// <copyright file="EdogTopicRouter.cs" company="Microsoft">
// Copyright (c) Microsoft Corporation. All rights reserved.
// </copyright>

#nullable disable
#pragma warning disable // DevMode-only file — suppress all warnings

namespace Microsoft.LiveTable.Service.DevMode
{
    using System;
    using System.Collections.Concurrent;

    /// <summary>
    /// Static registry of all EDOG topic buffers. Interceptors publish here;
    /// EdogPlaygroundHub reads from here via ChannelReader streaming.
    /// Thread-safe. Publish() never throws — interceptor failures never propagate to FLT.
    /// </summary>
    public static class EdogTopicRouter
    {
        private static readonly ConcurrentDictionary<string, TopicBuffer> _buffers = new();

        /// <summary>
        /// Initializes all 16 topic buffers with sizes from the SignalR Protocol Spec.
        /// Safe to call multiple times — TryAdd is idempotent.
        /// </summary>
        public static void Initialize()
        {
            RegisterTopic("log", 10000);
            RegisterTopic("telemetry", 5000);
            RegisterTopic("fileop", 2000);
            RegisterTopic("spark", 200);
            RegisterTopic("token", 1000);
            RegisterTopic("cache", 2000);
            RegisterTopic("http", 2000);
            RegisterTopic("retry", 500);
            RegisterTopic("flag", 1000);
            RegisterTopic("di", 100);
            RegisterTopic("perf", 5000);
            RegisterTopic("capacity", 500);
            RegisterTopic("catalog", 200);  // Catalog discovery events (start/complete/fail)
            RegisterTopic("dag", 500);  // DAG execution hooks + per-node lifecycle events
            RegisterTopic("flt-ops", 300);  // FLT operations: refresh triggers, MLV defs, DQ reports, maintenance
            RegisterTopic("nexus", 100);  // Nexus aggregated snapshots (low volume, high value)
        }

        /// <summary>
        /// Registers a topic buffer. Idempotent — existing topics are not replaced.
        /// </summary>
        /// <param name="topic">Topic name (lowercase).</param>
        /// <param name="maxSize">Maximum ring buffer size for this topic.</param>
        public static void RegisterTopic(string topic, int maxSize)
        {
            _buffers.TryAdd(topic.ToLowerInvariant(), new TopicBuffer(maxSize));
        }

        /// <summary>
        /// Gets the buffer for a topic. Returns null if topic is not registered.
        /// </summary>
        /// <param name="topic">Topic name.</param>
        public static TopicBuffer GetBuffer(string topic)
        {
            if (string.IsNullOrEmpty(topic)) return null;
            _buffers.TryGetValue(topic.ToLowerInvariant(), out var buffer);
            return buffer;
        }

        /// <summary>
        /// Publishes an event to a topic. Called by interceptors.
        /// Thread-safe. Never throws — interceptor failures never propagate to FLT.
        /// </summary>
        /// <param name="topic">Topic name (e.g., "flag", "perf", "token").</param>
        /// <param name="eventData">Topic-specific payload object.</param>
        public static void Publish(string topic, object eventData)
        {
            try
            {
                if (_buffers.TryGetValue(topic.ToLowerInvariant(), out var buffer))
                {
                    var evt = new TopicEvent
                    {
                        SequenceId = buffer.NextSequenceId(),
                        Timestamp = DateTimeOffset.UtcNow,
                        Topic = topic.ToLowerInvariant(),
                        Data = eventData
                    };
                    buffer.Write(evt);
                }
            }
            catch (Exception ex)
            {
                // Never propagate — this is a dev tool, not production telemetry
                System.Diagnostics.Debug.WriteLine($"[EDOG] TopicRouter.Publish error: {ex.Message}");
            }
        }
    }
}
