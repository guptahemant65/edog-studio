// <copyright file="EdogLogServer.cs" company="Microsoft">
// Copyright (c) Microsoft Corporation. All rights reserved.
// </copyright>

#nullable disable
#pragma warning disable // DevMode-only file — suppress all warnings

namespace Microsoft.LiveTable.Service.DevMode
{
    using System;
    using System.Collections.Concurrent;
    using System.Collections.Generic;
    using System.IO;
    using System.Linq;
    using System.Net.WebSockets;
    using System.Text;
    using System.Text.Json;
    using System.Threading;
    using System.Threading.Tasks;
    using Microsoft.AspNetCore.Builder;
    using Microsoft.AspNetCore.Hosting;
    using Microsoft.AspNetCore.Http;
    using Microsoft.Extensions.DependencyInjection;
    using Microsoft.Extensions.Hosting;
    using Microsoft.Extensions.Logging;

    /// <summary>
    /// Embedded Kestrel HTTP + WebSocket server for real-time log viewing in EDOG devmode.
    /// Provides REST APIs and WebSocket streaming for log entries and telemetry events.
    ///
    /// Batched streaming protocol:
    ///   - Logs and telemetry events are collected into per-client batch buffers.
    ///   - A dedicated flush timer fires every 150 ms and sends one JSON message per client.
    ///   - If a client's outbound buffer exceeds a threshold, a summary message is sent instead
    ///     and the detailed entries are dropped (backpressure).
    /// </summary>
    internal sealed class EdogLogServer : IDisposable
{
    private const int MaxLogEntries = 10000;
    private const int MaxTelemetryEvents = 5000;
    private const int BatchFlushIntervalMs = 150;

    /// <summary>
    /// Approximate byte threshold for a client's pending send queue.
    /// When exceeded, the server switches to summary messages for that client.
    /// </summary>
    private const int BackpressureBytesThreshold = 64 * 1024;

    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    private readonly int port;
    private readonly ConcurrentQueue<LogEntry> logBuffer = new();
    private readonly ConcurrentQueue<TelemetryEvent> telemetryBuffer = new();
    private readonly ConcurrentDictionary<int, ClientState> webSocketClients = new();
    private int nextClientId;

    private Timer batchFlushTimer;
    private WebApplication app;
    private Task hostTask;
    private string htmlContent = "<html><body><h1>EDOG Log Server</h1><p>WebSocket endpoint: /ws/logs</p></body></html>";
    private bool disposed;
    private EdogApiProxy apiProxy;

    /// <summary>
    /// Initializes a new instance of the <see cref="EdogLogServer"/> class.
    /// </summary>
    /// <param name="port">Port number for the HTTP server (default: 5555).</param>
    public EdogLogServer(int port = 5555)
    {
        var envPort = Environment.GetEnvironmentVariable("EDOG_STUDIO_PORT");
        this.port = envPort != null && int.TryParse(envPort, out var p) ? p : port;
    }

    /// <summary>
    /// Starts the embedded Kestrel server on a background thread.
    /// </summary>
    public void Start()
    {
        if (app != null) return;

        try
        {
            var builder = WebApplication.CreateBuilder(new WebApplicationOptions
            {
                ApplicationName = "EdogLogServer"
            });

            builder.Services.AddLogging(logging => logging.ClearProviders().SetMinimumLevel(LogLevel.Warning));
            builder.WebHost.UseUrls($"http://localhost:{port}");
            builder.WebHost.UseKestrel(options => options.AllowSynchronousIO = true);

            app = builder.Build();

            // Initialize API proxy — look for edog-config.json near the HTML source
            var configDir = FindEdogConfigDir();
            if (configDir != null)
            {
                apiProxy = new EdogApiProxy(configDir);
                Console.WriteLine($"[EDOG] API proxy enabled, config: {configDir}");
            }
            else
            {
                Console.WriteLine("[EDOG] API proxy disabled — edog-config.json not found");
            }

            ConfigureRoutes();

            // Start the batch flush timer — fires every 150 ms on a ThreadPool thread
            batchFlushTimer = new Timer(_ => FlushAllClients(), null, BatchFlushIntervalMs, BatchFlushIntervalMs);

            hostTask = Task.Run(async () =>
            {
                try
                {
                    await app.RunAsync();
                }
                catch (Exception ex)
                {
                    Console.WriteLine($"EdogLogServer error: {ex}");
                }
            });
        }
        catch (Exception ex)
        {
            Console.WriteLine($"Failed to start EdogLogServer: {ex}");
        }
    }

    /// <summary>
    /// Stops the server and performs graceful shutdown.
    /// </summary>
    public async Task Stop()
    {
        if (app == null) return;

        try
        {
            batchFlushTimer?.Change(Timeout.Infinite, Timeout.Infinite);
            batchFlushTimer?.Dispose();
            batchFlushTimer = null;

            // Final flush so no logs are lost
            FlushAllClients();

            await app.StopAsync(TimeSpan.FromSeconds(5));
            await app.DisposeAsync();
            
            if (hostTask != null)
                await hostTask;
        }
        catch (Exception ex)
        {
            Console.WriteLine($"Error stopping EdogLogServer: {ex}");
        }
        finally
        {
            app = null;
            hostTask = null;
        }
    }

    /// <summary>
    /// Sets the HTML content served at the root endpoint.
    /// </summary>
    /// <param name="html">HTML content to serve.</param>
    public void SetHtmlContent(string html)
    {
        htmlContent = html ?? throw new ArgumentNullException(nameof(html));
    }

    /// <summary>
    /// Adds a log entry to the ring buffer and enqueues it for batched broadcast.
    /// </summary>
    /// <param name="entry">Log entry to add.</param>
    public void AddLog(LogEntry entry)
    {
        if (disposed) return;

        try
        {
            logBuffer.Enqueue(entry);
            TrimBuffer(logBuffer, MaxLogEntries);

            foreach (var kvp in webSocketClients)
            {
                kvp.Value.PendingLogs.Enqueue(entry);
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine($"Error adding log entry: {ex}");
        }
    }

    /// <summary>
    /// Adds a telemetry event to the ring buffer and enqueues it for batched broadcast.
    /// </summary>
    /// <param name="telemetryEvent">Telemetry event to add.</param>
    public void AddTelemetry(TelemetryEvent telemetryEvent)
    {
        if (disposed) return;

        try
        {
            telemetryBuffer.Enqueue(telemetryEvent);
            TrimBuffer(telemetryBuffer, MaxTelemetryEvents);

            foreach (var kvp in webSocketClients)
            {
                kvp.Value.PendingTelemetry.Enqueue(telemetryEvent);
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine($"Error adding telemetry event: {ex}");
        }
    }

    // ────────────────────────────────────────────────────────────
    //  Batch flush logic
    // ────────────────────────────────────────────────────────────

    /// <summary>
    /// Called by the flush timer every 150 ms. Drains each client's pending queues
    /// and sends a single batch message. If a client is back-pressured, sends a
    /// summary instead.
    /// </summary>
    private void FlushAllClients()
    {
        foreach (var (clientId, clientState) in webSocketClients.ToArray())
        {
            try
            {
                if (clientState.Socket.State != WebSocketState.Open)
                {
                    webSocketClients.TryRemove(clientId, out _);
                    continue;
                }

                var logs = DrainQueue(clientState.PendingLogs);
                var telemetry = DrainQueue(clientState.PendingTelemetry);

                if (logs.Count == 0 && telemetry.Count == 0)
                    continue;

                if (clientState.PendingBytes > BackpressureBytesThreshold)
                {
                    SendSummary(clientState, logs, telemetry);
                    continue;
                }

                SendBatch(clientState, logs, telemetry);
            }
            catch
            {
                webSocketClients.TryRemove(clientId, out _);
            }
        }
    }

    private void SendBatch(ClientState client, List<LogEntry> logs, List<TelemetryEvent> telemetry)
    {
        var payload = JsonSerializer.Serialize(new
        {
            type = "batch",
            logs,
            telemetry
        }, JsonOptions);

        SendToClient(client, payload);
    }

    private void SendSummary(ClientState client, List<LogEntry> logs, List<TelemetryEvent> telemetry)
    {
        var levels = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        foreach (var log in logs)
        {
            var lvl = log.Level ?? "Unknown";
            levels.TryGetValue(lvl, out var count);
            levels[lvl] = count + 1;
        }

        var payload = JsonSerializer.Serialize(new
        {
            type = "summary",
            dropped = logs.Count + telemetry.Count,
            droppedLogs = logs.Count,
            droppedTelemetry = telemetry.Count,
            levels
        }, JsonOptions);

        SendToClient(client, payload);
    }

    private void SendToClient(ClientState client, string json)
    {
        var bytes = Encoding.UTF8.GetBytes(json);
        Interlocked.Add(ref client.PendingBytes, bytes.Length);

        _ = Task.Run(async () =>
        {
            try
            {
                if (client.Socket.State == WebSocketState.Open)
                {
                    await client.SendLock.WaitAsync();
                    try
                    {
                        await client.Socket.SendAsync(
                            new ArraySegment<byte>(bytes),
                            WebSocketMessageType.Text,
                            true,
                            CancellationToken.None);
                    }
                    finally
                    {
                        client.SendLock.Release();
                    }
                }
            }
            catch
            {
                // Client gone — will be cleaned up on next flush
            }
            finally
            {
                Interlocked.Add(ref client.PendingBytes, -bytes.Length);
            }
        });
    }

    private static List<T> DrainQueue<T>(ConcurrentQueue<T> queue)
    {
        var items = new List<T>();
        while (queue.TryDequeue(out var item))
        {
            items.Add(item);
        }
        return items;
    }

    private void ConfigureRoutes()
    {
        app!.UseWebSockets();

        // Root endpoint — studio mode returns JSON health, standalone serves HTML
        app.MapGet("/", async context =>
        {
            try
            {
                if (Environment.GetEnvironmentVariable("EDOG_STUDIO_PORT") != null)
                {
                    context.Response.ContentType = "application/json";
                    await context.Response.WriteAsync("{\"status\":\"ok\",\"mode\":\"studio\"}");
                    return;
                }
                context.Response.ContentType = "text/html";
                await context.Response.WriteAsync(htmlContent);
            }
            catch (Exception ex)
            {
                Console.WriteLine($"Error serving root: {ex}");
                context.Response.StatusCode = 500;
            }
        });

        // Logs API endpoint
        app.MapGet("/api/logs", async context =>
        {
            try
            {
                var query = context.Request.Query;
                var since = ParseDateTime(query["since"]);
                var level = query["level"].ToString();
                var search = query["search"].ToString();
                var limit = ParseInt(query["limit"], 1000);

                var logs = FilterLogs(since, level, search, limit);
                var json = JsonSerializer.Serialize(logs, JsonOptions);
                
                context.Response.ContentType = "application/json";
                await context.Response.WriteAsync(json);
            }
            catch (Exception ex)
            {
                Console.WriteLine($"Error serving logs API: {ex}");
                context.Response.StatusCode = 500;
            }
        });

        // Telemetry API endpoint
        app.MapGet("/api/telemetry", async context =>
        {
            try
            {
                var query = context.Request.Query;
                var since = ParseDateTime(query["since"]);
                var activity = query["activity"].ToString();
                var limit = ParseInt(query["limit"], 1000);

                var events = FilterTelemetry(since, activity, limit);
                var json = JsonSerializer.Serialize(events, JsonOptions);
                
                context.Response.ContentType = "application/json";
                await context.Response.WriteAsync(json);
            }
            catch (Exception ex)
            {
                Console.WriteLine($"Error serving telemetry API: {ex}");
                context.Response.StatusCode = 500;
            }
        });

        // Stats API endpoint
        app.MapGet("/api/stats", async context =>
        {
            try
            {
                var logs = logBuffer.ToArray();
                var events = telemetryBuffer.ToArray();
                
                var stats = new
                {
                    totalLogs = logs.Length,
                    verbose = logs.Count(l => l.Level.Equals("Verbose", StringComparison.OrdinalIgnoreCase)),
                    message = logs.Count(l => l.Level.Equals("Message", StringComparison.OrdinalIgnoreCase)),
                    warning = logs.Count(l => l.Level.Equals("Warning", StringComparison.OrdinalIgnoreCase)),
                    error = logs.Count(l => l.Level.Equals("Error", StringComparison.OrdinalIgnoreCase)),
                    totalEvents = events.Length,
                    succeeded = events.Count(e => e.ActivityStatus.Equals("Succeeded", StringComparison.OrdinalIgnoreCase)),
                    failed = events.Count(e => e.ActivityStatus.Equals("Failed", StringComparison.OrdinalIgnoreCase))
                };
                
                var json = JsonSerializer.Serialize(stats, JsonOptions);
                context.Response.ContentType = "application/json";
                await context.Response.WriteAsync(json);
            }
            catch (Exception ex)
            {
                Console.WriteLine($"Error serving stats API: {ex}");
                context.Response.StatusCode = 500;
            }
        });

        // Executions API endpoint
        app.MapGet("/api/executions", async context =>
        {
            try
            {
                var logs = logBuffer.ToArray();
                var events = telemetryBuffer.ToArray();

                var logsByIteration = logs
                    .Where(l => !string.IsNullOrEmpty(l.IterationId))
                    .GroupBy(l => l.IterationId)
                    .ToDictionary(g => g.Key, g => g.ToArray());

                var eventsByIteration = events
                    .Where(e => !string.IsNullOrEmpty(e.IterationId))
                    .GroupBy(e => e.IterationId)
                    .ToDictionary(g => g.Key, g => g.ToArray());

                var allIterationIds = logsByIteration.Keys
                    .Union(eventsByIteration.Keys)
                    .Distinct(StringComparer.OrdinalIgnoreCase);

                var executions = allIterationIds.Select(id =>
                {
                    logsByIteration.TryGetValue(id, out var iterLogs);
                    eventsByIteration.TryGetValue(id, out var iterEvents);
                    iterLogs ??= Array.Empty<LogEntry>();
                    iterEvents ??= Array.Empty<TelemetryEvent>();

                    var firstSeen = iterLogs.Select(l => l.Timestamp)
                        .Concat(iterEvents.Select(e => e.Timestamp))
                        .DefaultIfEmpty(DateTime.MinValue)
                        .Min();

                    var hasFailure = iterLogs.Any(l => l.Level.Equals("Error", StringComparison.OrdinalIgnoreCase))
                        || iterEvents.Any(e => e.ActivityStatus.Equals("Failed", StringComparison.OrdinalIgnoreCase));

                    return new
                    {
                        iterationId = id,
                        firstSeen,
                        status = hasFailure ? "Failed" : "Succeeded",
                        logCount = iterLogs.Length,
                        eventCount = iterEvents.Length
                    };
                })
                .OrderByDescending(x => x.firstSeen)
                .ToArray();

                var json = JsonSerializer.Serialize(executions, JsonOptions);
                context.Response.ContentType = "application/json";
                await context.Response.WriteAsync(json);
            }
            catch (Exception ex)
            {
                Console.WriteLine($"Error serving executions API: {ex}");
                context.Response.StatusCode = 500;
            }
        });

        // FLT API Proxy routes (Command Center)
        if (apiProxy != null)
        {
            app.MapGet("/api/flt/config", apiProxy.HandleConfig);
            app.MapGet("/api/edog/health", apiProxy.HandleHealth);
        }

        // WebSocket endpoint
        app.MapGet("/ws/logs", async context =>
        {
            if (!context.WebSockets.IsWebSocketRequest)
            {
                context.Response.StatusCode = 400;
                return;
            }

            var origin = context.Request.Headers["Origin"].ToString();
            if (!string.IsNullOrEmpty(origin)
                && !origin.Contains("localhost", StringComparison.OrdinalIgnoreCase)
                && !origin.Contains("127.0.0.1"))
            {
                context.Response.StatusCode = 403;
                return;
            }

            try
            {
                var webSocket = await context.WebSockets.AcceptWebSocketAsync();
                var clientId = Interlocked.Increment(ref nextClientId);
                var clientState = new ClientState(webSocket);
                webSocketClients.TryAdd(clientId, clientState);
                
                try
                {
                    await HandleWebSocket(webSocket);
                }
                finally
                {
                    webSocketClients.TryRemove(clientId, out _);
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine($"WebSocket error: {ex}");
            }
        });
    }

    private static string FindEdogConfigDir()
    {
        const string configFileName = "edog-config.json";

        // 1. Check EDOG_CONFIG_PATH environment variable first
        var envPath = Environment.GetEnvironmentVariable("EDOG_CONFIG_PATH");
        if (!string.IsNullOrEmpty(envPath))
        {
            var envDir = File.Exists(envPath) ? Path.GetDirectoryName(envPath) : envPath;
            if (envDir != null && File.Exists(Path.Combine(envDir, configFileName)))
            {
                return envDir;
            }
        }

        // 2. Walk up from current working directory
        try
        {
            var dir = new DirectoryInfo(Directory.GetCurrentDirectory());
            while (dir != null)
            {
                if (File.Exists(Path.Combine(dir.FullName, configFileName)))
                {
                    return dir.FullName;
                }

                dir = dir.Parent;
            }
        }
        catch
        {
            // Ignore directory access errors
        }

        // 3. Check %USERPROFILE%\flt-edog-devmode\
        var userProfile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        if (!string.IsNullOrEmpty(userProfile))
        {
            var knownDir = Path.Combine(userProfile, "flt-edog-devmode");
            if (File.Exists(Path.Combine(knownDir, configFileName)))
            {
                return knownDir;
            }
        }

        return null;
    }

    private async Task HandleWebSocket(WebSocket webSocket)
    {
        try
        {
            var buffer = new byte[1024 * 4];
            while (webSocket.State == WebSocketState.Open)
            {
                var result = await webSocket.ReceiveAsync(new ArraySegment<byte>(buffer), CancellationToken.None);
                if (result.MessageType == WebSocketMessageType.Close)
                    break;
                
                await Task.Delay(100); // Keep connection alive
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine($"WebSocket handling error: {ex}");
        }
        finally
        {
            try
            {
                if (webSocket.State == WebSocketState.Open)
                    await webSocket.CloseAsync(WebSocketCloseStatus.NormalClosure, "Connection closed", CancellationToken.None);
            }
            catch { /* Best effort cleanup */ }
        }
    }

    private static void TrimBuffer<T>(ConcurrentQueue<T> buffer, int maxSize)
    {
        while (buffer.Count > maxSize && buffer.TryDequeue(out _)) { }
    }

    private LogEntry[] FilterLogs(DateTime since, string level, string search, int limit)
    {
        return logBuffer.ToArray()
            .Where(log => since == DateTime.MinValue || log.Timestamp >= since)
            .Where(log => string.IsNullOrEmpty(level) || log.Level.Equals(level, StringComparison.OrdinalIgnoreCase))
            .Where(log => string.IsNullOrEmpty(search) || 
                         log.Message.Contains(search, StringComparison.OrdinalIgnoreCase) ||
                         log.Component.Contains(search, StringComparison.OrdinalIgnoreCase))
            .OrderByDescending(log => log.Timestamp)
            .Take(limit)
            .ToArray();
    }

    private TelemetryEvent[] FilterTelemetry(DateTime since, string activity, int limit)
    {
        return telemetryBuffer.ToArray()
            .Where(evt => since == DateTime.MinValue || evt.Timestamp >= since)
            .Where(evt => string.IsNullOrEmpty(activity) || evt.ActivityName.Equals(activity, StringComparison.OrdinalIgnoreCase))
            .OrderByDescending(evt => evt.Timestamp)
            .Take(limit)
            .ToArray();
    }

    private static DateTime ParseDateTime(string value) =>
        string.IsNullOrEmpty(value) ? DateTime.MinValue : DateTime.TryParse(value, out var dt) ? dt : DateTime.MinValue;

    private static int ParseInt(string value, int defaultValue) =>
        string.IsNullOrEmpty(value) ? defaultValue : int.TryParse(value, out var result) ? result : defaultValue;

    /// <inheritdoc/>
    public void Dispose()
    {
        if (disposed) return;
        disposed = true;

        try
        {
            batchFlushTimer?.Dispose();
            batchFlushTimer = null;
            Stop().GetAwaiter().GetResult();
        }
        catch (Exception ex)
        {
            Console.WriteLine($"Error during EdogLogServer disposal: {ex}");
        }
    }

    // ────────────────────────────────────────────────────────────
    //  Per-client state for batching + backpressure
    // ────────────────────────────────────────────────────────────

    /// <summary>
    /// Tracks a connected WebSocket client's pending batch and send-pressure.
    /// </summary>
    private sealed class ClientState
    {
        public ClientState(WebSocket socket)
        {
            Socket = socket;
        }

        public WebSocket Socket { get; }

        /// <summary>Pending log entries waiting for next flush.</summary>
        public ConcurrentQueue<LogEntry> PendingLogs { get; } = new();

        /// <summary>Pending telemetry events waiting for next flush.</summary>
        public ConcurrentQueue<TelemetryEvent> PendingTelemetry { get; } = new();

        /// <summary>
        /// Approximate bytes currently in-flight. Used for backpressure detection.
        /// </summary>
        public int PendingBytes;

        /// <summary>
        /// Serializes WebSocket SendAsync calls so frames don't interleave.
        /// </summary>
        public SemaphoreSlim SendLock { get; } = new(1, 1);
    }
}
}