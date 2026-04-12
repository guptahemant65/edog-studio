// <copyright file="EdogPerfMarkerCallback.cs" company="Microsoft">
// Copyright (c) Microsoft Corporation. All rights reserved.
// </copyright>

#nullable disable
#pragma warning disable // DevMode-only file — suppress all warnings

namespace Microsoft.LiveTable.Service.DevMode
{
    using System;
    using System.Collections.Generic;
    using System.Collections.Specialized;
    using Microsoft.ServicePlatform.Telemetry;

    /// <summary>
    /// Decorator that wraps <see cref="IServiceMonitoringCallback"/> to capture perf marker completions.
    /// Chains to the original callback first (preserves platform telemetry), then publishes
    /// PerfMarkerEvent to the "perf" topic via <see cref="EdogTopicRouter"/>.
    /// Thread-safe — _inner is readonly, Publish() is thread-safe.
    /// </summary>
    public class EdogPerfMarkerCallback : IServiceMonitoringCallback
    {
        private readonly IServiceMonitoringCallback _inner;

        /// <summary>
        /// Initializes a new instance of the <see cref="EdogPerfMarkerCallback"/> class.
        /// </summary>
        /// <param name="inner">The original <see cref="IServiceMonitoringCallback"/> to chain to.</param>
        public EdogPerfMarkerCallback(IServiceMonitoringCallback inner)
        {
            _inner = inner ?? throw new ArgumentNullException(nameof(inner));
        }

        /// <inheritdoc/>
        public void CustomReportingAction(
            long reliablityMetricValue,
            long durationMetricValue,
            IOrderedDictionary customDimensions)
        {
            // Chain to original first — preserve platform telemetry
            try
            {
                _inner.CustomReportingAction(reliablityMetricValue, durationMetricValue, customDimensions);
            }
            catch
            {
                // Original callback failure is non-fatal — platform already swallows internally
            }

            // Publish PerfMarkerEvent to EDOG topic router
            try
            {
                var operationName = customDimensions?[ServiceMetricDimensions.OpName]?.ToString();
                var result = customDimensions?[ServiceMetricDimensions.OpOutcome]?.ToString();
                var correlationId = customDimensions?[ServiceMetricDimensions.CorrelationIdDimension]?.ToString();

                var dimensions = BuildDimensions(customDimensions);

                var eventData = new
                {
                    operationName,
                    durationMs = durationMetricValue,
                    result,
                    dimensions,
                    correlationId,
                };

                EdogTopicRouter.Publish("perf", eventData);
            }
            catch (Exception ex)
            {
                // Never propagate — dev tool failures must not affect FLT service
                System.Diagnostics.Debug.WriteLine($"[EDOG] PerfMarkerCallback error: {ex.Message}");
            }
        }

        /// <summary>
        /// Extracts dimension key-value pairs from the ordered dictionary.
        /// Returns all dimensions except those already surfaced as top-level fields.
        /// </summary>
        private static Dictionary<string, string> BuildDimensions(IOrderedDictionary customDimensions)
        {
            if (customDimensions == null || customDimensions.Count == 0)
            {
                return new Dictionary<string, string>();
            }

            var dims = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            var enumerator = customDimensions.GetEnumerator();
            while (enumerator.MoveNext())
            {
                var key = enumerator.Key?.ToString();
                var value = enumerator.Value?.ToString();
                if (!string.IsNullOrEmpty(key))
                {
                    dims[key] = value ?? string.Empty;
                }
            }

            return dims;
        }
    }
}
