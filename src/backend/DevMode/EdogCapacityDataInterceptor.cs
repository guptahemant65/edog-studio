// <copyright file="EdogCapacityDataInterceptor.cs" company="Microsoft">
// Copyright (c) Microsoft Corporation. All rights reserved.
// </copyright>

#nullable disable
#pragma warning disable // DevMode-only file — suppress all warnings

namespace Microsoft.LiveTable.Service.DevMode
{
    using System;
    using System.Collections.Generic;
    using System.Linq;
    using System.Threading;
    using System.Threading.Tasks;
    using global::Trident.SharedContracts.Capacity.Consumption;
    using global::Trident.SharedContracts.DataModel.Consumption;
    using global::Trident.SharedContracts.External.Consumption;
    using Microsoft.MWC.Workload.Client.Library;
    using Microsoft.MWC.Workload.Client.Library.Utils;

    /// <summary>
    /// Decorator that wraps <see cref="IWorkloadResourceMetricsReporter"/> to capture all
    /// CU (Capacity Unit) consumption reporting events flowing through FLT.
    ///
    /// <para><b>Why this matters:</b> FLT reports CU consumption to the Fabric platform via
    /// this interface. By intercepting it, EDOG can display per-operation CU costs in
    /// real time — enabling the Insights &amp; Trends report and Capacity Health features.</para>
    ///
    /// <para><b>Current state:</b> FLT registers <c>IWorkloadResourceMetricsReporter</c> at
    /// <c>WorkloadApp.cs:200</c> but has zero callers today. This interceptor is ready for
    /// when FLT starts reporting consumption (e.g., after each DAG node execution).</para>
    ///
    /// <para><b>Threading:</b> <c>_inner</c> is readonly. <c>_eventCounter</c> uses
    /// <c>Interlocked.Increment</c> for atomic monotonic IDs. All Publish() calls are
    /// thread-safe. Zero shared mutable state.</para>
    /// </summary>
    internal sealed class EdogCapacityDataInterceptor : IWorkloadResourceMetricsReporter
    {
        private readonly IWorkloadResourceMetricsReporter _inner;
        private static long _eventCounter;

        /// <summary>
        /// Initializes a new instance of the <see cref="EdogCapacityDataInterceptor"/> class.
        /// </summary>
        /// <param name="inner">The original <see cref="IWorkloadResourceMetricsReporter"/> to chain to.</param>
        public EdogCapacityDataInterceptor(IWorkloadResourceMetricsReporter inner)
        {
            _inner = inner ?? throw new ArgumentNullException(nameof(inner));
        }

        /// <inheritdoc/>
        public async Task ReportConsumptionAsync(ConsumptionEvent consumptionEvent, CancellationToken ct)
        {
            // Chain to original first — preserve platform consumption reporting
            await _inner.ReportConsumptionAsync(consumptionEvent, ct).ConfigureAwait(false);

            // Publish structured event to EDOG
            try
            {
                var metrics = ExtractResourceMetrics(consumptionEvent.ResourceMetrics);

                EdogTopicRouter.Publish("capacity", new
                {
                    eventId = Interlocked.Increment(ref _eventCounter),
                    eventType = "Consumption",
                    tenantId = consumptionEvent.TenantId,
                    capacityId = consumptionEvent.CapacityId,
                    workspaceId = consumptionEvent.WorkspaceId,
                    artifactKind = consumptionEvent.ArtifactKind.ToString(),
                    artifactId = consumptionEvent.ArtifactId,
                    artifactName = consumptionEvent.ArtifactName,
                    operationId = consumptionEvent.OperationId,
                    operationName = consumptionEvent.OperationName,
                    operationStatus = consumptionEvent.OperationStatus.ToString(),
                    utilizationType = consumptionEvent.UtilizationType.ToString(),
                    durationMs = consumptionEvent.DurationMs,
                    operationStartTimeUtc = consumptionEvent.OperationStartTimeUtc,
                    resourceMetrics = metrics,
                    usageModeOverride = consumptionEvent.UsageModeOverride?.ToString(),
                });
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"[EDOG] CapacityDataInterceptor ConsumptionEvent error: {ex.Message}");
            }
        }

        /// <inheritdoc/>
        public void ReportResourceMetrics(
            string tenantId,
            OperationStatus status,
            string workspaceId,
            ArtifactKind artifactKind,
            string artifactId,
            string artifactName,
            string identity,
            string operationName,
            UtilizationType utilizationType,
            DateTime operationStartTimeUtc,
            long cpuTimeMs,
            long durationMs,
            IReadOnlyCollection<WorkloadOperationMetric> operationMetrics = null)
        {
            _inner.ReportResourceMetrics(
                tenantId, status, workspaceId, artifactKind, artifactId, artifactName,
                identity, operationName, utilizationType, operationStartTimeUtc,
                cpuTimeMs, durationMs, operationMetrics);

            PublishResourceMetricsEvent(
                null, tenantId, status, workspaceId, artifactKind, artifactId, artifactName,
                operationName, utilizationType, operationStartTimeUtc, cpuTimeMs, durationMs, 0, operationMetrics);
        }

        /// <inheritdoc/>
        public void ReportResourceMetrics(
            string tenantId,
            OperationStatus status,
            string workspaceId,
            ArtifactKind artifactKind,
            string artifactId,
            string artifactName,
            string identity,
            string operationName,
            UtilizationType utilizationType,
            DateTime operationStartTimeUtc,
            long cpuTimeMs,
            long durationMs,
            long throttlingDelayMs,
            IReadOnlyCollection<WorkloadOperationMetric> operationMetrics = null)
        {
            _inner.ReportResourceMetrics(
                tenantId, status, workspaceId, artifactKind, artifactId, artifactName,
                identity, operationName, utilizationType, operationStartTimeUtc,
                cpuTimeMs, durationMs, throttlingDelayMs, operationMetrics);

            PublishResourceMetricsEvent(
                null, tenantId, status, workspaceId, artifactKind, artifactId, artifactName,
                operationName, utilizationType, operationStartTimeUtc, cpuTimeMs, durationMs, throttlingDelayMs, operationMetrics);
        }

        /// <inheritdoc/>
        public async Task ReportResourceMetricsAsync(
            string tenantId,
            OperationStatus status,
            string workspaceId,
            ArtifactKind artifactKind,
            string artifactId,
            string artifactName,
            string identity,
            string operationName,
            UtilizationType utilizationType,
            DateTime operationStartTimeUtc,
            long cpuTimeMs,
            long durationMs,
            CancellationToken cancellationToken,
            IReadOnlyCollection<WorkloadOperationMetric> operationMetrics = null)
        {
            await _inner.ReportResourceMetricsAsync(
                tenantId, status, workspaceId, artifactKind, artifactId, artifactName,
                identity, operationName, utilizationType, operationStartTimeUtc,
                cpuTimeMs, durationMs, cancellationToken, operationMetrics).ConfigureAwait(false);

            PublishResourceMetricsEvent(
                null, tenantId, status, workspaceId, artifactKind, artifactId, artifactName,
                operationName, utilizationType, operationStartTimeUtc, cpuTimeMs, durationMs, 0, operationMetrics);
        }

        /// <inheritdoc/>
        public async Task ReportResourceMetricsAsync(
            string tenantId,
            OperationStatus status,
            string workspaceId,
            ArtifactKind artifactKind,
            string artifactId,
            string artifactName,
            string identity,
            string operationName,
            UtilizationType utilizationType,
            DateTime operationStartTimeUtc,
            long cpuTimeMs,
            long durationMs,
            long throttlingDelayMs,
            CancellationToken cancellationToken,
            IReadOnlyCollection<WorkloadOperationMetric> operationMetrics = null)
        {
            await _inner.ReportResourceMetricsAsync(
                tenantId, status, workspaceId, artifactKind, artifactId, artifactName,
                identity, operationName, utilizationType, operationStartTimeUtc,
                cpuTimeMs, durationMs, throttlingDelayMs, cancellationToken, operationMetrics).ConfigureAwait(false);

            PublishResourceMetricsEvent(
                null, tenantId, status, workspaceId, artifactKind, artifactId, artifactName,
                operationName, utilizationType, operationStartTimeUtc, cpuTimeMs, durationMs, throttlingDelayMs, operationMetrics);
        }

        /// <inheritdoc/>
        public async Task ReportResourceMetricsAsync(
            string capacityId,
            string tenantId,
            OperationStatus status,
            string workspaceId,
            ArtifactKind artifactKind,
            string artifactId,
            string artifactName,
            string identity,
            string operationName,
            UtilizationType utilizationType,
            DateTime operationStartTimeUtc,
            long cpuTimeMs,
            long durationMs,
            CancellationToken cancellationToken,
            IReadOnlyCollection<WorkloadOperationMetric> operationMetrics = null)
        {
            await _inner.ReportResourceMetricsAsync(
                capacityId, tenantId, status, workspaceId, artifactKind, artifactId, artifactName,
                identity, operationName, utilizationType, operationStartTimeUtc,
                cpuTimeMs, durationMs, cancellationToken, operationMetrics).ConfigureAwait(false);

            PublishResourceMetricsEvent(
                capacityId, tenantId, status, workspaceId, artifactKind, artifactId, artifactName,
                operationName, utilizationType, operationStartTimeUtc, cpuTimeMs, durationMs, 0, operationMetrics);
        }

        /// <inheritdoc/>
        public async Task ReportResourceMetricsAsync(
            string capacityId,
            string tenantId,
            OperationStatus status,
            string workspaceId,
            ArtifactKind artifactKind,
            string artifactId,
            string artifactName,
            string identity,
            string operationName,
            UtilizationType utilizationType,
            DateTime operationStartTimeUtc,
            long cpuTimeMs,
            long durationMs,
            long throttlingDelayMs,
            CancellationToken cancellationToken,
            IReadOnlyCollection<WorkloadOperationMetric> operationMetrics = null)
        {
            await _inner.ReportResourceMetricsAsync(
                capacityId, tenantId, status, workspaceId, artifactKind, artifactId, artifactName,
                identity, operationName, utilizationType, operationStartTimeUtc,
                cpuTimeMs, durationMs, throttlingDelayMs, cancellationToken, operationMetrics).ConfigureAwait(false);

            PublishResourceMetricsEvent(
                capacityId, tenantId, status, workspaceId, artifactKind, artifactId, artifactName,
                operationName, utilizationType, operationStartTimeUtc, cpuTimeMs, durationMs, throttlingDelayMs, operationMetrics);
        }

        /// <inheritdoc/>
        public async Task ReportResourceMetricPerArtifactAsync(
            string capacityId,
            string tenantId,
            string workspaceId,
            ArtifactKind artifactKind,
            string artifactId,
            string artifactName,
            MetricName metricName,
            long metricValue,
            MetricUnit metricUnit,
            CancellationToken cancellationToken)
        {
            await _inner.ReportResourceMetricPerArtifactAsync(
                capacityId, tenantId, workspaceId, artifactKind, artifactId, artifactName,
                metricName, metricValue, metricUnit, cancellationToken).ConfigureAwait(false);

            try
            {
                EdogTopicRouter.Publish("capacity", new
                {
                    eventId = Interlocked.Increment(ref _eventCounter),
                    eventType = "PerArtifactMetric",
                    capacityId,
                    tenantId,
                    workspaceId,
                    artifactKind = artifactKind.ToString(),
                    artifactId,
                    artifactName,
                    metricName = metricName.ToString(),
                    metricValue,
                    metricUnit = metricUnit.ToString(),
                });
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"[EDOG] CapacityDataInterceptor PerArtifactMetric error: {ex.Message}");
            }
        }

        /// <inheritdoc/>
        public async Task ReportStorageConsumptionAsync(WorkspaceConsumptionEvent workspaceConsumptionEvent, CancellationToken ct)
        {
            await _inner.ReportStorageConsumptionAsync(workspaceConsumptionEvent, ct).ConfigureAwait(false);

            try
            {
                var metrics = ExtractResourceMetrics(workspaceConsumptionEvent.ResourceMetrics);

                EdogTopicRouter.Publish("capacity", new
                {
                    eventId = Interlocked.Increment(ref _eventCounter),
                    eventType = "StorageConsumption",
                    tenantId = workspaceConsumptionEvent.TenantId,
                    capacityId = workspaceConsumptionEvent.CapacityId,
                    workspaceId = workspaceConsumptionEvent.WorkspaceId,
                    utilizationType = workspaceConsumptionEvent.UtilizationType.ToString(),
                    eventStartTimeUtc = workspaceConsumptionEvent.EventStartTimeUtc,
                    eventEndTimeUtc = workspaceConsumptionEvent.EventEndTimeUtc,
                    resourceMetrics = metrics,
                });
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"[EDOG] CapacityDataInterceptor StorageConsumption error: {ex.Message}");
            }
        }

        /// <inheritdoc/>
        public async Task ReportExternalConsumptionAsync(ExternalConsumptionEvent consumptionEvent, CancellationToken ct)
        {
            await _inner.ReportExternalConsumptionAsync(consumptionEvent, ct).ConfigureAwait(false);

            try
            {
                var metrics = ExtractResourceMetrics(consumptionEvent.ResourceMetrics);

                EdogTopicRouter.Publish("capacity", new
                {
                    eventId = Interlocked.Increment(ref _eventCounter),
                    eventType = "ExternalConsumption",
                    tenantId = consumptionEvent.TenantId,
                    capacityId = consumptionEvent.CapacityId,
                    workspaceId = consumptionEvent.WorkspaceId,
                    artifactKind = consumptionEvent.ArtifactKind.ToString(),
                    artifactId = consumptionEvent.ArtifactId,
                    artifactName = consumptionEvent.ArtifactName,
                    operationId = consumptionEvent.OperationId,
                    operationName = consumptionEvent.OperationName,
                    utilizationType = consumptionEvent.UtilizationType.ToString(),
                    windowStartTimeUtc = consumptionEvent.WindowStartTimeUtc,
                    windowEndTimeUtc = consumptionEvent.WindowEndTimeUtc,
                    resourceMetrics = metrics,
                });
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"[EDOG] CapacityDataInterceptor ExternalConsumption error: {ex.Message}");
            }
        }

        /// <inheritdoc/>
        public async Task ReportExternalStorageConsumptionAsync(ExternalConsumptionEvent consumptionEvent, CancellationToken ct)
        {
            await _inner.ReportExternalStorageConsumptionAsync(consumptionEvent, ct).ConfigureAwait(false);

            try
            {
                var metrics = ExtractResourceMetrics(consumptionEvent.ResourceMetrics);

                EdogTopicRouter.Publish("capacity", new
                {
                    eventId = Interlocked.Increment(ref _eventCounter),
                    eventType = "ExternalStorageConsumption",
                    tenantId = consumptionEvent.TenantId,
                    capacityId = consumptionEvent.CapacityId,
                    workspaceId = consumptionEvent.WorkspaceId,
                    artifactKind = consumptionEvent.ArtifactKind.ToString(),
                    artifactId = consumptionEvent.ArtifactId,
                    operationName = consumptionEvent.OperationName,
                    resourceMetrics = metrics,
                });
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"[EDOG] CapacityDataInterceptor ExternalStorageConsumption error: {ex.Message}");
            }
        }

        /// <inheritdoc/>
        public bool IsConsumptionOperationRegistered(ConsumptionOperationType operationType, string operationName)
        {
            return _inner.IsConsumptionOperationRegistered(operationType, operationName);
        }

        /// <summary>
        /// Publishes a structured ResourceMetrics event to the "capacity" topic.
        /// Shared by all sync/async ReportResourceMetrics overloads.
        /// </summary>
        private static void PublishResourceMetricsEvent(
            string capacityId,
            string tenantId,
            OperationStatus status,
            string workspaceId,
            ArtifactKind artifactKind,
            string artifactId,
            string artifactName,
            string operationName,
            UtilizationType utilizationType,
            DateTime operationStartTimeUtc,
            long cpuTimeMs,
            long durationMs,
            long throttlingDelayMs,
            IReadOnlyCollection<WorkloadOperationMetric> operationMetrics)
        {
            try
            {
                var customMetrics = operationMetrics?
                    .Select(m => new { name = m.Name, value = m.Value })
                    .ToArray();

                EdogTopicRouter.Publish("capacity", new
                {
                    eventId = Interlocked.Increment(ref _eventCounter),
                    eventType = "ResourceMetrics",
                    capacityId,
                    tenantId,
                    status = status.ToString(),
                    workspaceId,
                    artifactKind = artifactKind.ToString(),
                    artifactId,
                    artifactName,
                    operationName,
                    utilizationType = utilizationType.ToString(),
                    operationStartTimeUtc,
                    cpuTimeMs,
                    durationMs,
                    throttlingDelayMs,
                    operationMetrics = customMetrics,
                });
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"[EDOG] CapacityDataInterceptor ResourceMetrics error: {ex.Message}");
            }
        }

        /// <summary>
        /// Extracts resource metrics into a serializable dictionary.
        /// ConsumptionResourceMetric has Name (enum) and Value (double).
        /// </summary>
        private static Dictionary<string, double> ExtractResourceMetrics(
            IEnumerable<ConsumptionResourceMetric> metrics)
        {
            if (metrics == null) return new Dictionary<string, double>();

            var result = new Dictionary<string, double>(StringComparer.OrdinalIgnoreCase);
            foreach (var m in metrics)
            {
                result[m.Name.ToString()] = m.Value;
            }

            return result;
        }
    }
}
