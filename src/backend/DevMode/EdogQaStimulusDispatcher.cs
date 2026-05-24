// <copyright file="EdogQaStimulusDispatcher.cs" company="Microsoft">
// Copyright (c) Microsoft Corporation. All rights reserved.
// </copyright>

#nullable disable
#pragma warning disable // DevMode-only file — suppress all warnings

namespace Microsoft.LiveTable.Service.DevMode
{
    using System;
    using System.Collections.Generic;
    using System.Diagnostics;
    using System.Linq;
    using System.Net.Http;
    using System.Reflection;
    using System.Text;
    using System.Text.Json;
    using System.Threading;
    using System.Threading.Tasks;

    using Microsoft.AspNetCore.SignalR;
    using Microsoft.Extensions.DependencyInjection;
    using Microsoft.Extensions.Logging;

    // ──────────────────────────────────────────────
    // Strategy interface
    // ──────────────────────────────────────────────

    /// <summary>
    /// Handles execution of a single stimulus type.
    /// Implementations are stateless — receive spec, return result.
    /// </summary>
    internal interface IStimulusHandler
    {
        /// <summary>The stimulus type this handler services.</summary>
        StimulusType Type { get; }

        /// <summary>Execute the stimulus and return a result with timing.</summary>
        Task<StimulusResult> ExecuteAsync(Stimulus stimulus, CancellationToken ct);
    }

    // ──────────────────────────────────────────────
    // Dispatcher (orchestrator)
    // ──────────────────────────────────────────────

    /// <summary>
    /// Routes stimulus execution to type-specific <see cref="IStimulusHandler"/> implementations.
    /// Each handler is stateless — receives spec, returns result.
    ///
    /// Performance targets per stimulus type:
    ///   - http_request:       &lt; 1s (network round-trip)
    ///   - signalr_broadcast:  &lt; 100ms (in-process)
    ///   - dag_trigger:        &lt; 30s (DAG execution, async)
    ///   - file_event:         &lt; 500ms (disk I/O)
    ///   - timer_tick:         &lt; 10s (wait for scheduled event)
    ///   - di_invocation:      &lt; 5s (service method execution)
    /// </summary>
    public sealed class EdogQaStimulusDispatcher
    {
        private const string ClientName = "edog-stimulus";
        private const string ControlTokenHeaderName = "X-EDOG-Control-Token";
        private const int CaptureBufferBytes = 65_536; // 64KB

        private static readonly IReadOnlyDictionary<StimulusType, int> ContractDispatchTimeoutsMs
            = new Dictionary<StimulusType, int>
            {
                [StimulusType.HttpRequest] = 10_000,
                [StimulusType.DiInvocation] = 5_000,
                [StimulusType.SignalRBroadcast] = 5_000,
                [StimulusType.FileEvent] = 10_000,
                [StimulusType.TimerTick] = 15_000,
                [StimulusType.DagTrigger] = 30_000,
            };

        private readonly Dictionary<StimulusType, IStimulusHandler> _handlers;
        private readonly IHttpClientFactory _httpClientFactory;
        private readonly ILogger _logger;
        private readonly int _fltPort;

        /// <summary>
        /// Initializes a new instance of the <see cref="EdogQaStimulusDispatcher"/> class.
        /// </summary>
        public EdogQaStimulusDispatcher(
            IHttpClientFactory httpClientFactory,
            IServiceProvider serviceProvider,
            int fltPort,
            ILogger logger)
        {
            _httpClientFactory = httpClientFactory;
            _fltPort = fltPort;
            _logger = logger;

            var handlers = new IStimulusHandler[]
            {
                new HttpStimulusHandler(httpClientFactory, fltPort, logger),
                new SignalRBroadcastStimulusHandler(serviceProvider, logger),
                new DagTriggerStimulusHandler(httpClientFactory, fltPort, logger),
                new FileEventStimulusHandler(serviceProvider, logger),
                new TimerTickStimulusHandler(logger),
                new DiInvocationStimulusHandler(serviceProvider, logger),
            };

            _handlers = handlers.ToDictionary(h => h.Type);
        }

        /// <summary>
        /// Execute a stimulus with an optional per-scenario timeout.
        /// </summary>
        /// <param name="stimulus">The stimulus definition from the scenario.</param>
        /// <param name="timeoutMs">Scenario-level timeout in milliseconds.</param>
        /// <param name="ct">Cancellation token (e.g. from global kill switch).</param>
        /// <returns>A <see cref="StimulusResult"/> with timing and any errors.</returns>
        public async Task<StimulusResult> ExecuteAsync(Stimulus stimulus, int timeoutMs, CancellationToken ct)
        {
            if (stimulus == null)
                return new StimulusResult { Success = false, Error = "Stimulus is null" };

            if (!_handlers.TryGetValue(stimulus.Type, out var handler))
                return new StimulusResult { Success = false, Error = $"Unknown stimulus type: {stimulus.Type}" };

            using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeoutCts.CancelAfter(timeoutMs);

            var sw = Stopwatch.StartNew();
            try
            {
                var result = await handler.ExecuteAsync(stimulus, timeoutCts.Token).ConfigureAwait(false);
                return result;
            }
            catch (OperationCanceledException) when (!ct.IsCancellationRequested)
            {
                // Scenario timeout (not a global abort)
                sw.Stop();
                return new StimulusResult
                {
                    Success = false,
                    DurationMs = sw.ElapsedMilliseconds,
                    Error = $"Stimulus timed out after {timeoutMs}ms",
                };
            }
            catch (OperationCanceledException)
            {
                // Global cancellation — propagate
                throw;
            }
            catch (Exception ex)
            {
                sw.Stop();
                _logger?.LogWarning(ex, "[QA] Stimulus {Type} failed unexpectedly", stimulus.Type);
                return new StimulusResult
                {
                    Success = false,
                    DurationMs = sw.ElapsedMilliseconds,
                    Error = ex.Message,
                };
            }
        }

        /// <summary>
        /// Convenience overload without explicit timeout (uses caller's <paramref name="ct"/> only).
        /// </summary>
        public Task<StimulusResult> ExecuteAsync(Stimulus stimulus, CancellationToken ct)
            => ExecuteAsync(stimulus, timeoutMs: 30_000, ct);

        /// <summary>Fetches the P10 QA dispatch capability document.</summary>
        internal async Task<object> GetCapabilitiesAsync(CancellationToken ct)
        {
            using var request = new HttpRequestMessage(
                HttpMethod.Get,
                BuildQaUri("/devmode/qa/capabilities"));

            return await SendContractRequestAsync(request, timeoutMs: 5_000, ct).ConfigureAwait(false);
        }

        /// <summary>Dispatches a P10 sync stimulus for DiInvocation, SignalRBroadcast, FileEvent, or TimerTick.</summary>
        internal async Task<object> DispatchSyncAsync(Stimulus stimulus, string controlToken, CancellationToken ct)
        {
            if (stimulus == null)
            {
                return CreateErrorEnvelope("Stimulus is null.");
            }

            if (stimulus.Type != StimulusType.DiInvocation
                && stimulus.Type != StimulusType.SignalRBroadcast
                && stimulus.Type != StimulusType.FileEvent
                && stimulus.Type != StimulusType.TimerTick)
            {
                return CreateErrorEnvelope(
                    "/devmode/qa/dispatch supports DiInvocation, SignalRBroadcast, FileEvent, and TimerTick stimuli only.");
            }

            var dispatchPayload = BuildDispatchPayload(stimulus);
            using var request = new HttpRequestMessage(
                HttpMethod.Post,
                BuildQaUri("/devmode/qa/dispatch"))
            {
                Content = CreateJsonContent(dispatchPayload),
            };

            ApplyControlTokenHeader(request, controlToken);
            return await SendContractRequestAsync(request, GetContractTimeoutMs(stimulus), ct).ConfigureAwait(false);
        }

        /// <summary>Dispatches an async DAG stimulus and returns the dispatchId.</summary>
        internal async Task<string> DispatchDagAsync(Stimulus stimulus, string controlToken, CancellationToken ct)
        {
            if (stimulus == null)
            {
                throw new ArgumentNullException(nameof(stimulus));
            }

            var dispatchPayload = BuildDispatchPayload(stimulus);
            using var request = new HttpRequestMessage(
                HttpMethod.Post,
                BuildQaUri("/devmode/qa/dispatch/async"))
            {
                Content = CreateJsonContent(dispatchPayload),
            };

            ApplyControlTokenHeader(request, controlToken);
            var envelope = await SendContractRequestAsync(request, GetContractTimeoutMs(stimulus), ct).ConfigureAwait(false);
            return envelope?.CorrelationId ?? ReadStringFromDynamic(envelope, "dispatchId");
        }

        /// <summary>Polls the async DAG dispatch status by dispatchId.</summary>
        internal async Task<object> PollDagAsync(string dispatchId, CancellationToken ct)
        {
            if (string.IsNullOrWhiteSpace(dispatchId))
            {
                return CreateErrorEnvelope("dispatchId is required.");
            }

            using var request = new HttpRequestMessage(
                HttpMethod.Get,
                BuildQaUri($"/devmode/qa/dispatch/{Uri.EscapeDataString(dispatchId)}"));

            return await SendContractRequestAsync(request, ContractDispatchTimeoutsMs[StimulusType.DagTrigger], ct).ConfigureAwait(false);
        }

        /// <summary>Cancels an in-flight async DAG dispatch.</summary>
        internal async Task CancelDagAsync(string dispatchId, CancellationToken ct)
        {
            if (string.IsNullOrWhiteSpace(dispatchId))
            {
                return;
            }

            using var request = new HttpRequestMessage(
                HttpMethod.Delete,
                BuildQaUri($"/devmode/qa/dispatch/{Uri.EscapeDataString(dispatchId)}"));

            var envelope = await SendContractRequestAsync(
                request,
                ContractDispatchTimeoutsMs[StimulusType.DagTrigger],
                ct).ConfigureAwait(false);

            if (envelope != null && !envelope.Success && !string.IsNullOrWhiteSpace(envelope.Error))
            {
                throw new InvalidOperationException(envelope.Error);
            }
        }

        private Uri BuildQaUri(string path)
        {
            return new Uri($"http://localhost:{_fltPort}{(path?.StartsWith("/") == true ? string.Empty : "/")}{path}");
        }

        private static void ApplyControlTokenHeader(HttpRequestMessage request, string controlToken)
        {
            if (request == null || string.IsNullOrWhiteSpace(controlToken))
            {
                return;
            }

            request.Headers.Remove(ControlTokenHeaderName);
            request.Headers.TryAddWithoutValidation(ControlTokenHeaderName, controlToken);
        }

        private static StringContent CreateJsonContent(object payload)
        {
            return new StringContent(
                JsonSerializer.Serialize(payload),
                Encoding.UTF8,
                "application/json");
        }

        /// <summary>
        /// Maps an EDOG <see cref="Stimulus"/> to the FLT <c>QaDispatchRequest</c> shape:
        /// <c>{ StimulusKind, SlotId, Params, TimeoutMs, CorrelationId }</c>.
        /// The FLT controller binds to this flat DTO, not the EDOG discriminated-union model.
        /// </summary>
        private static object BuildDispatchPayload(Stimulus stimulus)
        {
            var kind = stimulus.Type.ToString();
            string slotId = null;
            Dictionary<string, object> @params = new();
            string correlationId = null;

            switch (stimulus.Type)
            {
                case StimulusType.DiInvocation when stimulus.DiInvocation != null:
                    slotId = $"{stimulus.DiInvocation.ServiceType}.{stimulus.DiInvocation.Method}";
                    @params["serviceType"] = stimulus.DiInvocation.ServiceType;
                    @params["method"] = stimulus.DiInvocation.Method;
                    if (stimulus.DiInvocation.Args?.Count > 0)
                        @params["args"] = stimulus.DiInvocation.Args;
                    break;

                case StimulusType.SignalRBroadcast when stimulus.SignalRBroadcast != null:
                    slotId = $"{stimulus.SignalRBroadcast.Hub}.{stimulus.SignalRBroadcast.Method}";
                    @params["hub"] = stimulus.SignalRBroadcast.Hub;
                    @params["method"] = stimulus.SignalRBroadcast.Method;
                    correlationId = Guid.NewGuid().ToString("N");
                    break;

                case StimulusType.DagTrigger when stimulus.DagTrigger != null:
                    slotId = stimulus.DagTrigger.IterationId ?? "current";
                    @params["iterationId"] = stimulus.DagTrigger.IterationId;
                    if (stimulus.DagTrigger.NodeFilter != null)
                        @params["nodeFilter"] = stimulus.DagTrigger.NodeFilter;
                    break;

                case StimulusType.FileEvent when stimulus.FileEvent != null:
                    slotId = stimulus.FileEvent.Path;
                    @params["path"] = stimulus.FileEvent.Path;
                    if (stimulus.FileEvent.Content != null)
                        @params["content"] = stimulus.FileEvent.Content;
                    break;

                case StimulusType.TimerTick when stimulus.TimerTick != null:
                    slotId = stimulus.TimerTick.TickSource;
                    @params["tickSource"] = stimulus.TimerTick.TickSource;
                    if (stimulus.TimerTick.Topic != null)
                        @params["topic"] = stimulus.TimerTick.Topic;
                    break;
            }

            return new
            {
                StimulusKind = kind,
                SlotId = slotId,
                Params = @params,
                CorrelationId = correlationId,
            };
        }

        /// <summary>Reads a string property from a dynamic/anonymous object by reflection.</summary>
        private static string ReadStringFromDynamic(object obj, string propertyName)
        {
            if (obj == null) return null;
            var prop = obj.GetType().GetProperty(propertyName,
                System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.IgnoreCase);
            return prop?.GetValue(obj)?.ToString();
        }

        private int GetContractTimeoutMs(Stimulus stimulus)
        {
            if (stimulus != null && ContractDispatchTimeoutsMs.TryGetValue(stimulus.Type, out var timeoutMs))
            {
                return timeoutMs;
            }

            return 10_000;
        }

        private async Task<ContractDispatchEnvelope> SendContractRequestAsync(
            HttpRequestMessage request,
            int timeoutMs,
            CancellationToken ct)
        {
            using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeoutCts.CancelAfter(timeoutMs);

            try
            {
                var client = _httpClientFactory.CreateClient(ClientName);
                using var response = await client.SendAsync(
                    request,
                    HttpCompletionOption.ResponseHeadersRead,
                    timeoutCts.Token).ConfigureAwait(false);

                return await ParseContractResponseAsync(response, timeoutMs, timeoutCts.Token).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (!ct.IsCancellationRequested)
            {
                return CreateTimeoutEnvelope(timeoutMs);
            }
        }

        private async Task<ContractDispatchEnvelope> ParseContractResponseAsync(
            HttpResponseMessage response,
            int timeoutMs,
            CancellationToken ct)
        {
            var envelope = new ContractDispatchEnvelope
            {
                Success = response.IsSuccessStatusCode,
                StatusCode = (int)response.StatusCode,
            };

            var body = await ReadContentPreviewAsync(response.Content, ct).ConfigureAwait(false);
            if (string.IsNullOrWhiteSpace(body))
            {
                if (!response.IsSuccessStatusCode)
                {
                    envelope.Verdict = ScenarioVerdict.Inconclusive.ToString();
                    envelope.Error = $"Dispatch endpoint returned HTTP {(int)response.StatusCode}.";
                }

                return envelope;
            }

            try
            {
                using var document = JsonDocument.Parse(body);
                var root = document.RootElement;
                envelope.Payload = ExtractValue(root);
                envelope.Success = ReadBool(root, "success") ?? envelope.Success;
                envelope.Verdict = ReadString(root, "verdict")
                    ?? ReadString(root, "status")
                    ?? (envelope.Success ? null : ScenarioVerdict.Inconclusive.ToString());
                envelope.CorrelationId = ReadString(root, "correlationId")
                    ?? ReadString(root, "dispatchId");
                envelope.Error = ReadString(root, "error")
                    ?? ReadString(root, "message")
                    ?? ReadString(root, "detail");
                envelope.CaptureBuffer = ParseCaptureBuffer(root);
                return envelope;
            }
            catch (JsonException)
            {
                envelope.Payload = body;
                envelope.Error = envelope.Success
                    ? null
                    : $"Dispatch endpoint returned HTTP {(int)response.StatusCode}.";
                envelope.Verdict ??= envelope.Success ? null : ScenarioVerdict.Inconclusive.ToString();
                return envelope;
            }
        }

        private static ContractDispatchEnvelope CreateTimeoutEnvelope(int timeoutMs)
        {
            return new ContractDispatchEnvelope
            {
                Success = false,
                Verdict = ScenarioVerdict.Inconclusive.ToString(),
                Error = $"Dispatch timed out after {timeoutMs}ms and was normalized to {ScenarioVerdict.Inconclusive}.",
            };
        }

        private static ContractDispatchEnvelope CreateErrorEnvelope(string message)
        {
            return new ContractDispatchEnvelope
            {
                Success = false,
                Verdict = ScenarioVerdict.Inconclusive.ToString(),
                Error = message,
            };
        }

        private static async Task<string> ReadContentPreviewAsync(HttpContent content, CancellationToken ct)
        {
            if (content == null)
            {
                return null;
            }

            using var stream = await content.ReadAsStreamAsync(ct).ConfigureAwait(false);
            var buffer = new byte[CaptureBufferBytes];
            var offset = 0;
            while (offset < buffer.Length)
            {
                var read = await stream.ReadAsync(buffer, offset, buffer.Length - offset, ct).ConfigureAwait(false);
                if (read <= 0)
                {
                    break;
                }

                offset += read;
            }

            return Encoding.UTF8.GetString(buffer, 0, offset);
        }

        private static string ReadString(JsonElement root, string propertyName)
        {
            var match = FindProperty(root, propertyName);
            if (match == null)
            {
                return null;
            }

            return match.Value.ValueKind switch
            {
                JsonValueKind.String => match.Value.GetString(),
                JsonValueKind.Number => match.Value.ToString(),
                JsonValueKind.True => bool.TrueString,
                JsonValueKind.False => bool.FalseString,
                _ => null,
            };
        }

        private static bool? ReadBool(JsonElement root, string propertyName)
        {
            var match = FindProperty(root, propertyName);
            if (match == null)
            {
                return null;
            }

            return match.Value.ValueKind switch
            {
                JsonValueKind.True => true,
                JsonValueKind.False => false,
                JsonValueKind.String when bool.TryParse(match.Value.GetString(), out var parsed) => parsed,
                _ => null,
            };
        }

        private static JsonElement? FindProperty(JsonElement root, string propertyName)
        {
            if (root.ValueKind == JsonValueKind.Object)
            {
                foreach (var property in root.EnumerateObject())
                {
                    if (string.Equals(property.Name, propertyName, StringComparison.OrdinalIgnoreCase))
                    {
                        return property.Value;
                    }

                    var nested = FindProperty(property.Value, propertyName);
                    if (nested != null)
                    {
                        return nested;
                    }
                }
            }
            else if (root.ValueKind == JsonValueKind.Array)
            {
                foreach (var item in root.EnumerateArray())
                {
                    var nested = FindProperty(item, propertyName);
                    if (nested != null)
                    {
                        return nested;
                    }
                }
            }

            return null;
        }

        private static List<TopicEvent> ParseCaptureBuffer(JsonElement root)
        {
            var match = FindProperty(root, "captureBuffer") ?? FindProperty(root, "capturedEvents");
            return match == null ? new List<TopicEvent>() : ParseCaptureBufferValue(match.Value);
        }

        private static List<TopicEvent> ParseCaptureBufferValue(JsonElement value)
        {
            var events = new List<TopicEvent>();
            switch (value.ValueKind)
            {
                case JsonValueKind.Array:
                    foreach (var item in value.EnumerateArray())
                    {
                        var evt = DeserializeTopicEvent(item);
                        if (evt != null)
                        {
                            events.Add(evt);
                        }
                    }
                    break;

                case JsonValueKind.Object:
                    if (FindProperty(value, "events") is JsonElement nestedEvents)
                    {
                        events.AddRange(ParseCaptureBufferValue(nestedEvents));
                    }
                    else
                    {
                        var evt = DeserializeTopicEvent(value);
                        if (evt != null)
                        {
                            events.Add(evt);
                        }
                    }
                    break;

                case JsonValueKind.String:
                    var raw = value.GetString();
                    if (string.IsNullOrWhiteSpace(raw))
                    {
                        break;
                    }

                    try
                    {
                        using var nestedDoc = JsonDocument.Parse(raw);
                        events.AddRange(ParseCaptureBufferValue(nestedDoc.RootElement));
                    }
                    catch (JsonException)
                    {
                        foreach (var line in raw.Split(new[] { "\r\n", "\n" }, StringSplitOptions.RemoveEmptyEntries))
                        {
                            try
                            {
                                using var lineDoc = JsonDocument.Parse(line);
                                var evt = DeserializeTopicEvent(lineDoc.RootElement);
                                if (evt != null)
                                {
                                    events.Add(evt);
                                }
                            }
                            catch (JsonException)
                            {
                                // Ignore malformed capture-buffer fragments.
                            }
                        }
                    }
                    break;
            }

            return events;
        }

        private static TopicEvent DeserializeTopicEvent(JsonElement value)
        {
            try
            {
                if (value.ValueKind != JsonValueKind.Object)
                {
                    return null;
                }

                if (FindProperty(value, "topic") == null)
                {
                    return null;
                }

                return JsonSerializer.Deserialize<TopicEvent>(value.GetRawText());
            }
            catch
            {
                return null;
            }
        }

        private static object ExtractValue(JsonElement element)
        {
            return element.ValueKind switch
            {
                JsonValueKind.Object => element.EnumerateObject()
                    .ToDictionary(property => property.Name, property => ExtractValue(property.Value), StringComparer.Ordinal),
                JsonValueKind.Array => element.EnumerateArray().Select(ExtractValue).ToList(),
                JsonValueKind.String => element.GetString(),
                JsonValueKind.Number when element.TryGetInt64(out var longValue) => longValue,
                JsonValueKind.Number => element.GetDouble(),
                JsonValueKind.True => true,
                JsonValueKind.False => false,
                JsonValueKind.Null => null,
                _ => element.GetRawText(),
            };
        }

        internal sealed class ContractDispatchEnvelope
        {
            public bool Success { get; set; }

            public int? StatusCode { get; set; }

            public string Verdict { get; set; }

            public string CorrelationId { get; set; }

            public string Error { get; set; }

            public object Payload { get; set; }

            public List<TopicEvent> CaptureBuffer { get; set; } = new();
        }
    }

    // ──────────────────────────────────────────────
    // HttpStimulusHandler
    // ──────────────────────────────────────────────

    /// <summary>
    /// Sends an HTTP request to FLT's internal Kestrel endpoints.
    /// The request flows through the full ASP.NET Core pipeline,
    /// including <see cref="EdogHttpPipelineHandler"/> which captures to the "http" topic.
    /// </summary>
    internal sealed class HttpStimulusHandler : IStimulusHandler
    {
        private const int MaxResponsePreviewBytes = 4096;
        private const string ClientName = "edog-stimulus";

        private readonly IHttpClientFactory _httpClientFactory;
        private readonly int _fltPort;
        private readonly ILogger _logger;

        public HttpStimulusHandler(IHttpClientFactory httpClientFactory, int fltPort, ILogger logger)
        {
            _httpClientFactory = httpClientFactory;
            _fltPort = fltPort;
            _logger = logger;
        }

        public StimulusType Type => StimulusType.HttpRequest;

        public async Task<StimulusResult> ExecuteAsync(Stimulus stimulus, CancellationToken ct)
        {
            var spec = stimulus.HttpRequest;
            if (spec == null)
                return new StimulusResult { Success = false, Error = "HttpRequest spec is null" };

            // ── Session-context rewriting ──────────────────────────────
            // The LLM generates placeholder GUIDs and fake auth tokens
            // because it doesn't have access to the live session. Rewrite
            // path placeholders with real workspace/lakehouse IDs from the
            // EdogSessionRegistry, and inject the real MWC control-token
            // header so the FLT API authenticates the request.
            var rewrittenPath = RewritePathPlaceholders(spec.Path);
            var rewrittenHeaders = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            if (spec.Headers != null)
            {
                foreach (var (key, value) in spec.Headers)
                    rewrittenHeaders[key] = value;
            }
            RewriteAuthHeader(rewrittenHeaders);

            var request = new HttpRequestMessage
            {
                Method = new HttpMethod(spec.Method ?? "GET"),
                RequestUri = BuildUri(rewrittenPath),
            };

            foreach (var (key, value) in rewrittenHeaders)
                request.Headers.TryAddWithoutValidation(key, value);

            if (spec.Body != null)
            {
                var bodyJson = spec.Body is string s ? s : JsonSerializer.Serialize(spec.Body);
                request.Content = new StringContent(bodyJson, Encoding.UTF8, spec.ContentType ?? "application/json");
            }

            var sw = Stopwatch.StartNew();
            try
            {
                var client = _httpClientFactory.CreateClient(ClientName);
                var response = await client.SendAsync(request, ct).ConfigureAwait(false);
                sw.Stop();

                return new StimulusResult
                {
                    Success = true,
                    StatusCode = (int)response.StatusCode,
                    DurationMs = sw.ElapsedMilliseconds,
                    ResponsePreview = await CapturePreviewAsync(response.Content, ct).ConfigureAwait(false),
                };
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                sw.Stop();
                _logger?.LogDebug(ex, "[QA] HTTP stimulus failed: {Path}", spec.Path);
                return new StimulusResult
                {
                    Success = false,
                    Error = ex.Message,
                    DurationMs = sw.ElapsedMilliseconds,
                };
            }
        }

        private Uri BuildUri(string path)
        {
            if (Uri.TryCreate(path, UriKind.Absolute, out var absolute))
                return absolute;

            return new Uri($"http://localhost:{_fltPort}{(path?.StartsWith("/") == true ? "" : "/")}{path}");
        }

        private static async Task<string> CapturePreviewAsync(HttpContent content, CancellationToken ct)
        {
            if (content == null) return null;
            try
            {
                var body = await content.ReadAsStringAsync(ct).ConfigureAwait(false);
                return body.Length > MaxResponsePreviewBytes
                    ? body.Substring(0, MaxResponsePreviewBytes)
                    : body;
            }
            catch
            {
                return null;
            }
        }

        // ── Session-context rewriting helpers ──────────────────────────

        /// <summary>
        /// Rewrites zero-GUID placeholders in the path with real workspace/
        /// lakehouse IDs from the active EdogSessionRegistry. The LLM uses
        /// 00000000-... GUIDs because it doesn't know the live session context.
        /// </summary>
        private static string RewritePathPlaceholders(string path)
        {
            if (string.IsNullOrEmpty(path)) return path;

            try
            {
                var snapshot = EdogSessionRegistry.GetSnapshot();
                var session = snapshot?.Sessions?.Count > 0 ? snapshot.Sessions[0] : null;
                if (session == null) return path;

                // Replace zero-GUID workspace/lakehouse IDs with real ones
                var zeroGuid = "00000000-0000-0000-0000-000000000";
                if (path.Contains(zeroGuid) && !string.IsNullOrEmpty(session.WorkspaceId) && !string.IsNullOrEmpty(session.LakehouseId))
                {
                    // Path format: /v1/workspaces/{wsId}/lakehouses/{lhId}/...
                    // Replace sequentially — first 0-GUID = workspace, second = lakehouse
                    var idx1 = path.IndexOf(zeroGuid, StringComparison.Ordinal);
                    if (idx1 >= 0)
                    {
                        var end1 = path.IndexOf('/', idx1 + 36);
                        if (end1 < 0) end1 = path.Length;
                        var placeholder1 = path.Substring(idx1, Math.Min(36, end1 - idx1));
                        path = path.Substring(0, idx1) + session.WorkspaceId + path.Substring(idx1 + placeholder1.Length);

                        var idx2 = path.IndexOf(zeroGuid, idx1 + session.WorkspaceId.Length, StringComparison.Ordinal);
                        if (idx2 >= 0)
                        {
                            var end2 = path.IndexOf('/', idx2 + 36);
                            if (end2 < 0) end2 = path.Length;
                            var placeholder2 = path.Substring(idx2, Math.Min(36, end2 - idx2));
                            path = path.Substring(0, idx2) + session.LakehouseId + path.Substring(idx2 + placeholder2.Length);
                        }
                    }
                }

                return path;
            }
            catch
            {
                return path;
            }
        }

        /// <summary>
        /// Injects the real FLT control-token header for authentication.
        /// The LLM generates 'Authorization: Bearer valid-mwc-token' as a
        /// placeholder — the FLT API needs the actual EDOG control token
        /// used by the API proxy.
        /// </summary>
        private static void RewriteAuthHeader(Dictionary<string, string> headers)
        {
            try
            {
                var snapshot = EdogSessionRegistry.GetSnapshot();
                var session = snapshot?.Sessions?.Count > 0 ? snapshot.Sessions[0] : null;
                if (session == null) return;

                // Remove fake auth headers the LLM generated
                headers.Remove("Authorization");

                // The FLT API proxy uses X-EDOG-Control-Token for
                // internal requests. The session's ConnectionId serves
                // as the identity — the proxy validates it against the
                // registered session list.
                if (!string.IsNullOrEmpty(session.ConnectionId))
                {
                    headers["X-EDOG-Control-Token"] = session.ConnectionId;
                }
            }
            catch { /* non-fatal */ }
        }
    }

    // ──────────────────────────────────────────────
    // SignalRBroadcastStimulusHandler
    // ──────────────────────────────────────────────

    /// <summary>
    /// Broadcasts a hub method on <see cref="EdogPlaygroundHub"/> via <c>IHubContext</c>.
    /// In-process — bypasses SignalR transport, exercises hub broadcast code directly.
    /// </summary>
    internal sealed class SignalRBroadcastStimulusHandler : IStimulusHandler
    {
        private readonly IServiceProvider _serviceProvider;
        private readonly ILogger _logger;

        public SignalRBroadcastStimulusHandler(IServiceProvider serviceProvider, ILogger logger)
        {
            _serviceProvider = serviceProvider;
            _logger = logger;
        }

        public StimulusType Type => StimulusType.SignalRBroadcast;

        public async Task<StimulusResult> ExecuteAsync(Stimulus stimulus, CancellationToken ct)
        {
            var spec = stimulus.SignalRBroadcast;
            if (spec == null)
                return new StimulusResult { Success = false, Error = "SignalRBroadcast spec is null" };

            var hubContext = _serviceProvider.GetRequiredService<IHubContext<EdogPlaygroundHub>>();
            var method = spec.Method;
            var args = spec.Args?.ToArray() ?? Array.Empty<object>();

            var sw = Stopwatch.StartNew();
            try
            {
                if (!string.IsNullOrEmpty(spec.ConnectionId))
                {
                    await hubContext.Clients.Client(spec.ConnectionId)
                        .SendCoreAsync(method, args, ct).ConfigureAwait(false);
                }
                else
                {
                    await hubContext.Clients.All
                        .SendCoreAsync(method, args, ct).ConfigureAwait(false);
                }

                sw.Stop();
                return new StimulusResult { Success = true, DurationMs = sw.ElapsedMilliseconds };
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                sw.Stop();
                _logger?.LogDebug(ex, "[QA] SignalR stimulus failed: {Method}", method);
                return new StimulusResult
                {
                    Success = false,
                    Error = ex.Message,
                    DurationMs = sw.ElapsedMilliseconds,
                };
            }
        }
    }

    // ──────────────────────────────────────────────
    // DagTriggerStimulusHandler
    // ──────────────────────────────────────────────

    /// <summary>
    /// Triggers a DAG execution via <c>POST /liveTableSchedule/runDAG/{iterationId}</c>.
    /// The endpoint returns 202 Accepted — actual DAG execution is async.
    /// CAPTURE phase handles waiting for <c>dag</c> topic events.
    /// </summary>
    internal sealed class DagTriggerStimulusHandler : IStimulusHandler
    {
        private const string ClientName = "edog-stimulus";

        private readonly IHttpClientFactory _httpClientFactory;
        private readonly int _fltPort;
        private readonly ILogger _logger;

        public DagTriggerStimulusHandler(IHttpClientFactory httpClientFactory, int fltPort, ILogger logger)
        {
            _httpClientFactory = httpClientFactory;
            _fltPort = fltPort;
            _logger = logger;
        }

        public StimulusType Type => StimulusType.DagTrigger;

        public async Task<StimulusResult> ExecuteAsync(Stimulus stimulus, CancellationToken ct)
        {
            var spec = stimulus.DagTrigger;
            if (spec == null)
                return new StimulusResult { Success = false, Error = "DagTrigger spec is null" };

            var iterationId = spec.IterationId;
            if (string.IsNullOrEmpty(iterationId))
                return new StimulusResult { Success = false, Error = "DagTrigger iterationId is required" };

            var url = $"http://localhost:{_fltPort}/liveTableSchedule/runDAG/{iterationId}";
            var client = _httpClientFactory.CreateClient(ClientName);

            // Attach node filter as query string if specified
            if (spec.NodeFilter != null && spec.NodeFilter.Count > 0)
            {
                var filterParam = string.Join(",", spec.NodeFilter);
                url += $"?nodeFilter={Uri.EscapeDataString(filterParam)}";
            }

            var sw = Stopwatch.StartNew();
            try
            {
                var response = await client.PostAsync(url, null, ct).ConfigureAwait(false);
                sw.Stop();

                return new StimulusResult
                {
                    Success = response.IsSuccessStatusCode,
                    StatusCode = (int)response.StatusCode,
                    DurationMs = sw.ElapsedMilliseconds,
                    Metadata = new { triggerType = "dag", iterationId, nodeFilter = spec.NodeFilter },
                };
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                sw.Stop();
                _logger?.LogDebug(ex, "[QA] DAG trigger failed: {IterationId}", iterationId);
                return new StimulusResult
                {
                    Success = false,
                    Error = ex.Message,
                    DurationMs = sw.ElapsedMilliseconds,
                };
            }
        }
    }

    // ──────────────────────────────────────────────
    // FileEventStimulusHandler
    // ──────────────────────────────────────────────

    /// <summary>
    /// Writes a file to the watched OneLake path to trigger file-change detection.
    /// Resolves <c>IFileSystem</c> from DI so the write flows through
    /// <c>EdogFileSystemInterceptor</c> and is captured on the "fileop" topic.
    /// </summary>
    internal sealed class FileEventStimulusHandler : IStimulusHandler
    {
        private const int MaxContentBytes = 1_048_576; // 1MB safety limit

        private readonly IServiceProvider _serviceProvider;
        private readonly ILogger _logger;

        public FileEventStimulusHandler(IServiceProvider serviceProvider, ILogger logger)
        {
            _serviceProvider = serviceProvider;
            _logger = logger;
        }

        public StimulusType Type => StimulusType.FileEvent;

        public async Task<StimulusResult> ExecuteAsync(Stimulus stimulus, CancellationToken ct)
        {
            var spec = stimulus.FileEvent;
            if (spec == null)
                return new StimulusResult { Success = false, Error = "FileEvent spec is null" };

            if (string.IsNullOrEmpty(spec.Path))
                return new StimulusResult { Success = false, Error = "FileEvent path is required" };

            byte[] bytes;
            try
            {
                bytes = string.Equals(spec.Encoding, "base64", StringComparison.OrdinalIgnoreCase)
                    ? Convert.FromBase64String(spec.Content ?? string.Empty)
                    : Encoding.UTF8.GetBytes(spec.Content ?? string.Empty);
            }
            catch (FormatException ex)
            {
                return new StimulusResult { Success = false, Error = $"Invalid base64 content: {ex.Message}" };
            }

            if (bytes.Length > MaxContentBytes)
                return new StimulusResult { Success = false, Error = $"Content exceeds 1MB limit ({bytes.Length} bytes)" };

            var sw = Stopwatch.StartNew();
            try
            {
                // Resolve IFileSystem from DI — goes through EdogFileSystemInterceptor
                var fileSystemType = ResolveType("IFileSystem");
                if (fileSystemType == null)
                    return new StimulusResult { Success = false, Error = "IFileSystem not found in DI container" };

                var fileSystem = _serviceProvider.GetRequiredService(fileSystemType);
                var writeMethod = fileSystemType.GetMethod("WriteAsync")
                    ?? fileSystemType.GetMethods().FirstOrDefault(m => m.Name.Contains("Write"));

                if (writeMethod == null)
                    return new StimulusResult { Success = false, Error = "WriteAsync method not found on IFileSystem" };

                var result = writeMethod.Invoke(fileSystem, new object[] { spec.Path, bytes, ct });
                if (result is Task task)
                    await task.ConfigureAwait(false);

                sw.Stop();
                return new StimulusResult { Success = true, DurationMs = sw.ElapsedMilliseconds };
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                sw.Stop();
                var inner = ex is TargetInvocationException tie ? tie.InnerException ?? ex : ex;
                _logger?.LogDebug(inner, "[QA] File event stimulus failed: {Path}", spec.Path);
                return new StimulusResult
                {
                    Success = false,
                    Error = inner.Message,
                    DurationMs = sw.ElapsedMilliseconds,
                };
            }
        }

        private Type ResolveType(string interfaceName)
        {
            return AppDomain.CurrentDomain.GetAssemblies()
                .SelectMany(a =>
                {
                    try { return a.GetTypes(); }
                    catch { return Array.Empty<Type>(); }
                })
                .FirstOrDefault(t => t.IsInterface && t.Name == interfaceName);
        }
    }

    // ──────────────────────────────────────────────
    // TimerTickStimulusHandler
    // ──────────────────────────────────────────────

    /// <summary>
    /// Waits for a scheduled timer tick event on the specified topic.
    /// Uses <see cref="TopicBuffer.AddObserver"/> to tap into the live event stream.
    /// </summary>
    internal sealed class TimerTickStimulusHandler : IStimulusHandler
    {
        private readonly ILogger _logger;

        public TimerTickStimulusHandler(ILogger logger) => _logger = logger;

        public StimulusType Type => StimulusType.TimerTick;

        public async Task<StimulusResult> ExecuteAsync(Stimulus stimulus, CancellationToken ct)
        {
            var spec = stimulus.TimerTick;
            if (spec == null)
                return new StimulusResult { Success = false, Error = "TimerTick spec is null" };

            var tickSource = spec.TickSource;
            if (string.IsNullOrEmpty(tickSource))
                return new StimulusResult { Success = false, Error = "TimerTick tickSource is required" };

            var topic = spec.Topic ?? "perf";
            var maxWaitMs = spec.MaxWaitMs > 0 ? spec.MaxWaitMs : 10_000;

            var buffer = EdogTopicRouter.GetBuffer(topic);
            if (buffer == null)
                return new StimulusResult { Success = false, Error = $"Topic '{topic}' not registered" };

            var tcs = new TaskCompletionSource<TopicEvent>(TaskCreationOptions.RunContinuationsAsynchronously);

            // Subscribe to the topic buffer and wait for a matching tick event
            using var observer = buffer.AddObserver(evt =>
            {
                if (MatchesTickPattern(evt, tickSource))
                    tcs.TrySetResult(evt);
            });

            using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeoutCts.CancelAfter(maxWaitMs);

            using var registration = timeoutCts.Token.Register(() => tcs.TrySetCanceled(timeoutCts.Token));

            var sw = Stopwatch.StartNew();
            try
            {
                var matchedEvent = await tcs.Task.ConfigureAwait(false);
                sw.Stop();
                return new StimulusResult
                {
                    Success = true,
                    DurationMs = sw.ElapsedMilliseconds,
                    Metadata = new { tickSource, topic, sequenceId = matchedEvent.SequenceId },
                };
            }
            catch (OperationCanceledException) when (!ct.IsCancellationRequested)
            {
                sw.Stop();
                return new StimulusResult
                {
                    Success = false,
                    DurationMs = sw.ElapsedMilliseconds,
                    Error = $"Timer tick '{tickSource}' not detected within {maxWaitMs}ms",
                };
            }
        }

        /// <summary>
        /// Checks whether a <see cref="TopicEvent"/> matches the expected tick source.
        /// Inspects the Data payload for a matching source name via JSON serialization.
        /// </summary>
        private static bool MatchesTickPattern(TopicEvent evt, string tickSource)
        {
            if (evt?.Data == null) return false;

            try
            {
                var json = evt.Data is JsonElement je
                    ? je
                    : JsonSerializer.SerializeToElement(evt.Data);

                // Check common payload shapes: { source: "..." } or { name: "..." } or { tickSource: "..." }
                foreach (var propertyName in new[] { "source", "name", "tickSource", "Source", "Name", "TickSource" })
                {
                    if (json.TryGetProperty(propertyName, out var prop) &&
                        prop.ValueKind == JsonValueKind.String &&
                        string.Equals(prop.GetString(), tickSource, StringComparison.OrdinalIgnoreCase))
                    {
                        return true;
                    }
                }
            }
            catch
            {
                // Best effort — payload may not be serializable
            }

            return false;
        }
    }

    // ──────────────────────────────────────────────
    // DiInvocationStimulusHandler
    // ──────────────────────────────────────────────

    /// <summary>
    /// Resolves a service from <see cref="IServiceProvider"/> and invokes a method via reflection.
    /// The most flexible stimulus — usable when no HTTP/SignalR entry point exists.
    /// </summary>
    internal sealed class DiInvocationStimulusHandler : IStimulusHandler
    {
        private readonly IServiceProvider _serviceProvider;
        private readonly ILogger _logger;

        public DiInvocationStimulusHandler(IServiceProvider serviceProvider, ILogger logger)
        {
            _serviceProvider = serviceProvider;
            _logger = logger;
        }

        public StimulusType Type => StimulusType.DiInvocation;

        public async Task<StimulusResult> ExecuteAsync(Stimulus stimulus, CancellationToken ct)
        {
            var spec = stimulus.DiInvocation;
            if (spec == null)
                return new StimulusResult { Success = false, Error = "DiInvocation spec is null" };

            if (string.IsNullOrEmpty(spec.ServiceType))
                return new StimulusResult { Success = false, Error = "DiInvocation serviceType is required" };

            if (string.IsNullOrEmpty(spec.Method))
                return new StimulusResult { Success = false, Error = "DiInvocation method is required" };

            var sw = Stopwatch.StartNew();
            try
            {
                // Resolve the service interface type from loaded assemblies
                var serviceType = ResolveServiceType(spec.ServiceType);
                if (serviceType == null)
                {
                    return new StimulusResult
                    {
                        Success = false,
                        Error = $"Service type '{spec.ServiceType}' not found in loaded assemblies",
                    };
                }

                // Try resolving the type directly. If that fails and the
                // resolved type is a concrete class, try its interfaces —
                // DI containers register interfaces, but the LLM cites
                // concrete class names (they're what appear in the diff).
                object service = null;
                Type resolvedServiceType = serviceType;
                try
                {
                    service = _serviceProvider.GetRequiredService(serviceType);
                }
                catch (InvalidOperationException) when (!serviceType.IsInterface && !serviceType.IsAbstract)
                {
                    // Concrete class not registered — try its interfaces
                    foreach (var iface in serviceType.GetInterfaces())
                    {
                        try
                        {
                            service = _serviceProvider.GetRequiredService(iface);
                            resolvedServiceType = iface;
                            _logger?.LogDebug(
                                "[QA] DiInvocation: resolved '{Concrete}' via interface '{Interface}'",
                                spec.ServiceType, iface.Name);
                            break;
                        }
                        catch (InvalidOperationException) { /* try next interface */ }
                    }
                }

                if (service == null)
                {
                    return new StimulusResult
                    {
                        Success = false,
                        Error = $"No service for type '{spec.ServiceType}' has been registered.",
                    };
                }

                // Find the method — search both the resolved service type
                // (may be an interface) and the actual implementation type.
                // The LLM cites method names from the diff (concrete class),
                // but the DI resolution may have landed on an interface.
                var searchTypes = resolvedServiceType == serviceType
                    ? new[] { serviceType }
                    : new[] { resolvedServiceType, serviceType, service.GetType() };
                MethodInfo[] methods = null;
                foreach (var st in searchTypes)
                {
                    methods = st.GetMethods(BindingFlags.Public | BindingFlags.Instance)
                        .Where(m => m.Name == spec.Method)
                        .ToArray();
                    if (methods.Length > 0) break;
                }

                if (methods == null || methods.Length == 0)
                {
                    return new StimulusResult
                    {
                        Success = false,
                        Error = $"Method '{spec.Method}' not found on '{spec.ServiceType}'",
                    };
                }

                var argCount = spec.Args?.Count ?? 0;
                var method = methods.FirstOrDefault(m => m.GetParameters().Length == argCount)
                    ?? methods[0];

                var parameters = DeserializeArgs(method.GetParameters(), spec.Args);
                var result = method.Invoke(service, parameters);

                // Await if async
                if (result is Task task)
                {
                    await task.ConfigureAwait(false);

                    // Extract result from Task<T> if applicable
                    var taskType = task.GetType();
                    if (taskType.IsGenericType)
                    {
                        var resultProp = taskType.GetProperty("Result");
                        var taskResult = resultProp?.GetValue(task);
                        sw.Stop();
                        return new StimulusResult
                        {
                            Success = true,
                            DurationMs = sw.ElapsedMilliseconds,
                            Metadata = taskResult,
                        };
                    }
                }

                sw.Stop();
                return new StimulusResult
                {
                    Success = true,
                    DurationMs = sw.ElapsedMilliseconds,
                    Metadata = result is Task ? null : result,
                };
            }
            catch (TargetInvocationException ex)
            {
                sw.Stop();
                var inner = ex.InnerException ?? ex;
                _logger?.LogDebug(inner, "[QA] DiInvocation failed: {Service}.{Method}", spec.ServiceType, spec.Method);
                return new StimulusResult
                {
                    Success = false,
                    Error = inner.Message,
                    DurationMs = sw.ElapsedMilliseconds,
                };
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                sw.Stop();
                _logger?.LogDebug(ex, "[QA] DiInvocation failed: {Service}.{Method}", spec.ServiceType, spec.Method);
                return new StimulusResult
                {
                    Success = false,
                    Error = ex.Message,
                    DurationMs = sw.ElapsedMilliseconds,
                };
            }
        }

        /// <summary>
        /// Resolves a type by simple or full name from all loaded assemblies.
        /// Checks <see cref="EdogDiRegistryCapture"/> data first for known registrations.
        /// </summary>
        private static Type ResolveServiceType(string typeName)
        {
            // Try exact match first (fully qualified)
            var type = System.Type.GetType(typeName);
            if (type != null) return type;

            // Scan loaded assemblies for interface/class matching the name
            return AppDomain.CurrentDomain.GetAssemblies()
                .SelectMany(a =>
                {
                    try { return a.GetTypes(); }
                    catch { return Array.Empty<Type>(); }
                })
                .FirstOrDefault(t =>
                    string.Equals(t.Name, typeName, StringComparison.Ordinal) ||
                    string.Equals(t.FullName, typeName, StringComparison.Ordinal));
        }

        /// <summary>
        /// Deserializes JSON arguments to the parameter types expected by the method.
        /// Handles CancellationToken parameters by injecting <see cref="CancellationToken.None"/>.
        /// </summary>
        private static object[] DeserializeArgs(ParameterInfo[] paramInfos, List<object> args)
        {
            if (paramInfos == null || paramInfos.Length == 0)
                return Array.Empty<object>();

            var result = new object[paramInfos.Length];
            var argIndex = 0;

            for (var i = 0; i < paramInfos.Length; i++)
            {
                var paramType = paramInfos[i].ParameterType;

                // Inject CancellationToken.None for CancellationToken parameters
                if (paramType == typeof(CancellationToken))
                {
                    result[i] = CancellationToken.None;
                    continue;
                }

                if (args != null && argIndex < args.Count)
                {
                    var arg = args[argIndex++];
                    result[i] = CoerceArg(arg, paramType);
                }
                else if (paramInfos[i].HasDefaultValue)
                {
                    result[i] = paramInfos[i].DefaultValue;
                }
                else
                {
                    result[i] = paramType.IsValueType ? Activator.CreateInstance(paramType) : null;
                }
            }

            return result;
        }

        /// <summary>
        /// Coerces a JSON-deserialized argument to the target parameter type.
        /// </summary>
        private static object CoerceArg(object arg, Type targetType)
        {
            if (arg == null) return null;

            if (targetType.IsInstanceOfType(arg))
                return arg;

            // Handle JsonElement from System.Text.Json deserialization
            if (arg is JsonElement je)
                return JsonSerializer.Deserialize(je.GetRawText(), targetType);

            // Fallback: serialize to JSON and deserialize to target type
            try
            {
                var json = JsonSerializer.Serialize(arg);
                return JsonSerializer.Deserialize(json, targetType);
            }
            catch
            {
                return Convert.ChangeType(arg, targetType);
            }
        }
    }
}
