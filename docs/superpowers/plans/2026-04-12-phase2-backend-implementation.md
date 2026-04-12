# Phase 2 Backend: Complete Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans. Each task is independent after Task 1.

**Goal:** Build the complete backend infrastructure for all 11 Runtime View topics: TopicBuffer system, EdogTopicRouter, 9 new interceptors, EdogDevModeRegistrar, ChannelReader streaming in hub, and all edog.py patching.

**Architecture:** SignalR ChannelReader streaming with snapshot hydration (SIGNALR_PROTOCOL.md v2). Interceptors write to TopicRouter → TopicBuffer. Hub streams from TopicBuffer (snapshot first, then live). Zero hardcoding. Auto-detect new services.

**Prerequisites:** Phase 1 complete (SignalR hub + JS client working). FLT codebase at `C:\Users\guptahemant\newrepo\workload-fabriclivetable`.

---

## Task Dependency Graph

```
Task 1: Core Infrastructure (TopicBuffer + TopicRouter + Event Models)
  │
  ├──► Task 2: Upgrade EdogPlaygroundHub (ChannelReader streaming)
  │
  ├──► Task 3: Migrate existing Log + Telemetry to TopicRouter
  │
  ├──► Task 4: EdogDevModeRegistrar (orchestrator)
  │     │
  │     ├──► Task 5: EdogFeatureFlighterWrapper (simplest interceptor)
  │     ├──► Task 6: EdogPerfMarkerCallback
  │     ├──► Task 7: EdogTokenInterceptor
  │     ├──► Task 8: EdogFileSystemInterceptor
  │     ├──► Task 9: EdogHttpPipelineHandler
  │     ├──► Task 10: EdogRetryInterceptor
  │     ├──► Task 11: EdogCacheInterceptor
  │     ├──► Task 12: EdogSparkSessionInterceptor
  │     └──► Task 13: EdogDiRegistryCapture
  │
  └──► Task 14: edog.py patching (file copy + RegisterAll insertion + revert)

Task 15: Integration test + build verification
```

**Tasks 5-13 are independent** — can be parallelized after Tasks 1-4 are done.

---

## Task 1: Core Infrastructure

**Create 3 new files** that form the backbone:

### 1a. `src/backend/DevMode/TopicEvent.cs` — Universal event envelope

```csharp
#nullable disable
#pragma warning disable

namespace Microsoft.LiveTable.Service.DevMode
{
    using System;

    /// <summary>
    /// Universal event envelope for all topic streams. Every event across all 11 topics
    /// uses this wrapper with topic-specific data in the Data property.
    /// </summary>
    public sealed class TopicEvent
    {
        public long SequenceId { get; set; }
        public DateTimeOffset Timestamp { get; set; }
        public string Topic { get; set; }
        public object Data { get; set; }
    }
}
```

### 1b. `src/backend/DevMode/TopicBuffer.cs` — Ring buffer + live channel per topic

```csharp
#nullable disable
#pragma warning disable

namespace Microsoft.LiveTable.Service.DevMode
{
    using System;
    using System.Collections.Concurrent;
    using System.Collections.Generic;
    using System.Runtime.CompilerServices;
    using System.Threading;
    using System.Threading.Channels;
    using System.Threading.Tasks;

    /// <summary>
    /// Bounded ring buffer per topic with snapshot + live stream support.
    /// Thread-safe. Used by interceptors (write) and hub (read).
    /// </summary>
    public sealed class TopicBuffer
    {
        private readonly int _maxSize;
        private readonly ConcurrentQueue<TopicEvent> _ring = new();
        private readonly Channel<TopicEvent> _liveChannel;
        private long _sequenceCounter;

        public TopicBuffer(int maxSize)
        {
            _maxSize = maxSize;
            // Unbounded writer (interceptors never block), bounded reader in hub stream
            _liveChannel = Channel.CreateUnbounded<TopicEvent>(
                new UnboundedChannelOptions { SingleWriter = false });
        }

        public long NextSequenceId() => Interlocked.Increment(ref _sequenceCounter);

        public string Topic { get; set; }

        /// <summary>
        /// Called by interceptors via TopicRouter.Publish(). Thread-safe. Non-blocking.
        /// </summary>
        public void Write(TopicEvent evt)
        {
            // Ring buffer for snapshot history
            _ring.Enqueue(evt);
            while (_ring.Count > _maxSize && _ring.TryDequeue(out _)) { }

            // Live channel for active streams
            _liveChannel.Writer.TryWrite(evt);
        }

        /// <summary>Returns snapshot of current ring buffer (for hydration).</summary>
        public TopicEvent[] GetSnapshot() => _ring.ToArray();

        /// <summary>Async enumerable of live events (after snapshot).</summary>
        public async IAsyncEnumerable<TopicEvent> ReadLiveAsync(
            [EnumeratorCancellation] CancellationToken ct)
        {
            await foreach (var item in _liveChannel.Reader.ReadAllAsync(ct))
            {
                yield return item;
            }
        }

        /// <summary>Current buffer count.</summary>
        public int Count => _ring.Count;
    }
}
```

### 1c. `src/backend/DevMode/EdogTopicRouter.cs` — Central publish/subscribe registry

```csharp
#nullable disable
#pragma warning disable

namespace Microsoft.LiveTable.Service.DevMode
{
    using System;
    using System.Collections.Concurrent;

    /// <summary>
    /// Central registry for all topic buffers. Interceptors publish here.
    /// Hub reads from here. Thread-safe singleton.
    /// </summary>
    public static class EdogTopicRouter
    {
        private static readonly ConcurrentDictionary<string, TopicBuffer> Buffers = new(StringComparer.OrdinalIgnoreCase);

        // Per-topic buffer sizes (from SIGNALR_PROTOCOL.md)
        private static readonly (string topic, int size)[] TopicSizes = new[]
        {
            ("log", 10000),
            ("telemetry", 5000),
            ("fileop", 2000),
            ("spark", 200),
            ("token", 500),
            ("cache", 2000),
            ("http", 2000),
            ("retry", 500),
            ("flag", 1000),
            ("di", 100),
            ("perf", 5000),
        };

        /// <summary>Initialize all topic buffers. Called once at startup.</summary>
        public static void Initialize()
        {
            foreach (var (topic, size) in TopicSizes)
            {
                var buffer = new TopicBuffer(size) { Topic = topic };
                Buffers.TryAdd(topic, buffer);
            }
        }

        /// <summary>Get buffer for a topic. Returns null for unknown topics.</summary>
        public static TopicBuffer GetBuffer(string topic)
        {
            Buffers.TryGetValue(topic, out var buffer);
            return buffer;
        }

        /// <summary>
        /// Publish an event to a topic. Called by interceptors. Thread-safe. Non-blocking.
        /// Silently drops if topic is unknown (future-proof: new topics auto-handled
        /// once registered).
        /// </summary>
        public static void Publish(string topic, object eventData)
        {
            if (Buffers.TryGetValue(topic, out var buffer))
            {
                try
                {
                    buffer.Write(new TopicEvent
                    {
                        SequenceId = buffer.NextSequenceId(),
                        Timestamp = DateTimeOffset.UtcNow,
                        Topic = topic,
                        Data = eventData
                    });
                }
                catch
                {
                    // Never fail FLT code for debug tooling
                }
            }
        }

        /// <summary>Register a new topic dynamically (for future auto-detection).</summary>
        public static void RegisterTopic(string topic, int maxSize)
        {
            var buffer = new TopicBuffer(maxSize) { Topic = topic };
            Buffers.TryAdd(topic, buffer);
        }
    }
}
```

- [ ] Create TopicEvent.cs
- [ ] Create TopicBuffer.cs
- [ ] Create EdogTopicRouter.cs
- [ ] Add all 3 to DEVMODE_FILES in edog.py
- [ ] Commit: `feat(runtime): add TopicBuffer + TopicRouter core infrastructure`

---

## Task 2: Upgrade EdogPlaygroundHub to ChannelReader Streaming

Replace the current Subscribe/Unsubscribe group methods with a `SubscribeToTopic` streaming method.

```csharp
/// <summary>
/// Client streams a topic: receives snapshot (history) then live events.
/// Called when user activates a tab. Cancelled when user leaves tab.
/// </summary>
public ChannelReader<TopicEvent> SubscribeToTopic(
    string topic,
    CancellationToken cancellationToken)
{
    var buffer = EdogTopicRouter.GetBuffer(topic);
    if (buffer == null)
        throw new HubException($"Unknown topic: {topic}");

    var channel = Channel.CreateBounded<TopicEvent>(
        new BoundedChannelOptions(1000)
        {
            FullMode = BoundedChannelFullMode.DropOldest,
            SingleReader = true
        });

    _ = Task.Run(async () =>
    {
        try
        {
            // Phase 1: Yield snapshot
            foreach (var item in buffer.GetSnapshot())
                await channel.Writer.WriteAsync(item, cancellationToken);

            // Phase 2: Yield live events
            await foreach (var item in buffer.ReadLiveAsync(cancellationToken))
                await channel.Writer.WriteAsync(item, cancellationToken);
        }
        catch (OperationCanceledException) { }
        catch (Exception ex)
        {
            System.Diagnostics.Debug.WriteLine($"EDOG stream error [{topic}]: {ex.Message}");
        }
        finally
        {
            channel.Writer.Complete();
        }
    }, cancellationToken);

    return channel.Reader;
}
```

Keep existing `Subscribe`/`Unsubscribe` methods for backward compatibility during transition.

- [ ] Add `using System.Threading.Channels;` to hub
- [ ] Add `SubscribeToTopic` streaming method
- [ ] Add `EdogTopicRouter.Initialize()` call in EdogLogServer.Start()
- [ ] Commit: `feat(signalr): add ChannelReader streaming with snapshot hydration`

---

## Task 3: Migrate Existing Log + Telemetry to TopicRouter

Currently `EdogLogServer.AddLog()` directly calls `hubContext.Clients.Group("log").SendAsync()`. Migrate to TopicRouter pattern so ALL topics use the same infrastructure.

In `EdogLogServer.AddLog()`:
```csharp
// OLD: _ = hubContext.Clients.Group("log").SendAsync("LogEntry", entry);
// NEW:
EdogTopicRouter.Publish("log", entry);
```

In `EdogLogServer.AddTelemetry()`:
```csharp
// OLD: _ = hubContext.Clients.Group("telemetry").SendAsync("TelemetryEvent", telemetryEvent);
// NEW:
EdogTopicRouter.Publish("telemetry", telemetryEvent);
```

Remove `hubContext` usage from AddLog/AddTelemetry (hub is only used by the streaming method now).

- [ ] Migrate AddLog to EdogTopicRouter.Publish
- [ ] Migrate AddTelemetry to EdogTopicRouter.Publish
- [ ] Verify existing logs still stream via agent-browser
- [ ] Commit: `refactor(signalr): migrate log+telemetry to TopicRouter`

---

## Task 4: EdogDevModeRegistrar

Single entry point for all interceptor DI registration. Called from WorkloadApp.cs patch.

```csharp
#nullable disable
#pragma warning disable

namespace Microsoft.LiveTable.Service.DevMode
{
    using System;

    /// <summary>
    /// Single entry point for all EDOG DevMode interceptor registrations.
    /// Called after FLT completes its own DI setup. Wraps/replaces FLT
    /// services with EDOG interceptor decorators.
    /// </summary>
    public static class EdogDevModeRegistrar
    {
        private static bool _registered;

        public static void RegisterAll()
        {
            // Idempotency guard — prevent double-wrapping on redeploy
            if (_registered) return;
            _registered = true;

            try
            {
                // Initialize topic buffers
                EdogTopicRouter.Initialize();

                // Register each interceptor (order doesn't matter — all independent)
                RegisterFeatureFlighterWrapper();
                RegisterPerfMarkerCallback();
                RegisterTokenInterceptor();
                RegisterFileSystemInterceptor();
                RegisterHttpPipelineHandler();
                RegisterRetryInterceptor();
                RegisterCacheInterceptor();
                RegisterSparkSessionInterceptor();
                RegisterDiRegistryCapture();

                Console.WriteLine("[EDOG] All 9 interceptors registered");
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[EDOG] Interceptor registration failed: {ex.Message}");
                // Non-fatal — FLT continues without some/all interceptors
            }
        }

        // Each method wraps one FLT service. Implemented in Tasks 5-13.
        private static void RegisterFeatureFlighterWrapper() { /* Task 5 */ }
        private static void RegisterPerfMarkerCallback() { /* Task 6 */ }
        private static void RegisterTokenInterceptor() { /* Task 7 */ }
        private static void RegisterFileSystemInterceptor() { /* Task 8 */ }
        private static void RegisterHttpPipelineHandler() { /* Task 9 */ }
        private static void RegisterRetryInterceptor() { /* Task 10 */ }
        private static void RegisterCacheInterceptor() { /* Task 11 */ }
        private static void RegisterSparkSessionInterceptor() { /* Task 12 */ }
        private static void RegisterDiRegistryCapture() { /* Task 13 */ }
    }
}
```

- [ ] Create EdogDevModeRegistrar.cs with stub methods
- [ ] Add to DEVMODE_FILES
- [ ] Commit: `feat(runtime): add EdogDevModeRegistrar orchestrator`

---

## Tasks 5-13: Individual Interceptors (can parallel after 1-4)

Each interceptor follows the same pattern:
1. Create `.cs` file in `src/backend/DevMode/`
2. Implement decorator/wrapper using FLT interface
3. Call `EdogTopicRouter.Publish(topic, eventData)` to broadcast
4. Snapshot data SYNCHRONOUSLY before publish (avoid disposed objects)
5. Idempotency: check if already wrapped before wrapping
6. Fill in the stub method in `EdogDevModeRegistrar.cs`
7. Add file to `DEVMODE_FILES` in `edog.py`

See `docs/superpowers/plans/2026-04-12-phase2-interceptors.md` for per-interceptor details:
- **Task 5:** EdogFeatureFlighterWrapper — `IFeatureFlighter` decorator
- **Task 6:** EdogPerfMarkerCallback — `IServiceMonitoringCallback` replacement  
- **Task 7:** EdogTokenInterceptor — `DelegatingHandler` + `IHttpClientFactory` wrapper
- **Task 8:** EdogFileSystemInterceptor — `IFileSystemFactory` decorator
- **Task 9:** EdogHttpPipelineHandler — `DelegatingHandler` on all HttpClients
- **Task 10:** EdogRetryInterceptor — `RetryPolicyProviderV2` wrapper
- **Task 11:** EdogCacheInterceptor — `ISqlEndpointMetadataCache` decorator
- **Task 12:** EdogSparkSessionInterceptor — `ISparkClientFactory` wrapper
- **Task 13:** EdogDiRegistryCapture — WireUp enumeration at startup

---

## Task 14: edog.py Patching

### 14a. Add all new files to DEVMODE_FILES

```python
DEVMODE_FILES = {
    # Existing
    "EdogLogServer": ...,
    "EdogPlaygroundHub": ...,
    "EdogApiProxy": ...,
    "EdogLogModels": ...,
    "EdogLogInterceptor": ...,
    "EdogTelemetryInterceptor": ...,
    "EdogLogsHtml": ...,
    "EditorConfig": ...,
    # Phase 2 - Core
    "TopicEvent": SERVICE_PATH / "DevMode/TopicEvent.cs",
    "TopicBuffer": SERVICE_PATH / "DevMode/TopicBuffer.cs",
    "EdogTopicRouter": SERVICE_PATH / "DevMode/EdogTopicRouter.cs",
    "EdogDevModeRegistrar": SERVICE_PATH / "DevMode/EdogDevModeRegistrar.cs",
    # Phase 2 - Interceptors (flat in DevMode/, no subdirectory)
    "EdogFeatureFlighterWrapper": SERVICE_PATH / "DevMode/EdogFeatureFlighterWrapper.cs",
    "EdogPerfMarkerCallback": SERVICE_PATH / "DevMode/EdogPerfMarkerCallback.cs",
    "EdogTokenInterceptor": SERVICE_PATH / "DevMode/EdogTokenInterceptor.cs",
    "EdogFileSystemInterceptor": SERVICE_PATH / "DevMode/EdogFileSystemInterceptor.cs",
    "EdogHttpPipelineHandler": SERVICE_PATH / "DevMode/EdogHttpPipelineHandler.cs",
    "EdogRetryInterceptor": SERVICE_PATH / "DevMode/EdogRetryInterceptor.cs",
    "EdogCacheInterceptor": SERVICE_PATH / "DevMode/EdogCacheInterceptor.cs",
    "EdogSparkSessionInterceptor": SERVICE_PATH / "DevMode/EdogSparkSessionInterceptor.cs",
    "EdogDiRegistryCapture": SERVICE_PATH / "DevMode/EdogDiRegistryCapture.cs",
}
```

### 14b. Add RegisterAll() to WorkloadApp.cs patch

Insert AFTER the existing telemetry interceptor patch:

```python
# In apply_log_viewer_registration_workloadapp_cs():
# After the existing EdogTelemetryInterceptor replacement, add:
registrar_line = (
    "\n"
    "            // EDOG DevMode - Register all runtime interceptors\n"
    "            Microsoft.LiveTable.Service.DevMode.EdogDevModeRegistrar.RegisterAll();\n"
)
```

Anchor: insert after `EdogTelemetryInterceptor` block (we control this exact text).

### 14c. Update revert

`revert_log_viewer_registration_workloadapp_cs()` must also remove the `RegisterAll()` line.

### 14d. Update CORS

Fix `SetIsOriginAllowed(_ => true)` to check for localhost only:

```csharp
policy.SetIsOriginAllowed(origin =>
    origin.Contains("localhost", StringComparison.OrdinalIgnoreCase) ||
    origin.Contains("127.0.0.1"))
```

### 14e. Fix DateTime rule

Add to `EdogLogServer.cs` JsonOptions:
```csharp
private static readonly JsonSerializerOptions JsonOptions = new()
{
    PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    Converters = { new System.Text.Json.Serialization.JsonStringEnumConverter() }
};
```

All new event models use `DateTimeOffset` (not `DateTime`).

- [ ] Add all files to DEVMODE_FILES
- [ ] Add RegisterAll() insertion to WorkloadApp patch
- [ ] Add RegisterAll() removal to revert
- [ ] Fix CORS
- [ ] Commit: `feat(deploy): add Phase 2 interceptor files to DEVMODE_FILES + patching`

---

## Task 15: Build Verification

- [ ] `python scripts/build-html.py` — HTML builds under 800KB
- [ ] `python -m pytest tests/ -v` — all tests pass
- [ ] Deploy to FLT: `edog --revert && edog` — builds, service starts
- [ ] agent-browser: verify log streaming still works through TopicRouter
- [ ] agent-browser: verify new topic data flows (at least feature flags, perf markers)
- [ ] Commit: `test(runtime): Phase 2 backend integration verified`

---

## Execution Strategy

**Recommended:** Tasks 1-4 sequentially (foundation), then Tasks 5-13 via parallel subagents (one Opus per interceptor), then Task 14-15.

**Estimated:** Tasks 1-4 (~30 min), Tasks 5-13 parallel (~20 min), Tasks 14-15 (~15 min). Total ~1 hour.

---

## Audit Fixes Embedded in This Plan

| Audit Finding | Where Fixed |
|---|---|
| No snapshot hydration | Task 2: ChannelReader streaming |
| No backpressure | Task 1: TopicBuffer bounded channel |
| Task.Run per event | Task 1: TopicRouter.Publish (synchronous enqueue) |
| No ordering | Task 1: monotonic sequenceId per TopicBuffer |
| Interceptor stacking | Task 4: `_registered` idempotency guard |
| CORS too permissive | Task 14d: localhost-only check |
| DateTime serialization | Task 14e: DateTimeOffset rule |
| Flat file layout | Task 14a: all files in DevMode/ (no subdirs) |
| Memory budget | Task 1c: per-topic sizes defined (50MB total) |
