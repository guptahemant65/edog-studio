// <copyright file="EdogSparkClientWrapper.cs" company="Microsoft">
// Copyright (c) Microsoft Corporation. All rights reserved.
// </copyright>

#nullable disable
#pragma warning disable // DevMode-only file — suppress all warnings

namespace Microsoft.LiveTable.Service.DevMode
{
    using System;
    using System.Collections.Concurrent;
    using System.Collections.Generic;
    using System.Diagnostics;
    using System.Linq;
    using System.Text.RegularExpressions;
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
        private readonly ConcurrentDictionary<Guid, string> _lastStates = new();
        private readonly ConcurrentDictionary<Guid, (string GtsSessionId, string ReplId)> _transformIdentity = new();

        public EdogSparkClientWrapper(ISparkClient inner, string trackingId, string iterationId)
        {
            _inner = inner ?? throw new ArgumentNullException(nameof(inner));
            _trackingId = trackingId;
            _iterationId = iterationId;
            _createdAtMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        }

        // Conservative redaction: anything whose key name hints at a credential
        // gets its value masked. False positives only hide debugging info; false
        // negatives leak secrets into the studio log — bias toward false positives.
        private static readonly Regex SecretKeyPattern = new(
            @"(password|secret|token|key|credential|cred|sas|auth|bearer|signature)",
            RegexOptions.Compiled | RegexOptions.IgnoreCase);

        private static Dictionary<string, string> SnapshotConf(SessionProperties props)
        {
            var conf = props?.Conf;
            if (conf == null || conf.Count == 0)
            {
                return null;
            }

            var snapshot = new Dictionary<string, string>(conf.Count);
            foreach (var kv in conf)
            {
                if (kv.Key == null) continue;
                var value = kv.Value;
                var stringValue = value?.ToString() ?? string.Empty;
                if (SecretKeyPattern.IsMatch(kv.Key))
                {
                    snapshot[kv.Key] = "***REDACTED***";
                }
                else if (stringValue.Length > 2048)
                {
                    snapshot[kv.Key] = stringValue.Substring(0, 2048) + "…";
                }
                else
                {
                    snapshot[kv.Key] = stringValue;
                }
            }

            return snapshot;
        }

        // Try multiple method/property names on a Node to extract the generated
        // Spark code / SQL body for display. FLT's Node hierarchy includes
        // SqlNode, PySparkNode, MaterializedNode, etc. with different shapes —
        // we probe in priority order and return the first non-empty string.
        private static string ExtractNodeCode(Node node)
        {
            if (node == null) return string.Empty;

            try
            {
                var nt = node.GetType();
                const System.Reflection.BindingFlags flags =
                    System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Instance;

                // Methods first — most explicit signal of "code for display".
                string[] methodCandidates = { "GetCodeForLogging", "GetCode", "GetSql", "GetQuery", "GetBody" };
                foreach (var name in methodCandidates)
                {
                    var m = nt.GetMethod(name, flags);
                    if (m != null && m.GetParameters().Length == 0)
                    {
                        var result = m.Invoke(node, null) as string;
                        if (!string.IsNullOrEmpty(result)) return result;
                    }
                }

                // Properties next — common shapes across node types.
                string[] propertyCandidates = { "CustomCode", "Code", "Body", "Sql", "Query", "Definition", "Expression" };
                foreach (var name in propertyCandidates)
                {
                    var p = nt.GetProperty(name, flags);
                    if (p == null) continue;
                    var raw = p.GetValue(node);
                    if (raw == null) continue;
                    var s = raw as string ?? raw.ToString();
                    if (!string.IsNullOrEmpty(s)) return s;
                }
            }
            catch (Exception ex)
            {
                Debug.WriteLine($"[EDOG] ExtractNodeCode reflection error: {ex.Message}");
            }

            return string.Empty;
        }

        /// <inheritdoc/>
        public SessionProperties SessionProperties
        {
            get => _inner.SessionProperties;
            set
            {
                _inner.SessionProperties = value;
                try
                {
                    // confKeys/confCount kept for back-compat; `conf` is the new
                    // payload the Conf tab actually consumes. Values pass through
                    // the secret-key redactor before leaving the FLT process.
                    var confSnapshot = SnapshotConf(value);
                    EdogTopicRouter.Publish("spark", new
                    {
                        sessionTrackingId = _trackingId,
                        @event = "SessionPropertiesSet",
                        iterationId = _iterationId,
                        confKeys = value?.Conf?.Keys.ToArray(),
                        confCount = value?.Conf?.Count ?? 0,
                        conf = confSnapshot,
                    });
                }
                catch (Exception ex)
                {
                    System.Diagnostics.Debug.WriteLine($"[EDOG] SparkWrapper.SessionProperties publish error: {ex.Message}");
                }
            }
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
                var sessionId = result.ComputeInfo?.SessionId?.ToString() ?? string.Empty;
                var replId = result.ComputeInfo?.ReplId?.ToString() ?? string.Empty;

                _transformIdentity[transformationId] = (sessionId, replId);

                // Pull generated code via reflection (FLT Node API). Truncate to
                // 4 KB to keep events small. Empty string when no code field is
                // discoverable — the Code tab handles the empty case.
                var sparkCode = ExtractNodeCode(node);
                if (sparkCode.Length > 4096) sparkCode = sparkCode.Substring(0, 4096);

                // Snapshot live conf at submit time too, so the Conf tab populates
                // even when FLT sets SessionProperties via the ctor (i.e. our
                // setter override never fires). Cheap dictionary copy.
                Dictionary<string, string> confSnapshot = null;
                try { confSnapshot = SnapshotConf(_inner.SessionProperties); }
                catch (Exception ex) { Debug.WriteLine($"[EDOG] SparkWrapper.snapshot conf error: {ex.Message}"); }

                EdogTopicRouter.Publish("spark", new
                {
                    sessionTrackingId = _trackingId,
                    @event = "TransformSubmitted",
                    iterationId = _iterationId,
                    transformationId = transformationId.ToString(),
                    nodeName = node?.Name ?? string.Empty,
                    nodeKind = node?.Kind ?? string.Empty,
                    nodeId = node?.NodeId.ToString() ?? string.Empty,
                    refreshMode = refreshMode.ToString(),
                    state = result.State.ToString(),
                    gtsSessionId = sessionId,
                    replId,
                    durationMs = sw.Elapsed.TotalMilliseconds,
                    retriable = result.Retriable,
                    retryAfterMs = result.RetryAfter?.TotalMilliseconds,
                    error = result.Error,
                    sparkCode,
                    conf = confSnapshot,
                });

                _lastStates[transformationId] = result.State.ToString();
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"[EDOG] SparkWrapper.SendTransform publish error: {ex.Message}");
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
                var prevState = _lastStates.TryGetValue(transformationId, out var ls) ? ls : null;
                var stateChanged = prevState != newState;
                var isTerminal = result.State == TransformationState.Succeeded
                              || result.State == TransformationState.Failed
                              || result.State == TransformationState.Cancelled;

                string errorCode = null;
                string errorMessage = null;
                string errorSource = null;
                string errorStage = null;
                string[] stackTrace = null;

                if (result.ErrorDetails != null)
                {
                    errorCode = result.ErrorDetails.ErrorCode;
                    errorMessage = result.ErrorDetails.Message;
                    errorSource = result.ErrorDetails.ErrorSource.ToString();
                    errorStage = result.ErrorDetails.ErrorStage.ToString();
                    if (result.ErrorDetails.StackTrace != null)
                        stackTrace = result.ErrorDetails.StackTrace.ToArray();
                }

                // Parse MLV refresh output on terminal success
                string refreshPolicy = null;
                string totalRowsProcessed = null;
                string totalRowsDropped = null;
                string mlvNamespace = null;
                string mlvName = null;
                string mlvId = null;
                string refreshTimestamp = null;
                string outputMessage = null;
                string totalViolations = null;
                string violationsPerConstraint = null;

                string rawOutput = null;
                if (!string.IsNullOrEmpty(result.Output))
                {
                    rawOutput = result.Output.Length > 4096
                        ? result.Output.Substring(0, 4096)
                        : result.Output;

                    if (isTerminal)
                    {
                        try
                        {
                            if (MLVRefreshOutput.TryParse(node?.Name ?? "", result.Output, out var parsed))
                            {
                                refreshPolicy = parsed.RefreshPolicy;
                                totalRowsProcessed = parsed.TotalRowsProcessed;
                                totalRowsDropped = parsed.TotalRowsDropped;
                                mlvNamespace = parsed.MlvNamespace;
                                mlvName = parsed.MlvName;
                                mlvId = parsed.MlvId;
                                refreshTimestamp = parsed.RefreshTimestamp?.ToString("O");
                                outputMessage = parsed.Message;
                                totalViolations = parsed.TotalViolations;
                                violationsPerConstraint = parsed.ViolationsPerConstraint;
                            }
                        }
                        catch (Exception ex)
                        {
                            System.Diagnostics.Debug.WriteLine($"[EDOG] MLVRefreshOutput parse error: {ex.Message}");
                        }
                    }
                }

                var identity = _transformIdentity.TryGetValue(transformationId, out var idv) ? idv : default;

                EdogTopicRouter.Publish("spark", new
                {
                    sessionTrackingId = _trackingId,
                    @event = isTerminal ? "TransformCompleted" : "TransformPolled",
                    iterationId = _iterationId,
                    transformationId = transformationId.ToString(),
                    nodeName = node?.Name ?? string.Empty,
                    state = newState,
                    previousState = prevState,
                    stateChanged,
                    isTerminal,
                    gtsSessionId = identity.GtsSessionId ?? string.Empty,
                    replId = identity.ReplId ?? string.Empty,
                    durationMs = sw.Elapsed.TotalMilliseconds,
                    retryAfterMs = result.RetryAfter?.TotalMilliseconds,
                    errorCode,
                    errorMessage,
                    errorSource,
                    errorStage,
                    stackTrace,
                    hasOutput = !string.IsNullOrEmpty(result.Output),
                    rawOutput,
                    refreshPolicy,
                    totalRowsProcessed,
                    totalRowsDropped,
                    mlvNamespace,
                    mlvName,
                    mlvId,
                    refreshTimestamp,
                    outputMessage,
                    totalViolations,
                    violationsPerConstraint,
                });

                _lastStates[transformationId] = newState;
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"[EDOG] SparkWrapper.GetTransformStatus publish error: {ex.Message}");
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
                var identity = _transformIdentity.TryGetValue(transformationId, out var idv) ? idv : default;

                EdogTopicRouter.Publish("spark", new
                {
                    sessionTrackingId = _trackingId,
                    @event = "TransformCancelled",
                    iterationId = _iterationId,
                    transformationId = transformationId.ToString(),
                    nodeName = node?.Name ?? string.Empty,
                    state = result.State.ToString(),
                    gtsSessionId = identity.GtsSessionId ?? string.Empty,
                    replId = identity.ReplId ?? string.Empty,
                    durationMs = sw.Elapsed.TotalMilliseconds,
                    error = result.Error,
                    retryAfterMs = result.RetryAfter?.TotalMilliseconds,
                });
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"[EDOG] SparkWrapper.CancelTransform publish error: {ex.Message}");
            }

            return result;
        }

        /// <inheritdoc/>
        public void Dispose()
        {
            try
            {
                var lifetimeMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - _createdAtMs;
                var lastState = _lastStates.Values.LastOrDefault();

                EdogTopicRouter.Publish("spark", new
                {
                    sessionTrackingId = _trackingId,
                    @event = "Disposed",
                    iterationId = _iterationId,
                    lifetimeMs,
                    transformCount = _transformCount,
                    lastState,
                });
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"[EDOG] SparkWrapper.Dispose publish error: {ex.Message}");
            }

            _inner.Dispose();
        }
    }
}
