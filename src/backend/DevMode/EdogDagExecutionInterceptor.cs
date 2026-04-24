// <copyright file="EdogDagExecutionInterceptor.cs" company="Microsoft">
// Copyright (c) Microsoft Corporation. All rights reserved.
// </copyright>

// REGISTRATION NOTE:
// EdogDagExecutionHook must be registered by FLT in DagExecutionHandlerV2's hook list.
// EdogNodeExecutorWrapper requires FLT to provide INodeExecutorFactory or
// change NodeExecutor creation to go through DI.
// The "dag" topic must be registered in EdogTopicRouter.Initialize().
// See gaps-roadmap.md Gap 2 for coordination details.

#nullable disable
#pragma warning disable // DevMode-only file — suppress all warnings

namespace Microsoft.LiveTable.Service.DevMode
{
    using System;
    using System.Diagnostics;
    using System.Linq;
    using System.Threading;
    using System.Threading.Tasks;
    using Microsoft.LiveTable.Service.Core.V2;
    using Microsoft.LiveTable.Service.DagExecutionHooks;
    using Microsoft.LiveTable.Service.DataModel.Dag;

    /// <summary>
    /// DAG execution hook that captures terminal DAG events and publishes them to the "dag" topic.
    /// Implements <see cref="IDagExecutionHook"/> — all exceptions are caught internally per the hook contract.
    /// Thread-safe. Zero overhead on caller — publish failures never propagate to FLT.
    /// </summary>
    internal class EdogDagExecutionHook : IDagExecutionHook
    {
        /// <inheritdoc/>
        public string Name => "EdogObservability";

        /// <inheritdoc/>
        public string GroupId => "edog-observability";

        /// <inheritdoc/>
        public HookPhase Phase => HookPhase.CRUD;

        /// <inheritdoc/>
        public Task ExecuteAsync(DagExecutionHookContext context, CancellationToken cancellationToken)
        {
            try
            {
                var instance = context.DagExecInstance;
                var dagCtx = context.DagExecutionContext;
                var metrics = instance?.DagExecutionMetrics;
                var terminalInfo = context.TerminalInfo;

                // Use TerminalInfo for accurate terminal status (AB#5169886).
                // DagExecutionMetrics may still show InProgress at hook time.
                var status = terminalInfo?.Status.ToString() ?? metrics?.Status.ToString() ?? "Unknown";

                // Compute duration from metrics StartedAt to TerminalInfo EndedAt
                long durationMs = 0;
                if (metrics?.StartedAt != null && terminalInfo?.EndedAt != null)
                {
                    durationMs = (long)(terminalInfo.EndedAt - metrics.StartedAt.Value).TotalMilliseconds;
                }
                else if (metrics?.StartedAt != null && metrics?.EndedAt != null)
                {
                    durationMs = (long)(metrics.EndedAt.Value - metrics.StartedAt.Value).TotalMilliseconds;
                }

                // Count node statuses from NodeExecutionMetrices
                int totalNodes = instance?.Dag?.Nodes?.Count ?? 0;
                int completedNodes = 0;
                int failedNodes = 0;
                int skippedNodes = 0;

                if (instance?.NodeExecutionMetrices != null)
                {
                    foreach (var kvp in instance.NodeExecutionMetrices)
                    {
                        switch (kvp.Value.Status)
                        {
                            case NodeExecutionStatus.Completed:
                                completedNodes++;
                                break;
                            case NodeExecutionStatus.Failed:
                                failedNodes++;
                                break;
                            case NodeExecutionStatus.Skipped:
                                skippedNodes++;
                                break;
                        }
                    }
                }

                PublishEvent(new
                {
                    @event = "DagTerminal",
                    dagId = dagCtx?.DagName,
                    iterationId = instance?.IterationId.ToString(),
                    status,
                    totalNodes,
                    completedNodes,
                    failedNodes,
                    skippedNodes,
                    parallelLimit = metrics?.ParallelNodeLimit ?? 0,
                    durationMs,
                    errorCode = terminalInfo?.ErrorCode ?? metrics?.ErrorCode,
                    errorMessage = terminalInfo?.ErrorMessage ?? metrics?.ErrorMessage,
                    errorSource = terminalInfo?.ErrorSource.ToString() ?? metrics?.ErrorSource.ToString(),
                });
            }
            catch (Exception ex)
            {
                // Hook contract: never propagate exceptions
                Debug.WriteLine($"[EDOG] DagExecutionHook error: {ex.Message}");
            }

            return Task.CompletedTask;
        }

        /// <summary>
        /// Publishes a DAG lifecycle event to the "dag" topic. Never throws.
        /// </summary>
        private static void PublishEvent(object eventData)
        {
            try
            {
                EdogTopicRouter.Publish("dag", eventData);
            }
            catch (Exception ex)
            {
                Debug.WriteLine($"[EDOG] DagExecutionHook publish error: {ex.Message}");
            }
        }
    }

    /// <summary>
    /// Transparent decorator that wraps <see cref="INodeExecutor"/> to capture per-node execution timing.
    /// Publishes NodeStarted, NodeCompleted, and NodeFailed events to the "dag" topic.
    /// Exceptions from the inner executor are always re-thrown after publishing — this is a transparent wrapper.
    /// Thread-safe. Publish failures never propagate to FLT.
    /// </summary>
    internal class EdogNodeExecutorWrapper : INodeExecutor
    {
        private const int MaxErrorMessageLength = 500;

        private readonly INodeExecutor _inner;
        private readonly string _nodeId;
        private readonly string _dagId;
        private readonly Guid _iterationId;

        /// <summary>
        /// Initializes a new instance of the <see cref="EdogNodeExecutorWrapper"/> class.
        /// </summary>
        /// <param name="inner">The original <see cref="INodeExecutor"/> to delegate to.</param>
        /// <param name="nodeId">The identifier of the node being executed.</param>
        /// <param name="dagId">The DAG name/identifier this node belongs to.</param>
        /// <param name="iterationId">The execution iteration identifier.</param>
        public EdogNodeExecutorWrapper(INodeExecutor inner, string nodeId, string dagId, Guid iterationId)
        {
            _inner = inner ?? throw new ArgumentNullException(nameof(inner));
            _nodeId = nodeId;
            _dagId = dagId;
            _iterationId = iterationId;
        }

        /// <inheritdoc/>
        public async Task ExecuteNodeAsync(CancellationToken ct)
        {
            PublishEvent(new
            {
                @event = "NodeStarted",
                nodeId = _nodeId,
                dagId = _dagId,
                iterationId = _iterationId.ToString(),
                timestamp = DateTime.UtcNow.ToString("o"),
            });

            var sw = Stopwatch.StartNew();
            try
            {
                await _inner.ExecuteNodeAsync(ct).ConfigureAwait(false);
                sw.Stop();

                PublishEvent(new
                {
                    @event = "NodeCompleted",
                    nodeId = _nodeId,
                    dagId = _dagId,
                    iterationId = _iterationId.ToString(),
                    durationMs = sw.ElapsedMilliseconds,
                });
            }
            catch (Exception ex)
            {
                sw.Stop();

                PublishEvent(new
                {
                    @event = "NodeFailed",
                    nodeId = _nodeId,
                    dagId = _dagId,
                    iterationId = _iterationId.ToString(),
                    durationMs = sw.ElapsedMilliseconds,
                    errorType = ex.GetType().Name,
                    errorMessage = Truncate(ex.Message, MaxErrorMessageLength),
                });

                // Transparent decorator — always re-throw
                throw;
            }
        }

        /// <summary>
        /// Truncates a string to the specified maximum length.
        /// </summary>
        private static string Truncate(string value, int maxLength)
        {
            if (string.IsNullOrEmpty(value) || value.Length <= maxLength)
            {
                return value;
            }

            return value.Substring(0, maxLength);
        }

        /// <summary>
        /// Publishes a node lifecycle event to the "dag" topic. Never throws.
        /// </summary>
        private static void PublishEvent(object eventData)
        {
            try
            {
                EdogTopicRouter.Publish("dag", eventData);
            }
            catch (Exception ex)
            {
                Debug.WriteLine($"[EDOG] NodeExecutorWrapper publish error: {ex.Message}");
            }
        }
    }
}
