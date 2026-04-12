# Phase 1: SignalR + MessagePack Foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the raw WebSocket transport in EdogLogServer.cs + websocket.js with SignalR + MessagePack hub protocol (per ADR-006), enabling topic-based group subscriptions for all 11 Runtime View tabs while preserving existing log + telemetry streaming.

**Architecture:** EdogLogServer.cs currently uses raw `System.Net.WebSockets` with a custom batched flush timer. We replace this with an ASP.NET Core SignalR Hub (`EdogPlaygroundHub`) that uses MessagePack binary protocol. The JS client (`websocket.js`) is replaced with a `SignalRManager` class wrapping `@microsoft/signalr`. Each of the 11 tabs subscribes to its topic group (`log`, `telemetry`, `fileop`, `spark`, `token`, `cache`, `http`, `retry`, `flag`, `di`, `perf`). The batched flush timer is retained server-side — it now pushes to SignalR groups instead of raw WebSocket frames. Existing consumers (`main.js` callbacks) are preserved via the same `onBatch`/`onMessage`/`onSummary`/`onStatusChange` interface.

**Tech Stack:** C# (ASP.NET Core SignalR, MessagePack hub protocol, Kestrel), JS (@microsoft/signalr browser client, inlined in single HTML), Python (build-html.py — add signalr.min.js to inline list)

**Settled Architecture (ADR-006):** SignalR + MessagePack. Not negotiable. Not re-discussed.

---

## Current State (What We're Replacing)

### C# Side: `src/backend/DevMode/EdogLogServer.cs`
- Raw WebSocket endpoint at `/ws/logs` (line 513)
- `ClientState` class tracks per-client `WebSocket`, `PendingLogs`, `PendingTelemetry`, `SendLock` (line 689)
- `FlushAllClients()` timer fires every 150ms, drains per-client queues, sends JSON `batch` or `summary` messages (line 228)
- `AddLog(entry)` enqueues to every client's `PendingLogs` — no topic filtering (line 175)
- `AddTelemetry(event)` enqueues to every client's `PendingTelemetry` (line 199)
- `HandleWebSocket()` just keeps connection alive, no incoming message handling (line 601)

### JS Side: `src/frontend/js/websocket.js`
- `WebSocketManager` class (170 lines)
- Connects to `ws://localhost:5555/ws/logs`
- Handles message types: `batch` (logs+telemetry), `summary`, legacy `log`/`telemetry`
- Callbacks: `onStatusChange`, `onMessage`, `onBatch`, `onSummary`
- Custom reconnect with exponential backoff (1s → 30s cap)
- Consumer: `main.js` line 98-143 wires all callbacks

### Consumer: `src/frontend/js/main.js`
- Line 98: `this.ws = new WebSocketManager()`
- Line 140: `this.ws.onStatusChange = this.updateConnectionStatus`
- Line 141: `this.ws.onMessage = this.handleWebSocketMessage`
- Line 142: `this.ws.onBatch = this.handleWebSocketBatch`
- Line 143: `this.ws.onSummary = this.handleWebSocketSummary`
- Line 161: `window.edogWs = this.ws`
- Line 205/218: `this.ws.setPort(s.fltPort)`

---

## File Map

```
src/backend/DevMode/
├── EdogLogServer.cs           ← MODIFY: add SignalR hub, replace raw WS
├── EdogPlaygroundHub.cs       ← CREATE: SignalR hub with Subscribe/Unsubscribe
├── EdogLogInterceptor.cs      ← UNCHANGED (calls EdogLogServer.AddLog)
├── EdogTelemetryInterceptor.cs← UNCHANGED (calls EdogLogServer.AddTelemetry)
├── EdogLogModels.cs           ← MODIFY: add MessagePack attributes
└── EdogApiProxy.cs            ← UNCHANGED

src/frontend/js/
├── websocket.js               ← REPLACE: rename to signalr-manager.js
├── signalr-manager.js         ← CREATE: SignalR client wrapping @microsoft/signalr
└── main.js                    ← MODIFY: update import, same callback interface

scripts/
└── build-html.py              ← MODIFY: inline signalr.min.js before our JS modules

lib/                           ← CREATE: directory for vendored JS
└── signalr.min.js             ← CREATE: vendored @microsoft/signalr browser bundle

tests/
└── test_signalr_migration.py  ← CREATE: verify build output includes SignalR client
```

---

## Questions to Resolve Before Implementation

Before any agent touches code, these need CEO answers:

1. **MessagePack vs JSON fallback:** ADR-006 says MessagePack. But the existing REST APIs (`/api/logs`, `/api/telemetry`) still use JSON. Should the SignalR hub support BOTH protocols (MessagePack default, JSON fallback for debugging), or MessagePack only?

2. **Batched flush retention:** The current 150ms batch timer is a performance optimization. With SignalR, we could either: (a) keep the timer and flush to SignalR groups, or (b) let each interceptor call `SendAsync` directly and rely on SignalR's internal buffering. Which approach?

3. **Backward compatibility period:** Should we keep the raw `/ws/logs` endpoint temporarily alongside SignalR for a transition period, or hard-cut immediately?

4. **SignalR JS client sourcing:** The `signalr.min.js` (~71KB) needs to be inlined in the single HTML. Options: (a) vendor it in `lib/signalr.min.js` and have build-html.py inline it, (b) download at build time via `npm pack`, (c) copy-paste the minified content directly. Which?

---

## Tasks

### Task 1: Vendor SignalR JS Client

**Files:**
- Create: `lib/signalr.min.js`
- Modify: `scripts/build-html.py`

- [ ] **Step 1:** Download `@microsoft/signalr` browser bundle
```bash
npm pack @microsoft/signalr --pack-destination ./tmp
# Extract dist/browser/signalr.min.js from the tarball
# Copy to lib/signalr.min.js
```

- [ ] **Step 2:** Verify the file size is ~70-80KB
```bash
python -c "from pathlib import Path; f=Path('lib/signalr.min.js'); print(f'{f.stat().st_size/1024:.0f}KB')"
```
Expected: ~71KB

- [ ] **Step 3:** Update `build-html.py` to inline `lib/signalr.min.js` BEFORE our JS modules
Read `scripts/build-html.py`, find where JS modules are concatenated. Add `lib/signalr.min.js` as the FIRST script block so `signalR` global is available to our modules.

- [ ] **Step 4:** Run build, verify signalR is in output
```bash
python scripts/build-html.py
python -c "html=open('src/edog-logs.html').read(); print('signalR' in html, 'HubConnectionBuilder' in html)"
```
Expected: `True True`

- [ ] **Step 5:** Verify total HTML size is within budget
```bash
python -c "from pathlib import Path; print(f'{Path(\"src/edog-logs.html\").stat().st_size/1024:.0f}KB')"
```
Expected: previous size + ~71KB, total under 800KB

- [ ] **Step 6:** Commit
```bash
git add lib/signalr.min.js scripts/build-html.py
git commit -m "chore(build): vendor @microsoft/signalr browser client for ADR-006

Adds lib/signalr.min.js (~71KB) inlined by build-html.py as the first
script block. signalR global available to all downstream JS modules.
Total HTML size within 800KB budget.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 2: Create EdogPlaygroundHub (C#)

**Files:**
- Create: `src/backend/DevMode/EdogPlaygroundHub.cs`

- [ ] **Step 1:** Create the SignalR hub class

```csharp
// EdogPlaygroundHub.cs
#nullable disable
#pragma warning disable

namespace Microsoft.LiveTable.Service.DevMode
{
    using System.Threading.Tasks;
    using Microsoft.AspNetCore.SignalR;

    /// <summary>
    /// SignalR hub for EDOG Playground real-time streaming.
    /// Clients subscribe to topic groups (log, telemetry, fileop, spark, token,
    /// cache, http, retry, flag, di, perf) and receive only messages for their
    /// active tabs. Implements ADR-006.
    /// </summary>
    public sealed class EdogPlaygroundHub : Hub
    {
        /// <summary>
        /// Client subscribes to a topic group. Called when a tab becomes active.
        /// </summary>
        /// <param name="topic">Topic name: log, telemetry, fileop, spark, token, cache, http, retry, flag, di, perf.</param>
        public async Task Subscribe(string topic)
        {
            if (!string.IsNullOrWhiteSpace(topic))
            {
                await Groups.AddToGroupAsync(Context.ConnectionId, topic.ToLowerInvariant());
            }
        }

        /// <summary>
        /// Client unsubscribes from a topic group. Called when switching away from a tab.
        /// </summary>
        /// <param name="topic">Topic name to leave.</param>
        public async Task Unsubscribe(string topic)
        {
            if (!string.IsNullOrWhiteSpace(topic))
            {
                await Groups.RemoveFromGroupAsync(Context.ConnectionId, topic.ToLowerInvariant());
            }
        }

        /// <summary>
        /// Called when a client connects. Auto-subscribe to "log" (default tab).
        /// </summary>
        public override async Task OnConnectedAsync()
        {
            // Auto-subscribe to logs — the default Runtime View tab
            await Groups.AddToGroupAsync(Context.ConnectionId, "log");
            await base.OnConnectedAsync();
        }
    }
}
```

- [ ] **Step 2:** Verify file compiles (syntax check)
```bash
# This file will be compiled as part of the FLT build — for now just verify syntax
python -c "print('EdogPlaygroundHub.cs created')"
```

- [ ] **Step 3:** Commit
```bash
git add src/backend/DevMode/EdogPlaygroundHub.cs
git commit -m "feat(signalr): create EdogPlaygroundHub with topic group subscriptions

ADR-006 implementation. Hub supports Subscribe/Unsubscribe for 11 topic
groups (log, telemetry, fileop, spark, token, cache, http, retry, flag,
di, perf). Auto-subscribes to 'log' on connect.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 3: Wire SignalR into EdogLogServer (C#)

**Files:**
- Modify: `src/backend/DevMode/EdogLogServer.cs`

This is the biggest C# change. We:
1. Add SignalR + MessagePack to the service pipeline
2. Replace raw WebSocket broadcast with SignalR group broadcast
3. Keep the 150ms batch flush timer (proven performance optimization)
4. Keep REST APIs unchanged
5. Remove raw WebSocket endpoint `/ws/logs`

- [ ] **Step 1:** Add SignalR services in `Start()` method

Find the `builder.Build()` line (~92). Before it, add:
```csharp
builder.Services.AddSignalR()
    .AddMessagePackProtocol();
```

- [ ] **Step 2:** Map the hub in `ConfigureRoutes()`

Find `app!.UseWebSockets();` (line 344). Replace the entire WebSocket section with:
```csharp
// SignalR hub endpoint (replaces raw WebSocket per ADR-006)
app.MapHub<EdogPlaygroundHub>("/hub/playground");
```

Remove the old `/ws/logs` MapGet (lines 513-550) and the `app!.UseWebSockets()` call.

- [ ] **Step 3:** Add hub context field

Add to class fields (near line 58):
```csharp
private IHubContext<EdogPlaygroundHub> hubContext;
```

In `Start()`, after `app = builder.Build()`:
```csharp
hubContext = app.Services.GetRequiredService<IHubContext<EdogPlaygroundHub>>();
```

- [ ] **Step 4:** Replace FlushAllClients to use SignalR groups

Replace the entire `FlushAllClients()` method. Instead of iterating `webSocketClients` and sending raw WS frames, broadcast to SignalR groups:
```csharp
private void FlushAllClients()
{
    try
    {
        var logs = DrainQueue(pendingLogBroadcast);
        var telemetry = DrainQueue(pendingTelemetryBroadcast);

        if (logs.Count > 0 && hubContext != null)
        {
            _ = hubContext.Clients.Group("log").SendAsync("LogBatch", logs);
        }

        if (telemetry.Count > 0 && hubContext != null)
        {
            _ = hubContext.Clients.Group("telemetry").SendAsync("TelemetryBatch", telemetry);
        }
    }
    catch (Exception ex)
    {
        Console.WriteLine($"Error flushing to SignalR: {ex}");
    }
}
```

- [ ] **Step 5:** Replace per-client queues with single broadcast queues

Replace `webSocketClients` dict + per-client enqueue in `AddLog`/`AddTelemetry` with simple broadcast queues:
```csharp
private readonly ConcurrentQueue<LogEntry> pendingLogBroadcast = new();
private readonly ConcurrentQueue<TelemetryEvent> pendingTelemetryBroadcast = new();
```

In `AddLog`:
```csharp
pendingLogBroadcast.Enqueue(entry);
```

In `AddTelemetry`:
```csharp
pendingTelemetryBroadcast.Enqueue(telemetryEvent);
```

- [ ] **Step 6:** Remove raw WebSocket code

Delete: `ClientState` class, `HandleWebSocket` method, `SendToClient`, `SendBatch`, `SendSummary`, `webSocketClients` field, `nextClientId` field. These are all replaced by SignalR.

- [ ] **Step 7:** Verify REST APIs still intact

Confirm these routes are unchanged: `/` (HTML), `/api/logs`, `/api/telemetry`, `/api/stats`, `/api/executions`, `/api/flt/config`, `/api/edog/health`.

- [ ] **Step 8:** Commit
```bash
git add src/backend/DevMode/EdogLogServer.cs
git commit -m "feat(signalr): replace raw WebSocket with SignalR hub in EdogLogServer

Removes raw WebSocket endpoint /ws/logs and all per-client state
(ClientState, SendToClient, SendBatch, SendSummary).
Adds SignalR hub at /hub/playground with MessagePack protocol.
Retains 150ms batch flush timer — now broadcasts to SignalR groups
instead of raw frames. REST APIs unchanged.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 4: Create SignalRManager JS Client

**Files:**
- Create: `src/frontend/js/signalr-manager.js`
- Delete: `src/frontend/js/websocket.js`

- [ ] **Step 1:** Create SignalRManager class that preserves the same callback interface

```javascript
/**
 * EDOG Playground — SignalR Connection Manager
 * Replaces raw WebSocketManager (ADR-006).
 * Uses @microsoft/signalr with MessagePack protocol.
 *
 * Same callback interface as the old WebSocketManager:
 *   - onStatusChange(status)  — 'connecting'|'connected'|'reconnecting'|'disconnected'
 *   - onBatch(logs[], telemetry[])
 *   - onMessage(type, data)   — legacy single-entry
 *   - onSummary(summary)      — backpressure summary
 */
class SignalRManager {
  constructor() {
    this.connection = null;
    this.status = 'disconnected';
    this.onStatusChange = null;
    this.onMessage = null;
    this.onBatch = null;
    this.onSummary = null;
    this._port = 5555;
    this._subscribedTopics = new Set();
    this._closing = false;
  }

  setPort(port) {
    if (port && port !== this._port) {
      this._port = port;
      if (this.connection) {
        this.disconnect();
        this.connect();
      }
    }
  }

  connect() {
    if (this.connection) return;
    this._closing = false;
    this._setStatus('connecting');

    try {
      this.connection = new signalR.HubConnectionBuilder()
        .withUrl('http://localhost:' + this._port + '/hub/playground')
        .withHubProtocol(new signalR.protocols.msgpack.MessagePackHubProtocol())
        .withAutomaticReconnect([0, 1000, 2000, 5000, 10000, 30000])
        .configureLogging(signalR.LogLevel.Warning)
        .build();

      // Wire hub event handlers
      this.connection.on('LogBatch', (logs) => {
        if (this.onBatch) {
          this.onBatch(logs, []);
        } else if (this.onMessage) {
          for (const log of logs) this.onMessage('log', log);
        }
      });

      this.connection.on('TelemetryBatch', (telemetry) => {
        if (this.onBatch) {
          this.onBatch([], telemetry);
        } else if (this.onMessage) {
          for (const evt of telemetry) this.onMessage('telemetry', evt);
        }
      });

      this.connection.on('Summary', (summary) => {
        if (this.onSummary) this.onSummary(summary);
      });

      // Future topic handlers (Phase 2+)
      // this.connection.on('FileOpBatch', ...)
      // this.connection.on('SparkEvent', ...)
      // this.connection.on('TokenEvent', ...)
      // etc.

      // Reconnection events
      this.connection.onreconnecting(() => this._setStatus('reconnecting'));
      this.connection.onreconnected(() => {
        this._setStatus('connected');
        // Re-subscribe to all topics after reconnect
        for (const topic of this._subscribedTopics) {
          this.connection.invoke('Subscribe', topic).catch(() => {});
        }
      });
      this.connection.onclose(() => {
        if (!this._closing) this._setStatus('disconnected');
      });

      // Start connection
      this.connection.start()
        .then(() => {
          this._setStatus('connected');
          // Subscribe to default topics
          this.subscribe('log');
        })
        .catch((err) => {
          console.error('SignalR connection failed:', err);
          this._setStatus('disconnected');
        });

    } catch (err) {
      console.error('Failed to create SignalR connection:', err);
      this._setStatus('disconnected');
    }
  }

  /** Subscribe to a topic group (e.g., 'log', 'telemetry', 'token'). */
  subscribe(topic) {
    this._subscribedTopics.add(topic);
    if (this.connection && this.connection.state === signalR.HubConnectionState.Connected) {
      this.connection.invoke('Subscribe', topic).catch((err) => {
        console.warn('Failed to subscribe to ' + topic + ':', err);
      });
    }
  }

  /** Unsubscribe from a topic group. */
  unsubscribe(topic) {
    this._subscribedTopics.delete(topic);
    if (this.connection && this.connection.state === signalR.HubConnectionState.Connected) {
      this.connection.invoke('Unsubscribe', topic).catch((err) => {
        console.warn('Failed to unsubscribe from ' + topic + ':', err);
      });
    }
  }

  disconnect() {
    this._closing = true;
    this._subscribedTopics.clear();
    if (this.connection) {
      this.connection.stop().catch(() => {});
      this.connection = null;
    }
    this._setStatus('disconnected');
  }

  _setStatus(status) {
    this.status = status;
    if (this.onStatusChange) this.onStatusChange(status);
  }
}
```

- [ ] **Step 2:** Update `main.js` to use SignalRManager instead of WebSocketManager

In `main.js` line 98, change:
```javascript
// OLD: this.ws = new WebSocketManager();
this.ws = new SignalRManager();
```

The callback wiring (lines 140-143) stays identical — same interface.

- [ ] **Step 3:** Update `build-html.py` module list

Replace `websocket.js` with `signalr-manager.js` in the JS module concatenation order. It must come AFTER `lib/signalr.min.js` (which provides the `signalR` global).

- [ ] **Step 4:** Delete old `websocket.js`
```bash
git rm src/frontend/js/websocket.js
```

- [ ] **Step 5:** Build and verify
```bash
python scripts/build-html.py
# Verify the built HTML contains SignalRManager class
python -c "html=open('src/edog-logs.html').read(); print('SignalRManager' in html, 'WebSocketManager' not in html, 'HubConnectionBuilder' in html)"
```
Expected: `True True True`

- [ ] **Step 6:** Commit
```bash
git add src/frontend/js/signalr-manager.js src/frontend/js/main.js scripts/build-html.py
git rm src/frontend/js/websocket.js
git commit -m "feat(signalr): replace WebSocketManager with SignalRManager JS client

New SignalRManager class uses @microsoft/signalr with MessagePack.
Same callback interface (onBatch, onMessage, onSummary, onStatusChange)
so main.js consumer code is unchanged. Adds subscribe/unsubscribe
methods for topic groups. Auto-reconnect with state recovery built-in.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 5: Add MessagePack Attributes to Models (C#)

**Files:**
- Modify: `src/backend/DevMode/EdogLogModels.cs`

- [ ] **Step 1:** Add MessagePack attributes to LogEntry and TelemetryEvent

MessagePack serialization needs `[MessagePackObject]` and `[Key]` attributes for efficient binary serialization. Add them to both model classes.

Note: This requires `using MessagePack;` — which comes from the `MessagePack` NuGet package (dependency of `Microsoft.AspNetCore.SignalR.Protocols.MessagePack`).

- [ ] **Step 2:** Commit
```bash
git add src/backend/DevMode/EdogLogModels.cs
git commit -m "feat(signalr): add MessagePack attributes to LogEntry and TelemetryEvent

Required for binary serialization over SignalR MessagePack protocol.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 6: Integration Test — End-to-End Verification

**Files:**
- Create: `tests/test_signalr_migration.py`

- [ ] **Step 1:** Write build verification test

```python
"""Tests for SignalR migration (ADR-006) — build output verification."""
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
BUILD_OUTPUT = REPO_ROOT / "src" / "edog-logs.html"


def test_build_output_contains_signalr_client():
    """Built HTML must include the @microsoft/signalr browser bundle."""
    assert BUILD_OUTPUT.exists(), f"Build output not found: {BUILD_OUTPUT}"
    html = BUILD_OUTPUT.read_text(encoding="utf-8")
    assert "HubConnectionBuilder" in html, "SignalR client not found in build output"
    assert "MessagePackHubProtocol" in html or "msgpack" in html, "MessagePack protocol not in build"


def test_build_output_contains_signalr_manager():
    """Built HTML must include our SignalRManager wrapper class."""
    html = BUILD_OUTPUT.read_text(encoding="utf-8")
    assert "SignalRManager" in html, "SignalRManager class not in build output"
    assert "WebSocketManager" not in html, "Old WebSocketManager should be removed"


def test_build_output_no_raw_websocket_url():
    """Built HTML should not reference the old raw WebSocket endpoint."""
    html = BUILD_OUTPUT.read_text(encoding="utf-8")
    assert "ws://localhost" not in html and "ws/logs" not in html, \
        "Old WebSocket URL found — should use SignalR /hub/playground"


def test_signalr_manager_has_subscribe_methods():
    """SignalRManager source must expose subscribe/unsubscribe for topic groups."""
    src = (REPO_ROOT / "src" / "frontend" / "js" / "signalr-manager.js").read_text()
    assert "subscribe(topic)" in src, "Missing subscribe method"
    assert "unsubscribe(topic)" in src, "Missing unsubscribe method"
    assert "_subscribedTopics" in src, "Missing topic tracking"


def test_signalr_hub_exists():
    """EdogPlaygroundHub.cs must exist with Subscribe/Unsubscribe methods."""
    hub = REPO_ROOT / "src" / "backend" / "DevMode" / "EdogPlaygroundHub.cs"
    assert hub.exists(), "EdogPlaygroundHub.cs not found"
    code = hub.read_text()
    assert "class EdogPlaygroundHub" in code, "Hub class not found"
    assert "Subscribe" in code, "Subscribe method not found"
    assert "Unsubscribe" in code, "Unsubscribe method not found"


def test_edog_log_server_uses_signalr():
    """EdogLogServer.cs must reference SignalR hub, not raw WebSocket."""
    server = REPO_ROOT / "src" / "backend" / "DevMode" / "EdogLogServer.cs"
    code = server.read_text()
    assert "MapHub<EdogPlaygroundHub>" in code, "SignalR hub not mapped"
    assert "IHubContext<EdogPlaygroundHub>" in code, "Hub context not injected"
    # Raw WebSocket should be gone
    assert "AcceptWebSocketAsync" not in code, "Raw WebSocket accept still present"
    assert "HandleWebSocket" not in code, "Raw WebSocket handler still present"
```

- [ ] **Step 2:** Run tests
```bash
make build && make test
```
Expected: All pass

- [ ] **Step 3:** Run full Sentinel gauntlet
```bash
make lint && make test && make build
```

- [ ] **Step 4:** Manual browser verification
Open `http://localhost:5555` (or `file://` the built HTML). Verify:
- [ ] Page loads without JS errors
- [ ] If FLT service is running: logs stream in the Logs view
- [ ] Connection status shows "Connected" (not "Disconnected")
- [ ] Switching views doesn't break the connection

- [ ] **Step 5:** Commit
```bash
git add tests/test_signalr_migration.py
git commit -m "test(signalr): add build verification tests for ADR-006 migration

Verifies: SignalR client in build output, SignalRManager replaces
WebSocketManager, EdogPlaygroundHub exists with Subscribe/Unsubscribe,
EdogLogServer uses MapHub instead of raw WebSocket.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| SignalR JS client too large for HTML budget | Low | Medium | 71KB well within 800KB budget |
| MessagePack NuGet not in FLT dependency tree | Medium | High | Falls back to JSON protocol if needed |
| Existing interceptors break during migration | Low | High | AddLog/AddTelemetry interface unchanged |
| Browser doesn't support MessagePack | Very Low | Medium | SignalR auto-negotiates transport |
| Batch flush timing changes | Low | Medium | Keep identical 150ms timer |

## Phase 1 Completion Criteria

- [ ] `EdogPlaygroundHub.cs` exists with Subscribe/Unsubscribe
- [ ] `EdogLogServer.cs` uses `MapHub` instead of raw WebSocket
- [ ] `signalr-manager.js` replaces `websocket.js` with same callback interface
- [ ] `build-html.py` inlines `signalr.min.js`
- [ ] `make lint && make test && make build` all pass
- [ ] Logs stream correctly through SignalR in browser
- [ ] REST APIs (`/api/logs`, `/api/telemetry`, etc.) still work
