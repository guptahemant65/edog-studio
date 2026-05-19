// <copyright file="EdogSparkClientWrapper.cs" company="Microsoft">
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
    using Microsoft.LiveTable.Service.DataModel;
    using Microsoft.LiveTable.Service.DataModel.Dag;
    using Microsoft.LiveTable.Service.SparkHttp;
    using Microsoft.LiveTable.Service.SparkHttp.Model;
    using Microsoft.LiveTable.Service.SparkSql;

    /// <summary>
    /// Decorator around <see cref="ISparkClient"/> that emits rich lifecycle events
    /// to the <c>spark</c> SignalR topic.
    ///
    /// <para>The factory interceptor (<see cref="EdogSparkSessionInterceptor"/>) wraps
    /// the returned <see cref="ISparkClient"/> in this decorator. Every method call on
    /// the Spark client now produces a structured event — transform submissions, poll
    /// ticks, terminal states, cancellations, and disposal.</para>
    ///
    /// <para><b>Threading:</b> All state is per-instance (one wrapper per DAG iteration).
    /// <c>_transformCount</c> uses Interlocked for safety. The wrapper delegates every
    /// call to <c>_inner</c> and never modifies FLT behavior — publish failures are
    /// swallowed silently.</para>
    /// </summary>
    internal class EdogSparkClientWrapper : ISparkClient
    {
        private readonly ISparkClient _inner;
        private readonly string _trackingId;
        private readonly string _iterationId;
        private readonly long _createdAtMs;
        private int _transformCount;
        private string _lastState;

        public EdogSparkClientWrapper(ISparkClient inner, string trackingId, string iterationId)
        {
            _inner = inner ?? throw new ArgumentNullException(nameof(inner));
            _trackingId = trackingId;
            _iterationId = iterationId;
            _createdAtMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        }

        /// <inheritdoc/>
        public SessionProperties SessionProperties
        {
            get => _inner.SessionProperties;
            set => _inner.SessionProperties = value;
        }

        /// <inheritdoc/>
        public async Task<TransformExecutionSubmitResponse> SendTransformRequestAsync(
            Guid transformationId,
            Node node,
            RefreshMode refreshMode = RefreshMode.Optimal,
            DefaultLakehouseContext defaultLakehouseContext = default,
            CancellationToken ct = default)
        {
            Interlocked.Increment(ref _transformCount);
            var sw = Stopwatch.StartNew();

            var result = await _inner.SendTransformRequestAsync(
                transformationId, node, refreshMode, defaultLakehouseContext, ct)
                .ConfigureAwait(false);

            sw.Stop();

            try
            {
                var sessionId = result.ComputeInfo?.SessionId?.ToString();
                var replId = result.ComputeInfo?.ReplId?.ToString();

                EdogTopicRouter.Publish("spark", new
                {
                    sessionTrackingId = _trackingId,
                    @event = "TransformSubmitted",
                    iterationId = _iterationId,
                    transformationId = transformationId.ToString(),
                    nodeName = node?.Name ?? string.Empty,
                    nodeKind = node?.Kind ?? string.Empty,
                    state = result.State.ToString(),
                    gtsSessionId = sessionId,
                    replId,
                    durationMs = sw.Elapsed.TotalMilliseconds,
                    retriable = result.Retriable,
                    retryAfterMs = result.RetryAfter?.TotalMilliseconds,
                    error = result.Error,
                });

                _lastState = result.State.ToString();
            }
            catch
            {
                // Never propagate — interceptor failures are non-fatal
            }

            return result;
        }

        /// <inheritdoc/>
        public async Task<TransformExecutionResponse> GetTransformStatusAsync(
            Guid transformationId,
            Node node,
            CancellationToken ct = default)
        {
            var sw = Stopwatch.StartNew();

            var result = await _inner.GetTransformStatusAsync(transformationId, node, ct)
                .ConfigureAwait(false);

            sw.Stop();

            try
            {
                var newState = result.State.ToString();
                var stateChanged = _lastState != newState;
                var isTerminal = result.State == TransformationState.Succeeded
                              || result.State == TransformationState.Failed
                              || result.State == TransformationState.Cancelled;

                string errorCode = null;
                string errorMessage = null;
                string errorSource = null;

                if (result.ErrorDetails != null)
                {
                    errorCode = result.ErrorDetails.ErrorCode;
                    errorMessage = result.ErrorDetails.Message;
                    errorSource = result.ErrorDetails.ErrorSource.ToString();
                }

                EdogTopicRouter.Publish("spark", new
                {
                    sessionTrackingId = _trackingId,
                    @event = isTerminal ? "TransformCompleted" : "TransformPolled",
                    iterationId = _iterationId,
                    transformationId = transformationId.ToString(),
                    nodeName = node?.Name ?? string.Empty,
                    state = newState,
                    previousState = _lastState,
                    stateChanged,
                    isTerminal,
                    durationMs = sw.Elapsed.TotalMilliseconds,
                    retryAfterMs = result.RetryAfter?.TotalMilliseconds,
                    errorCode,
                    errorMessage,
                    errorSource,
                    hasOutput = !string.IsNullOrEmpty(result.Output),
                });

                _lastState = newState;
            }
            catch
            {
                // Never propagate
            }

            return result;
        }

        /// <inheritdoc/>
        public async Task<TransformExecutionCancelResponse> CancelTransformAsync(
            Guid transformationId,
            Node node,
            CancellationToken ct = default)
        {
            var sw = Stopwatch.StartNew();

            var result = await _inner.CancelTransformAsync(transformationId, node, ct)
                .ConfigureAwait(false);

            sw.Stop();

            try
            {
                EdogTopicRouter.Publish("spark", new
                {
                    sessionTrackingId = _trackingId,
                    @event = "TransformCancelled",
                    iterationId = _iterationId,
                    transformationId = transformationId.ToString(),
                    nodeName = node?.Name ?? string.Empty,
                    state = result.State.ToString(),
                    durationMs = sw.Elapsed.TotalMilliseconds,
                    error = result.Error,
                    retryAfterMs = result.RetryAfter?.TotalMilliseconds,
                });
            }
            catch
            {
                // Never propagate
            }

            return result;
        }

        /// <inheritdoc/>
        public void Dispose()
        {
            try
            {
                var lifetimeMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - _createdAtMs;

                EdogTopicRouter.Publish("spark", new
                {
                    sessionTrackingId = _trackingId,
                    @event = "Disposed",
                    iterationId = _iterationId,
                    lifetimeMs,
                    transformCount = _transformCount,
                    lastState = _lastState,
                });
            }
            catch
            {
                // Never propagate
            }

            _inner.Dispose();
        }
    }
}
