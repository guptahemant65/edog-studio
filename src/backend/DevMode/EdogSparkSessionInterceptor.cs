// <copyright file="EdogSparkSessionInterceptor.cs" company="Microsoft">
// Copyright (c) Microsoft Corporation. All rights reserved.
// </copyright>

#nullable disable
#pragma warning disable // DevMode-only file — suppress all warnings

namespace Microsoft.LiveTable.Service.DevMode
{
    using System;
    using System.Diagnostics;
    using System.Threading;
    using System.Threading.Tasks;
    using Microsoft.LiveTable.Service.SparkHttp;
    using Microsoft.MWC.Workload.Client.Library.Providers;

    /// <summary>
    /// Decorator that wraps <see cref="ISparkClientFactory"/> to track Spark session lifecycle.
    ///
    /// <para><b>Tracking IDs:</b> FLT has no native Spark session ID. We generate a monotonic
    /// tracking ID per factory call: <c>edog-spark-{N}</c>. The frontend maps these to DAG
    /// nodes for the Spark Inspector view.</para>
    ///
    /// <para><b>Threading:</b> <c>_sessionCounter</c> uses <c>Interlocked.Increment</c> for
    /// atomic monotonic IDs. <c>_inner</c> is readonly. Zero shared mutable state.</para>
    /// </summary>
    internal class EdogSparkSessionInterceptor : ISparkClientFactory
    {
        private readonly ISparkClientFactory _inner;
        private static int _sessionCounter;

        /// <summary>
        /// Initializes a new instance of the <see cref="EdogSparkSessionInterceptor"/> class.
        /// </summary>
        /// <param name="inner">The original <see cref="ISparkClientFactory"/> implementation to delegate to.</param>
        public EdogSparkSessionInterceptor(ISparkClientFactory inner)
        {
            _inner = inner ?? throw new ArgumentNullException(nameof(inner));
        }

        /// <inheritdoc/>
        public async Task<ISparkClient> CreateSparkClientAsync(
            string tenantId,
            Guid workspaceId,
            Guid artifactId,
            Guid iterationId,
            string workspaceName,
            string artifactName,
            ITokenProvider tokenProvider)
        {
            var trackingId = $"edog-spark-{Interlocked.Increment(ref _sessionCounter)}";
            var sw = Stopwatch.StartNew();

            ISparkClient client;
            try
            {
                client = await _inner.CreateSparkClientAsync(
                    tenantId, workspaceId, artifactId, iterationId,
                    workspaceName, artifactName, tokenProvider).ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                sw.Stop();

                // Publish error event before re-throwing
                EdogTopicRouter.Publish("spark", new
                {
                    sessionTrackingId = trackingId,
                    @event = "Error",
                    tenantId,
                    workspaceId = workspaceId.ToString(),
                    artifactId = artifactId.ToString(),
                    iterationId = iterationId.ToString(),
                    workspaceName = workspaceName ?? string.Empty,
                    artifactName = artifactName ?? string.Empty,
                    durationMs = sw.Elapsed.TotalMilliseconds,
                    error = ex.Message,
                });

                throw;
            }

            sw.Stop();

            var eventData = new
            {
                sessionTrackingId = trackingId,
                @event = "Created",
                tenantId,
                workspaceId = workspaceId.ToString(),
                artifactId = artifactId.ToString(),
                iterationId = iterationId.ToString(),
                workspaceName = workspaceName ?? string.Empty,
                artifactName = artifactName ?? string.Empty,
                durationMs = sw.Elapsed.TotalMilliseconds,
                error = (string)null,
            };

            EdogTopicRouter.Publish("spark", eventData);

            return client;
        }
    }
}
