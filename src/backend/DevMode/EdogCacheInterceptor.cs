// <copyright file="EdogCacheInterceptor.cs" company="Microsoft">
// Copyright (c) Microsoft Corporation. All rights reserved.
// </copyright>

#nullable disable
#pragma warning disable // DevMode-only file — suppress all warnings

namespace Microsoft.LiveTable.Service.DevMode
{
    using System;
    using System.Diagnostics;
    using System.Runtime.CompilerServices;
    using System.Threading;
    using System.Threading.Tasks;
    using Microsoft.LiveTable.Service.SqlEndpoint;

    /// <summary>
    /// Decorator that wraps <see cref="ISqlEndpointMetadataCache"/> to capture cache operations.
    /// Publishes CacheEvent to the "cache" topic via <see cref="EdogTopicRouter"/>.
    ///
    /// <para><b>Hit/Miss detection:</b> The original <c>GetOrResolveAsync</c> accepts a factory
    /// delegate that is only invoked on cache miss. We wrap that delegate with a sentinel that
    /// sets a flag — if our wrapper was called, it was a miss; otherwise a hit.</para>
    ///
    /// <para><b>Threading:</b> Stateless decorator — <c>_inner</c> is readonly. The
    /// <c>factoryCalled</c> flag is local to each call (stack-allocated bool), so there
    /// is no cross-thread contention.</para>
    /// </summary>
    public class EdogCacheInterceptor : ISqlEndpointMetadataCache
    {
        private readonly ISqlEndpointMetadataCache _inner;

        /// <summary>
        /// Initializes a new instance of the <see cref="EdogCacheInterceptor"/> class.
        /// </summary>
        /// <param name="inner">The original <see cref="ISqlEndpointMetadataCache"/> implementation to delegate to.</param>
        public EdogCacheInterceptor(ISqlEndpointMetadataCache inner)
        {
            _inner = inner ?? throw new ArgumentNullException(nameof(inner));
        }

        /// <inheritdoc/>
        public async Task<SqlEndpointMetadata> GetOrResolveAsync(
            Guid workspaceId,
            Guid artifactId,
            Func<Task<SqlEndpointMetadata>> factory,
            CancellationToken cancellationToken)
        {
            var sw = Stopwatch.StartNew();
            var factoryBox = new StrongBox<bool>(false);

            async Task<SqlEndpointMetadata> wrappedFactory()
            {
                factoryBox.Value = true;
                return await factory().ConfigureAwait(false);
            }

            var result = await _inner.GetOrResolveAsync(
                workspaceId, artifactId, wrappedFactory, cancellationToken).ConfigureAwait(false);

            sw.Stop();

            var eventData = new
            {
                cacheName = "SqlEndpointMetadataCache",
                operation = "GetOrResolve",
                key = $"{workspaceId}:{artifactId}",
                hitOrMiss = factoryBox.Value ? "Miss" : "Hit",
                durationMs = sw.Elapsed.TotalMilliseconds,
                evictionReason = (string)null,
            };

            EdogTopicRouter.Publish("cache", eventData);

            return result;
        }

        /// <inheritdoc/>
        public void Evict(Guid workspaceId, Guid artifactId)
        {
            var sw = Stopwatch.StartNew();

            _inner.Evict(workspaceId, artifactId);

            sw.Stop();

            var eventData = new
            {
                cacheName = "SqlEndpointMetadataCache",
                operation = "Evict",
                key = $"{workspaceId}:{artifactId}",
                hitOrMiss = (string)null,
                durationMs = sw.Elapsed.TotalMilliseconds,
                evictionReason = "Explicit",
            };

            EdogTopicRouter.Publish("cache", eventData);
        }
    }
}
