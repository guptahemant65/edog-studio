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
    /// Decorator that wraps <see cref="IFeatureFlighter"/> with two behaviors:
    /// <list type="bullet">
    ///   <item>Observation: every evaluation is published to the <c>"flag"</c>
    ///   topic via <see cref="EdogTopicRouter"/>.</item>
    ///   <item>Override short-circuit: when
    ///   <see cref="EdogFeatureOverrideStore"/> has an entry for the
    ///   featureName, return its value WITHOUT calling the inner flighter
    ///   (per <c>F11/architecture.md §3.4</c>).</item>
    /// </list>
    /// Force-ON only — the store enforces this. The wrapper trusts the store
    /// and returns whatever value it has (always <c>true</c> in V1).
    /// Thread-safe stateless decorator; _inner is readonly.
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
            bool overridden = false;
            bool result;

            if (EdogFeatureOverrideStore.TryGet(featureName, out var forced))
            {
                // Short-circuit: do NOT call _inner. Force-ON is the only path
                // (the store enforces value == true at write time).
                result = forced;
                overridden = true;
            }
            else
            {
                result = _inner.IsEnabled(featureName, tenantId, capacityId, workspaceId);
            }

            sw.Stop();

            var eventData = new
            {
                flagName = featureName,
                tenantId = tenantId?.ToString(),
                capacityId = capacityId?.ToString(),
                workspaceId = workspaceId?.ToString(),
                result,
                durationMs = sw.Elapsed.TotalMilliseconds,
                overridden,
            };

            EdogTopicRouter.Publish("flag", eventData);

            return result;
        }
    }
}

