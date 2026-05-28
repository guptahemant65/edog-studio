# F28 HTTP MITM — P0 Foundation Research

> **Author:** Sana (Architecture)
> **Status:** RESEARCH — gates all subsequent F28 work
> **Date:** 2026-08
> **Scope:** Interactive Man-in-the-Middle for the Runtime → HTTP tab. Testing tool, not a debugger.

---

## 0. TL;DR

EDOG already owns the perfect interception point: `EdogHttpPipelineHandler.SendAsync()` is a `DelegatingHandler` in front of every named `HttpClient`. Today it is **passive plus one narrow active path** — it consults `EdogHttpFaultStore` (added by F27 P5) to synthesize fake responses, but only for three pre-baked fault types (`http_error`, `latency`, `timeout`), and only when the QA execution engine pushes scenario-scoped rules. There is **no user-facing interactive MITM** anywhere.

F28 builds the **user-facing, interactive** half on the foundation F27 P5 already laid:

| Layer | Status | F28 work |
|---|---|---|
| Interception point | ✅ done — `EdogHttpPipelineHandler` (`src/backend/DevMode/EdogHttpPipelineHandler.cs:46`) | extend with breakpoint pause + arbitrary-modification path |
| Fault store | ⚠ partial — `EdogHttpFaultStore` only supports 3 fault types, scenario-scoped only | replace/extend with full F24-style `ChaosRule` model OR add a thinner "session rule" store for interactive MITM |
| Event publishing | ✅ done — `EdogTopicRouter.Publish("http", …)` (`src/backend/DevMode/EdogTopicRouter.cs:74`) writes to a 2000-event ring buffer | reuse — annotate published events with `mitm` metadata when intercepted |
| SignalR streaming | ✅ done — `SubscribeToTopic("http")` ChannelReader streaming (`EdogPlaygroundHub.cs:419`) | reuse — add new RPC methods for interactive control |
| Frontend HTTP tab | ✅ done — `HttpPipelineTab` in `src/frontend/js/tab-http.js` | extend toolbar + detail panel with MITM controls; reuse table, filters, detail tabs |
| Request composer UI | ✅ done — `RequestBuilder` in `src/frontend/js/api-playground.js:442` | reuse for "Modify & Forward" editor and "Replay with edits" UI |

F24 (Chaos Engineering Panel) and F28 (HTTP MITM) overlap heavily — both want to mutate the HTTP pipeline. The dividing line for this project: **F24 = persistent rules defined in a separate panel and applied automatically; F28 = interactive, request-by-request control wired into the existing HTTP tab**. The two should share one backend rule engine, not duplicate it.

---

## §1. Existing Code Audit

### 1.1 `src/backend/DevMode/EdogHttpPipelineHandler.cs` — the interception point

**Purpose:** A `DelegatingHandler` injected into every named `HttpClient` via `EdogHttpClientFactoryWrapper`. Wraps every outbound HTTP call. Snapshots the request, optionally synthesizes/delays via the fault store, calls `base.SendAsync`, snapshots the response, publishes a `TopicEvent` to the `http` topic.

**Key locations:**

| File:Line | What it does | Reuse for F28 |
|---|---|---|
| `EdogHttpPipelineHandler.cs:46` `SendAsync(...)` | Override that owns the whole request/response cycle. | This is **the** insertion point for breakpoints, modify-and-forward, replay. |
| `EdogHttpPipelineHandler.cs:49–72` | Snapshots `method`, `url` (SAS-redacted), `requestHeaders` (Authorization-redacted), `correlationId`, `requestBodyPreview` (≤4KB, text-content only), `requestSizeBytes`. | Already captures everything F28 needs for the **request** half. Body preview cap of 4KB is currently a problem for full MITM — see §4 risks. |
| `EdogHttpPipelineHandler.cs:74–103` | Timeout fault path. If a rule with `Fault == "timeout"` matches, publishes a synthetic event with `statusCode: 0` and throws `TaskCanceledException` **without calling `base.SendAsync`**. | Proves the "short-circuit before forwarding" pattern works end-to-end. Same hook = F28 "Block" action. |
| `EdogHttpPipelineHandler.cs:105–128` | `http_error` and `latency` fault branches. Either synthesizes via `SynthesizeErrorResponse` or `await Task.Delay(LatencyMs)` then forwards. | This is the existing "respond without calling real service" + "delay" plumbing F28 needs for Block/Forge/Delay. |
| `EdogHttpPipelineHandler.cs:130–144` | Captures response, publishes `http` topic event annotated with optional `chaos {fault, scenarioId, target, synthesized}` block. | The event envelope is already extensible — F28 can add a `mitm { sessionId, action, modifications }` block the same way. |
| `EdogHttpPipelineHandler.cs:160–173` `SynthesizeErrorResponse` | Builds a fake `HttpResponseMessage` from a fault entry (status, body, request-message link). | **Directly reusable** as the "Forge Response" primitive. |
| `EdogHttpPipelineHandler.cs:253–264` `RedactUrl` | SAS-token-aware URL redaction (`sig|se|st|sp|spr|sv|sr|sdd` → `[redacted]`). | Reuse — F28 MUST keep redaction on published events. |
| `EdogHttpPipelineHandler.cs:270–298` `RedactRequestHeaders` | Authorization → `[redacted]` for published events. | Reuse — and add same redaction to the breakpoint editor view. **Decision needed**: in the interactive MITM "edit and forward" path the editor must show the *real* header to the user, because otherwise they cannot modify it meaningfully. This is a security/UX trade-off; see §4. |
| `EdogHttpPipelineHandler.cs:356–392` `CaptureBodyPreview` | Buffers via `LoadIntoBufferAsync` so the stream is re-readable. First 4KB. Skips >10MB and binary content. | Reuse the `LoadIntoBufferAsync` trick — it is exactly what F28 needs to let a user inspect/edit the body without consuming the stream for the real consumer. **Limit must change** (4KB is too small for editing) — see §4. |

**Critical observation:** The handler currently does the fault-store match **once**, before `base.SendAsync`. F28's "interactive breakpoint" needs **two** suspension points — pre-request and post-response — both able to await a frontend decision. The handler is async already, so adding an `await _mitmCoordinator.AwaitDecisionAsync(...)` call is straightforward; the architectural challenge is the coordinator (see §4).

---

### 1.2 `src/backend/DevMode/EdogHttpFaultStore.cs` — the fault store

**Purpose:** Process-wide HTTP fault rule store. Lock-free reads, write-locked merges, `FrozenDictionary` snapshot swapped via `Volatile.Write`. Populated only by `ChaosIntegration` (in `EdogQaExecutionEngine.cs`) when a QA scenario declares chaos rules.

**Key locations:**

| File:Line | Detail |
|---|---|
| `EdogHttpFaultStore.cs:53–75` `HttpFaultEntry` | Immutable shape: `ScenarioId`, `TargetSubstring` (case-insensitive substring match on absolute URI), `Fault` (`http_error`/`latency`/`timeout`), `StatusCode`, `ResponseBody`, `LatencyMs`. |
| `EdogHttpFaultStore.cs:82–88` | Two parallel snapshots — `_byScenario` (FrozenDictionary keyed by scenario) and `_flatRules` (flat array for the hot-path scan). Monotonic `_revision`. |
| `EdogHttpFaultStore.cs:109–136` `AddRule(scenarioId, rule)` | Append-by-scenario. Atomic snapshot commit. Writers serialised under `_writeLock`. |
| `EdogHttpFaultStore.cs:143–163` `RemoveRulesForScenario` | Bulk teardown for end of scenario. |
| `EdogHttpFaultStore.cs:174–194` `TryMatchFault(absoluteUri, out match)` | **The hot path.** Linear scan of `_flatRules` (length 0 short-circuit), first-substring-match wins. |
| `EdogHttpFaultStore.cs:209–250` `ToEntry` | Parse-and-validate from `ChaosRuleSpec.Parameters` (`statusCode`, `delayMs`, `body`) with hard defensible bounds (100–599, 0–600000ms). |

**Reuse vs. extend:**

- The **storage pattern** (FrozenDictionary snapshot + lock-free read + monotonic revision) is exactly right for F28 and is the F24 spec's recommended pattern too — keep it.
- The **rule shape** is too narrow. Three fault types vs. the 30 capabilities in `chaos-mitm-capabilities.md`. F28 needs at least: Block, Forge, Delay, ModifyHeaders, ModifyBody, RewriteUrl, plus a "Breakpoint" pseudo-action that suspends and waits for a frontend decision.
- The **owner model** (`ScenarioId`) is wrong for F28. Interactive MITM rules are owned by a UI session, not a QA scenario. They should auto-expire when the SignalR connection drops. Recommend a parallel `OwnerId` ("scenario:xyz" vs "mitm-session:abc") and a single store, OR a second store with the same shape — TBD in P1 design.
- `TargetSubstring` matching is too coarse (no method filter, no regex). F28 needs URL pattern + method + optional `httpClientName` filter at minimum.

---

### 1.3 `src/backend/DevMode/EdogTopicRouter.cs` — event publishing

**Purpose:** Static registry of named topic buffers. Publishers call `Publish(topic, payload)`; the router stamps `SequenceId`, `Timestamp`, `Topic` and writes to the buffer.

**Key locations:**

- `EdogTopicRouter.cs:26–45` `Initialize` — pre-registers 17 topics. `http` is sized 2000. **F28 may want a new topic `mitm` (`RegisterTopic("mitm", 1000)`)** for control-plane events (breakpoint hit, modification applied, session start/stop) distinct from raw HTTP traffic.
- `EdogTopicRouter.cs:74–95` `Publish` — never throws; swallows on failure. F28 control events should use this same channel.

**Reuse:** All of it. The publish-via-topic pattern is canonical and SignalR streaming consumes it via `SubscribeToTopic`.

---

### 1.4 `src/backend/DevMode/TopicBuffer.cs` and `TopicEvent.cs`

- `TopicBuffer.cs:21–66` — per-topic ring + unbounded live channel + observer list. `Write` writes to ring, to channel, and notifies observers. Non-blocking. Thread-safe.
- `TopicBuffer.cs:73–78` `AddObserver(callback)` — synchronous observer hook returning `IDisposable`. This is the QA recording-session hook; F28 doesn't need it (the stream already covers it) but it exists.
- `TopicBuffer.cs:83–86` `GetSnapshot()` — returns the full ring on subscribe so a newly-connected tab sees history.
- `TopicEvent.cs:17–30` — `{ SequenceId, Timestamp, Topic, Data }`. `Data` is `object`, serialized by SignalR's JSON protocol. F28 can attach arbitrary anonymous-object payloads here.

**Reuse:** All of it, unchanged.

---

### 1.5 `src/backend/DevMode/EdogPlaygroundHub.cs` — the SignalR hub

**Purpose:** Single SignalR hub at `/hub/playground`. Auto-subscribes to `log` on connect (`L406-410`). Two streaming patterns: group-broadcast (`Subscribe`/`Unsubscribe`/server-side `Clients.Group(...)`) and ChannelReader streaming (`SubscribeToTopic`).

**Key locations:**

| File:Line | Method | Relevant |
|---|---|---|
| `EdogPlaygroundHub.cs:384–401` | `Subscribe(topic)` / `Unsubscribe(topic)` | Legacy group pattern. Not needed for F28. |
| `EdogPlaygroundHub.cs:406–410` | `OnConnectedAsync` auto-joins `log` group. | F28 can attach session-lifetime hooks here (e.g., to clear interactive rules on disconnect). |
| `EdogPlaygroundHub.cs:419–463` | `SubscribeToTopic(topic, ct)` | **The canonical streaming method.** Returns `ChannelReader<TopicEvent>`. Yields snapshot then live events. Uses a bounded channel with `DropOldest` (`L427–433`). `cancellationToken` fires when client disconnects → ideal anchor for "auto-clear MITM rules when tab closes". |
| `EdogPlaygroundHub.cs:493–1042` | F27 QA RPC methods (`QaStartCodeAnalysis`, `QaSubmitCuratedScenarios`, `QaStartRun`, …) | **The RPC pattern** F28 should follow: `Task<TResult> XxxAsync(XxxRequest)` returning a result envelope, with progress streaming via a separate topic. |
| `EdogPlaygroundHub.cs:1055–1070` | `QaGetCapabilities` | Returns `QaCapabilityReport` — same pattern F28 should use to gate UI on whether MITM is enabled (env-var or build constant). |

**No existing chaos hub methods.** Despite the rich spec in `chaos-mitm-capabilities.md` and `F24-chaos-engineering/signalr-protocol.md`, no `ChaosCreateRule`/`ChaosSubscribeTraffic`/etc. methods are implemented in the hub. F28 is the first implementation of interactive MITM RPC.

---

### 1.6 `src/frontend/js/tab-http.js` — the current HTTP tab

**Purpose:** Network-style HTTP traffic inspector. Subscribes to the `http` topic immediately on construct (`L56–59`) so events accumulate even when the tab is hidden. Maintains a 2000-event ring (`L42`), filters and sorts client-side, renders a detail panel with Request/Response/Timing/Headers tabs.

**Key locations:**

| File:Line | What it does | Reuse for F28 |
|---|---|---|
| `tab-http.js:13–60` constructor + immediate subscription | Wires `signalr.on('http', _onEvent)` and `signalr.subscribeTopic('http')`. | **Don't break this** — F28 reuses the same stream. Add a second subscription for the new `mitm` topic (control-plane events). |
| `tab-http.js:88–117` `_onEvent` | Normalizes envelope payload into a row entry with the fields listed in §2.1 below. Ring-buffered, then `_applyFilters()`. | Extend the row entry shape to carry `mitmTag` (intercepted/modified/forged/blocked) so the row can be styled distinctly. |
| `tab-http.js:194–397` `_buildToolbar` | Two-row toolbar: search, method pills, status pills, duration slider, p50/p95/p99 stats, distribution bar, filter badge, clear, export dropdown. | **Add a third group** to row 1: an "Intercept" toggle pill (off → no rules; on → MITM mode armed) and a "Rules: N" badge next to the count. The whole toolbar layout is the right place to live. |
| `tab-http.js:399–442` empty state + table header | Six columns: Method, URL, Status, Duration, Retry, Time. | Add a 7th column `MITM` (icon: ⏸ paused / ◆ modified / ⊘ blocked / ⟲ replayed) or fold it into the Status cell. Either way it must be visible at-a-glance. |
| `tab-http.js:444–487` `_buildDetailPanel` | Tabs: Request / Response / Timing / Headers. Resize handle. | Add two new tabs: **Intercept** (rule editor — "block/forge/modify this request next time it fires") and **Replay** (compose a new request seeded from this one and fire it through the pipeline). Tab strip animates with an indicator (`_dtabIndicator`) — reuse. |
| `tab-http.js:907–943` row rendering | Builds row with status icon, method class, duration class, error sub-row for 5xx. | Add row-level CSS classes `http-row-intercepted`, `http-row-forged`, `http-row-blocked` mirroring the existing `http-row-failed`/`http-row-throttled` pattern. |
| `tab-http.js:1001–1168` detail tab renderers | `_renderRequestTab`, `_renderResponseTab`, `_renderTimingTab`, `_renderHeadersTab` — server-rendered HTML strings with `_jsonHighlight`. | Reuse the renderers; the Intercept tab can reuse `_jsonHighlight` for editor previews. |
| `tab-http.js:1174–1261` `_exportAs` | HAR 1.2 / JSON / CSV export. | Reuse — HAR export is already the format Burp/Charles/DevTools share. F28 should add a `cURL` export for any selected row (Postman pattern). |

**Crucial reuse decisions:**
- Don't fork the tab. Extend `HttpPipelineTab` in-place; gate new UI behind a capability check from the backend (same pattern as `QaGetCapabilities`).
- The "subscribe on construct" pattern (`L56–59`) means we already buffer events while the tab is hidden — MITM intercepts will be visible even if the user is on another tab when the breakpoint hits. Pair this with a Runtime-View-level toast/badge to surface paused requests.

---

### 1.7 `src/frontend/css/tab-http.css`

Not read in full (25 KB) but the toolbar/pills/detail-panel selectors are established. F28 CSS work: add `.http-pill.http-intercept-toggle.active`, `.http-row-intercepted`, `.http-mitm-badge`, `.http-detail-tab[data-dtab="intercept"]` styling. Follow the existing color tokens (`--http-red`, `--http-amber`, `--http-blue`, etc., used in `tab-http.js:1115–1120`).

---

### 1.8 `src/frontend/js/api-playground.js` — request composer (REUSE)

**Purpose:** The full API Playground (Swagger catalog, request builder, response viewer, history). Class graph: `JsonTree` (L50), `EndpointCatalog` (L168), `RequestBuilder` (L442), `ResponseViewer` (L1267), `SwaggerSpecView` (L1712), `HistorySaved` (L2568), `ApiPlayground` (L2845).

**Key reuse target — `RequestBuilder` (L442):**

| File:Line | Element |
|---|---|
| `api-playground.js:466–540` | URL bar: method pill + dropdown (GET/POST/PUT/PATCH/DELETE, color-tokenised), URL input, Send, Cancel, cURL, Save. |
| `api-playground.js:542–555` | Request tabs: Params / Headers / Body / Auth. |
| `api-playground.js:1133–1152` | `fetch('/api/flt/config')` + `/api/edog/mwc-token` integration — how the playground gets credentials. |

**Why this matters for F28:**
- The "Modify & Forward" editor (when a breakpoint pauses a request, the user edits then resumes) is **structurally identical** to `RequestBuilder` minus the Send button. Extract a reusable subset — `RequestEditor` — and embed it in the Intercept detail tab.
- The "Replay" feature (right-click row → Replay) needs exactly `RequestBuilder` pre-populated from a captured request, with the Send button wired to a new hub method (`MitmReplayRequest`) instead of the playground's `/api/playground/dispatch`.
- The `cURL` export button (L529–532) is the kind of small utility F28 should add per-row in the HTTP tab.

---

### 1.9 `src/frontend/js/api-client.js`

Plain `fetch()` wrappers around the localhost EDOG backend (`/api/*` REST endpoints), not the SignalR hub. **Not relevant to F28** — MITM is a SignalR-only feature. Calling it out so we don't accidentally add HTTP endpoints when we should be adding hub methods.

---

### 1.10 `src/frontend/js/signalr-manager.js` — SignalR client

**Purpose:** Drop-in replacement for the old WebSocketManager. Manages reconnect, topic streams, listener bus.

**Key locations:**

| File:Line | What | Relevance to F28 |
|---|---|---|
| `signalr-manager.js:53–122` | `connect()` — builds `HubConnectionBuilder` with auto-reconnect schedule `[0, 1000, 2000, 5000, 10000, 30000]`. | F28 inherits robust reconnect for free. **But** — interactive MITM rules MUST clear on disconnect (server-side), so reconnects don't accidentally re-arm stale rules. |
| `signalr-manager.js:179–191` | `on(topic, callback)` / `off(topic, callback)` — multi-listener bus. | F28 adds `signalr.on('mitm', …)` for control-plane events. |
| `signalr-manager.js:193–224` | `subscribeTopic(topic)` — calls `connection.stream('SubscribeToTopic', topic)`, subscribes with `{ next, error, complete }`. Handles disconnect-time pending topics. | F28 reuses this for the new `mitm` topic. No client-side stream code needs to change. |
| `signalr-manager.js:148–167` | `_resubscribeAll` on reconnect — restarts active streams and flushes pending. | Means rules-cleared-on-disconnect must be re-pushed by the frontend after reconnect. F28 needs a `MitmGetActiveRules()` RPC on reconnect to reconcile. |

**Missing capability for F28:** `signalr-manager.js` has no helper to `invoke()` a hub RPC method. Callers do this directly via `this._signalr.connection.invoke(...)` in other files (see `qa-analysis.js` patterns). F28 will follow the same direct-invoke pattern; we don't need a new wrapper.

---

### 1.11 F24 spec corpus (read for overlap)

| File | What | Relevance |
|---|---|---|
| `docs/specs/features/F24-chaos-engineering/spec.md` | Master spec — 5th-sidebar panel with Rule Builder / Active Rules / Traffic Monitor / Recording sub-views. 30 capabilities across 6 categories. Zero-overhead fast path (`L124–134`). Lock-free immutable-snapshot store (`L138–141`). Kill switch Ctrl+Shift+K (`L143–149`). | **F24 owns "rules as a feature".** F28 owns "rules as a per-request action in the HTTP tab". They share an engine. |
| `docs/specs/features/F24-chaos-engineering/signalr-protocol.md` | Detailed SignalR protocol: `ChaosCreateRule`, `ChaosUpdateRule`, `ChaosDeleteRule`, `ChaosSubscribeTraffic`, … on the same `/hub/playground`. New topic `chaos`. `ChaosRuleInput` shape, validation errors, audit broadcast events. | **F28 should adopt this protocol verbatim** for the rule-management surface. F28's *interactive* additions (breakpoint pause/resume, modify-and-forward) are extensions on top. |
| `docs/specs/features/F24-chaos-engineering/engine-design.md` | (Not read in this audit — referenced for the rule model.) | Read in P1 design before finalising the F28 rule shape. |
| `docs/specs/features/F24-chaos-engineering/interceptor-audit.md` | Confirms `EdogHttpPipelineHandler` is read-only today and enumerates exactly the limitations F28 must remove (`L30–38`). Documents the handler chain: `EdogTokenInterceptor → EdogHttpPipelineHandler → original`. | Authoritative gap list — F28 must close 8 of the 9 "Limitations" bullets. |
| `docs/specs/features/chaos-mitm-capabilities.md` | The 30-capability catalogue with `ChaosActionType` enum (`L115–142`), `ChaosRule` model (`L42–113`), engine pseudocode (`L218–264`), `ChaosRuleStore` storage pattern (`L178–211`), `ChaosEvent` topic shape (`L300–315`). | **The de facto F28 design reference for the action model.** F28 is the UI half of this spec; F24 is the rules-panel half. |
| `docs/specs/features/F24-chaos-engineering/states/traffic-monitor.md` | State matrix for the live traffic view in the F24 panel. | F28 reuses the HTTP tab instead — but the state machine ("no data" / "streaming" / "paused" / "intercepting" / "frozen during breakpoint") is directly applicable. Read in P1. |

---

## §2. Data Source Mapping

### 2.1 Current `http` topic event shape (the wire contract today)

Published from `EdogHttpPipelineHandler.PublishHttpEvent` (`EdogHttpPipelineHandler.cs:183–248`). Two variants — without and with the optional `chaos` block — sent inside the `TopicEvent.Data` slot.

**No chaos applied (the common case):**

```json
{
  "sequenceId": 1234,
  "timestamp": "2026-08-12T17:42:11.123Z",
  "topic": "http",
  "data": {
    "method": "GET",
    "url": "https://onelake.dfs.fabric.microsoft.com/.../Tables?sig=[redacted]",
    "statusCode": 200,
    "durationMs": 142.37,
    "requestHeaders": {
      "Authorization": "[redacted]",
      "x-ms-correlation-id": "abc-123",
      "User-Agent": "FabricLiveTable/1.0"
    },
    "responseHeaders": {
      "Content-Type": "application/json",
      "x-ms-request-id": "def-456"
    },
    "responseBodyPreview": "{\"value\":[...]}",
    "requestBodyPreview": null,
    "requestSizeBytes": 0,
    "responseSizeBytes": 8421,
    "httpClientName": "OneLakeRestClient",
    "correlationId": "abc-123"
  }
}
```

**Chaos applied (F27 P5 path, `EdogHttpPipelineHandler.cs:200–223`):**

Same as above plus an extra block:

```json
"chaos": {
  "fault": "http_error",
  "scenarioId": "scn-onelake-503",
  "target": "/Tables",
  "synthesized": true
}
```

**F28 extension proposal:** Same envelope, add an optional `mitm` block analogous to `chaos`:

```json
"mitm": {
  "sessionId": "mitm-7f3a",
  "action": "modify",                // "block" | "forge" | "modify" | "delay" | "replay" | "passthrough-tagged"
  "breakpoint": "request",           // "request" | "response" | null
  "ruleId": "rule-abc",              // null for ad-hoc one-shot intercepts
  "modifications": [
    { "target": "request.body", "op": "replace", "summary": "rewrote $.query" },
    { "target": "response.statusCode", "op": "replace", "from": 200, "to": 503 }
  ],
  "synthesized": false               // true when base.SendAsync was skipped
}
```

This keeps the wire shape additive and compatible with the existing `HttpPipelineTab._onEvent` consumer (`tab-http.js:88–117`).

### 2.2 Fault rule shape today (`HttpFaultEntry`)

From `EdogHttpFaultStore.cs:53–75`:

| Field | Type | Notes |
|---|---|---|
| `ScenarioId` | string | Owner — used for bulk teardown. F28 needs an analogous `SessionId`. |
| `TargetSubstring` | string | Case-insensitive substring match on `request.RequestUri.AbsoluteUri`. No method filter, no regex. |
| `Fault` | string | One of `"http_error"` / `"latency"` / `"timeout"`. Rejected otherwise. |
| `StatusCode` | int | 100–599, default 500. Used by `http_error`. |
| `ResponseBody` | string | Used by `http_error`. |
| `LatencyMs` | int | 0–600000, used by `latency`. |

**Source of rules:** `ChaosIntegration.ApplyChaosRuleAsync` in `EdogQaExecutionEngine.cs:1450` calls `EdogHttpFaultStore.AddRule(scenarioId, rule)`. Rules come from QA scenario specs (`ChaosRuleSpec`), not the UI.

**Capability gating:** `EdogQaCapabilityRegistry.IsChaosFaultSupported` (`EdogQaCapabilityRegistry.cs:135–142`) requires both the build constant `HttpChaosPipelineWired = true` (currently true) and the env var `EDOG_QA_CHAOS_HTTP=1`. F28's interactive mode needs a parallel gate — recommend a separate env var like `EDOG_MITM_INTERACTIVE=1` so the two paths can be enabled independently.

### 2.3 SignalR protocol for the `http` topic today

**Topic registration:** `EdogTopicRouter.Initialize`, line `EdogTopicRouter.cs:34` — `RegisterTopic("http", 2000)`.

**Streaming:** Hub method `ChannelReader<TopicEvent> SubscribeToTopic(string topic, CancellationToken ct)` in `EdogPlaygroundHub.cs:419–463`.
- Phase 1: yields full ring buffer snapshot (up to 2000 events).
- Phase 2: yields live events from `TopicBuffer.ReadLiveAsync`.
- Bounded channel of size 1000 between source and client with `DropOldest` semantics (`EdogPlaygroundHub.cs:427–433`).
- `cancellationToken` fires on client disconnect or stream dispose.

**Client:** `signalr-manager.js:194–224` calls `connection.stream('SubscribeToTopic', topic).subscribe({next, error, complete})`. Events are dispatched to `_listeners` map keyed by topic.

**Existing HTTP-manipulation RPC methods on `EdogPlaygroundHub`:** **None.** Every existing fault-injection path goes through the QA execution engine (`QaStartRun` → scenario → `ChaosIntegration` → `EdogHttpFaultStore.AddRule`). There is no direct UI-driven RPC to add/remove HTTP rules. F28 introduces the first.

### 2.4 RPC patterns to follow

Patterns established in `EdogPlaygroundHub.cs` that F28 should mimic:

- **Request envelope + result envelope:** `Task<QaAnalysisResult> QaStartCodeAnalysis(QaAnalysisRequest request)` (`L493`). Returns `{ Success, Message, CorrelationId, ... }`.
- **Streaming progress via topic, not callback:** Long-running operations stream progress through a dedicated topic (`qa` for QA runs). For F28: breakpoint hits + decisions stream through the new `mitm` topic.
- **Cancellation by correlation ID:** `QaCancelAnalysis(string correlationId)` (`L585`). F28 analog: `MitmResume(string interceptId, MitmAction decision)`.
- **Capability discovery:** `Task<QaCapabilityReport> QaGetCapabilities()` (`L1055`). F28 analog: `MitmGetCapabilities()` returning `{ Enabled, Reason, SupportedActions, MaxRulesPerSession }`.

---

## §3. Industry Research — How the Best Tools Do It

The seven tools below cover the full design space. For each: interaction model, key UX patterns, what makes it good *for testing* (vs. observation).

### 3.1 Burp Suite — Proxy + Breakpoints

**Model:** External HTTP/HTTPS proxy. Browser/client configured to route through it. Operates in two modes that you can toggle live: **Intercept ON** (every request pauses, waits for human Forward/Drop/Modify) and **Intercept OFF** (everything flows, logged to History).

**Key UX:**
- **Single big "Intercept is on/off" toggle** dominates the Proxy tab. Mode is global, not per-request. Predicate filters (URL include/exclude) control *which* requests pause.
- **Forward / Drop / Action** triumvirate. Forward sends the (optionally modified) request. Drop kills it. Action menu = Send to Repeater (replay), Send to Intruder (fuzz), Copy as cURL.
- **Repeater tab** is a separate workspace seeded with one request you can edit and re-send N times. Each send shown side-by-side.
- **History tab** is the passive log; rows have right-click → Send to Repeater / Intruder / Comparer.
- **Match-and-replace rules** (Project options → Sessions): persistent regex find/replace on headers and bodies, applied to all flowing traffic automatically.

**What makes it great for testing:** The Forward/Drop/Modify three-way decision is the whole product. Plus the "right-click to escalate" pattern — observe in History, escalate to Repeater when something interesting appears. No mode-switching overhead.

**For F28:** Adopt the toggle, the three-way decision, and the "right-click any row → Replay with edits" pattern. The Repeater equivalent is the existing `api-playground.js` `RequestBuilder` reused inside an Intercept detail tab.

### 3.2 Charles Proxy — Rewrite Rules + Breakpoints

**Model:** Same OS-level proxy model as Burp. **Two separate features** for the two needs:
- **Breakpoints** = interactive pause-and-edit per matching request.
- **Rewrite** = persistent automatic rules (find/replace headers, status, body, host).

**Key UX:**
- **Tool → Rewrite** opens a dedicated rule editor: enable, rule name, list of locations (host/port/path/query/protocol pattern), list of operations (add/modify/remove header / response status / body matching). Multiple operations per rule.
- **Tool → Breakpoints** opens a list of URL patterns. When traffic matches, the request OR response (or both) pauses in a separate window with an editable form: Edit Request, Edit Response, Execute, Cancel.
- **Throttling** ("Throttle Settings") is a separate tool — predefined profiles (3G, 56k, GPRS) for bandwidth limiting.
- **Map Local / Map Remote** — redirect a URL to a local file or a different host. Two of the most-used features.

**What makes it great for testing:** The strict separation of "edit one request right now" (Breakpoints) from "edit a class of requests forever" (Rewrite). Both share the same predicate model.

**For F28:** Mirror this split. The HTTP tab's per-row Intercept tab = Breakpoint. A "Rules" overlay (or the F24 panel) = Rewrite. Same predicate language for both.

### 3.3 mitmproxy — Scriptable Proxy

**Model:** TUI / web UI proxy with a **scripting interface** (Python). Every request/response runs through user-supplied hooks (`def request(flow)`, `def response(flow)`).

**Key UX:**
- The TUI is fast: arrow keys to navigate flows, `e` to edit, `r` to replay, `d` to drop, `^X` to export. Keyboard-first.
- `flow.request.set_text("...")`, `flow.response.headers["X-Foo"] = "bar"` — direct property mutation in scripts.
- **Intercept filter** is a typed predicate language: `~u onelake & ~m POST & ~s 500`. Composable. Saved as a string in the UI.
- **Replay** preserves the full original request and lets you tweak any field including method/URL/headers/body in a vim-style editor.

**What makes it great for testing:** The filter language is more powerful than a form. A power user can express "all 500s from Spark, in the last 5 minutes, with body containing 'timeout'" as one string. And scripting makes the long tail of weird cases possible without UI work.

**For F28:** We're a UI-driven tool, not a scriptable proxy — *don't copy the scripting*. Do copy the **keyboard-first navigation** (the HTTP tab already has `Ctrl+/` for search and arrow-key row navigation — extend with `b` to set breakpoint, `r` to replay, `f` to forge) and the **typed filter idea** (a single text field where `m:POST status:500 host:onelake` is parsed into the existing filter pills).

### 3.4 Chrome DevTools — Network Tab

**Model:** Same-process inspection of browser HTTP. **Not a general proxy** — only sees what the page makes.

**Key UX relevant to F28:**
- **Right-click a request → Block request URL / Block request domain.** Once blocked, the row shows a red "(blocked)" badge; the rule appears in the Network Request Blocking pane where you can toggle/edit.
- **Override responses:** Sources → Overrides → enable local overrides folder. Right-click a response → Save for overrides → edit the local file → next time that URL is requested, the override is served. Round-trip is "intercept → save → edit → reload".
- **Throttling** profiles dropdown in toolbar (Fast 3G, Slow 3G, Offline). One click.
- **Replay XHR** right-click action — re-issues with current credentials, no edit.
- **Copy as → fetch / cURL / PowerShell** is the de facto export format for "I want to redo this manually".

**What makes it great for testing:** The right-click context menu is the central UX. Every action is one click from any row. No mode-switching, no separate window. F28's HTTP tab should follow this — every interesting action is on a row's right-click menu.

**For F28:** Adopt the **right-click menu** model as the primary entry point: Block URL, Block Domain, Override Response (open editor), Replay, Replay with edits, Copy as cURL, Copy as fetch. The toolbar Intercept toggle covers the "intercept everything globally" case but most workflows start from a specific row.

### 3.5 Postman / Postman Interceptor — Replay & Mock

**Model:** Mostly a request composer. The Interceptor extension captures browser traffic into Postman's history. Mock Servers serve pre-defined responses for testing.

**Key UX relevant to F28:**
- The request builder UX (tabs: Params, Authorization, Headers, Body, Pre-request Script, Tests) is the gold standard for composing arbitrary HTTP requests. **`api-playground.js`'s `RequestBuilder` (L442) is already a faithful adaptation** — F28 doesn't need to reinvent this.
- **Examples** feature: save a response as an "example" tied to a request. The mock server then returns that example. This is "Forge Response" with a name and persistence.
- **Environment variables** for dynamic substitution (`{{token}}`, `{{baseUrl}}`). Useful in F28 for "use the live MWC token here" patterns.

**For F28:** Reuse `RequestBuilder` directly for the Replay editor. Borrow the "save as example" idea for "save this forged response as a reusable forgery" (future enhancement; not P0/P1).

### 3.6 WireMock / MockServer — Programmable HTTP Mocks

**Model:** Standalone HTTP servers that the system-under-test points at. Define request matchers + response definitions via JSON or fluent API. The server matches, returns the response, records the interaction.

**Key UX (less UI, more API):**
- **Request matcher** is a rich predicate: URL regex, method, headers (with operators: equalTo, contains, matches), query params, body (JSON path, regex). This is the most expressive matcher in the industry.
- **Response templates** with handlebars: `{{request.headers.X-Trace-Id}}` reflects request data into the response. Useful for `correlationId` echo behaviour.
- **Stateful mocks** ("scenarios"): "first request returns 503, second request returns 200" — a tiny state machine attached to a matcher.
- **Recording mode**: proxy through to a real backend, capture every interaction, save as a fixture set. The replay-from-recording loop.

**What makes it great for testing:** The rich matcher + the stateful scenarios. "Return 429 the first three times then 200" is a one-liner in WireMock and impossible in Charles/Burp.

**For F28:** **The predicate model is the F28 (and F24) blueprint.** Adopt the WireMock matcher shape verbatim: URL (regex), method (set), headers (operators), body (jsonpath/regex). Stateful counters per rule (already in `ChaosRule` as `MaxFirings`, `FireCount` — `chaos-mitm-capabilities.md:90, 108`). Recording mode = F28's "Save session as HAR/fixture" (deferred — Phase 2).

### 3.7 Cypress `cy.intercept()` — Test-Time HTTP Control

**Model:** In-process interception inside the test runner. Tests declare `cy.intercept('POST', '/api/users', { fixture: 'users.json' })` and the runtime intercepts matching calls.

**Key UX:**
- **One function, three modes:** observe (`cy.intercept(url).as('alias')`), stub (`cy.intercept(url, { statusCode, body })`), modify (`cy.intercept(url, (req) => { req.body.foo = 'bar'; req.reply(...) })`).
- **`req.continue(res => res.body.x = 1)`** — modify response after real call. The cleanest "modify-and-forward" API in any tool.
- **Spy assertions:** `cy.wait('@alias').its('request.body').should('deep.equal', {...})` — the intercept doubles as a verification primitive.

**What makes it great for testing:** It's *intentionally* test-shaped. The same function declares intent and asserts behaviour. Mode is determined by what argument shape you pass. Zero ceremony.

**For F28:** EDOG isn't a test runner, but the **assert-via-intercept idea** matters. A rule that says "if a POST to /api/foo happens, block it AND raise a UI alert" doubles as a regression test. Phase-2 idea: convert a captured intercept into a `cy.intercept`-style assertion the user can save to a scenario file. Out of scope for P0 but worth holding the door open in the rule shape.

---

### 3.8 Synthesis — UX Patterns F28 Should Adopt

| Pattern | Source | F28 application |
|---|---|---|
| Global Intercept ON/OFF toggle | Burp | Toolbar pill on the HTTP tab. |
| Forward / Drop / Modify three-way decision | Burp | Buttons in the Intercept detail tab when a request is paused. |
| Right-click row menu drives 80% of actions | DevTools | Block URL / Block Domain / Override Response / Replay / Replay-with-edits / Copy as cURL / Copy as fetch. |
| Strict split: "edit this one" vs. "rewrite a class" | Charles | Per-row Intercept tab (one-shot) vs. Rules pane (persistent). Same predicate language. |
| Rich matcher: URL regex + method + header ops + body jsonpath | WireMock | The shared rule shape for F24 + F28. |
| Stateful counters: MaxFirings, RatePerSecond | WireMock, F24 spec | Already in the F24 ChaosRule model — adopt verbatim. |
| Keyboard-first nav | mitmproxy | Extend existing keyboard map: `b` breakpoint, `r` replay, `f` forge, `Ctrl+Shift+K` kill switch. |
| Throttle profiles in toolbar | DevTools | Phase 2 — bandwidth/latency presets next to the Intercept toggle. |
| Copy as cURL / fetch | DevTools | Per-row, in the export dropdown and right-click menu. |
| Replay seeded by RequestBuilder | Postman | Embed `api-playground.js` `RequestBuilder` in the Intercept/Replay detail tab. |
| Response template variables | WireMock | Phase 2 — `{{request.headers.X-Trace-Id}}` in forge response body. |

---

## §4. Gap Analysis

### 4.1 What F28 needs that doesn't exist yet

| Capability | Status | Where it must land |
|---|---|---|
| **Interactive breakpoint suspension** — `await` a frontend decision mid-request | Missing | New `MitmCoordinator` service. `EdogHttpPipelineHandler.SendAsync` calls `await _coordinator.AwaitDecisionAsync(interceptId, snapshot, ct)` at request-phase and response-phase hooks. |
| **Hub RPC for rule CRUD** — `MitmCreateRule`/`MitmUpdateRule`/`MitmDeleteRule`/`MitmListRules` | Missing — no chaos/mitm methods on the hub today | `EdogPlaygroundHub.cs` new region. Same pattern as `Qa*` methods. |
| **Hub RPC for breakpoint resume** — `MitmResume(interceptId, decision, modifications)` / `MitmDrop(interceptId)` | Missing | `EdogPlaygroundHub.cs`. Returns void; result delivered via topic. |
| **Hub RPC for one-shot replay** — `MitmReplayRequest(snapshot)` re-runs a captured request through the pipeline | Missing | New method. Reuses `EdogHttpClientFactoryWrapper` to obtain a real `HttpClient`. |
| **`mitm` topic** for control-plane events | Missing | Register in `EdogTopicRouter.Initialize` (`EdogTopicRouter.cs:34`). |
| **Rich rule shape** (URL regex, method set, header ops, body jsonpath, lifecycle counters) | Missing — `HttpFaultEntry` is too narrow | Either: (a) extend `HttpFaultEntry` and `EdogHttpFaultStore` to the full `ChaosRule` shape from `chaos-mitm-capabilities.md`; or (b) introduce a parallel `MitmRule` / `MitmRuleStore` with the same FrozenDictionary pattern. **Recommendation:** option (b) for P0 to avoid breaking F27 P5 callers, then converge in F24's full rollout. |
| **Action types beyond http_error/latency/timeout** — Block, Forge, ModifyHeaders, ModifyBody, RewriteUrl, DelayResponse | Missing | Action dispatch table in the handler. Forge is closest to existing `SynthesizeErrorResponse` (`EdogHttpPipelineHandler.cs:160–173`); ModifyBody/Headers/RewriteUrl are new. |
| **Body editing past 4KB preview limit** | The current `MaxBodyPreviewBytes = 4096` (`EdogHttpPipelineHandler.cs:27`) truncates anything bigger | When a rule is "edit before forward" or "edit response before delivery", we must buffer the full body (subject to `MaxBufferableBytes = 10MB` cap). New code path in the handler that bypasses the preview-only buffering. |
| **Capability gating + reporting** for the UI | Missing | `MitmGetCapabilities()` RPC. Gated by env var `EDOG_MITM_INTERACTIVE=1` (default off) and a build constant. |
| **HTTP tab UI: Intercept toggle, row badges, Intercept/Replay detail tabs** | Missing | Extend `HttpPipelineTab` (`src/frontend/js/tab-http.js`). |
| **Embedded RequestEditor** (Send-button-less subset of `RequestBuilder`) | Missing | Extract from `api-playground.js:442–540`. New file `src/frontend/js/request-editor.js` or inline in `tab-http.js` if small. |
| **Per-row right-click menu** | Missing — current tab has no context menu | New module `http-row-menu.js`. Add `contextmenu` handler in `tab-http.js`. |
| **Kill switch** (`Ctrl+Shift+K`) | Missing | Global key handler that calls `MitmClearAllRules()`. Mirror F24's kill switch (`F24 spec:143`). |
| **Per-session rule scoping** so reconnect or tab close clears rules | Missing | `MitmCoordinator` tracks rules by SignalR `Context.ConnectionId`. `OnDisconnectedAsync` purges. |
| **Reconnect reconciliation** — frontend re-pushes rules after reconnect | Missing | Frontend calls `MitmListRules` on reconnect (handled by `signalr-manager.js:79` reconnected hook). |

### 4.2 What can be reused (with refs)

| F28 need | Reuse from | Line refs |
|---|---|---|
| Interception point | `EdogHttpPipelineHandler.SendAsync` | `src/backend/DevMode/EdogHttpPipelineHandler.cs:46` |
| Short-circuit / synthesize pattern | Existing `SynthesizeErrorResponse` + the `timeout`/`http_error` branches | `EdogHttpPipelineHandler.cs:88–128, 160–173` |
| Delay pattern | Existing `latency` branch with `Task.Delay` | `EdogHttpPipelineHandler.cs:116–123` |
| Lock-free immutable-snapshot store | `EdogHttpFaultStore` pattern (FrozenDictionary + Volatile.Write + write lock + revision counter) | `EdogHttpFaultStore.cs:82–88, 109–136, 252–266` |
| Capability registry pattern | `EdogQaCapabilityRegistry` (env-var + build constant gates + result envelope) | `src/backend/DevMode/EdogQaCapabilityRegistry.cs:39, 135–142, 181–185, 203–230` |
| Topic publishing | `EdogTopicRouter.Publish` | `src/backend/DevMode/EdogTopicRouter.cs:74–95` |
| Ring buffer + live channel + snapshot-on-subscribe | `TopicBuffer` (unchanged) | `src/backend/DevMode/TopicBuffer.cs:34–95` |
| Streaming hub method shape | `SubscribeToTopic` | `EdogPlaygroundHub.cs:419–463` |
| RPC shape (request envelope, result envelope, correlationId, capability discovery) | `Qa*` methods | `EdogPlaygroundHub.cs:493, 585, 1055` |
| Frontend SignalR stream subscription, reconnect handling, pending-topic flush | `SignalRManager` | `src/frontend/js/signalr-manager.js:74–122, 148–224` |
| HTTP tab table, filters, pills, detail tabs, export | `HttpPipelineTab` | `src/frontend/js/tab-http.js` (entire file extended in-place) |
| Request composer UI (method pill+dropdown, URL bar, Params/Headers/Body/Auth tabs, cURL export) | `RequestBuilder` in API Playground | `src/frontend/js/api-playground.js:442–555, 529–532` |
| JSON syntax-highlight rendering | `_jsonHighlight`/`_jsonToHtml` | `tab-http.js:1289–1332` |
| SAS/Authorization redaction | `RedactUrl`, `RedactRequestHeaders`, `_sanitizeUrl`, `_redactHeaders` | `EdogHttpPipelineHandler.cs:253–298`, `tab-http.js:123–142` |
| HAR/JSON/CSV export | `_exportAs` | `tab-http.js:1174–1261` |
| Existing event annotation precedent (`chaos {…}` block) | Anonymous-object payload extension in publish | `EdogHttpPipelineHandler.cs:200–223` |

### 4.3 F24 vs. F28 — Overlap and Divide

Both want to mutate the HTTP pipeline. Both want a rule shape with predicates + actions + lifecycle. Both want a `chaos`/`mitm` topic for control-plane events. **Implement the engine once.**

| Concern | F24 (Chaos Engineering Panel) | F28 (HTTP MITM) |
|---|---|---|
| **Primary surface** | New 5th-sidebar panel | Existing Runtime → HTTP tab |
| **Rule authoring** | Dedicated Rule Builder UI with predicate/action/lifecycle sections | Per-row right-click → Block/Forge/Modify; inline Intercept detail tab |
| **Rule lifetime** | Persistent — created in panel, lives until disabled or expires | Session-scoped — created from HTTP tab interaction, cleared on disconnect by default |
| **Trigger pattern** | Always-on automatic when rule matches | Two modes: (a) one-shot interactive breakpoint that pauses one matching request; (b) auto-apply rules with explicit lifetime |
| **Scope** | All 30 capabilities across 6 categories | Subset: Block, Forge, Modify request/response, Delay, Replay. Defers: security probing, schema fuzzing, shadow traffic, bandwidth throttle, full HAR-based offline replay |
| **Recording** | First-class Recording sub-view, HAR export, diff-two-recordings | Reuses HTTP tab's existing HAR export. No first-class recording-vs-recording diff. |
| **Kill switch** | Ctrl+Shift+K disables ALL rules from any panel | Same global handler; clears MITM rules too |
| **Backend** | Same engine + same store + same topic | Same engine + same store + same topic |

**Decision for P0:** Treat F24 and F28 as **two front-ends to one engine**. F28 ships first with a minimal rule shape that is a subset of F24's. F24 grows the panel later and reuses the same store and RPC surface.

This decision has architectural consequences worth flagging now:
- The store should be **owner-tagged** (`OwnerType: "scenario" | "mitm-session" | "chaos-panel"`, `OwnerId: string`) so disconnect-purge and panel-edit work cleanly side-by-side. The existing `_byScenario` shape needs widening.
- The rule shape used on the wire and in the store should match the F24 `ChaosRuleInput` (see `F24-chaos-engineering/signalr-protocol.md`) — F28 just doesn't expose all fields in its UI yet.
- Two new env vars / build flags: `EDOG_MITM_INTERACTIVE`, `EDOG_CHAOS_PANEL`. F27 P5's `EDOG_QA_CHAOS_HTTP` stays.

### 4.4 Risks & Technical Constraints

| # | Risk | Mitigation |
|---|---|---|
| R1 | **Test-tool stance vs. debugger temptation.** F28 must remain a testing tool. Pausing a real production-like FLT request indefinitely is debugger behaviour. | Every interactive breakpoint MUST have a default timeout (e.g., 30s) after which the original request proceeds untouched and a `mitm.timedOut` event is published. Configurable, but always finite. |
| R2 | **Authorization redaction conflict.** `RedactRequestHeaders` (`EdogHttpPipelineHandler.cs:280–283`) replaces `Authorization` with `[redacted]` in published events. If F28 lets the user *modify* the Authorization header, the editor needs the real value, which means it leaves the FLT process. | Two separate code paths: published `http` topic events stay redacted (existing behaviour); the breakpoint-paused snapshot delivered via the `mitm` topic for a *specific* paused intercept may include the real Authorization, gated behind capability flag + explicit user opt-in. **Default: redacted even in the editor**; show a "Reveal" affordance with a confirmation. |
| R3 | **Body size limits.** `MaxBodyPreviewBytes = 4096` is fine for observation but breaks editing of large JSON. `MaxBufferableBytes = 10MB` (`EdogHttpPipelineHandler.cs:27–28`) is the real ceiling. | When a rule is "modify before forward", buffer the full body up to 10MB. >10MB → reject the rule with a clear error. Never silently truncate during a modify path. |
| R4 | **Stream semantics during modify.** `CaptureBodyPreview` uses `LoadIntoBufferAsync` (`L371`) so the stream remains readable. The modify path will *replace* the content; the real consumer downstream sees the new body. Need to ensure no stream is consumed twice. | Always construct a fresh `StringContent`/`ByteArrayContent` with copied headers for the modified body. Existing `SynthesizeErrorResponse` is the template (`L160–173`). |
| R5 | **Race: rule push happens after request started.** A user creates a rule while a request is mid-flight; the rule should affect future requests, not the in-flight one. | Snapshot read in handler is single `Volatile.Read` at request entry. The in-flight request uses its own snapshot. F27 P5 already has this property. |
| R6 | **Breakpoint deadlocks under reconnect.** SignalR disconnects mid-breakpoint → no one will resume. | `MitmCoordinator` registers a cancellation hook on the connection ID. `OnDisconnectedAsync` cancels all pending breakpoints owned by that connection → request proceeds untouched. R1 timeout is a second line of defence. |
| R7 | **Performance: rule eval on every request.** F27 P5 already pays this cost. With richer rules (regex URL match, header ops) the per-request cost grows. | (a) Fast-path: `if (_flatRules.Length == 0 && _interactiveBreakpointsEnabled == false) return base.SendAsync(...)`. (b) Compile regex once at rule creation, cache on the `MitmRule` instance. (c) Order rules so cheap predicates short-circuit first. Same pattern as F24 spec §3.1 (`F24-chaos-engineering/spec.md:124–141`). |
| R8 | **Order of operations between F27 P5 fault store and F28 rules.** What happens if a QA scenario installs a `http_error` for `/Tables` AND the user MITMs a `/Tables` request interactively? | Define explicit precedence: interactive breakpoints win first; then scenario faults; then session rules. Document in P1 design. Single match table in the handler. |
| R9 | **Replay safety.** "Replay this request" with stale credentials, against a real prod-like service, can have side effects (POST/PUT/DELETE). | Replay always shows the method + URL + a confirmation toast for non-idempotent methods. Mark replayed events distinctly (`mitm.action = "replay"`) so users see them in the table. Never auto-replay. |
| R10 | **Frontend rule reconciliation on reconnect.** Rules may have been auto-purged server-side; frontend must re-push or surface "rules expired". | After `signalr-manager.js:79` reconnected event, frontend calls `MitmListRules()`. If empty but local state has rules, frontend pushes them OR (preferable) shows a toast "MITM rules cleared on reconnect — re-arm?". Decision in P1. |
| R11 | **Single HTML build constraint.** Per ADR-003 the studio ships as one HTML. Any new file under `src/frontend/js/` must be picked up by `scripts/build-html.py`. | Verify by adding `request-editor.js` and confirming the build inlines it. No new third-party deps. |
| R12 | **No tests exist for the existing fault store path beyond unit-level**, so F28 expansion is at risk of regressing F27 P5. | Sentinel-gated: every new action type ships with a unit test. The existing `ResetForTesting` hook (`EdogHttpFaultStore.cs:199`) is the template for cleanup between tests. |

---

## §5. Competitive Landscape — Every Tool That Does This

A market survey, not a feature list. The point is to know **exactly** where F28 sits and which tools each F28 user is mentally comparing it to. Tools grouped by category; within each group, ordered by how much they shape the F28 design.

> Note on screenshots: I do not have image attachments, so each entry includes a careful textual description of the UI layout that an engineer who has used the tool will recognise instantly.

### Group A — Interception Proxies (general-purpose MITM)

#### A1. Burp Suite (PortSwigger)

- **What it does:** OS-level HTTP/HTTPS proxy. Pioneered the modern interception model: traffic flows through Burp; the **Proxy → Intercept** tab pauses every matching request for human Forward/Drop/Modify; the **Proxy → HTTP history** tab logs everything. Sister tabs Repeater (replay one request N times), Intruder (fuzz), Sequencer (entropy analysis), Decoder, Comparer, Scanner.
- **Target audience:** Web security testers / pentesters. Has crept into API/QA use because nothing else is as flexible.
- **Pricing:** Community Edition free (no Scanner, slowed Intruder). Professional ~$475/yr/user. Enterprise from ~$8K/yr.
- **Killer feature:** **Repeater + Match-and-Replace rules.** Repeater lets you take any captured request, edit any field, fire it again, and diff the response. Match-and-Replace (Settings → Sessions) applies persistent rewrites to all flowing traffic — "every request, set Header X to Y" — without any rule-builder ceremony.
- **Weakness:** Java Swing UI feels like 2008. Slow startup. Requires browser proxy config + cert install. Free tier intentionally crippled. Not designed for inside-the-app use.
- **UI/UX:** Top tab bar (Proxy, Repeater, Intruder, Scanner…). Inside Proxy: sub-tabs (Intercept, HTTP history, WebSockets history, Options). Intercept view = single-pane raw request with a big "Forward" / "Drop" / "Intercept is on" button row at the top, "Action" dropdown for context actions. History view = sortable table (host, method, URL, params, edited, status, length, MIME type, extension, title, comment, SSL, IP, cookies). Click row → 4-pane detail (Request raw / Request params / Response raw / Response render).

#### A2. Charles Proxy

- **What it does:** Same model as Burp but designed for app developers, not pentesters. Strong emphasis on **Rewrite** (persistent rules) vs. **Breakpoints** (interactive pause). Plus Map Local / Map Remote, Throttle, SSL Proxying allow-list.
- **Target audience:** Mobile + web developers. Big in the iOS dev community for inspecting app traffic.
- **Pricing:** $50 one-time license, 30-day free trial that nags you every 30 minutes.
- **Killer feature:** **Map Local** — point any URL at a file on disk. Edit the file, hit reload, the app sees your edited response. Zero rule ceremony for "what if this endpoint returned X".
- **Weakness:** macOS-first; Windows/Linux builds feel ported. UI is busy. Body editing inside breakpoints is a basic textarea, no JSON tree.
- **UI/UX:** Left tree pane (Structure view — hosts grouped hierarchically) or sequence view (chronological list). Right detail pane with sub-tabs: Overview, Request, Response, Summary, Chart, Notes. Breakpoint window pops up modally with three buttons: Edit Request, Edit Response, Cancel. Rewrite is a separate modal: list of rule sets, each containing locations and operations (add/modify/remove header / response body / etc.).

#### A3. mitmproxy

- **What it does:** Free open-source proxy. Three front-ends: `mitmproxy` (TUI), `mitmweb` (browser UI), `mitmdump` (headless). The whole tool is scriptable in Python — every flow goes through user-supplied hooks.
- **Target audience:** Power users, automation engineers, security researchers, anyone who wants HTTP interception in a CI pipeline.
- **Pricing:** Free, Apache 2.0.
- **Killer feature:** **Addons (Python scripts).** `def request(flow): flow.request.headers["X-Foo"] = "bar"`. Combine with filter language `~m POST & ~u onelake & ~s 500` to scope precisely. Anything a UI tool does can be expressed as 5 lines of Python here.
- **Weakness:** No GUI polish. Web UI is functional but spartan. Steep learning curve for the filter DSL. No native breakpoint UI in the TUI — you script it.
- **UI/UX:** TUI: vim-like keybindings, single flow list with `?` for help, `e` to edit, `r` to replay, `:` for command mode. mitmweb: three-pane web UI (flow list left, request/response detail right, command bar bottom). Black-and-white aesthetic. Filter expression bar at the top — type `~u /api/users` to filter.

#### A4. Fiddler (Telerik / Progress) — Classic + Everywhere

- **What it does:** The original Windows HTTP debugger. **Fiddler Classic** = free Windows-only legacy tool. **Fiddler Everywhere** = Electron rewrite, cross-platform, freemium. **AutoResponder** rules (URL match → local file / status / latency) and **Composer** (build a request from scratch) are the two flagship features.
- **Target audience:** Windows .NET devs (historically), QA, API testers. Microsoft-adjacent engineers in particular.
- **Pricing:** Fiddler Classic free. Fiddler Everywhere ~$12/user/month after trial; free tier has limits on sessions and rules.
- **Killer feature:** **AutoResponder** — drag a response into the AutoResponder tab, define a URL match, and from now on that URL is served by the canned response. Disk-backed, shareable as `.saz` files (Session Archive Zip).
- **Weakness:** Classic is unmaintained. Everywhere is Electron-heavy and the freemium model is annoying (5-rule limit by default). UI is dated even in Everywhere.
- **UI/UX:** Left pane = session list (numbered, with result/protocol/host/URL/body size/caching/process columns). Right pane = sub-tabs (Statistics, Inspectors, AutoResponder, Composer, Fiddler Script, Filters, Timeline). Inspectors has sub-sub-tabs (Headers, TextView, SyntaxView, WebForms, HexView, Raw, JSON, XML…). Composer is a tabbed request builder almost identical to Postman.

#### A5. Proxyman (macOS, iOS, Windows, Linux)

- **What it does:** Modern Charles/Fiddler competitor. Native-feeling proxy with first-class breakpoints, map local/remote, rewrite rules, scripting (JavaScript), Atlassian integration, and *significantly better UX* than the older players.
- **Target audience:** macOS-first mobile and API developers. Has grown into the dominant choice for new iOS devs.
- **Pricing:** Free tier (limited rules, throttled SSL after 10 min). Personal $49/yr, Team from $59/seat/yr, one-time license $99.
- **Killer feature:** **Atlas** — built-in Postman-style API client + scenarios + assertions wired into the proxy. You can capture a request, mutate it, save as a scenario, and run scenarios in batch. Closest competitor's "MITM ↔ API client ↔ test runner" loop.
- **Weakness:** Premium gating on long sessions. JavaScript scripting is more limited than mitmproxy's Python.
- **UI/UX:** Native macOS three-pane: source list (hosts/domains hierarchical), session list (middle), detail (right) with sub-tabs Overview / Headers / Body / Original / Edited / Notes. Light + dark themes that actually look polished. Breakpoint inspector is a modal sheet with side-by-side Original vs. Edited columns and an "Execute" / "Abort" button row.

#### A6. HTTP Toolkit

- **What it does:** Free open-core proxy with the cleanest first-run experience in the category. One-click intercept of any browser/process (no manual cert install). Built around an event log with inline filtering and a per-row "Mock this" action.
- **Target audience:** Web/API developers who want zero-config interception. Modern stack (Electron + React).
- **Pricing:** Free open-source core. Pro $7/month or $77/year — unlocks mock rules, custom certs, request rewriting, automated tests.
- **Killer feature:** **One-click intercept buttons** for specific clients on the home screen — "Intercept Chrome", "Intercept Electron app", "Intercept Android device". No proxy config, no cert dance. Just click → that target's traffic appears in the log.
- **Weakness:** Newer/smaller than Burp/Charles. Mocking and rewriting are paid-only. Electron memory footprint.
- **UI/UX:** Three primary views — Intercept (a launchpad of "click me to intercept X" tiles), View (event log with filter bar + detail panel), Mock (rule list + editor). View detail uses a "stages" timeline (Request sent → Response received → Response completed) with editable inline JSON. Mock editor has predicate + action sections; actions include "Pause the request" (breakpoint), "Return fixed response", "Forward to different host", "Timeout", "Close connection".

#### A7. Requestly

- **What it does:** Browser-extension-first traffic modifier. Doesn't require a proxy — installs as a Chrome/Firefox/Edge/Safari extension and uses devtools APIs (or its desktop app for full HTTP). Rule types: Redirect, Cancel, Replace, Headers, User-Agent, Query Params, Insert Script, Modify Response, Delay, Map Local.
- **Target audience:** Web developers who want lightweight per-tab interception without OS-level proxy. Strong frontend dev mindshare.
- **Pricing:** Free tier with limited rules. Pro $9.99/user/month. Team plans. Open-sourced the core engine in 2023.
- **Killer feature:** **Shared rule libraries via team workspaces.** Your team's "redirect prod API to staging" rule is one click for every new joiner. Sync via cloud account.
- **Weakness:** Browser-extension model can't intercept native apps; the desktop proxy is newer and less mature. Some rule types are paid-only.
- **UI/UX:** Web-app-style left rail (Rules, Mock Server, Sessions, Test Reports). Rule list with toggle switches. Rule editor is a single-page form per rule type with predicate fields at the top (URL contains/matches/regex) and action fields below. Mock Server view = endpoint table with method/path/status/delay/body columns.

#### A8. Whistle

- **What it does:** Cross-platform Node.js HTTP debugging proxy. Web UI at `localhost:8899`. Famous in Chinese frontend communities; less well-known in the West.
- **Target audience:** Frontend devs (especially mobile-web). Heavy use in WeChat ecosystem development.
- **Pricing:** Free, MIT-licensed.
- **Killer feature:** **Pattern-rule DSL in a single text file** — `pattern operator value` lines, e.g. `^api.foo.com/users file:///mocks/users.json` redirects every matching URL to a local file. Hot-reload on save.
- **Weakness:** Documentation primarily in Chinese; English docs lag. Visual UI for rules is afterthought to the text DSL.
- **UI/UX:** Browser-based UI. Top nav: Network, Rules, Values, Plugins, Settings, Weinre. Network = HAR-style log. Rules = monospace text editor where you write rule lines; left sidebar lists rule sets you can toggle.

### Group B — Browser DevTools (built-in interception)

#### B1. Chrome DevTools — Network tab + Local Overrides + Response Override

- **What it does:** Same-process inspection of browser HTTP. Three relevant features for F28: **Network Request Blocking** (right-click → block URL/domain → red-badged blocked rows), **Local Overrides** (Sources → Overrides → enable a local folder; right-click any response → Save for overrides → edits to the local file are served on subsequent loads), **Override headers** (in the Network → Headers tab, click "Override headers" → edit any request/response header → persists across reloads).
- **Target audience:** Web developers. Universal — every web dev uses some subset.
- **Pricing:** Free, ships with Chrome.
- **Killer feature:** **Right-click on a row.** Block / Replay XHR / Copy as cURL / Copy as fetch / Copy as PowerShell / Copy response / Override headers / Save for overrides — every important action is one menu click from any row. Zero context switch.
- **Weakness:** Only sees what the page makes. Overrides require enabling a folder and remembering it's enabled. No first-class breakpoint UI ("pause this request"). Throttling is preset profiles only.
- **UI/UX:** Top filter bar (search, Invert, Hide data URLs, request-type pills All/Fetch/XHR/JS/CSS/Img/Media/Font/Doc/WS/Wasm/Manifest/Other, Has-blocked-cookies, Blocked-requests, 3rd-party, throttling dropdown). Table columns user-configurable (Name, Status, Type, Initiator, Size, Time, Waterfall). Detail panel sub-tabs Headers / Payload / Preview / Response / Initiator / Timing / Cookies. Network conditions drawer for throttling.

#### B2. Firefox DevTools — Network monitor

- **What it does:** Mostly parity with Chrome's network tab. Differences: clearer "Edit and Resend" feature (the equivalent of Burp's Repeater built into the browser), better large-response handling, no native equivalent of Local Overrides (until recent versions added basic blocking).
- **Target audience:** Web developers, especially those on Firefox.
- **Pricing:** Free.
- **Killer feature:** **Edit and Resend** — right-click any request, edit method/URL/headers/body in a side panel, hit Send. New request appears in the list with the edits. The closest DevTools experience to F28's Replay-with-edits.
- **Weakness:** No response override / local overrides equivalent of Chrome's full power.
- **UI/UX:** Very similar to Chrome — top filter, request-type pills, sortable table, detail panel with Headers/Cookies/Request/Response/Timings/Stack Trace/Security. Edit and Resend opens a sidebar panel with editable fields and a Send button — does not block the main flow.

#### B3. Safari Web Inspector — Network tab

- **What it does:** Apple's DevTools. Network tab + local overrides (since macOS 13.3 / Safari 16.4). Less feature-rich than Chrome but improving.
- **Target audience:** macOS/iOS web developers, especially WebKit-targeted work.
- **Pricing:** Free.
- **Killer feature:** **iOS device remote inspection** — connect an iOS device via cable, debug its Safari traffic from the Mac. The only way to truly inspect Safari-on-iOS HTTP.
- **Weakness:** Lags Chrome in features. Mac-only.
- **UI/UX:** Tabbed DevTools like Chrome. Network table → detail with Headers/Cookies/Sizes/Timing/Security/Preview/Response sub-tabs. Local overrides UI is minimal compared to Chrome's.

### Group C — API Clients with Interception Capabilities

#### C1. Postman / Postman Interceptor

- **What it does:** API request composer (the original — Newman, environments, collections). Postman Interceptor is a browser extension that captures the browser's HTTP into Postman's History.
- **Target audience:** API developers, QA, technical writers, anyone hand-crafting API requests.
- **Pricing:** Free tier (limited collection runs, collaborators). Team $14/user/month, Business $29, Enterprise $49+.
- **Killer feature:** **Collections + Environments + Newman.** A captured/edited request is one save away from being a parameterized test that runs in CI. Best collection-management UX in the industry.
- **Weakness:** Heavyweight (Electron + cloud sync). Forced cloud account. Privacy-conscious teams have left in droves since the local-scratchpad-removal incident (2023).
- **UI/UX:** Left sidebar (Collections / Environments / Mock Servers / History / APIs). Center pane = tabbed request editor (method pill, URL bar, Params/Authorization/Headers/Body/Pre-request Script/Tests/Settings/Cookies tabs). Right pane = response viewer with status, time, size, sub-tabs Body/Cookies/Headers/Test Results.

#### C2. Insomnia

- **What it does:** Postman alternative. REST/GraphQL/gRPC client with a leaner UX and stronger plugin model. Owned by Kong since 2019.
- **Target audience:** API devs who find Postman too heavy. Strong open-source community.
- **Pricing:** Free for individual local use. Cloud sync paid ($5/user/month and up).
- **Killer feature:** **GraphQL support** — the schema explorer, autocomplete, and variable handling beat Postman's GraphQL UX.
- **Weakness:** Smaller ecosystem than Postman. Plugin API is JavaScript-only.
- **UI/UX:** Three-pane — request list (left), tabbed editor (center), response viewer (right). Cleaner default theme than Postman; less ceremony to send a request.

#### C3. Hoppscotch

- **What it does:** Browser-based open-source API client. Was "Postwoman". Real-time collaboration, WebSocket / SSE / MQTT / GraphQL / gRPC support. Self-hostable.
- **Target audience:** Developers who want Postman in a tab. Big in the open-source / self-host crowd.
- **Pricing:** Free open-source. Hoppscotch Cloud has paid tiers.
- **Killer feature:** **Browser-native, zero-install** — you can paste a Hoppscotch URL into Slack and a teammate has the exact request loaded in their browser in one click.
- **Weakness:** Limited compared to Postman/Insomnia for complex auth flows. No native breakpoint/proxy capabilities.
- **UI/UX:** Single-page app with left rail (REST, GraphQL, Realtime, Documentation, Settings). Center = method/URL bar + tabbed editor (Parameters, Body, Headers, Authorization, Pre-Request Script, Tests). Right = response panel.

#### C4. Bruno

- **What it does:** Newer open-source Postman alternative. Local-first, no account, requests stored as plain text files in your git repo. Strong privacy positioning.
- **Target audience:** Devs burned by Postman's cloud pivot.
- **Pricing:** Free MIT for desktop app. Paid Bruno Cloud and Golden Edition (enterprise features).
- **Killer feature:** **Git-friendly storage** — requests are `.bru` text files. Diff them. Code review them. Branch them.
- **Weakness:** Younger; smaller plugin ecosystem.
- **UI/UX:** Similar three-pane to Insomnia. Collections appear as folder trees mapped to disk.

### Group D — Programmatic Mocking & Test-Time Interception

#### D1. WireMock (Java) and WireMock Cloud

- **What it does:** Standalone HTTP server. Stubs request → response mappings. Stateful "scenarios" (request N returns 503, request N+1 returns 200). Recording mode (proxy through, capture, save).
- **Target audience:** Backend test engineers, contract testers, integration test authors.
- **Pricing:** OSS free. WireMock Cloud SaaS from $159/month for teams.
- **Killer feature:** **Rich request matcher.** URL regex + method + headers (equalTo / matches / contains / absent) + query params + body (json-path / regex / equal-to-json with ignore-array-order). The most expressive matcher in the industry.
- **Weakness:** Java tooling — heavy for non-Java teams. The standalone JAR is ~30 MB. UI/admin is functional, not pretty.
- **UI/UX:** WireMock Cloud has a Postman-ish web UI: collection of mappings, each editable as form OR JSON. Local OSS is API-driven (POST mappings to `/__admin/mappings`) with a basic web admin.

#### D2. MockServer

- **What it does:** WireMock competitor — Java + JS clients, expectations API, verification API, proxy mode.
- **Target audience:** Same as WireMock — backend test engineers.
- **Pricing:** Free, Apache 2.0.
- **Killer feature:** **Verification API** — your test asserts "MockServer received a POST to /foo with body containing 'bar' exactly 3 times". Stronger spy/mock semantics than WireMock.
- **Weakness:** Less polished docs, smaller community than WireMock.
- **UI/UX:** UI is afterthought; tool is API-driven.

#### D3. Mock Service Worker (MSW)

- **What it does:** Runs inside the browser as a service worker (or in Node via interceptors). Intercepts `fetch` / `XHR` calls at the network layer; tests / dev environments see mocked responses **without ever knowing they're mocked**. The mock definitions are code, colocated with the app.
- **Target audience:** Frontend devs, especially React/Vue/Svelte teams using Jest/Vitest/Playwright. Has become the de facto standard for frontend HTTP mocking.
- **Pricing:** Free MIT.
- **Killer feature:** **Same mocks in tests, dev server, and Storybook.** You write `http.get('/api/users', () => HttpResponse.json([...]))` once and it works in every context.
- **Weakness:** Service worker scope limits (no cross-origin without setup). Browser-only for fetch; Node setup is separate.
- **UI/UX:** No UI — it's a library. Optional `msw devtools` browser extension shows intercepted requests.

#### D4. Cypress `cy.intercept()`

- **What it does:** In-process interception inside the Cypress test runner. Declares mocks/spies/modifications inline in tests.
- **Target audience:** Frontend E2E testers using Cypress.
- **Pricing:** Free OSS. Cypress Cloud (record/replay) is paid.
- **Killer feature:** **One function for observe + stub + modify.** `cy.intercept(url, (req) => { req.continue(res => res.body.x = 1) })`. The cleanest modify-and-forward API in any tool, anywhere.
- **Weakness:** Cypress-only. Tied to the Cypress test lifecycle.
- **UI/UX:** Code-only. Cypress Test Runner UI shows intercepted requests in the command log with click-to-inspect.

#### D5. Playwright `page.route()` / `browserContext.route()`

- **What it does:** In-process interception inside Playwright tests. `await page.route('**/api/users', route => route.fulfill({...}))`. Supports `route.continue({modifications})` and `route.abort()`.
- **Target audience:** Cross-browser E2E testers using Playwright. Microsoft-shop favourite.
- **Pricing:** Free OSS.
- **Killer feature:** **HAR record/replay** — `await page.routeFromHAR(harPath)` plays back a HAR file so tests run offline. Plus `recordHar` capture. The whole record→replay loop ships out of the box.
- **Weakness:** Playwright-only. Routing is per-page or per-context; no global "intercept all browser traffic" mode.
- **UI/UX:** Code-only. Playwright Inspector and Trace Viewer show intercepted calls in the trace timeline.

#### D6. Pact / Pactflow

- **What it does:** Consumer-driven contract testing. Not interception per se — but lives in the same space because Pact mocks providers during consumer tests and verifies expectations against the real provider later.
- **Target audience:** Teams doing microservice contract testing.
- **Pricing:** OSS Pact free. Pactflow SaaS from $250/month.
- **Killer feature:** **Bidirectional contracts** — generate Pact contracts from OpenAPI specs without writing consumer tests.
- **Weakness:** Different mental model from "interception". Steeper onboarding.
- **UI/UX:** Pactflow UI is a contract registry — broker showing consumer/provider matrices, contract versions, verification status.

#### D7. Nock (Node.js)

- **What it does:** Library that intercepts `http`/`https` module calls in Node tests. `nock('https://api.example.com').get('/users').reply(200, [...])`.
- **Target audience:** Node.js backend test authors.
- **Pricing:** Free MIT.
- **Killer feature:** **Recording mode** — `nock.recorder.rec()` captures real traffic, prints a `nock(...)` script for each call. Paste into tests, done.
- **Weakness:** Node-only. Doesn't intercept `fetch` in Node 18+ without extra setup.
- **UI/UX:** Code-only.

#### D8. Mockoon

- **What it does:** Desktop GUI for designing mock API servers. Visual route editor (method, path, response status, headers, body templating). Runs the mock locally; export OpenAPI.
- **Target audience:** Frontend devs who want quick mock servers without writing code; QA prototyping.
- **Pricing:** Free OSS desktop. Mockoon Cloud paid sync.
- **Killer feature:** **Visual mock authoring + Faker.js templating** — `{{faker 'name.findName'}}` in response bodies for realistic dummy data.
- **Weakness:** Mocks only; no interception of real traffic.
- **UI/UX:** Three-pane desktop app — environment list, route list per environment, route editor with status/headers/body tabs. Start/stop a green "play" button per environment.

#### D9. Beeceptor

- **What it does:** Cloud mock endpoint service. Sign up → get a hostname → define rules visually → integrate. Plus inspection mode (your real endpoint proxied through Beeceptor with logging).
- **Target audience:** Devs who need a public mock URL quickly (no localhost tunneling).
- **Pricing:** Free tier (50 requests/day). Paid from $10/month.
- **Killer feature:** **Public mock URLs in 30 seconds** — no install. Share the URL with mobile/embedded developers who can't run a local proxy.
- **Weakness:** Cloud-only; limited customisation.
- **UI/UX:** Web app. Endpoints list, per-endpoint rule list (path match + method + response), recent-traffic log, share-link button.

### Group E — Specialised / Adjacent

#### E1. Telerik JustMock / Moq / NSubstitute (.NET mocking libraries)

- **What it does:** In-process mocking of .NET interfaces. Not HTTP-specific but used heavily to mock `HttpClient` via `IHttpClientFactory` indirection or `HttpMessageHandler` substitutes.
- **Target audience:** .NET unit test authors.
- **Pricing:** Moq/NSubstitute free OSS. JustMock paid.
- **Killer feature:** **`Mock.Of<HttpMessageHandler>()` + protected setup** — the .NET-native way to fake HTTP in tests.
- **Weakness:** Test-time only; no runtime interception of a live process. F28 exists exactly because these are insufficient for the FLT runtime debugging case.
- **UI/UX:** Code-only.

#### E2. Stoplight Prism

- **What it does:** Generate a mock server from an OpenAPI / Swagger spec automatically. Validation, dynamic example generation, contract verification.
- **Target audience:** API-design-first teams.
- **Pricing:** OSS free, Stoplight Platform paid.
- **Killer feature:** **OpenAPI → live mock in one command.** `prism mock spec.yaml` and you have a server that validates and responds to every operation.
- **Weakness:** Spec-driven; not for ad-hoc interception.
- **UI/UX:** CLI primary. Stoplight Studio is the visual companion for editing OpenAPI specs.

#### E3. Ngrok + ngrok inspect

- **What it does:** Reverse tunnel for exposing localhost. Not interception, but the inspect interface at `localhost:4040` shows every request that flowed through and lets you **Replay** any of them.
- **Target audience:** Webhook developers, demo presenters, integration testers.
- **Pricing:** Free tier with limits. Paid from $8/month.
- **Killer feature:** **One-click public URL + traffic inspector with replay.** Perfect for webhook debugging — Stripe sends an event → you see it in ngrok inspect → click Replay → re-fire it during local debugging.
- **Weakness:** Free tier rate-limits and random URLs. Replay only; no modification.
- **UI/UX:** Local web UI at `localhost:4040`. Left list of requests, right detail panel with Summary / Headers / Raw. Big green "Replay" button.

#### E4. Telepresence (Ambassador Labs)

- **What it does:** Connects your laptop's local process to a remote Kubernetes cluster as if it were a pod. Two-way network traffic. Intercept a service in the cluster and route its traffic to your local dev process.
- **Target audience:** Kubernetes microservice devs.
- **Pricing:** OSS free. Ambassador Cloud paid.
- **Killer feature:** **Personal traffic intercepts** — route only YOUR requests (tagged with a header) to your local dev pod; everyone else's traffic continues to prod. Reviewing PRs becomes a live debug session.
- **Weakness:** Kubernetes-only.
- **UI/UX:** CLI primary. Cloud UI for managing intercepts.

#### E5. Lightrun

- **What it does:** Production-debug observability. Insert "dynamic logs" / "dynamic breakpoints" into a running JVM/Node/Python/.NET process without redeploy. The breakpoint doesn't pause execution; it captures a snapshot and sends it to the IDE.
- **Target audience:** Backend / production engineers debugging live services.
- **Pricing:** Paid; enterprise pricing.
- **Killer feature:** **Non-breaking breakpoints in production** — add a "snapshot" that fires once and ships variable state to your IDE. Closest commercial analog to F28's "intercept inside the process" position.
- **Weakness:** Not HTTP-specific; not interception, just observation. Expensive.
- **UI/UX:** IDE plugins (IntelliJ, VS Code). Right-click line → Add Snapshot. Snapshots appear in the IDE log panel with full variable trees.

#### E6. Rookout (now Dynatrace LiveDebugger)

- **What it does:** Same model as Lightrun — production snapshots without pausing. Acquired by Dynatrace in 2023.
- **Target audience:** Same as Lightrun.
- **Pricing:** Bundled into Dynatrace.
- **Killer feature:** **Snapshots route to multiple sinks** — IDE, Slack, Sentry, your own webhook. Production debugging as data flow.
- **Weakness:** Enterprise sales motion.

#### E7. Otterize, Speedscale, Speedscope (traffic-replay platforms)

- **What it does:** Record production traffic, replay it against staging / new builds for performance and regression testing. Speedscale is the leader here.
- **Target audience:** SRE, performance engineering teams.
- **Pricing:** Enterprise paid.
- **Killer feature:** **Record-and-replay at production scale.** "Capture 10 minutes of real traffic, replay it against the new build, diff the responses."
- **Weakness:** Heavyweight platform; not interactive debugging.
- **UI/UX:** Web app dashboards.

#### E8. mockttp / @mock-server/node (libraries)

- **What it does:** Programmable in-process HTTP mocking for Node test code. mockttp is the engine behind HTTP Toolkit.
- **Target audience:** Node integration testers.
- **Pricing:** Free.
- **Killer feature:** **Same engine in standalone GUI (HTTP Toolkit) and library form** — your code-level mocks and your interactive sessions can share configuration.
- **Weakness:** Node-only.

#### E9. Toxiproxy

- **What it does:** TCP-level chaos proxy. Inject latency, bandwidth limits, slow_close, timeout, connection limits. Not HTTP-aware — operates one layer down.
- **Target audience:** Resilience / chaos engineers.
- **Pricing:** Free OSS (Shopify).
- **Killer feature:** **TCP-level fault injection that doesn't care about protocol.** Works for HTTP, gRPC, databases, anything.
- **Weakness:** No HTTP semantic awareness — can't say "fail this URL" or "modify this header".
- **UI/UX:** CLI + HTTP admin API. No GUI.

#### E10. Envoy / Istio fault injection

- **What it does:** Service-mesh-level fault injection. Inject delays and aborts at the sidecar layer for matching requests.
- **Target audience:** Kubernetes / service-mesh users.
- **Pricing:** Free OSS; managed offerings paid.
- **Killer feature:** **Cluster-wide chaos by routing rule** — VirtualService config injects 5% 503s on every pod, no app changes.
- **Weakness:** Requires mesh adoption. Configuration verbose.
- **UI/UX:** YAML / CLI / mesh dashboards.

#### E11. Chrome's "Network conditions" — request blocking + override headers (mention again, granular)

Already covered in B1 but worth flagging the lesser-known features:
- **"Override headers" per response** — right-click a response → Override headers, edits persist to disk in the overrides folder.
- **Search across all responses** — Ctrl-F in the Network tab searches request and response bodies. Useful for "find every response that mentions 'rowCount: 0'".

#### E12. SoapUI / ReadyAPI

- **What it does:** Legacy SOAP/REST API testing, now Smartbear ReadyAPI. Has a built-in mock service mode.
- **Target audience:** Enterprise testers, especially SOAP-era.
- **Pricing:** Free SoapUI OSS. ReadyAPI paid.
- **Killer feature:** **Heavy XML/SOAP support** that nothing modern matches.
- **Weakness:** UI feels late-2000s.
- **UI/UX:** Eclipse-style desktop app, project tree on left, multi-tab editor on right.

#### E13. Karate

- **What it does:** Cucumber-style API test DSL. Includes a built-in mock server.
- **Target audience:** QA writing BDD-style API tests.
- **Pricing:** Free OSS, Karate Labs commercial offering.
- **Killer feature:** **One DSL for tests + mocks + perf.** Mock servers defined in the same Gherkin-ish syntax as the tests.
- **Weakness:** Java tooling baggage.

### Group F — Honorable mentions (briefly)

- **HTTPie Desktop** — modern API client, gorgeous UI, mostly composer + history. No interception yet.
- **Yaak** — open-source desktop API client by the original Insomnia author. Local-first.
- **Bloomrpc** — gRPC client. Like Postman for gRPC.
- **grpcurl + grpcui** — gRPC inspection tools.
- **Microcks** — Open-source contract testing + mocking platform. Imports Postman / OpenAPI / AsyncAPI.
- **Karate Netty** — Karate's mock netty subsystem.
- **Stripe CLI `stripe listen` + `stripe trigger`** — domain-specific (webhooks), but the replay model is gold.
- **Smee.io (GitHub)** — public webhook forwarder + inspect/replay. Like ngrok but free + simpler.
- **Sniffnet, Wireshark, tcpdump** — packet-level inspection. Outside F28's scope (we're application-layer) but worth knowing the layer below.

### 5.2 Market Synthesis — Where F28 Sits

| Category | Examples | F28's relationship |
|---|---|---|
| External OS-level proxies | Burp, Charles, Proxyman, Fiddler, mitmproxy, HTTP Toolkit | F28 borrows interaction model (intercept toggle, breakpoint, repeater) but operates **inside** the .NET process, so no cert install / no proxy config / no traffic egress complexity. |
| Browser DevTools | Chrome / Firefox / Safari Network tab | F28 mirrors the right-click-row UX and the inline detail panel. Crucially, FLT runs server-side, so DevTools are not an option — F28 fills that exact gap. |
| API clients | Postman, Insomnia, Hoppscotch, Bruno | F28 reuses the `RequestBuilder` UI (already in `api-playground.js`) for Replay-with-edits. F28 is not trying to be a general API client — it is "Replay this captured FLT request". |
| Programmatic mocks | WireMock, MockServer, Prism, Mockoon | F28 borrows the rich matcher model (URL regex + header ops + body json-path) but exposes it through interactive UI, not config files. |
| Test-time interception | Cypress, Playwright, MSW, Nock | F28 is *runtime* not *test-time* — it intercepts a live FLT process. The Phase-2 "convert MITM session to QA scenario" idea bridges to this category. |
| Browser-extension modifiers | Requestly | Different audience; not a competitor for FLT-runtime use. |
| Production observability | Lightrun, Rookout, Dynatrace LiveDebugger | Closest in *philosophy* — in-process, non-disruptive. But none of them are HTTP-MITM-shaped, and none have FLT-specific context. |
| Service-mesh / chaos | Envoy fault injection, Toxiproxy, Chaos Mesh | Different scope — infrastructure-level. F28 plus F24 occupy the application-level chaos space. |
| Traffic record/replay | Speedscale, Playwright HAR record | F28 captures the same HAR-compatible stream; record/replay at scale is a Phase 2 / F24 concern. |

**The crucial differentiator:** **None of the 50+ tools above run inside the application process.** They are all either external proxies (need cert + proxy config), test-runner-coupled (only work during a test run), or library mocks (test-time only). F28's seat — inside the FLT .NET process with access to the DI container, feature flags, retry context, token state, DAG context, and Nexus graph — is genuinely unoccupied.

---

## §6. "Crazy Wow" Extension Ideas

The premise: every idea below is **impossible for an external proxy** because it needs the EDOG-in-process position. Each idea is named, scoped, and graded for technical feasibility against the code mapped in §1. Ideas are ordered by ratio of impact to effort.

> Reading order: §6.1–§6.5 are the "must build to win" Tier-1 ideas. §6.6–§6.12 are the "would melt an FLT engineer's brain" Tier-2. §6.13+ are seed ideas worth keeping in the design backlog.

### Tier 1 — Build these for v1 to be transformative

#### §6.1 — **Causal Replay**

- **One-liner:** Click any failed request in the HTTP tab → instantly see the full causal chain that led to it (which DAG node, which retry attempt, which feature flag was active, which token was used, which Nexus dependency triggered it) → mutate any one variable → replay through the same pipeline.
- **Why it's wow:** External proxies see HTTP in isolation. They have no idea this `GET /Tables` is retry attempt 3 of OneLake-list-call during node "Bronze_Sales" of DAG iteration #4271 with feature flag `EnableV2Catalog=true`. F28 has access to all of it via topic correlation — `log`, `retry`, `flag`, `token`, `dag`, `nexus` topics are all keyed on the same `correlationId`.
- **Technical feasibility:** **High.** All upstream events already flow through `EdogTopicRouter` keyed by `correlationId`. We need (a) a server-side correlation join that, on request, builds a causal-chain payload for a given HTTP event; (b) UI to render it as a vertical timeline next to the request detail; (c) per-variable "what if" overrides — toggle flag false, swap token to expired, change retry count to 0 — and replay.
- **Effort:** Large. The replay-with-mutated-context plumbing is the hard part; the UI and correlation lookup are medium.

#### §6.2 — **Stateful Breakpoint Conditions**

- **One-liner:** Breakpoint conditions aren't just URL/method/header — they include FLT's *internal state*. "Break on this request only if the retry count > 2 AND the active token expires in < 30s AND feature flag X is enabled AND the current DAG node is Bronze_*."
- **Why it's wow:** mitmproxy can break on "URL contains foo". Charles can break on method+path. None can break on "retry count > 2 because Polly is in the middle of an exponential backoff". F28 sees the retry topic events (`src/backend/DevMode/EdogTopicRouter.cs:35`), the flag topic, the token topic — they are all readable from inside the handler.
- **Technical feasibility:** **High.** The condition language is the work. Reuse the rule-predicate shape from `chaos-mitm-capabilities.md:42–113`. Add a `Condition` block referring to ambient state: `state.retryCountForCorrelationId > 2`, `state.flag('EnableV2Catalog') == true`, `state.activeTokenExpiresIn < 30s`, `state.dagNodeName matches 'Bronze_.*'`. The MitmCoordinator already has the per-request context.
- **Effort:** Medium for the v1 expression set (probably 6–8 state accessors). Large for a full DSL.

#### §6.3 — **MITM-to-Scenario Recorder ("Save this session as a QA test")**

- **One-liner:** Hit Record → do interactive MITM → click Stop → EDOG auto-generates a complete `QaScenarioSubmission` that reproduces what you just did against the same FLT iteration. Run it from the QA panel and your interactive session is now a regression test.
- **Why it's wow:** Every other tool's record/replay is "save HTTP traffic, replay HTTP traffic". F28's record/replay would be "save the *intent* — block this, modify that, expect this assertion — and replay through the QA scenario engine that already exists (`EdogQaExecutionEngine`, `QaSubmitCuratedScenarios` at `EdogPlaygroundHub.cs:639`)".
- **Technical feasibility:** **High.** F27 already has the scenario submission RPC and the scenario→chaos→fault-store pipeline (`ChaosIntegration.ApplyChaosRuleAsync` at `EdogQaExecutionEngine.cs:1450`). F28's MITM rules ARE chaos rules in a different owner-bucket. The transform is one function: convert MITM session log → `QaScenarioSubmission` payload.
- **Effort:** Medium. The data is all there; building the transform + UI export button + "open in QA panel" deep link is mostly glue.

#### §6.4 — **Time-Travel Response Forgery**

- **One-liner:** Right-click a previously-captured response in the HTTP tab → "Use as forgery template for future matching requests". The forgery rule auto-populates with the captured response, but every field is editable. Combine with §6.1 — re-fire the original request, this time with the modified response forged in.
- **Why it's wow:** Most tools make you hand-craft forged responses. F28 lets you forge from *yesterday's real response*. "Make every Spark status call return what it returned at 14:22:03 yesterday" — useful for reproducing intermittent bugs.
- **Technical feasibility:** **Very high.** The `http` topic ring buffer already retains 2000 events. The forgery action already exists (`SynthesizeErrorResponse` at `EdogHttpPipelineHandler.cs:160–173`). UI work is a "Use as template" context-menu item that pre-fills the rule editor.
- **Effort:** Small.

#### §6.5 — **AI-Assisted Failure Response Generation**

- **One-liner:** In the Forge editor, click "✦ Generate failure response" → an LLM proposes 3–5 realistic failure variants tailored to the endpoint + request (proper Microsoft Fabric error code shape, plausible inner error message, correct `x-ms-error-code` header, valid JSON schema). One click to use.
- **Why it's wow:** Hand-crafting realistic Microsoft Fabric error responses is annoying. Engineers either return a generic `{"error":"oops"}` (unrealistic) or copy-paste from production logs (slow). The LLM knows the shape because it can be primed on the captured request URL, method, and a handful of historical responses.
- **Technical feasibility:** **Medium.** EDOG already has LLM calls in the QA path (the F27 code-analysis pipeline calls an LLM). Reuse the same client. Prompt with: endpoint, captured headers, sample of last 5 responses to similar URLs, target HTTP status. Output: JSON body + headers patch.
- **Effort:** Medium. Mostly prompt engineering + the UX surface.

### Tier 2 — These would make engineers say "how is this possible"

#### §6.6 — **Dependency Graph Heatmap**

- **One-liner:** Open the Nexus dependency graph view → every node is colour-coded by HTTP volume / failure rate / p99 latency from the live `http` topic stream. Click a hot node → see the exact HTTP calls it has made in the last N seconds.
- **Why it's wow:** External tools cannot map HTTP calls to internal dependency-graph nodes because they don't know the graph exists. EDOG has the Nexus topic (`EdogTopicRouter.cs:43`) — `RegisterTopic("nexus", 100)` — and the HTTP topic, and can join them by correlationId / DI scope.
- **Technical feasibility:** **Medium.** The Nexus topic already publishes snapshots. The join is by correlationId. Heatmap render is a new view, not a tab extension.
- **Effort:** Large (new view), but each piece exists.

#### §6.7 — **Token Lifecycle Visualizer + Forced Expiry**

- **One-liner:** In any paused request's Intercept tab, see the full token lifecycle: when this token was acquired, its `aud`, `iat`, `exp`, how many requests have used it, what would happen if it expired right now. One button: "Force this token to be treated as expired" — replay the request with an expired-token simulation.
- **Why it's wow:** Token-refresh bugs are notoriously hard to reproduce because tokens last an hour and you can't wait an hour during testing. F28 sees both the token topic AND the HTTP topic, and the EdogTokenInterceptor already classifies tokens (`F24 interceptor-audit.md:46–54`). Forge an expired-token response upstream OR fake `exp` in headers downstream.
- **Technical feasibility:** **High.** Token metadata is captured (`tokenType`, `audience`, `expiryUtc`, `issuedUtc`). The visualizer is UI; "force expired" maps to a Forge action with status 401 and a Microsoft `expired_token` claim payload.
- **Effort:** Medium.

#### §6.8 — **Retry Storm Detector + Suppressor**

- **One-liner:** When EDOG detects N retries for the same logical call in M seconds (from the `retry` topic), the HTTP tab raises a red bar: "Retry storm detected: 12 retries in 4s for OneLake-list. Click to suppress." Suppressing it auto-installs a temporary MITM rule that fails further attempts immediately so the human can investigate without the storm flooding the tab.
- **Why it's wow:** No external proxy sees the retry context — to them, every retry looks like a fresh request from a different `HttpClient` instance. EDOG sees the Polly retry topic and can correlate.
- **Technical feasibility:** **High.** Retry topic exists (`EdogTopicRouter.cs:35`). Detection is a sliding-window count. Suppression is an auto-generated MITM rule with a 30s TTL.
- **Effort:** Small for the detector. Medium for the suppress action.

#### §6.9 — **Differential Replay ("What changed between these two runs?")**

- **One-liner:** Run an FLT iteration. Capture all HTTP. Make a code change. Run again. F28 shows a unified diff at the HTTP-call level: which calls disappeared, which appeared, which had different parameters, which had different responses, ordered by similarity. Plus retry-count diff, latency diff, status diff.
- **Why it's wow:** "Did my change break OneLake calls?" is currently answered by reading logs. F28 turns it into a visual diff. Same idea as Burp Comparer but at the workflow level, not the request level.
- **Technical feasibility:** **Medium.** Capture is two HAR exports (already supported via `_exportAs('har')` at `tab-http.js:1213`). Diff is a similarity-keyed alignment (URL+method as primary key, body-hash as secondary). UI is a side-by-side waterfall.
- **Effort:** Medium.

#### §6.10 — **DI-Container-Aware Targeting**

- **One-liner:** In a rule predicate, target by DI scope: "every HTTP call originating from the `IFabricCatalogService` resolution, regardless of URL". Or "every call where the `IRetryPolicyProvider` resolved to `AggressiveRetryPolicy`".
- **Why it's wow:** No external proxy can target by "which service in the DI graph made this call". F28 sits inside the process and can read the DI container at request time, via the `httpClientName` (already captured) and via reflection on the call stack at the handler.
- **Technical feasibility:** **Medium.** The `httpClientName` is already the named-client tag, which maps to a DI registration. Targeting by named client is essentially already there (`HttpClientNameFilter` in `chaos-mitm-capabilities.md:73`). The deeper "by resolved policy provider" is harder — needs walking the stack or capturing scope ID at request entry.
- **Effort:** Small for named-client targeting. Large for full scope/dependency awareness.

#### §6.11 — **Feature-Flag-Coupled Rule Activation**

- **One-liner:** A MITM rule can be conditioned on a feature flag: "Only fire this 503 forgery when flag `UseNewSparkClient` is OFF". Plus the inverse: "Toggle flag X on/off as a side effect of this rule firing." Now you can A/B chaos-test flag transitions automatically.
- **Why it's wow:** F24 already plans flag override capability (the `flag` topic and `EdogFeatureOverrideStore` pattern exist). F28 *uses* it: rule conditions can read live flag state; rule actions can mutate flag state. External proxies have no concept of feature flags.
- **Technical feasibility:** **High.** The override store exists in the codebase (referenced by `EdogHttpFaultStore.cs:27` as the pattern template).
- **Effort:** Medium.

#### §6.12 — **Chaos Coverage Map**

- **One-liner:** A dashboard that shows, for each FLT outbound endpoint, which failure modes have been tested via MITM in the current session/iteration: 401 ✓, 429 ✓, 503 ✗, body corruption ✗, latency >30s ✗. "Coverage" = % of common failure modes exercised. Click an unchecked cell to one-click apply that fault to the next call.
- **Why it's wow:** Turns interactive testing into a measurable goal. "Cover OneLake-list with all 7 failure modes" is now a literal checklist that fills in as you test.
- **Technical feasibility:** **Medium.** Endpoint enumeration comes from the HTTP topic history. Failure-mode dictionary is small (7–10 canonical faults). One-click apply is a rule template.
- **Effort:** Medium.

### Tier 3 — Backlog seeds (interesting, defer)

#### §6.13 — **DAG-Scoped Auto-Pause**

- **One-liner:** "Pause every outbound HTTP call originating from DAG node `Bronze_Sales` until I manually release them, in order." Lets you step through a node's HTTP calls one at a time.
- **Feasibility:** High; the DAG topic carries node context. Effort: Medium.

#### §6.14 — **Token Audience Cross-Test**

- **One-liner:** Auto-generate a 7×N matrix that probes every captured endpoint with every observed token type. Surface accept/reject anomalies. (Direct port of `chaos-mitm-capabilities.md §4.2`.)
- **Feasibility:** Medium. Effort: Large.

#### §6.15 — **Replay-with-Schema-Drift**

- **One-liner:** Replay a captured request but auto-mutate the response: drop one field, add an unknown field, change one type. Surface deserialization failures. Like `chaos-mitm-capabilities.md §2.4` but triggered per-replay.
- **Feasibility:** Medium. Effort: Medium.

#### §6.16 — **Diff Against Production Recording**

- **One-liner:** Import a HAR file from a known-good production capture. F28 raises an alert whenever the current iteration's HTTP traffic deviates (extra calls, missing calls, schema drift in responses).
- **Feasibility:** Medium. Effort: Medium.

#### §6.17 — **Live cURL Pin**

- **One-liner:** Pin any captured request's cURL to a sticky panel. Each subsequent capture that matches the pin auto-overrides the pinned cURL with the latest (e.g., latest token). One click to copy "the freshest cURL for OneLake-list".
- **Feasibility:** Very high. Effort: Small.

#### §6.18 — **Conditional Latency Curve**

- **One-liner:** Instead of a fixed delay, define a latency curve — first 5 calls: instant, calls 6–10: +500ms, calls 11+: timeout. Models "service degrades under load" without a real load test.
- **Feasibility:** High. Effort: Small.

#### §6.19 — **Two-Side Replay (Shadow MITM)**

- **One-liner:** Capture both real and forged response for matching requests. FLT sees the forged one; the tab shows both with a diff. Tests "would FLT have done the same thing with the real response?".
- **Feasibility:** Medium. Effort: Medium.

#### §6.20 — **Voice / Natural Language Rule Authoring**

- **One-liner:** "Break on the next OneLake POST that has retry count above 2 and force it to return 503 with Retry-After 30." → LLM converts to a structured rule.
- **Feasibility:** Medium (same LLM client as §6.5). Effort: Medium. Risk: ambiguity.

#### §6.21 — **Per-DAG-Iteration HAR Bundle**

- **One-liner:** Auto-package one HAR + one feature-flag snapshot + one DI scope snapshot + the QA assertions executed = a single "iteration bundle" file. Attach to bug reports.
- **Feasibility:** High (everything is already published to topics). Effort: Medium.

#### §6.22 — **Predictive Forgery Suggestion**

- **One-liner:** When a request is paused, F28 suggests forgeries based on what previous similar requests have returned in this session — "9 of 12 similar GET /Tables responses contained `rowCount > 0`. Try `rowCount: 0`?" One-click apply.
- **Feasibility:** Medium. Effort: Medium.

#### §6.23 — **Co-Pilot Replay**

- **One-liner:** A "replay this scenario" mode where F28 walks the user through a captured failure step-by-step: "Here is the request that failed. Here is what changed compared to the previous successful run. Try changing X and replay." LLM-driven narrative.
- **Feasibility:** Medium. Effort: Large.

### 6.24 — Synthesis: What the v1 "Wow" Story Looks Like

Imagine an FLT engineer on day one with F28 shipping the Tier-1 ideas:

1. They run an FLT iteration. A request fails with 500. **§6.1 Causal Replay** shows them: this was retry 3 of 5, feature flag `UseV2Catalog` was true, the token expires in 18s.
2. They right-click the failed response → **§6.4 Time-Travel Forgery**: "Make every retry of this URL succeed with the response from 10 minutes ago." Done. They click Replay.
3. The replay succeeds — but now the next call fails. They want to test "what if the token expired *during* this DAG node?". They set a **§6.2 Stateful Breakpoint**: "Break on any OneLake call when `state.activeTokenExpiresIn < 10s`". The breakpoint fires. They use **§6.7 Token Lifecycle** to force-expire the token. Replay. The bug reproduces.
4. They've now reproduced a flaky bug deterministically in 90 seconds. They click **§6.3 Save as QA Scenario**. A regression test is born.

That four-step loop — observe → contextualise → mutate → reproduce → persist — is impossible in any other tool because no other tool sits where EDOG sits. **That is the wow.**

---

## §7. Recommended Next Steps (P1)

These are inputs to P1 design, not commitments:

1. **Confirm scope split with CEO:** F28 = "interactive MITM in HTTP tab", deferring panel-style persistent rules and the wider F24 scope.
2. **Adopt F24 `ChaosRule` / `ChaosActionType` shape** as the wire-level rule contract; F28 UI may only expose a subset.
3. **Design the `MitmCoordinator`** — the new component owning suspension/resume of in-flight requests, capability gating, owner scoping.
4. **Decide store strategy:** parallel `MitmRuleStore` (lower regression risk, two stores to merge later) vs. extended `EdogHttpFaultStore` with `OwnerType` discriminator (one store, more change-surface in F27 P5 code).
5. **Decide redaction policy for the editor** — default redacted with explicit reveal? Or per-header policy? CEO-level call.
6. **Audit `MaxBodyPreviewBytes`/`MaxBufferableBytes` interaction** with the modify path; produce a buffer-policy doc.
7. **List the P0/P1 action subset** for F28: confirm minimum = Block, Forge, ModifyRequest (headers+body+url), ModifyResponse (status+headers+body), Delay, Replay. Defer: bandwidth throttle, shadow traffic, security probes, schema fuzzing, recording diff.
8. **Pick the Tier-1 wow ideas to commit to** from §6.1–§6.5. Recommend committing to **§6.1 Causal Replay**, **§6.2 Stateful Breakpoints**, **§6.3 MITM-to-Scenario**, and **§6.4 Time-Travel Forgery** as the v1 differentiators. **§6.5 AI-assisted forgery** is the natural v1.1 follow-up.

---

## §8. File Inventory (for downstream phases)

**Backend — touched by F28:**
- `src/backend/DevMode/EdogHttpPipelineHandler.cs` (extend `SendAsync` with coordinator hooks; broaden action dispatch)
- `src/backend/DevMode/EdogHttpFaultStore.cs` (extend or shadow with `MitmRuleStore`)
- `src/backend/DevMode/EdogTopicRouter.cs` (register `mitm` topic)
- `src/backend/DevMode/EdogPlaygroundHub.cs` (add `Mitm*` RPC methods)
- `src/backend/DevMode/EdogQaCapabilityRegistry.cs` (add `IsMitmInteractiveSupported` / report)
- New: `src/backend/DevMode/MitmCoordinator.cs` (suspension/resume)
- New: `src/backend/DevMode/MitmRule.cs` + `MitmRuleStore.cs` (or extensions to fault store)

**Frontend — touched by F28:**
- `src/frontend/js/tab-http.js` (extend with Intercept toggle, row context menu, Intercept/Replay detail tabs)
- `src/frontend/css/tab-http.css` (new selectors for intercept states)
- `src/frontend/js/signalr-manager.js` (no change expected; verify reconnect path)
- New: `src/frontend/js/request-editor.js` (extracted subset of `api-playground.js` `RequestBuilder`)
- New: `src/frontend/js/http-row-menu.js` (right-click context menu)

**Specs / docs (this phase's outputs):**
- This file: `docs/specs/features/F28-http-mitm/research/p0-foundation.md`
- Next: `docs/specs/features/F28-http-mitm/spec.md` (P1)
- Next: `docs/specs/features/F28-http-mitm/states/*.md`
- Next: `docs/specs/features/F28-http-mitm/mocks/*.html`

---

*End of P0 research. Every claim is grounded in either a file:line reference or a named third-party tool. Open questions are explicit and live in §4.4 and §7.*
