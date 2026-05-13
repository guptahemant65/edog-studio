# C03: Execution Engine — P1 Component Deep Spec

> **Author:** Sana (Architecture & FLT Internals)
> **Date:** 2025-07-12
> **Status:** P1 Complete
> **Parent:** F27 QA Testing — `docs/specs/features/F27-qa-testing/spec.md` §5
> **Depends On:** C01 (Scenario Model), C02 (Code Understanding Engine), C04 (Assertion Engine), C05 (SignalR Protocol), C06 (Frontend Panel)
> **Infrastructure:** `EdogTopicRouter`, `TopicBuffer`, `TopicEvent`, `EdogPlaygroundHub`, `EdogHttpPipelineHandler`, `EdogDagExecutionInterceptor`, `EdogFeatureFlighterWrapper`, F24 ChaosRule engine

---

## Overview

The Execution Engine is the runtime core of F27. It takes a curated list of scenarios from C01 and runs them sequentially against the live FLT process, coordinating stimulus delivery, event capture, assertion evaluation (C04), chaos rule lifecycle (F24), and real-time progress reporting (C05/C06). It owns the eight-phase execution loop: ISOLATE → SETUP → MARK → STIMULATE → CAPTURE → EVALUATE → TEARDOWN → REPORT.

**Constraint:** EDOG runs inside the FLT process. The engine cannot fork, cannot outlive FLT, and must never crash the host. Every error path recovers or degrades — never propagates to FLT production code.

**Performance target:** Per-scenario orchestration overhead < 50ms (excluding stimulus latency and capture timeout).

---

## Execution Loop State Machine

```
                    ┌─────────────────────────────────────────────────────┐
                    │              ExecutionRun (sequential)               │
                    │                                                     │
  StartRun() ──►   │  for each scenario in run.scenarios:                │
                    │    ┌──────────┐                                     │
                    │    │ ISOLATE  │ ── CreateRecordingSession()         │
                    │    └────┬─────┘                                     │
                    │         ▼                                           │
                    │    ┌──────────┐                                     │
                    │    │  SETUP   │ ── ApplyChaosRules, OverrideFlags  │
                    │    └────┬─────┘                                     │
                    │         ▼                   setup fails?            │
                    │    ┌──────────┐             ──────────► SKIP        │
                    │    │  MARK    │ ── Record T0                       │
                    │    └────┬─────┘                                     │
                    │         ▼                                           │
                    │    ┌──────────┐                                     │
                    │    │STIMULATE │ ── DeliverStimulus(type, args)      │
                    │    └────┬─────┘                                     │
                    │         ▼                   stimulus fails?         │
                    │    ┌──────────┐             ──────────► TEARDOWN    │
                    │    │ CAPTURE  │ ── StreamEvents(timeout | allMet)  │
                    │    └────┬─────┘                                     │
                    │         ▼                                           │
                    │    ┌──────────┐                                     │
                    │    │EVALUATE  │ ── AssertionEngine.Evaluate()       │
                    │    └────┬─────┘                                     │
                    │         ▼                                           │
                    │    ┌──────────┐                                     │
                    │    │TEARDOWN  │ ── RemoveChaosRules, RestoreFlags  │
                    │    └────┬─────┘                                     │
                    │         ▼                                           │
                    │    ┌──────────┐                                     │
                    │    │ REPORT   │ ── EmitResult via SignalR           │
                    │    └──────────┘                                     │
                    │                                                     │
                    │    ── 500ms inter-scenario gap ──                   │
                    │    ── safety checks ──                              │
                    │    ── next scenario ──                              │
                    └─────────────────────────────────────────────────────┘
```

---

## Scenarios

### S01: Recording Session Lifecycle

**ID:** `C03-S01`
**One-liner:** Create a scoped recording session that captures events without destroying Runtime View data.

**Detailed description:**
Each scenario execution needs its own isolated window of interceptor events. The recording session snapshots the current position (sequence ID) in each relevant `TopicBuffer` ring buffer at creation time, then collects all events written after that position during execution. On close, it yields the bounded event set for assertion. This is additive — it never clears buffers, never disrupts the live `ChannelReader` streaming that powers Runtime View panels. Multiple recording sessions must not interfere with each other (though in practice only one runs at a time due to sequential execution).

**Technical mechanism:**
```csharp
// Pseudocode — RecordingSession lifecycle
public sealed class RecordingSession : IDisposable
{
    public string ScenarioId { get; }
    public string RunId { get; }
    public DateTimeOffset StartedAt { get; }
    public DateTimeOffset? ClosedAt { get; private set; }

    // topic → sequenceId at session start (snapshot position)
    private readonly Dictionary<string, long> _startPositions;
    // topic → list of events captured since start
    private readonly Dictionary<string, List<TopicEvent>> _captured;
    private readonly CancellationTokenSource _cts;
    private bool _disposed;

    public static RecordingSession Create(string scenarioId, string runId, string[] topics)
    {
        var session = new RecordingSession
        {
            ScenarioId = scenarioId,
            RunId = runId,
            StartedAt = DateTimeOffset.UtcNow,
        };

        // Snapshot current position in each relevant topic buffer
        foreach (var topic in topics)
        {
            var buffer = EdogTopicRouter.GetBuffer(topic);
            if (buffer == null) continue;

            var snapshot = buffer.GetSnapshot();
            long lastSeqId = snapshot.Length > 0
                ? snapshot[^1].SequenceId
                : 0;
            session._startPositions[topic] = lastSeqId;
        }

        // Start background capture: subscribe to live channel per topic
        foreach (var topic in topics)
        {
            var buffer = EdogTopicRouter.GetBuffer(topic);
            if (buffer == null) continue;

            _ = Task.Run(async () =>
            {
                await foreach (var evt in buffer.ReadLiveAsync(session._cts.Token))
                {
                    if (evt.SequenceId > session._startPositions[topic])
                    {
                        lock (session._captured)
                        {
                            if (!session._captured.TryGetValue(topic, out var list))
                            {
                                list = new List<TopicEvent>();
                                session._captured[topic] = list;
                            }
                            list.Add(evt);
                        }
                    }
                }
            });
        }

        return session;
    }

    public IReadOnlyList<TopicEvent> GetCapturedEvents(string topic)
    {
        lock (_captured)
        {
            return _captured.TryGetValue(topic, out var list)
                ? list.AsReadOnly()
                : Array.Empty<TopicEvent>();
        }
    }

    public IReadOnlyList<TopicEvent> GetAllCapturedEvents()
    {
        lock (_captured)
        {
            return _captured.Values
                .SelectMany(list => list)
                .OrderBy(e => e.Timestamp)
                .ToList()
                .AsReadOnly();
        }
    }

    public void Close()
    {
        ClosedAt = DateTimeOffset.UtcNow;
        _cts.Cancel();
    }

    public void Dispose()
    {
        if (!_disposed)
        {
            _disposed = true;
            _cts.Cancel();
            _cts.Dispose();
        }
    }
}
```

**Source code path:**
- `TopicBuffer.GetSnapshot()` — `src/backend/DevMode/TopicBuffer.cs:61-64`
- `TopicBuffer.ReadLiveAsync()` — `src/backend/DevMode/TopicBuffer.cs:70-73`
- `TopicBuffer.NextSequenceId()` — `src/backend/DevMode/TopicBuffer.cs:41`
- `TopicEvent.SequenceId` — `src/backend/DevMode/TopicEvent.cs:20`
- `EdogTopicRouter.GetBuffer()` — `src/backend/DevMode/EdogTopicRouter.cs:60-65`

**Edge cases:**
- Ring buffer eviction during capture: if a high-volume topic (e.g., `log` at 10,000 cap) wraps around during a long scenario, the live channel still delivers all events (unbounded), but `GetSnapshot()` called after the fact may miss early events. Mitigation: the live-channel subscription is the primary capture path; snapshot is only for position reference.
- Topic not registered: `GetBuffer()` returns null. Session silently skips that topic. Logged at Debug level.
- Session left open: `IDisposable` + finalizer guard. `Close()` called explicitly in TEARDOWN; `Dispose()` as safety net.
- Concurrent `ReadLiveAsync` consumers: `Channel<TopicEvent>` is `SingleWriter=false` but live channel is shared with the SignalR streaming path in `EdogPlaygroundHub.SubscribeToTopic()` (`src/backend/DevMode/EdogPlaygroundHub.cs:62-73`). **Critical issue:** `ChannelReader.ReadAllAsync()` is single-consumer — two readers on the same channel would race. **Solution:** Recording session must tap into `TopicBuffer.Write()` via a secondary channel or event callback, not by calling `ReadLiveAsync()` directly. See S07 (Scoped Recording) for the detailed mechanism.

**Interactions:**
- **C01 (Scenario Model):** Session topics derived from `scenario.expectations[].topic` field.
- **C04 (Assertion Engine):** Receives `GetAllCapturedEvents()` output for evaluation.
- **C05 (SignalR Protocol):** Must not interfere with existing `SubscribeToTopic()` streaming.

**Revert/undo mechanism:** `Dispose()` cancels all background capture tasks via `CancellationTokenSource`. No persistent state. If abandoned, GC + finalizer cleans up.

**Priority:** P0 — Without recording sessions, no scenario can capture evidence.

---

### S02: Stimulus Execution — `http_request`

**ID:** `C03-S02`
**One-liner:** Send an HTTP request to FLT's internal Kestrel endpoints to trigger code paths.

**Detailed description:**
The most common stimulus type. EDOG constructs an `HttpRequestMessage` from the scenario's stimulus spec (method, URL, headers, body) and sends it to FLT's Kestrel server. Since EDOG is in-process, this goes through the full ASP.NET Core pipeline — routing, middleware, auth, controller — exercising the exact code path a real client would hit. The request goes through `EdogHttpPipelineHandler` (`src/backend/DevMode/EdogHttpPipelineHandler.cs:25`), which captures it to the `http` topic, providing built-in observability. The response status code, headers, and body preview are available for assertion.

**Technical mechanism:**
```csharp
// Pseudocode — HTTP stimulus delivery
async Task<StimulusResult> ExecuteHttpStimulus(StimulusSpec stimulus, CancellationToken ct)
{
    var request = new HttpRequestMessage
    {
        Method = new HttpMethod(stimulus.Config["method"] ?? "GET"),
        RequestUri = new Uri(stimulus.Config["url"], UriKind.RelativeOrAbsolute),
    };

    // Apply headers from stimulus spec
    if (stimulus.Config.TryGetValue("headers", out var headers))
    {
        foreach (var (key, value) in headers)
            request.Headers.TryAddWithoutValidation(key, value);
    }

    // Apply body
    if (stimulus.Config.TryGetValue("body", out var body))
    {
        request.Content = new StringContent(
            body,
            Encoding.UTF8,
            stimulus.Config.GetValueOrDefault("contentType", "application/json"));
    }

    var sw = Stopwatch.StartNew();
    try
    {
        // Use IHttpClientFactory to get a client that includes EDOG's handler chain
        var client = _httpClientFactory.CreateClient("edog-stimulus");
        var response = await client.SendAsync(request, ct);
        sw.Stop();

        return new StimulusResult
        {
            Success = true,
            StatusCode = (int)response.StatusCode,
            DurationMs = sw.ElapsedMilliseconds,
            ResponsePreview = await CapturePreview(response.Content),
        };
    }
    catch (Exception ex) when (ex is not OperationCanceledException)
    {
        sw.Stop();
        return new StimulusResult
        {
            Success = false,
            Error = ex.Message,
            DurationMs = sw.ElapsedMilliseconds,
        };
    }
}
```

**Source code path:**
- `EdogHttpPipelineHandler.SendAsync()` — `src/backend/DevMode/EdogHttpPipelineHandler.cs:46-87` (captures the request/response)
- `EdogHttpPipelineHandler` DelegatingHandler registration — `src/backend/DevMode/EdogDevModeRegistrar.cs:40` (`RegisterHttpPipelineHandler`)
- HTTP topic publish — `src/backend/DevMode/EdogHttpPipelineHandler.cs:67-78`
- `EdogTopicRouter.Publish("http", ...)` — `src/backend/DevMode/EdogTopicRouter.cs:73-94`

**Edge cases:**
- Relative URL without base address: must resolve against FLT's bound Kestrel port (typically `http://localhost:{fltPort}`). The port is known at Connected phase start.
- Auth headers: stimulus spec may include `Authorization` header for endpoints requiring auth. EDOG must NOT log raw tokens — `EdogHttpPipelineHandler` already redacts at `EdogHttpPipelineHandler.cs:30-32` (SAS) and `EdogHttpPipelineHandler.cs:109-137` (Authorization).
- Request timeout vs scenario timeout: HTTP request has its own `HttpClient.Timeout` (default 100s). Scenario timeout (from spec) should be shorter. Use `CancellationToken` with `Task.WhenAny` to enforce scenario timeout.
- FLT endpoint returns 5xx: this is NOT a stimulus failure — it's a valid response that assertions evaluate. Stimulus failure = transport-level exception (connection refused, DNS failure).
- Large response body: `EdogHttpPipelineHandler` already truncates at 4KB (`MaxBodyPreviewBytes = 4096` at `EdogHttpPipelineHandler.cs:27`). Stimulus result captures same preview.

**Interactions:**
- **C01 (Scenario Model):** Stimulus spec defines `type: "http_request"` with `config: { method, url, headers, body }`.
- **C04 (Assertion Engine):** HTTP topic events captured by recording session feed into assertion evaluation.
- **C05 (SignalR):** Stimulus execution progress reported via `ScenarioStepChanged` method.

**Revert/undo mechanism:** HTTP requests are inherently stateless from the engine's perspective. If the request mutates FLT state (e.g., triggers a DAG run), the TEARDOWN phase must handle state cleanup (scenario-specific).

**Priority:** P0 — HTTP is the most common stimulus type. Covers API/controller code paths.

---

### S03: Stimulus Execution — `signalr_invoke`

**ID:** `C03-S03`
**One-liner:** Invoke a hub method on `EdogPlaygroundHub` to trigger real-time feature code paths.

**Detailed description:**
For PRs that touch SignalR hub methods or real-time features, the stimulus invokes a method on the hub directly. Since EDOG is in-process, it can resolve `IHubContext<EdogPlaygroundHub>` from DI and invoke methods without establishing a separate WebSocket connection. This exercises the hub method code but bypasses the SignalR transport layer. For full end-to-end testing (including transport), the engine can alternatively create a SignalR client connection from within the process.

**Technical mechanism:**
```csharp
async Task<StimulusResult> ExecuteSignalRStimulus(StimulusSpec stimulus, CancellationToken ct)
{
    var hubContext = _serviceProvider.GetRequiredService<IHubContext<EdogPlaygroundHub>>();
    var method = stimulus.Config["method"];     // e.g., "Subscribe"
    var args = stimulus.Config["args"];         // e.g., ["dag"]

    var sw = Stopwatch.StartNew();
    try
    {
        // Invoke on all connected clients (broadcast) or specific connection
        if (stimulus.Config.TryGetValue("connectionId", out var connId))
        {
            await hubContext.Clients.Client(connId).SendAsync(method, args, ct);
        }
        else
        {
            await hubContext.Clients.All.SendAsync(method, args, ct);
        }
        sw.Stop();

        return new StimulusResult { Success = true, DurationMs = sw.ElapsedMilliseconds };
    }
    catch (Exception ex) when (ex is not OperationCanceledException)
    {
        sw.Stop();
        return new StimulusResult { Success = false, Error = ex.Message, DurationMs = sw.ElapsedMilliseconds };
    }
}
```

**Source code path:**
- `EdogPlaygroundHub` class — `src/backend/DevMode/EdogPlaygroundHub.cs:22`
- `Subscribe()` method — `src/backend/DevMode/EdogPlaygroundHub.cs:27-33`
- `SubscribeToTopic()` streaming — `src/backend/DevMode/EdogPlaygroundHub.cs:62-73`

**Edge cases:**
- No connected clients: `Clients.All.SendAsync()` succeeds silently with zero recipients. This is not an error — assertions should check downstream effects, not client receipt.
- Hub method throws: exception propagates to `StimulusResult.Error`. Scenario continues to EVALUATE (the exception itself may be the expected behavior).
- Transport-level testing needed: for scenarios requiring full WebSocket round-trip, use `HubConnectionBuilder` to create an in-process client connection first.

**Interactions:**
- **C01:** Stimulus spec `type: "signalr_invoke"` with `config: { method, args, connectionId? }`.
- **C05:** Hub is the same `EdogPlaygroundHub` used for progress reporting. Avoid self-referential invocations that could cause infinite loops.

**Revert/undo mechanism:** Hub invocations are typically read-only (subscribe/unsubscribe). No revert needed. If a hub method triggers side effects, TEARDOWN handles cleanup.

**Priority:** P1 — Less common than HTTP but critical for real-time feature testing.

---

### S04: Stimulus Execution — `dag_trigger`

**ID:** `C03-S04`
**One-liner:** Trigger a DAG execution via the existing FLT scheduling endpoint.

**Detailed description:**
DAG-related PRs (touching scheduling, node execution, dependency resolution) need a stimulus that triggers a full or partial DAG run. The engine sends `POST /liveTableSchedule/runDAG/{iterationId}` to FLT's internal endpoint. This exercises the full `DagExecutionHandlerV2` pipeline, which includes `EdogDagExecutionHook` (`src/backend/DevMode/EdogDagExecutionInterceptor.cs:31`) and `EdogNodeExecutorWrapper` (`src/backend/DevMode/EdogDagExecutionInterceptor.cs:140`), providing rich observability of node lifecycle events on the `dag` topic. DAG stimulus is inherently long-running (seconds to minutes) so the engine must handle extended capture windows.

**Technical mechanism:**
```csharp
async Task<StimulusResult> ExecuteDagTriggerStimulus(StimulusSpec stimulus, CancellationToken ct)
{
    var iterationId = stimulus.Config["iterationId"];
    var url = $"http://localhost:{_fltPort}/liveTableSchedule/runDAG/{iterationId}";

    var client = _httpClientFactory.CreateClient("edog-stimulus");
    var sw = Stopwatch.StartNew();
    try
    {
        var response = await client.PostAsync(url, null, ct);
        sw.Stop();

        // DAG trigger returns immediately (202 Accepted typically)
        // Actual DAG execution happens asynchronously — CAPTURE phase handles the wait
        return new StimulusResult
        {
            Success = response.IsSuccessStatusCode,
            StatusCode = (int)response.StatusCode,
            DurationMs = sw.ElapsedMilliseconds,
            Metadata = new { triggerType = "dag", iterationId },
        };
    }
    catch (Exception ex) when (ex is not OperationCanceledException)
    {
        sw.Stop();
        return new StimulusResult { Success = false, Error = ex.Message, DurationMs = sw.ElapsedMilliseconds };
    }
}
```

**Source code path:**
- `EdogDagExecutionHook.ExecuteAsync()` — `src/backend/DevMode/EdogDagExecutionInterceptor.cs:43-116` (terminal DAG event capture)
- `EdogNodeExecutorWrapper.ExecuteNodeAsync()` — `src/backend/DevMode/EdogDagExecutionInterceptor.cs:165-208` (per-node lifecycle)
- DAG topic publish — `src/backend/DevMode/EdogDagExecutionInterceptor.cs:125` and `231`
- URL pattern reference — `src/backend/DevMode/EdogNexusClassifier.cs:79` (liveTableSchedule pattern)

**Edge cases:**
- No valid iteration ID: endpoint returns 404. This is a stimulus configuration error — scenario marked as `SETUP_FAILED`.
- DAG already running: FLT may reject concurrent DAG runs for the same iteration. Check response body for error.
- Long-running DAG: scenario timeout must be generous (30s+). CAPTURE phase streams `dag` topic events and can early-complete when `DagTerminal` event arrives.
- Node failures within DAG: expected in chaos scenarios. The DAG still reaches terminal state — assertions evaluate the failure path.

**Interactions:**
- **C01:** Stimulus spec `type: "dag_trigger"` with `config: { iterationId }`.
- **C04:** Assertion engine matches `dag` topic events (`DagTerminal`, `NodeStarted`, `NodeCompleted`, `NodeFailed`).
- **F24 Chaos:** Setup step may inject latency/errors on HTTP calls that DAG nodes make, then assertions verify retry/failure handling.

**Revert/undo mechanism:** DAG execution cannot be "undone" — it produces artifacts. TEARDOWN should verify DAG reached terminal state. If stuck, log a warning but do not attempt to kill the DAG (could corrupt FLT state).

**Priority:** P0 — DAG execution is the core FLT workflow. Most PRs touch DAG-related code.

---

### S05: Stimulus Execution — `file_event`

**ID:** `C03-S05`
**One-liner:** Write a file to a watched OneLake path to trigger file-change detection flows.

**Detailed description:**
PRs touching file-triggered flows (OneLake watchers, file processors) need a stimulus that produces a file event. The engine writes a synthetic file to a watched path. The `EdogFileSystemInterceptor` captures the write operation on the `fileop` topic, and downstream processing triggers additional events on other topics. The file content can be templated from the scenario spec (e.g., a minimal Parquet header, a JSON config fragment).

**Technical mechanism:**
```csharp
async Task<StimulusResult> ExecuteFileEventStimulus(StimulusSpec stimulus, CancellationToken ct)
{
    var path = stimulus.Config["path"];            // Watched OneLake path
    var content = stimulus.Config["content"];       // File content (string or base64)
    var encoding = stimulus.Config.GetValueOrDefault("encoding", "utf8");

    var sw = Stopwatch.StartNew();
    try
    {
        // Resolve IFileSystem from DI (goes through EdogFileSystemInterceptor)
        var fileSystem = _serviceProvider.GetRequiredService<IFileSystem>();
        byte[] bytes = encoding == "base64"
            ? Convert.FromBase64String(content)
            : Encoding.UTF8.GetBytes(content);

        await fileSystem.WriteAsync(path, bytes, ct);
        sw.Stop();

        return new StimulusResult { Success = true, DurationMs = sw.ElapsedMilliseconds };
    }
    catch (Exception ex) when (ex is not OperationCanceledException)
    {
        sw.Stop();
        return new StimulusResult { Success = false, Error = ex.Message, DurationMs = sw.ElapsedMilliseconds };
    }
}
```

**Source code path:**
- File system interceptor publish — `src/backend/DevMode/EdogFileSystemInterceptor.cs:264` (per P0 foundation research)
- `fileop` topic registration — `src/backend/DevMode/EdogTopicRouter.cs:30` (buffer size 2,000)

**Edge cases:**
- Path outside watched directory: write succeeds but no downstream processing triggers. Scenario may timeout waiting for expected events. Mitigation: stimulus validation in SETUP could verify path matches a known watcher pattern.
- Permission denied: FLT process may lack write access to some OneLake paths. Report as stimulus failure.
- Large file content: impose a 1MB limit in stimulus spec validation to prevent memory issues.
- Race condition: file watcher may not detect the write instantly. CAPTURE phase timeout accommodates this.

**Interactions:**
- **C01:** Stimulus spec `type: "file_event"` with `config: { path, content, encoding? }`.
- **C04:** Assertions on `fileop` topic events + downstream topics triggered by file processing.

**Revert/undo mechanism:** TEARDOWN should delete the synthetic file if `stimulus.Config["cleanup"]` is true (default). Use the same `IFileSystem` to remove.

**Priority:** P1 — Important for OneLake-related PRs. Less frequent than HTTP/DAG.

---

### S06: Stimulus Execution — `timer_tick` and `direct_invoke`

**ID:** `C03-S06`
**One-liner:** Advance timers or invoke internal services directly via DI resolution.

**Detailed description:**
Two remaining stimulus types that handle code with no external entry point. `timer_tick` waits for or advances the next scheduled timer tick (used for code triggered by background timers — eviction, cache refresh, scheduled checks). `direct_invoke` resolves a service from DI and calls a method directly — the most flexible stimulus, usable when no HTTP/SignalR entry point exists for the changed code path. Direct invoke exercises the service code but bypasses HTTP pipeline middleware.

**Technical mechanism:**
```csharp
// timer_tick — wait for next scheduled tick
async Task<StimulusResult> ExecuteTimerTickStimulus(StimulusSpec stimulus, CancellationToken ct)
{
    var tickSource = stimulus.Config["tickSource"];  // e.g., "EvictionManager", "CacheRefresh"
    var maxWaitMs = int.Parse(stimulus.Config.GetValueOrDefault("maxWaitMs", "10000"));

    var sw = Stopwatch.StartNew();
    // Wait for a specific event pattern on the relevant topic that indicates the tick fired
    var tickDetected = await WaitForTopicEvent(
        topic: stimulus.Config.GetValueOrDefault("topic", "perf"),
        predicate: evt => MatchesTickPattern(evt, tickSource),
        timeoutMs: maxWaitMs,
        ct: ct);
    sw.Stop();

    return new StimulusResult
    {
        Success = tickDetected,
        DurationMs = sw.ElapsedMilliseconds,
        Error = tickDetected ? null : $"Timer tick '{tickSource}' not detected within {maxWaitMs}ms",
    };
}

// direct_invoke — resolve service from DI, call method
async Task<StimulusResult> ExecuteDirectInvokeStimulus(StimulusSpec stimulus, CancellationToken ct)
{
    var serviceType = stimulus.Config["serviceType"];   // e.g., "IOneLakeWriter"
    var methodName = stimulus.Config["method"];          // e.g., "WriteFileAsync"
    var args = stimulus.Config["args"];                  // JSON array of arguments

    var sw = Stopwatch.StartNew();
    try
    {
        // Resolve the service interface from DI
        var type = ResolveServiceType(serviceType); // Lookup from EdogDiRegistryCapture data
        var service = _serviceProvider.GetRequiredService(type);
        var method = type.GetMethod(methodName);

        if (method == null)
            return new StimulusResult { Success = false, Error = $"Method '{methodName}' not found on '{serviceType}'" };

        var parameters = DeserializeArgs(method.GetParameters(), args);
        var result = method.Invoke(service, parameters);

        // Await if async
        if (result is Task task)
            await task.ConfigureAwait(false);

        sw.Stop();
        return new StimulusResult { Success = true, DurationMs = sw.ElapsedMilliseconds };
    }
    catch (TargetInvocationException ex)
    {
        sw.Stop();
        return new StimulusResult
        {
            Success = false,
            Error = ex.InnerException?.Message ?? ex.Message,
            DurationMs = sw.ElapsedMilliseconds,
        };
    }
}
```

**Source code path:**
- DI registry data — `src/backend/DevMode/EdogDiRegistryCapture.cs:25-60` (known registrations)
- Perf markers (timer ticks) — `src/backend/DevMode/EdogPerfMarkerCallback.cs:35-75` (per P0 foundation)
- DI registration entry point — `src/backend/DevMode/EdogDevModeRegistrar.cs:25-56`

**Edge cases:**
- `direct_invoke` on non-DI service: `GetRequiredService()` throws `InvalidOperationException`. Report as stimulus failure.
- Ambiguous method overloads: `GetMethod()` may return null if multiple overloads exist. Use `GetMethods().First(m => ...)` with parameter type matching.
- `timer_tick` target never fires: scenario times out. TIMED_OUT result with partial captures.
- Security: `direct_invoke` can call ANY registered service method. This is acceptable because EDOG is a dev tool running locally — but should be gated behind Connected phase only.
- Reflection failure on trimmed/obfuscated assemblies: unlikely in Debug builds (FLT dev mode), but catch `MissingMethodException` explicitly.

**Interactions:**
- **C01:** Stimulus spec `type: "timer_tick"` or `type: "direct_invoke"`.
- **C02 (Code Understanding):** Reverse call-graph analysis identifies when `direct_invoke` is needed (changed code has no HTTP entry point).
- **C04:** All topic events during invocation captured by recording session.

**Revert/undo mechanism:** `direct_invoke` side effects are scenario-specific. TEARDOWN steps in the scenario spec must handle cleanup. `timer_tick` is passive (observation only) — no revert needed.

**Priority:** P1 (`direct_invoke`), P2 (`timer_tick`) — `direct_invoke` is the escape hatch for untestable code. `timer_tick` is rare.

---

### S07: Scoped Recording (Additive, Non-Destructive)

**ID:** `C03-S07`
**One-liner:** Recording sessions observe events additively without interfering with Runtime View streaming.

**Detailed description:**
The critical constraint from spec §5.3: recording must be additive, not destructive. The existing `TopicBuffer.ReadLiveAsync()` (`src/backend/DevMode/TopicBuffer.cs:70-73`) returns a `ChannelReader` that is consumed by `EdogPlaygroundHub.SubscribeToTopic()` (`src/backend/DevMode/EdogPlaygroundHub.cs:62`). A recording session cannot call `ReadLiveAsync()` on the same buffer — `ChannelReader` consumers would race. Instead, recording sessions must use a secondary tap mechanism.

**Technical mechanism:**

Option A (preferred): Add an `OnWrite` callback list to `TopicBuffer`:
```csharp
// Extension to TopicBuffer (minimal, non-breaking)
public sealed class TopicBuffer
{
    // Existing fields...
    private readonly List<Action<TopicEvent>> _observers = new();
    private readonly object _observerLock = new();

    public IDisposable AddObserver(Action<TopicEvent> callback)
    {
        lock (_observerLock)
        {
            _observers.Add(callback);
        }
        return new ObserverRemoval(this, callback);
    }

    public void Write(TopicEvent evt)
    {
        // Existing: ring buffer + live channel
        _ring.Enqueue(evt);
        while (_ring.Count > _maxSize) _ring.TryDequeue(out _);
        _liveChannel.Writer.TryWrite(evt);

        // NEW: notify observers (recording sessions)
        lock (_observerLock)
        {
            foreach (var obs in _observers)
            {
                try { obs(evt); }
                catch { /* never propagate */ }
            }
        }
    }
}
```

Recording session subscribes via `AddObserver()` on create, removes on `Dispose()`. This is O(1) overhead per observer per event — negligible for the 1-2 observers expected during a test run.

**Source code path:**
- `TopicBuffer.Write()` — `src/backend/DevMode/TopicBuffer.cs:48-56` (extension point)
- `TopicBuffer._liveChannel` — `src/backend/DevMode/TopicBuffer.cs:24` (existing live channel)
- `EdogPlaygroundHub.SubscribeToTopic()` — `src/backend/DevMode/EdogPlaygroundHub.cs:62-73` (existing consumer — must not be disrupted)

**Edge cases:**
- Observer callback throws: caught and swallowed (same pattern as `EdogTopicRouter.Publish` at `EdogTopicRouter.cs:88-93`).
- High event volume during capture: observer is called synchronously on the `Write()` path. Must be fast (< 1μs). The callback does `List.Add()` under lock — acceptable.
- Observer not removed: memory leak. `IDisposable` pattern + `RecordingSession.Dispose()` ensures cleanup.
- Concurrent `Write()` + `AddObserver()`: the `_observerLock` serializes observer list mutations. `Write()` also takes the lock (brief), which is safe because `Write()` is non-blocking and never called from a lock-holding path.

**Interactions:**
- **C05 (SignalR):** Runtime View streaming via `SubscribeToTopic()` continues unaffected — live channel is untouched.
- **S01 (Recording Session):** This is the implementation mechanism for S01's live capture.
- **C06 (Frontend):** No UI changes — Runtime View panels continue receiving events normally during test execution.

**Revert/undo mechanism:** `ObserverRemoval.Dispose()` removes the callback from the list. `TopicBuffer` returns to zero-overhead state.

**Priority:** P0 — Core architectural piece. Without this, recording sessions cannot capture events.

---

### S08: Sequential Isolation

**ID:** `C03-S08`
**One-liner:** Enforce 500ms gap and safety checks between scenarios to prevent cross-contamination.

**Detailed description:**
Scenarios run strictly one at a time. Between scenarios, the engine waits 500ms (configurable) to allow async operations from the previous scenario to flush through the interceptor pipeline. Then it performs safety checks: no lingering chaos rules from the previous scenario (tagged with scenario ID), no lingering flag overrides, no open recording sessions. Only after all checks pass does the next scenario begin. If checks fail after 3 retries (each 200ms), the engine force-clears and logs a warning.

**Technical mechanism:**
```csharp
async Task RunInterScenarioGap(string previousScenarioId, CancellationToken ct)
{
    // 1. Wait for async flush
    await Task.Delay(500, ct);

    // 2. Safety checks (3 retries, 200ms between)
    for (int attempt = 0; attempt < 3; attempt++)
    {
        var issues = new List<string>();

        // Check: no chaos rules tagged with previous scenario
        var orphanRules = _chaosEngine.GetRulesForScenario(previousScenarioId);
        if (orphanRules.Any())
            issues.Add($"Orphan chaos rules: {orphanRules.Count}");

        // Check: no flag overrides from previous scenario
        var orphanFlags = _flagOverrideStore.GetOverridesForScenario(previousScenarioId);
        if (orphanFlags.Any())
            issues.Add($"Orphan flag overrides: {orphanFlags.Count}");

        if (!issues.Any())
            return; // Clean — proceed

        if (attempt < 2)
        {
            await Task.Delay(200, ct);
            continue;
        }

        // Final attempt failed — force clear and warn
        _chaosEngine.RemoveRulesForScenario(previousScenarioId);
        _flagOverrideStore.ClearOverridesForScenario(previousScenarioId);

        PublishWarning($"Force-cleared orphan state after scenario '{previousScenarioId}': {string.Join(", ", issues)}");
    }
}
```

**Source code path:**
- Chaos rule lifecycle reference — `docs/specs/features/F24-chaos-engineering/engine-design.md:1230-1340` (ChaosRule data model with `tags` field for scenario ID)
- `EdogFeatureFlighterWrapper.IsEnabled()` — `src/backend/DevMode/EdogFeatureFlighterWrapper.cs:33-56` (flag evaluation interception point)

**Edge cases:**
- Async operations take longer than 500ms + 600ms retries: possible for long-running DAG nodes. The force-clear prevents contamination but may cause the lingering operation to behave unexpectedly. Log a warning with the specific scenario ID.
- Cancellation during gap: honor `CancellationToken`. Abandoned cleanup is acceptable — TEARDOWN at run level handles final cleanup.
- FLT process crash during gap: covered by S10 (FLT Crash Recovery).

**Interactions:**
- **F24 Chaos:** `RemoveRulesForScenario(scenarioId)` — chaos engine must support scenario-tagged rules.
- **C01:** Inter-scenario gap is configurable in the run-level settings (default 500ms).
- **S01:** Previous recording session must be closed/disposed before gap starts.

**Revert/undo mechanism:** Force-clear is the revert mechanism itself. The gap ensures no state leaks between scenarios.

**Priority:** P0 — Without isolation, scenario results are unreliable.

---

### S09: Timeout Handling

**ID:** `C03-S09`
**One-liner:** Force-complete scenarios that exceed their timeout, reporting partial results.

**Detailed description:**
Every scenario has a timeout (from `scenario.timeout` field, default 10,000ms). The CAPTURE phase runs until either (a) all expectations are met (early exit) or (b) the timeout expires. On timeout, the engine force-closes the recording session, evaluates whatever was captured (partial results), and marks the scenario as `TIMED_OUT` with a sub-status indicating which expectations were met and which were not. The scenario still gets a full TEARDOWN and REPORT phase. Timeout does NOT skip teardown — chaos rules and flag overrides must always be cleaned up.

**Technical mechanism:**
```csharp
async Task<CaptureResult> RunCapturePhase(
    RecordingSession session,
    Expectation[] expectations,
    int timeoutMs,
    CancellationToken ct)
{
    using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
    timeoutCts.CancelAfter(timeoutMs);

    var allMet = new TaskCompletionSource<bool>();
    var metCount = 0;

    // Poll expectations at 100ms intervals
    _ = Task.Run(async () =>
    {
        while (!timeoutCts.Token.IsCancellationRequested)
        {
            var events = session.GetAllCapturedEvents();
            var currentMet = expectations.Count(e => e.IsSatisfiedBy(events));

            if (currentMet == expectations.Length)
            {
                allMet.TrySetResult(true);
                return;
            }

            // Report progress: X of Y expectations met
            PublishProgress(session.ScenarioId, currentMet, expectations.Length);

            await Task.Delay(100, timeoutCts.Token).ConfigureAwait(false);
        }
    }, timeoutCts.Token);

    try
    {
        await allMet.Task.WaitAsync(timeoutCts.Token);
        return new CaptureResult { Complete = true };
    }
    catch (OperationCanceledException) when (timeoutCts.IsCancellationRequested && !ct.IsCancellationRequested)
    {
        // Timeout — not user cancellation
        return new CaptureResult
        {
            Complete = false,
            Reason = "timeout",
            CapturedEventCount = session.GetAllCapturedEvents().Count,
        };
    }
}
```

**Source code path:** New code. References existing infrastructure only.

**Edge cases:**
- Timeout = 0: interpret as "no timeout" — use a maximum ceiling of 300,000ms (5 minutes) to prevent indefinite hangs.
- All expectations met before stimulus completes: early exit. Stimulus may still be running (e.g., DAG in progress). Recording session closes but the underlying operation continues in FLT.
- Partial results: some expectations PASS, some remain UNKNOWN (not enough events). Report both. Never report unmatched expectations as FAIL on timeout — they are INCONCLUSIVE.
- Polling overhead: 100ms interval × 16 topics = negligible. `IsSatisfiedBy()` is O(events × matchers) — see C04 for complexity bounds.

**Interactions:**
- **C01:** `scenario.timeout` field (milliseconds).
- **C04 (Assertion Engine):** `Expectation.IsSatisfiedBy()` called repeatedly during capture.
- **C05 (SignalR):** Progress updates via `ExpectationProgress` method.
- **C06 (Frontend):** Real-time progress bar showing X/Y expectations met.

**Revert/undo mechanism:** Timeout triggers normal TEARDOWN flow. No special revert needed.

**Priority:** P0 — Every scenario needs a timeout. Without it, a stuck scenario blocks the entire run.

---

### S10: FLT Crash Recovery

**ID:** `C03-S10`
**One-liner:** Persist execution state so a run can resume after FLT process restart.

**Detailed description:**
EDOG runs inside FLT. If FLT crashes during scenario execution, EDOG dies too. On restart, the engine checks for an in-progress execution state file at `~/.edog/qa-state.json`. If found, it resumes from the next unexecuted scenario. The crashed scenario is marked `FAILED` with `reason: "process_crash"`. The state file is updated atomically (write-to-temp then rename) after each scenario completes. On clean run completion, the state file is deleted.

**Technical mechanism:**
```json
// ~/.edog/qa-state.json — persisted execution state
{
    "version": 1,
    "runId": "run-abc123",
    "startedAt": "2025-07-12T10:30:00Z",
    "totalScenarios": 12,
    "completedScenarios": [
        { "id": "s01", "result": "PASS", "completedAt": "..." },
        { "id": "s02", "result": "FAIL", "completedAt": "..." }
    ],
    "currentScenario": "s03",
    "currentPhase": "STIMULATE",
    "pendingScenarios": ["s04", "s05", "s06", "..."]
}
```

```csharp
// Pseudocode — state persistence
async Task PersistState(ExecutionState state)
{
    var json = JsonSerializer.Serialize(state, _jsonOptions);
    var tempPath = Path.Combine(_stateDir, "qa-state.tmp");
    var finalPath = Path.Combine(_stateDir, "qa-state.json");

    await File.WriteAllTextAsync(tempPath, json);
    File.Move(tempPath, finalPath, overwrite: true); // Atomic on NTFS and ext4
}

// On startup — check for interrupted run
ExecutionState CheckForInterruptedRun()
{
    var path = Path.Combine(_stateDir, "qa-state.json");
    if (!File.Exists(path)) return null;

    var state = JsonSerializer.Deserialize<ExecutionState>(File.ReadAllText(path));

    // Mark the interrupted scenario as crashed
    state.CompletedScenarios.Add(new ScenarioResult
    {
        Id = state.CurrentScenario,
        Result = "FAILED",
        Reason = "process_crash",
        Phase = state.CurrentPhase,
    });

    state.PendingScenarios.RemoveAt(0); // Skip the crashed scenario
    return state;
}
```

**Source code path:** New code. State directory mirrors existing EDOG state conventions.

**Edge cases:**
- Crash during state file write: temp file exists but final doesn't. On restart, temp file is ignored (incomplete). Run starts fresh. Previous partial results are lost.
- Crash during SETUP (chaos rules injected but not recorded): on restart, run a blanket `ClearAllChaosRules()` before resuming. This is safe — no intentional chaos rules should exist across restarts.
- State file corrupt (truncated JSON): catch `JsonException`, delete the file, start fresh.
- Multiple EDOG instances: not supported — `qa-state.json` is a single-writer file. If concurrent instances exist, last-writer-wins (acceptable for dev tool).
- FLT upgrade changes scenario format: `version` field in state file. If version mismatch, discard and start fresh.

**Interactions:**
- **C01:** Scenario IDs and results stored in state file.
- **F24 Chaos:** `ClearAllChaosRules()` on crash recovery — `docs/specs/features/F24-chaos-engineering/engine-design.md:1026`.
- **C06 (Frontend):** On reconnect after crash, frontend receives `RunResumed` event showing which scenarios completed, which crashed, which remain.

**Revert/undo mechanism:** State file is the recovery mechanism. Clean completion deletes it. Manual recovery: user can delete `~/.edog/qa-state.json` to force a fresh start.

**Priority:** P1 — Important for reliability but crashes are rare during normal dev usage.

---

### S11: F24 Chaos Integration (Setup/Teardown)

**ID:** `C03-S11`
**One-liner:** Scenario setup steps inject chaos rules via F24; teardown removes them by scenario tag.

**Detailed description:**
The F24 Chaos Engineering subsystem provides the fault injection infrastructure. Scenario `setup` steps that specify chaos rules are translated into F24 `ChaosRule` objects and injected via the chaos engine API. Each rule is tagged with the scenario ID for deterministic cleanup in TEARDOWN. The chaos rule data model (from `docs/specs/features/F24-chaos-engineering/engine-design.md:1230`) supports `tags[]` which is used for scenario association. Supported fault types: HTTP error injection, latency injection, timeout simulation, partial response truncation, intermittent failures.

**Technical mechanism:**
```csharp
// SETUP phase — inject chaos rules from scenario spec
async Task SetupChaosRules(Scenario scenario, CancellationToken ct)
{
    foreach (var step in scenario.Setup.Where(s => s.Type == "chaos_rule"))
    {
        var rule = new ChaosRule
        {
            Id = $"qa-{scenario.Id}--{step.ChaosRule.Id}",
            Name = $"[QA] {step.ChaosRule.Name}",
            Predicate = step.ChaosRule.Predicate,
            Action = step.ChaosRule.Action,
            Phase = step.ChaosRule.Phase ?? "request",
            Enabled = true,           // QA rules start enabled (bypass normal safety gate)
            Tags = new[] { $"scenario:{scenario.Id}", "qa-managed" },
            Limits = new ChaosRuleLimits
            {
                TtlSeconds = scenario.Timeout / 1000 + 30, // Auto-expire after scenario + buffer
            },
        };

        await _chaosEngine.AddRule(rule, ct);
    }
}

// TEARDOWN phase — remove all chaos rules for this scenario
async Task TeardownChaosRules(string scenarioId, CancellationToken ct)
{
    await _chaosEngine.RemoveRulesForScenario(scenarioId, ct);

    // Verify removal
    var remaining = _chaosEngine.GetRulesForScenario(scenarioId);
    if (remaining.Any())
    {
        // Belt-and-suspenders: force clear
        foreach (var rule in remaining)
            await _chaosEngine.RemoveRule(rule.Id, ct);

        PublishWarning($"Force-removed {remaining.Count} orphan chaos rules for scenario '{scenarioId}'");
    }
}
```

**Source code path:**
- ChaosRule data model — `docs/specs/features/F24-chaos-engineering/engine-design.md:1230-1340`
- ChaosRule `tags` field — `docs/specs/features/F24-chaos-engineering/engine-design.md:1274-1279`
- ChaosRule `limits.ttlSeconds` — `docs/specs/features/F24-chaos-engineering/engine-design.md:1335-1340`
- `ClearAllChaosRules()` — `docs/specs/features/F24-chaos-engineering/engine-design.md:1026-1029`

**Edge cases:**
- Chaos engine not available (F24 not initialized): setup step fails. Scenario marked `SETUP_FAILED`, skipped (not the whole run).
- TTL expires mid-scenario: rule auto-disables. If the scenario depends on the fault being active for the full capture window, the TTL buffer (scenario timeout + 30s) should prevent this. Log a warning if TTL triggers before scenario completion.
- QA rules bypassing safety gate: acceptable because (a) TTL provides automatic expiry, (b) scenario-tagged rules are deterministically cleaned, (c) dev-tool context.
- Teardown fails: chaos rule remains active. S08 (Sequential Isolation) catches this in the inter-scenario gap. Worst case: rule TTL auto-expires.

**Interactions:**
- **F24:** Primary dependency. Chaos engine API must support `AddRule()`, `RemoveRulesForScenario()`, `GetRulesForScenario()`.
- **C01:** Scenario `setup[].type == "chaos_rule"` with embedded ChaosRule spec.
- **S08:** Inter-scenario gap verifies chaos cleanup.

**Revert/undo mechanism:** TEARDOWN removes rules by scenario tag. TTL provides automatic expiry as a safety net. `ClearAllChaosRules()` is the nuclear option.

**Priority:** P0 — Chaos-driven scenarios are a core F27 value proposition.

---

### S12: Event Correlation

**ID:** `C03-S12`
**One-liner:** Tag interceptor events with scenario run ID for unambiguous attribution.

**Detailed description:**
During scenario execution, other FLT activity may generate interceptor events (background timers, other user actions). The assertion engine needs to distinguish "events caused by my stimulus" from "ambient events." The primary correlation mechanism is temporal: the recording session captures events between T0 (MARK) and T_end (CAPTURE close). For stronger correlation, the engine injects a unique run ID into outbound requests (via an `X-Edog-Scenario` header) which propagates through the HTTP pipeline and appears in `EdogHttpPipelineHandler` captures as `correlationId`.

**Technical mechanism:**
```csharp
// Inject correlation header for HTTP-based stimuli
void InjectCorrelationHeader(HttpRequestMessage request, string scenarioId, string runId)
{
    request.Headers.TryAddWithoutValidation("X-Edog-Scenario", scenarioId);
    request.Headers.TryAddWithoutValidation("X-Edog-RunId", runId);
}

// Correlation strategy for the assertion engine
public class EventCorrelation
{
    public string ScenarioId { get; }
    public string RunId { get; }
    public DateTimeOffset T0 { get; }        // MARK timestamp
    public DateTimeOffset? TEnd { get; }     // Capture close timestamp

    // Primary: temporal window
    public bool IsInWindow(TopicEvent evt)
        => evt.Timestamp >= T0 && (TEnd == null || evt.Timestamp <= TEnd);

    // Secondary: header correlation (HTTP events only)
    public bool HasCorrelationId(TopicEvent evt)
    {
        if (evt.Data is not IDictionary<string, object> data) return false;
        return data.TryGetValue("correlationId", out var id) && id?.ToString() == RunId;
    }

    // Combined: temporal window + optional correlation strengthening
    public bool Correlates(TopicEvent evt)
        => IsInWindow(evt) && (HasCorrelationId(evt) || !IsHttpEvent(evt));
}
```

**Source code path:**
- Correlation ID extraction — `src/backend/DevMode/EdogHttpPipelineHandler.cs:171-188` (`ExtractCorrelationId`)
- HTTP event payload `correlationId` field — `src/backend/DevMode/EdogHttpPipelineHandler.cs:78`
- `TopicEvent.Timestamp` — `src/backend/DevMode/TopicEvent.cs:23`

**Edge cases:**
- Non-HTTP stimuli: no correlation header available. Rely on temporal window only. Widen window by 100ms on each side to account for clock skew.
- High ambient event volume: temporal window may include unrelated events. Assertion engine (C04) must be specific enough in matchers to filter these. Overly broad assertions (e.g., "any HTTP event") will false-match.
- Clock skew between interceptors: all interceptors use `DateTimeOffset.UtcNow` via `EdogTopicRouter.Publish()` (`EdogTopicRouter.cs:82`), so skew is bounded by publish timing (< 1ms).
- Correlation header stripped by middleware: possible if FLT has header-filtering middleware. Use a non-standard header prefix (`X-Edog-`) to avoid stripping.

**Interactions:**
- **C04 (Assertion Engine):** Receives `EventCorrelation` context to filter events before matching.
- **S01 (Recording Session):** Recording session provides the raw event set; correlation narrows it.
- **C02 (Code Understanding):** Correlation metadata helps the LLM understand which events belong to which scenario in multi-scenario analysis.

**Revert/undo mechanism:** Correlation headers are ephemeral — they exist only in the request. No persistent state to revert.

**Priority:** P1 — Temporal window is sufficient for P0. Header-based correlation is a reliability improvement.

---

### S13: Parallel Safety

**ID:** `C03-S13`
**One-liner:** Handle user-triggered FLT activity during test execution without corrupting results.

**Detailed description:**
While the execution engine runs scenarios, the user may interact with FLT directly (trigger a DAG run from the UI, make API calls from Postman, etc.). This generates interceptor events that fall within the recording session's capture window but are unrelated to the test stimulus. The engine does NOT block user activity — FLT is a dev tool, and preventing normal usage during tests is unacceptable. Instead, the engine relies on event correlation (S12) and publishes a warning to the UI indicating that external activity was detected during the capture window.

**Technical mechanism:**
```csharp
// After CAPTURE phase, detect potential contamination
ContaminationReport DetectContamination(RecordingSession session, EventCorrelation correlation)
{
    var allEvents = session.GetAllCapturedEvents();
    var correlatedEvents = allEvents.Where(e => correlation.Correlates(e)).ToList();
    var uncorrelatedEvents = allEvents.Except(correlatedEvents).ToList();

    return new ContaminationReport
    {
        TotalCaptured = allEvents.Count,
        CorrelatedCount = correlatedEvents.Count,
        UncorrelatedCount = uncorrelatedEvents.Count,
        Warning = uncorrelatedEvents.Count > 0
            ? $"Detected {uncorrelatedEvents.Count} events not correlated to scenario stimulus. Results may be affected by concurrent FLT activity."
            : null,
        UncorrelatedTopics = uncorrelatedEvents
            .GroupBy(e => e.Topic)
            .ToDictionary(g => g.Key, g => g.Count()),
    };
}
```

**Source code path:** New code. Uses `RecordingSession` from S01 and `EventCorrelation` from S12.

**Edge cases:**
- User triggers the same endpoint as the stimulus: events are indistinguishable by correlation. Assertion may see double the expected count. This is a known limitation — warn the user.
- Background FLT timers fire during capture: these are ambient events. The temporal window includes them. Assertions must be specific enough to not false-match on timer events.
- User clicks "Stop" in Runtime View: does NOT affect the recording session (separate mechanism). Runtime View uses `SubscribeToTopic()` streams; recording uses observer callbacks (S07).

**Interactions:**
- **S12 (Event Correlation):** Primary mechanism for distinguishing stimulus events from ambient events.
- **C06 (Frontend):** Contamination warning displayed in scenario result card.
- **C04 (Assertion Engine):** Assertions run against ALL captured events (not just correlated ones) — correlation is advisory, not filtering.

**Revert/undo mechanism:** No revert needed. Contamination is detected and reported, not prevented.

**Priority:** P1 — Important for result reliability. Temporal correlation handles most cases.

---

### S14: Cancellation

**ID:** `C03-S14`
**One-liner:** User stops a test run mid-execution; engine cleanly aborts current scenario and all remaining.

**Detailed description:**
The user can cancel a running test via the frontend "Stop" button (C06) or by sending a `CancelRun` SignalR message (C05). The engine cancels the current scenario at whatever phase it's in: if in CAPTURE, force-close the recording session; if in STIMULATE, cancel the HTTP request / hub invocation. TEARDOWN always runs for the current scenario (chaos rules must be cleaned up even on cancel). Remaining scenarios are marked as `CANCELLED`. The partial run result is reported to the frontend.

**Technical mechanism:**
```csharp
// Engine-level cancellation
class ExecutionEngine
{
    private CancellationTokenSource _runCts;

    public void CancelRun()
    {
        _runCts?.Cancel();
    }

    async Task RunScenarios(Scenario[] scenarios, CancellationToken externalCt)
    {
        _runCts = CancellationTokenSource.CreateLinkedTokenSource(externalCt);
        var results = new List<ScenarioResult>();

        foreach (var scenario in scenarios)
        {
            if (_runCts.Token.IsCancellationRequested)
            {
                results.Add(new ScenarioResult
                {
                    Id = scenario.Id,
                    Status = "CANCELLED",
                    Reason = "run_cancelled_by_user",
                });
                continue;
            }

            var result = await ExecuteScenario(scenario, _runCts.Token);
            results.Add(result);

            // Persist state after each scenario (S10)
            await PersistState(/* ... */);
        }

        // Final report
        await ReportRunComplete(results, _runCts.Token);
    }

    async Task<ScenarioResult> ExecuteScenario(Scenario scenario, CancellationToken ct)
    {
        RecordingSession session = null;
        try
        {
            // ISOLATE
            session = RecordingSession.Create(scenario.Id, _runId, scenario.GetRelevantTopics());

            // SETUP — always runs to completion (even on cancel, for safety)
            await SetupScenario(scenario, ct);

            // MARK
            var t0 = DateTimeOffset.UtcNow;

            // STIMULATE — cancellable
            var stimResult = await DeliverStimulus(scenario.Stimulus, ct);

            // CAPTURE — cancellable (or natural completion)
            var captureResult = await RunCapturePhase(session, scenario.Expectations, scenario.Timeout, ct);

            // EVALUATE
            var evalResult = _assertionEngine.Evaluate(session.GetAllCapturedEvents(), scenario.Expectations);

            return BuildResult(scenario, stimResult, captureResult, evalResult);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            return new ScenarioResult
            {
                Id = scenario.Id,
                Status = "CANCELLED",
                Reason = "cancelled_during_execution",
            };
        }
        finally
        {
            // TEARDOWN — ALWAYS runs, even on cancel
            await TeardownScenario(scenario, CancellationToken.None); // Uncancellable
            session?.Dispose();
        }
    }
}
```

**Source code path:** New code. SignalR cancel method will be in `EdogPlaygroundHub`.

**Edge cases:**
- Cancel during SETUP (chaos rules partially injected): TEARDOWN runs with `CancellationToken.None` to ensure all rules are removed.
- Cancel during STIMULATE (HTTP request in-flight): `HttpClient.SendAsync` receives cancellation. The server-side processing may continue — FLT doesn't know the stimulus was for a test.
- Rapid cancel/start: engine must not accept a new `StartRun` until the current run fully completes teardown. Use a `SemaphoreSlim(1)` to serialize runs.
- Cancel while persisting state: write-to-temp + rename is atomic. Partial state file won't exist.

**Interactions:**
- **C05 (SignalR):** `CancelRun` method on hub triggers `_runCts.Cancel()`.
- **C06 (Frontend):** "Stop" button sends `CancelRun`. UI updates to show cancelled state.
- **S10 (Crash Recovery):** Cancelled run deletes `qa-state.json` (no recovery needed for intentional cancellation).
- **S11 (Chaos):** Teardown runs with `CancellationToken.None` — chaos cleanup is non-cancellable.

**Revert/undo mechanism:** Cancellation IS the revert. TEARDOWN ensures clean state.

**Priority:** P0 — Users must be able to stop a run. Without this, a long test run is uncommittable.

---

### S15: Progress Reporting

**ID:** `C03-S15`
**One-liner:** Real-time execution progress streamed to frontend via SignalR.

**Detailed description:**
The engine publishes progress events at every phase transition and expectation match. The frontend (C06) shows: which scenario is executing, which phase it's in, how many expectations are met, and the overall run progress (X of Y scenarios complete). Events are published via `EdogPlaygroundHub` to a `qa` topic group. The frontend subscribes to this group when the QA Testing panel is active.

**Technical mechanism:**
```csharp
// Progress event types published to "qa" topic via SignalR
enum QaProgressEventType
{
    RunStarted,           // { runId, totalScenarios, startedAt }
    ScenarioStarted,      // { runId, scenarioId, scenarioIndex, name }
    PhaseChanged,         // { runId, scenarioId, phase: "ISOLATE"|"SETUP"|...|"REPORT" }
    StimulusDelivered,    // { runId, scenarioId, stimulusType, durationMs, success }
    ExpectationProgress,  // { runId, scenarioId, metCount, totalCount }
    ExpectationMatched,   // { runId, scenarioId, expectationId, matchedAt }
    ScenarioCompleted,    // { runId, scenarioId, status, durationMs, passCount, failCount }
    RunCompleted,         // { runId, totalPass, totalFail, totalSkip, totalDurationMs }
    RunCancelled,         // { runId, completedCount, cancelledCount }
    Warning,              // { runId, scenarioId?, message }
}

// Publishing via the existing hub infrastructure
void PublishProgress(QaProgressEventType type, object data)
{
    EdogTopicRouter.Publish("qa", new { @event = type.ToString(), data });
}
```

**Source code path:**
- `EdogTopicRouter.Publish()` — `src/backend/DevMode/EdogTopicRouter.cs:73-94`
- `EdogPlaygroundHub` group mechanism — `src/backend/DevMode/EdogPlaygroundHub.cs:27-33`
- `qa` topic registration: must be added to `EdogTopicRouter.Initialize()` at `src/backend/DevMode/EdogTopicRouter.cs:26-44`

**Edge cases:**
- No frontend connected: events published to `qa` topic buffer, not consumed. Buffer size should be small (100) since these are ephemeral progress events.
- Rapid phase transitions: multiple events in quick succession. Frontend must handle bursts without UI jank (batch updates, requestAnimationFrame).
- SignalR disconnection mid-run: engine continues running. Frontend reconnects and receives latest state from snapshot hydration.

**Interactions:**
- **C05 (SignalR):** New `qa` topic. `SubscribeToTopic("qa")` used by frontend.
- **C06 (Frontend):** Renders progress events into execution timeline UI.
- **S09 (Timeout):** `ExpectationProgress` events published during capture polling loop.

**Revert/undo mechanism:** Progress events are fire-and-forget. No revert needed.

**Priority:** P0 — Users need visibility into what the engine is doing. A silent test run is a bad UX.

---

### S16: Resource Limits

**ID:** `C03-S16`
**One-liner:** Enforce bounds on scenarios per run, timeout ceilings, and memory usage.

**Detailed description:**
The execution engine enforces resource limits to prevent runaway test runs from degrading FLT performance. Limits are validated before execution starts and enforced during the run. The engine runs inside the FLT process — it shares memory, CPU, and thread pool with production workloads. Every allocation matters.

**Technical mechanism:**
```csharp
public static class ExecutionLimits
{
    public const int MaxScenariosPerRun = 100;
    public const int MaxTimeoutPerScenarioMs = 300_000;  // 5 minutes
    public const int MaxTotalRunTimeMs = 1_800_000;      // 30 minutes
    public const int MaxCapturedEventsPerScenario = 50_000;
    public const int MaxConcurrentChaosRules = 10;
    public const long MaxRecordingSessionMemoryBytes = 100 * 1024 * 1024; // 100MB

    public static ValidationResult Validate(ExecutionRun run)
    {
        var issues = new List<string>();

        if (run.Scenarios.Length > MaxScenariosPerRun)
            issues.Add($"Too many scenarios: {run.Scenarios.Length} > {MaxScenariosPerRun}");

        foreach (var s in run.Scenarios)
        {
            if (s.Timeout > MaxTimeoutPerScenarioMs)
                issues.Add($"Scenario '{s.Id}' timeout {s.Timeout}ms exceeds {MaxTimeoutPerScenarioMs}ms");
        }

        var totalChaosRules = run.Scenarios
            .SelectMany(s => s.Setup.Where(st => st.Type == "chaos_rule"))
            .Count();

        // Per-scenario limit (not total — rules are cleaned between scenarios)
        var maxPerScenario = run.Scenarios
            .Max(s => s.Setup.Count(st => st.Type == "chaos_rule"));

        if (maxPerScenario > MaxConcurrentChaosRules)
            issues.Add($"A scenario has {maxPerScenario} chaos rules (max {MaxConcurrentChaosRules})");

        return new ValidationResult { Valid = !issues.Any(), Issues = issues };
    }
}
```

**Source code path:** New code. Limit constants are engine configuration.

**Edge cases:**
- Memory limit exceeded during capture: monitor `GC.GetTotalMemory()` periodically. If recording session exceeds 100MB, force-close and report partial results.
- Thread pool starvation: all stimulus delivery and capture is async. Never block thread pool threads. Use `ConfigureAwait(false)` everywhere.
- Total run time exceeded: enforce a 30-minute wall clock limit. Cancel remaining scenarios if exceeded.

**Interactions:**
- **C01 (Scenario Model):** Validation runs before execution starts.
- **C06 (Frontend):** Validation errors displayed before run starts — user can fix and retry.
- **S09 (Timeout):** Per-scenario timeout capped at 5 minutes.

**Revert/undo mechanism:** Limits are pre-validation. If exceeded, run doesn't start. No state to revert.

**Priority:** P0 — EDOG must not degrade FLT. Resource limits are a safety requirement.

---

### S17: Error Propagation

**ID:** `C03-S17`
**One-liner:** Setup failures skip the scenario; execution errors are contained — never crash the run.

**Detailed description:**
The execution engine follows a "fail-forward" philosophy. If a scenario's SETUP phase fails (e.g., chaos engine unavailable, DI resolution fails), that scenario is marked `SETUP_FAILED` and skipped. The run continues with the next scenario. If STIMULATE fails (e.g., HTTP connection refused), the scenario still proceeds to EVALUATE (the stimulus failure itself may be what assertions check). If EVALUATE throws (assertion engine bug), the scenario is marked `ENGINE_ERROR`. The TEARDOWN phase ALWAYS runs. The run itself never terminates due to a single scenario failure.

**Technical mechanism:**
```csharp
// Error containment in the execution loop
async Task<ScenarioResult> ExecuteScenario(Scenario scenario, CancellationToken ct)
{
    var result = new ScenarioResult { Id = scenario.Id };
    RecordingSession session = null;

    try
    {
        // ISOLATE
        session = RecordingSession.Create(scenario.Id, _runId, scenario.GetRelevantTopics());

        // SETUP — failure here skips the scenario
        try
        {
            await SetupScenario(scenario, ct);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            result.Status = "SETUP_FAILED";
            result.Error = ex.Message;
            return result; // Skip to finally (TEARDOWN)
        }

        // MARK
        var t0 = DateTimeOffset.UtcNow;

        // STIMULATE — failure is captured, not thrown
        var stimResult = await DeliverStimulus(scenario.Stimulus, ct);
        result.StimulusResult = stimResult;

        // CAPTURE
        var captureResult = await RunCapturePhase(
            session, scenario.Expectations, scenario.Timeout, ct);

        // EVALUATE — failure here is an engine bug
        try
        {
            var evalResult = _assertionEngine.Evaluate(
                session.GetAllCapturedEvents(), scenario.Expectations);
            result.Status = evalResult.AllPassed ? "PASS" : "FAIL";
            result.Expectations = evalResult;
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            result.Status = "ENGINE_ERROR";
            result.Error = $"Assertion engine error: {ex.Message}";
        }
    }
    catch (Exception ex) when (ex is not OperationCanceledException)
    {
        result.Status = "ENGINE_ERROR";
        result.Error = ex.Message;
    }
    finally
    {
        // TEARDOWN — ALWAYS runs
        try
        {
            await TeardownScenario(scenario, CancellationToken.None);
        }
        catch (Exception teardownEx)
        {
            result.Warnings ??= new List<string>();
            result.Warnings.Add($"Teardown error: {teardownEx.Message}");
        }

        session?.Dispose();
    }

    return result;
}
```

**Source code path:** New code. Pattern mirrors `EdogTopicRouter.Publish()` never-throw guarantee at `src/backend/DevMode/EdogTopicRouter.cs:88-93`.

**Edge cases:**
- All scenarios fail setup: run completes with all `SETUP_FAILED`. Not an engine error — likely a configuration or environment issue.
- Teardown throws: warning appended to result. Not fatal. S08 inter-scenario gap catches remaining state.
- Stack overflow in assertion engine: `catch (Exception)` catches `StackOverflowException` on .NET 8+ (CLR improvement). Scenario marked `ENGINE_ERROR`.
- Out of memory: caught by runtime. If it reaches the engine, mark `ENGINE_ERROR`. If it kills the process, S10 crash recovery handles it.

**Interactions:**
- **C04 (Assertion Engine):** Evaluate call is wrapped in try/catch. Engine bugs are contained.
- **C06 (Frontend):** `SETUP_FAILED`, `ENGINE_ERROR` statuses have distinct visual treatments.
- **S10 (Crash Recovery):** If error causes process death, crash recovery picks up.

**Revert/undo mechanism:** Error propagation is a containment strategy, not a revertible action.

**Priority:** P0 — Resilience is non-negotiable. A single bad scenario must not kill the run.

---

### S18: Retry Logic

**ID:** `C03-S18`
**One-liner:** Configurable retry for failed scenarios — off by default, opt-in per scenario or run.

**Detailed description:**
Failed scenarios can optionally be retried. Retry is OFF by default (deterministic results are preferred). When enabled, the engine re-executes the full ISOLATE→REPORT loop for failed scenarios. Retry count is configurable (1-3 retries, default 1 if enabled). A retried scenario that passes on retry is reported as `FLAKY` (not `PASS`) to flag non-determinism. Retry uses the same inter-scenario gap (S08) and isolation guarantees.

**Technical mechanism:**
```json
// Run-level retry configuration
{
    "retryPolicy": {
        "enabled": false,
        "maxRetries": 1,
        "retryableStatuses": ["FAIL", "TIMED_OUT"],
        "backoffMs": 1000
    }
}
```

```csharp
async Task<ScenarioResult> ExecuteWithRetry(Scenario scenario, RetryPolicy policy, CancellationToken ct)
{
    var attempts = new List<ScenarioResult>();
    var maxAttempts = policy.Enabled ? 1 + policy.MaxRetries : 1;

    for (int attempt = 0; attempt < maxAttempts; attempt++)
    {
        if (attempt > 0)
        {
            await Task.Delay(policy.BackoffMs, ct);
            await RunInterScenarioGap(scenario.Id, ct); // Full isolation between retries
        }

        var result = await ExecuteScenario(scenario, ct);
        attempts.Add(result);

        if (!policy.RetryableStatuses.Contains(result.Status))
            break; // Not a retryable status (PASS, CANCELLED, SETUP_FAILED)
    }

    var finalResult = attempts.Last();
    if (attempts.Count > 1 && finalResult.Status == "PASS")
    {
        finalResult.Status = "FLAKY";
        finalResult.FlakyDetails = new
        {
            totalAttempts = attempts.Count,
            failedAttempts = attempts.Count(a => a.Status != "PASS"),
            attempts = attempts.Select(a => new { a.Status, a.DurationMs }),
        };
    }

    return finalResult;
}
```

**Source code path:** New code. Configuration in run-level settings.

**Edge cases:**
- Retry a scenario that has side effects: the second execution may see state left by the first (e.g., DAG already completed). Scenario setup must be idempotent or handle this.
- Retry policy exceeds resource limits: total retry count contributes to max run time. Enforce ceiling.
- `SETUP_FAILED` is not retryable by default: if setup fails, it will likely fail again. Retrying wastes time.
- `ENGINE_ERROR` is never retryable: engine bugs won't fix themselves.

**Interactions:**
- **C01 (Scenario Model):** `retryPolicy` can be overridden per scenario.
- **S08 (Sequential Isolation):** Full gap + safety checks between retries.
- **C06 (Frontend):** `FLAKY` status has distinct visual treatment (yellow/amber indicator).

**Revert/undo mechanism:** Retry creates additional execution attempts. Each attempt follows full TEARDOWN. No persistent state beyond the result.

**Priority:** P2 — Nice-to-have for flaky test detection. Not needed for day-one ship.

---

## Cross-Component Integration Map

```
C01 (Scenario Model)  ──scenarios──►  C03 (Execution Engine)  ──events──►  C04 (Assertion Engine)
                                           │                                       │
                                           │ chaos rules                           │ results
                                           ▼                                       ▼
                                     F24 (Chaos Engine)                      C05 (SignalR)
                                                                                   │
                                                                                   ▼
                                                                             C06 (Frontend)

Infrastructure:
  EdogTopicRouter ← all interceptors (16 topics)
  TopicBuffer ← observer callbacks (S07) ← RecordingSession (S01)
  EdogPlaygroundHub ← "qa" topic ← progress events (S15)
```

---

## Performance Budget

| Operation | Target | Mechanism |
|-----------|--------|-----------|
| RecordingSession.Create() | < 5ms | Dictionary alloc + snapshot position read |
| Observer callback per event | < 1μs | List.Add() under lock |
| Inter-scenario gap | 500ms fixed + 0-600ms retry | Task.Delay + safety checks |
| Stimulus dispatch overhead | < 10ms | HttpClient.SendAsync setup, DI resolution |
| Capture polling interval | 100ms | Task.Delay between IsSatisfiedBy() checks |
| State persistence (per scenario) | < 5ms | JSON serialize + File.Move (atomic) |
| Progress event publish | < 1ms | EdogTopicRouter.Publish() |
| Total engine overhead per scenario | < 50ms | Excluding stimulus latency + capture timeout |

---

## Priority Summary

| Scenario | ID | Priority | Rationale |
|----------|----|----------|-----------|
| Recording Session Lifecycle | S01 | P0 | Core capture mechanism |
| HTTP Stimulus | S02 | P0 | Most common stimulus type |
| SignalR Stimulus | S03 | P1 | Less common, real-time features |
| DAG Trigger Stimulus | S04 | P0 | Core FLT workflow |
| File Event Stimulus | S05 | P1 | OneLake-related PRs |
| Timer Tick + Direct Invoke | S06 | P1/P2 | Escape hatch for internal services |
| Scoped Recording | S07 | P0 | Architectural foundation |
| Sequential Isolation | S08 | P0 | Result reliability |
| Timeout Handling | S09 | P0 | Every scenario needs a timeout |
| FLT Crash Recovery | S10 | P1 | Reliability improvement |
| F24 Chaos Integration | S11 | P0 | Core value proposition |
| Event Correlation | S12 | P1 | Reliability improvement |
| Parallel Safety | S13 | P1 | Dev workflow support |
| Cancellation | S14 | P0 | User must be able to stop |
| Progress Reporting | S15 | P0 | UX requirement |
| Resource Limits | S16 | P0 | Safety requirement |
| Error Propagation | S17 | P0 | Resilience requirement |
| Retry Logic | S18 | P2 | Flaky test detection, post-MVP |
