// <copyright file="EdogFeatureFlighterWrapper.cs" company="Microsoft">
// Copyright (c) Microsoft Corporation. All rights reserved.
// </copyright>

#nullable disable
#pragma warning disable // DevMode-only file — suppress all warnings

namespace Microsoft.LiveTable.Service.DevMode
{
    using System;
    using System.Diagnostics;
    using Microsoft.LiveTable.Service.FeatureFlightProvider;

    /// <summary>
    /// Decorator that wraps <see cref="IFeatureFlighter"/> to capture flag evaluations.
    /// Publishes FlagEvalEvent to the "flag" topic via <see cref="EdogTopicRouter"/>.
    /// Thread-safe stateless decorator — _inner is readonly. Zero overhead on caller.
    /// </summary>
    public class EdogFeatureFlighterWrapper : IFeatureFlighter
    {
        private readonly IFeatureFlighter _inner;

        /// <summary>
        /// Initializes a new instance of the <see cref="EdogFeatureFlighterWrapper"/> class.
        /// </summary>
        /// <param name="inner">The original <see cref="IFeatureFlighter"/> implementation to delegate to.</param>
        public EdogFeatureFlighterWrapper(IFeatureFlighter inner)
        {
            _inner = inner ?? throw new ArgumentNullException(nameof(inner));
        }

        /// <inheritdoc/>
        public bool IsEnabled(
            string featureName,
            Guid? tenantId,
            Guid? capacityId,
            Guid? workspaceId)
        {
            var sw = Stopwatch.StartNew();
            var result = _inner.IsEnabled(featureName, tenantId, capacityId, workspaceId);
            sw.Stop();

            var eventData = new
            {
                flagName = featureName,
                tenantId = tenantId?.ToString(),
                capacityId = capacityId?.ToString(),
                workspaceId = workspaceId?.ToString(),
                result,
                durationMs = sw.Elapsed.TotalMilliseconds,
            };

            EdogTopicRouter.Publish("flag", eventData);

            return result;
        }
    }
}
