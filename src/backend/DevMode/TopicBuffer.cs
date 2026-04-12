// <copyright file="TopicBuffer.cs" company="Microsoft">
// Copyright (c) Microsoft Corporation. All rights reserved.
// </copyright>

#nullable disable
#pragma warning disable // DevMode-only file — suppress all warnings

namespace Microsoft.LiveTable.Service.DevMode
{
    using System.Collections.Concurrent;
    using System.Collections.Generic;
    using System.Threading;
    using System.Threading.Channels;

    /// <summary>
    /// Per-topic ring buffer with live channel for SignalR ChannelReader streaming.
    /// Ring buffer stores snapshot history; live channel feeds active stream subscribers.
    /// Thread-safe. Non-blocking writes.
    /// </summary>
    public sealed class TopicBuffer
    {
        private readonly int _maxSize;
        private readonly ConcurrentQueue<TopicEvent> _ring = new();
        private readonly Channel<TopicEvent> _liveChannel;
        private long _sequenceCounter;

        /// <summary>
        /// Initializes a new instance of the <see cref="TopicBuffer"/> class.
        /// </summary>
        /// <param name="maxSize">Maximum number of events in the ring buffer.</param>
        public TopicBuffer(int maxSize)
        {
            _maxSize = maxSize;
            _liveChannel = Channel.CreateUnbounded<TopicEvent>(
                new UnboundedChannelOptions { SingleWriter = false });
        }

        /// <summary>
        /// Returns the next monotonic sequence ID for this topic (atomic).
        /// </summary>
        public long NextSequenceId() => Interlocked.Increment(ref _sequenceCounter);

        /// <summary>
        /// Writes an event to both the ring buffer (snapshot) and live channel (streams).
        /// Called by interceptors via EdogTopicRouter.Publish(). Thread-safe, non-blocking.
        /// </summary>
        /// <param name="evt">The topic event to write.</param>
        public void Write(TopicEvent evt)
        {
            // Ring buffer for snapshot hydration
            _ring.Enqueue(evt);
            while (_ring.Count > _maxSize) _ring.TryDequeue(out _);

            // Live channel for active stream subscribers (non-blocking)
            _liveChannel.Writer.TryWrite(evt);
        }

        /// <summary>
        /// Returns current ring buffer contents for snapshot hydration on subscribe.
        /// </summary>
        public TopicEvent[] GetSnapshot()
        {
            return _ring.ToArray();
        }

        /// <summary>
        /// Async enumerable of live events for streaming after snapshot delivery.
        /// </summary>
        /// <param name="ct">Cancellation token — fires when client disconnects.</param>
        public IAsyncEnumerable<TopicEvent> ReadLiveAsync(CancellationToken ct)
        {
            return _liveChannel.Reader.ReadAllAsync(ct);
        }
    }
}
