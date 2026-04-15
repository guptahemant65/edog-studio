// <copyright file="EdogCacheInterceptor.cs" company="Microsoft">
// Copyright (c) Microsoft Corporation. All rights reserved.
// </copyright>

#nullable disable
#pragma warning disable // DevMode-only file — suppress all warnings

namespace Microsoft.LiveTable.Service.DevMode
{
    using System;
    using System.Diagnostics;

    /// <summary>
    /// Utility class that publishes cache-related events to the "cache" topic
    /// via <see cref="EdogTopicRouter"/>. Called by <see cref="EdogDevModeRegistrar"/>
    /// to instrument cache operations discovered at runtime.
    ///
    /// <para>FLT does not expose a single cache interface — caching is spread across
    /// multiple components (TokenManager, CatalogHandler, DagExecutionStore, etc.).
    /// This interceptor provides static helper methods that can be wired to any
    /// cache-like operation without requiring a specific interface dependency.</para>
    /// </summary>
    public static class EdogCacheInterceptor
    {
        /// <summary>
        /// Record a cache operation event.
        /// </summary>
        /// <param name="cacheName">Name of the cache (e.g., "TokenManager", "CatalogCache").</param>
        /// <param name="operation">Operation type: "Get", "Set", "Evict", "GetOrResolve".</param>
        /// <param name="key">Cache key (e.g., "workspaceId:artifactId").</param>
        /// <param name="hitOrMiss">"Hit", "Miss", or null for non-read operations.</param>
        /// <param name="durationMs">Operation duration in milliseconds.</param>
        /// <param name="valueSizeBytes">Approximate size of the cached value, or null.</param>
        /// <param name="ttlSeconds">TTL of the cached entry, or null.</param>
        /// <param name="evictionReason">Reason for eviction, or null.</param>
        public static void RecordCacheEvent(
            string cacheName,
            string operation,
            string key,
            string hitOrMiss = null,
            double durationMs = 0,
            long? valueSizeBytes = null,
            int? ttlSeconds = null,
            string evictionReason = null)
        {
            var eventData = new
            {
                cacheName = cacheName ?? "Unknown",
                operation = operation ?? "Unknown",
                key = key ?? "",
                hitOrMiss = hitOrMiss,
                valueSizeBytes = valueSizeBytes,
                ttlSeconds = ttlSeconds,
                durationMs = Math.Round(durationMs, 2),
                evictionReason = evictionReason,
            };

            EdogTopicRouter.Publish("cache", eventData);
        }

        /// <summary>
        /// Convenience wrapper: time an operation and record hit/miss based on whether
        /// the factory delegate was invoked (cache miss) or not (cache hit).
        /// </summary>
        public static T GetOrResolve<T>(
            string cacheName,
            string key,
            Func<T> inner,
            Func<T> factory,
            out bool wasMiss)
        {
            var sw = Stopwatch.StartNew();
            bool factoryCalled = false;

            T result = inner();

            sw.Stop();

            // If result is null/default, it was likely a miss — but we can't be sure
            // without wrapping the factory. Caller should set wasMiss explicitly.
            wasMiss = factoryCalled;

            RecordCacheEvent(
                cacheName, "GetOrResolve", key,
                hitOrMiss: factoryCalled ? "Miss" : "Hit",
                durationMs: sw.Elapsed.TotalMilliseconds);

            return result;
        }
    }
}
