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
    using System.Text.Json;
    using System.Text.RegularExpressions;
    using System.Threading;
    using System.Threading.Tasks;
    using Microsoft.LiveTable.Service.DataModel;
    using Microsoft.LiveTable.Service.DataModel.Dag;
    using Microsoft.LiveTable.Service.ErrorMapping;
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

        // ADR-008: Channel 1 (HTTP 200 + Failed status) fault injection.
        //
        // When a Channel 1 rule matches at submit time, we let the real submit
        // pass through to the inner client (so a real session is allocated,
        // matching production semantics) and synthesize the Failed status at
        // the FIRST status-poll call. NodeExecutor's poll loop stops on the
        // first terminal state — but we defend against re-firing on duplicate
        // poll attempts by tracking which transformations have already had
        // their status-forge consumed. One firing per transformation, period.
        private readonly ConcurrentDictionary<Guid, byte> _firedStatusForges = new();

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

            // ADR-008: Error Code Simulator fault injection at the ISparkClient
            // semantic layer. The GTS HttpClient bypasses EdogHttpPipelineHandler
            // (see runDAG-lifecycle §4.3.4), so HTTP-level injection misses these
            // calls entirely. We intercept here instead.
            //
            // Channels handled at submit time:
            //   Channel 2 (HTTP non-200): short-circuit — return synthesized
            //              Failed submit response so NodeExecutor never calls _inner.
            //   Channel 4 (timeout):       short-circuit — return the same shape
            //              the inner client produces when it catches TaskCanceledException
            //              at GTSBasedSparkClient.cs:185-202 (Retriable=true,
            //              MLV_SPARK_SESSION_ACQUISITION_TIMEOUT). Never throw — the
            //              inner client itself swallows TCE.
            //   Channel 1 (HTTP 200 + Failed status): pass through — the real
            //              submit allocates a real session; the failure manifests
            //              at GetTransformStatusAsync.
            //
            // Match counters: Channels 2/4 increment here (one fire per submit
            // attempt; matches production HTTP-pipeline semantics under retry).
            // Channel 1 increments at status-poll time.
            try
            {
                string nodeIdKey = node?.NodeId.ToString();
                if (EdogHttpFaultStore.TryPeekSparkFault(nodeIdKey, node?.Name, out var entry))
                {
                    if (string.Equals(entry.Fault, "http_error", StringComparison.OrdinalIgnoreCase)
                        && entry.StatusCode != 200)
                    {
                        sw.Stop();
                        EdogHttpFaultStore.IncrementMatchCount(entry.RuleId);
                        var injected = BuildInjectedSubmitErrorResponse(transformationId, entry);
                        PublishInjectedSubmitEvent(transformationId, node, refreshMode, entry, injected, sw.Elapsed.TotalMilliseconds, channel: 2);
                        return injected;
                    }

                    if (string.Equals(entry.Fault, "timeout", StringComparison.OrdinalIgnoreCase))
                    {
                        sw.Stop();
                        EdogHttpFaultStore.IncrementMatchCount(entry.RuleId);
                        var injected = BuildInjectedTimeoutSubmitResponse(transformationId);
                        PublishInjectedSubmitEvent(transformationId, node, refreshMode, entry, injected, sw.Elapsed.TotalMilliseconds, channel: 4);
                        return injected;
                    }

                    // Channel 1 (http_error with StatusCode == 200): fall through;
                    // GetTransformStatusAsync below will synthesize the Failed state.
                }
            }
            catch (Exception ex)
            {
                // Fault-injection must never break the real submit path. Log and
                // fall through to the inner client.
                System.Diagnostics.Debug.WriteLine($"[EDOG] SparkWrapper.SendTransform fault-injection error: {ex.Message}");
                sw.Restart();
            }

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

            // ADR-008: Channel 1 (GTS Status Forge) injection.
            //
            // We arrived here because the Channel 1 submit passed through to the
            // real inner client (so a real session was allocated). The first
            // status poll for this transformationId returns the synthesized
            // Failed response carrying the user's chosen MLV_* error code.
            // Subsequent polls (none expected — NodeExecutor stops on terminal
            // state — but defended against) pass through to the inner client.
            try
            {
                if (!_firedStatusForges.ContainsKey(transformationId))
                {
                    string nodeIdKey = node?.NodeId.ToString();
                    if (EdogHttpFaultStore.TryPeekSparkFault(nodeIdKey, node?.Name, out var entry)
                        && string.Equals(entry.Fault, "http_error", StringComparison.OrdinalIgnoreCase)
                        && entry.StatusCode == 200)
                    {
                        // Mark first so a concurrent poll on the same transformationId
                        // cannot double-fire (TryAdd is the atomic gate).
                        if (_firedStatusForges.TryAdd(transformationId, 1))
                        {
                            sw.Stop();
                            EdogHttpFaultStore.IncrementMatchCount(entry.RuleId);
                            var injected = BuildInjectedStatusForgeResponse(transformationId, entry);
                            PublishInjectedStatusEvent(transformationId, node, entry, injected, sw.Elapsed.TotalMilliseconds);
                            _lastStates[transformationId] = injected.State.ToString();
                            return injected;
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"[EDOG] SparkWrapper.GetTransformStatus fault-injection error: {ex.Message}");
                sw.Restart();
            }

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

        // ── ADR-008 fault-injection helpers ──────────────────────────────
        //
        // These mirror the response shapes the inner GTSBasedSparkClient
        // produces for the same scenarios. Synthesis is at the semantic
        // layer (TransformExecution*Response) — no HttpResponseMessage
        // forgery, no FLT response-parser dependency.

        /// <summary>
        /// Channel 2 — GTS Submit Forge. Synthesizes a Failed submit response
        /// matching the shape that <c>ConvertToTransformAcceptanceResponseAsync</c>
        /// produces for the same HTTP status code. Retriable is set per the same
        /// rules: <c>true</c> for 429/430/5xx; <c>false</c> otherwise.
        /// </summary>
        private static TransformExecutionSubmitResponse BuildInjectedSubmitErrorResponse(
            Guid transformationId, HttpFaultEntry entry)
        {
            ParseInjectedError(entry, out var errorCodeString, out var message);

            // Mirror ConvertToTransformAcceptanceResponseAsync retry semantics:
            //   429 / 430 / >=500 → Retriable=true (matches lines 486-503 of
            //                       GTSBasedSparkClient.cs).
            //   Everything else  → Retriable=false.
            bool retriable = entry.StatusCode == 429
                          || entry.StatusCode == 430
                          || entry.StatusCode >= 500;

            var response = new TransformExecutionSubmitResponse(transformationId, TransformationState.Failed)
            {
                Retriable = retriable,
            };

            // SetError requires the FLT ErrorCode enum. If the catalog code is
            // not a member of the FLT enum, fall back to the generic submission-
            // failed code; the user-facing message still carries the simulator's
            // chosen error string so the injection is visible end-to-end.
            ErrorCode errorCode = ErrorCode.MLV_SPARK_SESSION_REQUEST_SUBMISSION_FAILED;
            if (!string.IsNullOrEmpty(errorCodeString)
                && Enum.TryParse<ErrorCode>(errorCodeString, ignoreCase: true, out var parsed))
            {
                errorCode = parsed;
            }

            response.SetError(errorCode, message);
            return response;
        }

        /// <summary>
        /// Channel 4 — Exception Injection. Synthesizes the exact response
        /// that <see cref="GTSBasedSparkClient"/> produces when it catches
        /// <see cref="TaskCanceledException"/> at lines 185-202: Failed state,
        /// Retriable=true, error code MLV_SPARK_SESSION_ACQUISITION_TIMEOUT.
        /// Never throws — the inner client itself never lets the TCE escape,
        /// and we preserve that contract.
        /// </summary>
        private static TransformExecutionSubmitResponse BuildInjectedTimeoutSubmitResponse(Guid transformationId)
        {
            var response = new TransformExecutionSubmitResponse(transformationId, TransformationState.Failed)
            {
                Retriable = true,
            };
            response.SetError(ErrorCode.MLV_SPARK_SESSION_ACQUISITION_TIMEOUT, "Simulated Spark session acquisition timeout (EDOG Error Code Simulator)");
            return response;
        }

        /// <summary>
        /// Channel 1 — GTS Status Forge. Synthesizes the Failed status-poll
        /// response carrying the user's chosen MLV_* error code in
        /// <see cref="TransformExecutionResponse.ErrorDetails"/>. NodeExecutor
        /// reads <c>ErrorDetails.ErrorCode</c> at <c>NodeExecutor.cs:629</c>
        /// (and earlier at line 144) and surfaces it through the normal
        /// failure path.
        /// </summary>
        private static TransformExecutionResponse BuildInjectedStatusForgeResponse(
            Guid transformationId, HttpFaultEntry entry)
        {
            ParseInjectedError(entry, out var errorCodeString, out var message);
            ParseInjectedErrorSource(entry, out var errorSource);

            var errorDetails = new TransformErrorDetails(
                errorCode: errorCodeString ?? "MLV_UNKNOWN_ERROR",
                message: message ?? $"[{errorCodeString ?? "MLV_UNKNOWN_ERROR"}] Simulated GTS status failure (EDOG Error Code Simulator) failureType: {errorSource}Error",
                errorSource: errorSource);

            return new TransformExecutionResponse(transformationId, TransformationState.Failed, errorDetails);
        }

        /// <summary>
        /// Extracts the user's chosen error code + message from the rule's
        /// pre-built response body. Bodies are produced by
        /// <see cref="EdogErrorSimEngine.BuildGtsStatusForgeBody"/> /
        /// <see cref="EdogErrorSimEngine.BuildGtsSubmitErrorBody"/> with
        /// well-known field names:
        ///   Channel 1: <c>{"id":..., "state":"Failed", "error":{"errorCode":..., "message":..., "errorSource":...}}</c>
        ///   Channel 2: <c>{"error":{"code":..., "message":...}}</c>
        /// We probe both shapes. Any parse failure returns null/null so callers
        /// can fall back to the generic shape.
        /// </summary>
        private static void ParseInjectedError(HttpFaultEntry entry, out string errorCode, out string message)
        {
            errorCode = null;
            message = null;
            if (entry == null || string.IsNullOrEmpty(entry.ResponseBody)) return;

            try
            {
                using var doc = JsonDocument.Parse(entry.ResponseBody);
                if (doc.RootElement.ValueKind != JsonValueKind.Object) return;
                if (!doc.RootElement.TryGetProperty("error", out var errorElem)
                    || errorElem.ValueKind != JsonValueKind.Object) return;

                // Channel 1 uses "errorCode"; Channel 2 uses "code".
                // Channel 2 now includes "edogErrorCode" which holds the exact FLT enum name.
                if (errorElem.TryGetProperty("edogErrorCode", out var eec) && eec.ValueKind == JsonValueKind.String)
                {
                    errorCode = eec.GetString();
                }
                else if (errorElem.TryGetProperty("errorCode", out var ec) && ec.ValueKind == JsonValueKind.String)
                {
                    errorCode = ec.GetString();
                }
                else if (errorElem.TryGetProperty("code", out var c) && c.ValueKind == JsonValueKind.String)
                {
                    errorCode = c.GetString();
                }

                if (errorElem.TryGetProperty("message", out var m) && m.ValueKind == JsonValueKind.String)
                {
                    message = m.GetString();
                }
            }
            catch (Exception ex)
            {
                Debug.WriteLine($"[EDOG] SparkWrapper.ParseInjectedError: {ex.Message}");
            }
        }

        /// <summary>
        /// Parses <c>error.errorSource</c> from a Channel 1 response body into the
        /// FLT <see cref="ErrorSource"/> enum. Defaults to <c>System</c> when absent
        /// or unrecognized — the same default the inner client uses when GTS omits
        /// the field.
        /// </summary>
        private static void ParseInjectedErrorSource(HttpFaultEntry entry, out ErrorSource errorSource)
        {
            errorSource = ErrorSource.System;
            if (entry == null || string.IsNullOrEmpty(entry.ResponseBody)) return;

            try
            {
                using var doc = JsonDocument.Parse(entry.ResponseBody);
                if (doc.RootElement.ValueKind != JsonValueKind.Object) return;
                if (!doc.RootElement.TryGetProperty("error", out var errorElem)
                    || errorElem.ValueKind != JsonValueKind.Object) return;
                if (!errorElem.TryGetProperty("errorSource", out var es)
                    || es.ValueKind != JsonValueKind.String) return;

                if (Enum.TryParse<ErrorSource>(es.GetString(), ignoreCase: true, out var parsed))
                {
                    errorSource = parsed;
                }
            }
            catch (Exception ex)
            {
                Debug.WriteLine($"[EDOG] SparkWrapper.ParseInjectedErrorSource: {ex.Message}");
            }
        }

        /// <summary>
        /// Emits a <c>SparkFaultInjected</c> event on the <c>spark</c> topic when
        /// a Channel 2 or Channel 4 fault is injected at submit time. Lets the
        /// Studio UI distinguish "this transform failed because of a real GTS
        /// error" from "this transform failed because the simulator injected
        /// a fault." Never throws — pure diagnostic.
        /// </summary>
        private void PublishInjectedSubmitEvent(
            Guid transformationId,
            Node node,
            RefreshMode refreshMode,
            HttpFaultEntry entry,
            TransformExecutionSubmitResponse injected,
            double durationMs,
            int channel)
        {
            try
            {
                EdogTopicRouter.Publish("spark", new
                {
                    sessionTrackingId = _trackingId,
                    @event = "SparkFaultInjected",
                    injectionPhase = "Submit",
                    channel,
                    iterationId = _iterationId,
                    transformationId = transformationId.ToString(),
                    nodeName = node?.Name ?? string.Empty,
                    nodeKind = node?.Kind ?? string.Empty,
                    nodeId = node?.NodeId.ToString() ?? string.Empty,
                    refreshMode = refreshMode.ToString(),
                    state = injected.State.ToString(),
                    retriable = injected.Retriable,
                    error = injected.Error,
                    ruleId = entry?.RuleId,
                    targetSubstring = entry?.TargetSubstring,
                    statusCode = entry?.StatusCode,
                    fault = entry?.Fault,
                    durationMs,
                });
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"[EDOG] SparkWrapper.PublishInjectedSubmitEvent error: {ex.Message}");
            }
        }

        /// <summary>
        /// Emits a <c>SparkFaultInjected</c> event on the <c>spark</c> topic when
        /// a Channel 1 fault is injected at status-poll time.
        /// </summary>
        private void PublishInjectedStatusEvent(
            Guid transformationId,
            Node node,
            HttpFaultEntry entry,
            TransformExecutionResponse injected,
            double durationMs)
        {
            try
            {
                EdogTopicRouter.Publish("spark", new
                {
                    sessionTrackingId = _trackingId,
                    @event = "SparkFaultInjected",
                    injectionPhase = "Status",
                    channel = 1,
                    iterationId = _iterationId,
                    transformationId = transformationId.ToString(),
                    nodeName = node?.Name ?? string.Empty,
                    nodeId = node?.NodeId.ToString() ?? string.Empty,
                    state = injected.State.ToString(),
                    errorCode = injected.ErrorDetails?.ErrorCode,
                    errorMessage = injected.ErrorDetails?.Message,
                    errorSource = injected.ErrorDetails?.ErrorSource.ToString(),
                    ruleId = entry?.RuleId,
                    targetSubstring = entry?.TargetSubstring,
                    statusCode = entry?.StatusCode,
                    fault = entry?.Fault,
                    durationMs,
                });
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"[EDOG] SparkWrapper.PublishInjectedStatusEvent error: {ex.Message}");
            }
        }
    }
}
