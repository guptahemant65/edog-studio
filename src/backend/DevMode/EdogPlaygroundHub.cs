// <copyright file="EdogPlaygroundHub.cs" company="Microsoft">
// Copyright (c) Microsoft Corporation. All rights reserved.
// </copyright>

#nullable disable
#pragma warning disable // DevMode-only file

namespace Microsoft.LiveTable.Service.DevMode
{
    using System;
    using System.Collections.Generic;
    using System.Threading;
    using System.Threading.Channels;
    using System.Threading.Tasks;
    using Microsoft.AspNetCore.SignalR;

    /// <summary>
    /// SignalR hub for EDOG Playground real-time streaming (ADR-006).
    /// Clients subscribe to topic groups and receive only messages for their active tabs.
    /// Topics: log, telemetry, fileop, spark, token, cache, http, retry, flag, di, perf.
    /// </summary>
    public sealed class EdogPlaygroundHub : Hub
    {
        /// <summary>
        /// Client subscribes to a topic group. Called when a tab becomes active.
        /// </summary>
        public async Task Subscribe(string topic)
        {
            if (!string.IsNullOrWhiteSpace(topic))
            {
                await Groups.AddToGroupAsync(Context.ConnectionId, topic.ToLowerInvariant());
            }
        }

        /// <summary>
        /// Client unsubscribes from a topic group. Called when switching away from a tab.
        /// </summary>
        public async Task Unsubscribe(string topic)
        {
            if (!string.IsNullOrWhiteSpace(topic))
            {
                await Groups.RemoveFromGroupAsync(Context.ConnectionId, topic.ToLowerInvariant());
            }
        }

        /// <summary>
        /// Auto-subscribe to log group on connect (default Runtime View tab).
        /// </summary>
        public override async Task OnConnectedAsync()
        {
            await Groups.AddToGroupAsync(Context.ConnectionId, "log");
            await base.OnConnectedAsync();
        }

        /// <summary>
        /// Client streams a topic: receives snapshot (history) then live events.
        /// Called when user activates a tab. Cancelled when user leaves tab.
        /// SignalR recognizes ChannelReader&lt;T&gt; return type as a streaming method.
        /// </summary>
        /// <param name="topic">Topic name (e.g., "log", "flag", "perf").</param>
        /// <param name="cancellationToken">Fires when client disconnects or disposes stream.</param>
        public ChannelReader<TopicEvent> SubscribeToTopic(
            string topic,
            CancellationToken cancellationToken)
        {
            var buffer = EdogTopicRouter.GetBuffer(topic);
            if (buffer == null)
                throw new ArgumentException($"Unknown topic: {topic}");

            var channel = Channel.CreateBounded<TopicEvent>(
                new BoundedChannelOptions(1000)
                {
                    FullMode = BoundedChannelFullMode.DropOldest,
                    SingleReader = true,
                    SingleWriter = false
                });

            _ = Task.Run(async () =>
            {
                try
                {
                    // Phase 1: Yield snapshot (buffered history)
                    foreach (var item in buffer.GetSnapshot())
                    {
                        await channel.Writer.WriteAsync(item, cancellationToken);
                    }

                    // Phase 2: Yield live events as they arrive
                    await foreach (var item in buffer.ReadLiveAsync(cancellationToken))
                    {
                        await channel.Writer.WriteAsync(item, cancellationToken);
                    }
                }
                catch (OperationCanceledException) { /* Client disconnected — clean */ }
                catch (Exception ex)
                {
                    System.Diagnostics.Debug.WriteLine($"[EDOG] Stream error for topic '{topic}': {ex.Message}");
                }
                finally
                {
                    channel.Writer.Complete();
                }
            }, cancellationToken);

            return channel.Reader;
        }
    }
}
