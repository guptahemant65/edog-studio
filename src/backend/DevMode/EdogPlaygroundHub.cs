// <copyright file="EdogPlaygroundHub.cs" company="Microsoft">
// Copyright (c) Microsoft Corporation. All rights reserved.
// </copyright>

#nullable disable
#pragma warning disable // DevMode-only file

namespace Microsoft.LiveTable.Service.DevMode
{
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
    }
}
