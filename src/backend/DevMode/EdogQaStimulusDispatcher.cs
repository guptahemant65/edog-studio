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
    ///   - http_request:    &lt; 1s (network round-trip)
    ///   - signalr_invoke:  &lt; 100ms (in-process)
    ///   - dag_trigger:     &lt; 30s (DAG execution, async)
    ///   - file_event:      &lt; 500ms (disk I/O)
    ///   - timer_tick:      &lt; 10s (wait for scheduled event)
    ///   - direct_invoke:   &lt; 5s (service method execution)
    /// </summary>
    public sealed class EdogQaStimulusDispatcher
    {
        private readonly Dictionary<StimulusType, IStimulusHandler> _handlers;
        private readonly ILogger _logger;

        /// <summary>
        /// Initializes a new instance of the <see cref="EdogQaStimulusDispatcher"/> class.
        /// </summary>
        public EdogQaStimulusDispatcher(
            IHttpClientFactory httpClientFactory,
            IServiceProvider serviceProvider,
            int fltPort,
            ILogger logger)
        {
            _logger = logger;

            var handlers = new IStimulusHandler[]
            {
                new HttpStimulusHandler(httpClientFactory, fltPort, logger),
                new SignalRStimulusHandler(serviceProvider, logger),
                new DagTriggerStimulusHandler(httpClientFactory, fltPort, logger),
                new FileEventStimulusHandler(serviceProvider, logger),
                new TimerTickStimulusHandler(logger),
                new DirectInvokeStimulusHandler(serviceProvider, logger),
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

            var request = new HttpRequestMessage
            {
                Method = new HttpMethod(spec.Method ?? "GET"),
                RequestUri = BuildUri(spec.Path),
            };

            if (spec.Headers != null)
            {
                foreach (var (key, value) in spec.Headers)
                    request.Headers.TryAddWithoutValidation(key, value);
            }

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
    }

    // ──────────────────────────────────────────────
    // SignalRStimulusHandler
    // ──────────────────────────────────────────────

    /// <summary>
    /// Invokes a hub method on <see cref="EdogPlaygroundHub"/> via <c>IHubContext</c>.
    /// In-process — bypasses SignalR transport, exercises hub method code directly.
    /// </summary>
    internal sealed class SignalRStimulusHandler : IStimulusHandler
    {
        private readonly IServiceProvider _serviceProvider;
        private readonly ILogger _logger;

        public SignalRStimulusHandler(IServiceProvider serviceProvider, ILogger logger)
        {
            _serviceProvider = serviceProvider;
            _logger = logger;
        }

        public StimulusType Type => StimulusType.SignalrInvoke;

        public async Task<StimulusResult> ExecuteAsync(Stimulus stimulus, CancellationToken ct)
        {
            var spec = stimulus.SignalrInvoke;
            if (spec == null)
                return new StimulusResult { Success = false, Error = "SignalrInvoke spec is null" };

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
    // DirectInvokeStimulusHandler
    // ──────────────────────────────────────────────

    /// <summary>
    /// Resolves a service from <see cref="IServiceProvider"/> and invokes a method via reflection.
    /// The most flexible stimulus — usable when no HTTP/SignalR entry point exists.
    /// </summary>
    internal sealed class DirectInvokeStimulusHandler : IStimulusHandler
    {
        private readonly IServiceProvider _serviceProvider;
        private readonly ILogger _logger;

        public DirectInvokeStimulusHandler(IServiceProvider serviceProvider, ILogger logger)
        {
            _serviceProvider = serviceProvider;
            _logger = logger;
        }

        public StimulusType Type => StimulusType.DirectInvoke;

        public async Task<StimulusResult> ExecuteAsync(Stimulus stimulus, CancellationToken ct)
        {
            var spec = stimulus.DirectInvoke;
            if (spec == null)
                return new StimulusResult { Success = false, Error = "DirectInvoke spec is null" };

            if (string.IsNullOrEmpty(spec.ServiceType))
                return new StimulusResult { Success = false, Error = "DirectInvoke serviceType is required" };

            if (string.IsNullOrEmpty(spec.Method))
                return new StimulusResult { Success = false, Error = "DirectInvoke method is required" };

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

                var service = _serviceProvider.GetRequiredService(serviceType);

                // Find the method — handle overloads by matching parameter count
                var methods = serviceType.GetMethods(BindingFlags.Public | BindingFlags.Instance)
                    .Where(m => m.Name == spec.Method)
                    .ToArray();

                if (methods.Length == 0)
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
                _logger?.LogDebug(inner, "[QA] DirectInvoke failed: {Service}.{Method}", spec.ServiceType, spec.Method);
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
                _logger?.LogDebug(ex, "[QA] DirectInvoke failed: {Service}.{Method}", spec.ServiceType, spec.Method);
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
