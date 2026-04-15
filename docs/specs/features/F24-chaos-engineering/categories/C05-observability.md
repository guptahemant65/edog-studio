# C05: Observability — Recording, Diffing & Graphing HTTP Traffic

> **Author:** Sana Reeves (Architect)
> **Status:** DEEP SPEC — READY FOR REVIEW
> **Date:** 2025-07-24
> **Depends On:** `interceptor-audit.md` (P0.1+P0.2), `engine-design.md` (P0.3+P2)
> **Category:** Observability
> **Scenarios:** OB-01 through OB-08

---

## 0. Why This Category Exists

The other five categories (C01–C04, C06) are about *acting* on traffic — mutating, blocking, forging. C05 is about *understanding* it. Before you can inject chaos intelligently, you need to know:

1. **What does normal look like?** — Baseline traffic patterns, latencies, error rates.
2. **What changed?** — Diff two recordings to see exactly which calls appeared, disappeared, or shifted.
3. **Who talks to whom?** — Dependency graph of FLT → external services.
4. **Is it getting worse?** — Regression detection against a known-good baseline.

Today, `EdogHttpPipelineHandler` publishes to the `"http"` topic buffer (ring buffer, 2000 entries). That's live-only, ephemeral, no persistence, no export. The Traffic Monitor in section 2.3 of the master spec shows it in real-time. C05 upgrades this from "look at what's happening right now" to "record, analyze, compare, and alert."

### What Our Interceptors Already Capture

From `interceptor-audit.md` §1.1, `EdogHttpPipelineHandler` publishes per-request:

| Field | Type | Notes |
|-------|------|-------|
| `method` | `string` | HTTP method (GET, PUT, POST, DELETE) |
| `url` | `string` | Full URL, SAS tokens redacted (`sig=`, `se=`, etc. → `[redacted]`) |
| `statusCode` | `int` | HTTP response status |
| `durationMs` | `double` | Round-trip latency via `Stopwatch` |
| `requestHeaders` | `Dictionary<string,string>` | All request headers, Authorization → `[redacted]` |
| `responseHeaders` | `Dictionary<string,string>` | All response headers (unredacted) |
| `responseBodyPreview` | `string?` | First 4KB of text responses, `null` for binary, `null` if >10MB |
| `httpClientName` | `string` | Named HttpClient (e.g., `"OneLakeRestClient"`, `"DatalakeDirectoryClient"`) |
| `correlationId` | `string?` | From `x-ms-correlation-id` / `x-ms-request-id` / `x-ms-client-request-id` / `Request-Id` |

**What's missing for full observability (new fields needed):**

| Missing Field | Why Needed | Source |
|---------------|-----------|--------|
| `requestBodyPreview` | Diff request payloads between recordings | Must add to `EdogHttpPipelineHandler` — capture first 4KB of request body |
| `requestBodySize` | HAR `bodySize` field; payload size tracking (OB-07) | `request.Content?.Headers.ContentLength` |
| `responseBodySize` | HAR `bodySize` field; payload size tracking (OB-07) | `response.Content?.Headers.ContentLength` |
| `startedDateTimeUtc` | HAR `startedDateTime` — absolute timestamp per entry | `DateTimeOffset.UtcNow` captured before `base.SendAsync()` |
| `httpVersion` | HAR requires it; useful for protocol regression detection | `response.Version.ToString()` |
| `serverAddress` | HAR `serverIPAddress` — DNS resolution target | Not available inside `DelegatingHandler` — omit, mark as `""` |

---

## 1. Storage Architecture

### 1.1 The Recording Model

A **Recording** is a named, time-bounded collection of HTTP entries. It's the unit of capture, storage, export, and comparison.

```
┌──────────────────────────────────────────────────────────┐
│                     RecordingSession                       │
│                                                            │
│  id: "rec-2025-07-24-onelake-baseline"                    │
│  name: "OneLake Baseline — before DAG optimization"       │
│  startedAt: "2025-07-24T10:30:00Z"                        │
│  stoppedAt: "2025-07-24T10:35:12Z"                        │
│  status: "completed"                                       │
│  filter: { httpClientName: "OneLakeRestClient" }          │
│  entryCount: 847                                           │
│  totalRequestBytes: 12_400                                 │
│  totalResponseBytes: 3_847_200                             │
│  entries: RecordingEntry[]                                 │
│  metadata: { fltVersion, edogVersion, gitSha, user }      │
│  tags: ["baseline", "onelake", "dag-v2"]                  │
└──────────────────────────────────────────────────────────┘
```

### 1.2 Storage Strategy: Memory + File

**In-memory ring buffer** for live traffic (existing `TopicBuffer` on `"http"` topic, 2000 entries).

**Recording sessions** spill to disk as line-delimited JSON (JSONL):

```
.edog/recordings/
├── rec-2025-07-24-onelake-baseline.jsonl      ← one JSON object per line
├── rec-2025-07-24-onelake-baseline.meta.json   ← session metadata
├── rec-2025-07-24-dag-after-fix.jsonl
├── rec-2025-07-24-dag-after-fix.meta.json
└── index.json                                  ← listing of all recordings
```

**Why JSONL, not a single JSON array:**
- **Streaming writes** — append one line per entry, no need to hold the whole file in memory.
- **Streaming reads** — process entries one at a time for diff/analysis.
- **Crash-safe** — if EDOG or FLT crashes mid-recording, everything up to the last line is intact.
- **Large recording support** — a 30-minute DAG execution can produce 10K+ entries. JSONL handles this; a JSON array means buffering everything.

**Size estimates:**
- Average entry: ~2KB (URL ~200 chars, headers ~500 chars, body preview ~1KB, metadata ~300 chars).
- 10K entries ≈ 20MB JSONL file. Manageable on any dev machine.
- Maximum recording size: **100MB** (configurable). Recording auto-stops at this limit.

### 1.3 RecordingEntry Schema

Each line in the JSONL file:

```jsonc
{
  // === Identity ===
  "sequenceId": 1,                                          // Monotonic within this recording
  "startedDateTime": "2025-07-24T10:30:01.234Z",           // ISO 8601 UTC

  // === Request ===
  "method": "PUT",
  "url": "https://onelake.dfs.fabric.microsoft.com/ws-guid/lh-guid/Tables/mytable/part-0001.parquet",
  "httpVersion": "2.0",
  "httpClientName": "DatalakeDirectoryClient",
  "requestHeaders": { "Content-Type": "application/octet-stream", "Authorization": "[redacted]" },
  "requestBodyPreview": null,                               // null for binary PUT (Parquet)
  "requestBodySize": 1048576,                               // 1MB

  // === Response ===
  "statusCode": 201,
  "statusText": "Created",
  "responseHeaders": { "x-ms-request-id": "abc-123", "Content-Length": "0" },
  "responseBodyPreview": null,
  "responseBodySize": 0,

  // === Timing ===
  "durationMs": 145.32,

  // === Correlation ===
  "correlationId": "abc-123",

  // === EDOG Extensions (not in HAR) ===
  "_edog": {
    "chaosRulesMatched": [],                                // IDs of chaos rules that fired on this request
    "topicSequenceId": 4821,                                // Original http topic sequence ID
    "tags": {}                                              // From tagRequest chaos action
  }
}
```

### 1.4 RecordingSession Lifecycle

```
                    ┌────────────────────────────────┐
                    │         User clicks             │
                    │       "Start Recording"         │
                    └───────────────┬────────────────┘
                                    │
                                    ▼
                             ┌─────────────┐
                             │  RECORDING   │  Entries appended to JSONL
                             │              │  Counter increments in UI
                             └──────┬───────┘
                                    │
                    ┌───────────────┼───────────────┐
                    │               │               │
              User clicks      Size limit        FLT process
             "Stop Recording"   reached (100MB)   exits / crashes
                    │               │               │
                    ▼               ▼               ▼
             ┌─────────────┐ ┌─────────────┐ ┌─────────────┐
             │  COMPLETED   │ │ TRUNCATED    │ │ INTERRUPTED  │
             └──────────────┘ └──────────────┘ └──────────────┘
                    │               │               │
                    └───────┬───────┴───────────────┘
                            ▼
                     Available for:
                     • Browse / search
                     • Export as HAR 1.2
                     • Diff against another recording
                     • Import as mock data source (C06 AD-02)
                     • Delete
```

**States:**

| State | Description |
|-------|-------------|
| `recording` | Actively capturing. JSONL file open for append. |
| `completed` | User stopped normally. File closed, metadata finalized. |
| `truncated` | Hit size limit. Metadata includes `truncationReason`. |
| `interrupted` | FLT process died mid-recording. Last entry may be partial (JSONL tolerates this — skip malformed last line). |

**Concurrency rule:** Only ONE recording session can be active at a time. Starting a new recording while one is active stops the current one first (with user confirmation).

---

## 2. Scenarios

### OB-01: HAR Recording

**ID:** OB-01
**Name:** HAR Recording
**One-liner:** Record all (or filtered) HTTP traffic, export as HAR 1.2
**Priority:** P0 — Foundation for all other OB scenarios

#### Description

The user clicks "Start Recording" in the Recording sub-view. All HTTP traffic flowing through `EdogHttpPipelineHandler` is captured to a `RecordingSession`. When stopped, the recording can be exported as a HAR 1.2 JSON file importable in Chrome DevTools, Charles Proxy, or any HAR viewer.

Optional **recording filter:** The user can scope the recording to a subset of traffic:
- By `httpClientName` (e.g., only `OneLakeRestClient`)
- By URL pattern (glob or regex)
- By HTTP method
- By status code range (e.g., only errors: 400+)

This reuses the `ConditionPredicate` system from `engine-design.md` — a recording filter IS a predicate, evaluated on each entry before writing.

#### ChaosRule JSON (Observability Action)

```json
{
  "id": "record-all-traffic",
  "name": "Record All HTTP Traffic",
  "category": "observability",
  "predicate": { "field": "method", "op": "matches", "value": ".*" },
  "action": {
    "type": "recordTraffic",
    "config": {
      "sessionName": "onelake-baseline-2025-07-24",
      "maxEntries": 50000,
      "maxSizeMB": 100,
      "includeRequestBody": true,
      "includeResponseBody": true,
      "bodyPreviewMaxBytes": 4096
    }
  },
  "phase": "response",
  "priority": 999,
  "enabled": true,
  "probability": 1.0,
  "limits": { "ttlSeconds": 1800 }
}
```

**Note:** `recordTraffic` is a special action type — it doesn't mutate anything. The `phase` is `"response"` because we need the full response before writing the entry. Priority 999 = runs last (after any chaos mutations, so the recording captures the mutated traffic).

#### C# Mechanism

Recording hooks into `EdogHttpPipelineHandler.SendAsync()` at the capture point (after step 3, before step 4):

```csharp
// In EdogHttpPipelineHandler.SendAsync() — new recording tap
if (RecordingManager.IsActive)
{
    RecordingManager.TryAppend(new RecordingEntry
    {
        SequenceId = RecordingManager.NextSequenceId(),
        StartedDateTime = requestStartTime,
        Method = method,
        Url = url,
        HttpVersion = response.Version.ToString(),
        HttpClientName = _httpClientName,
        RequestHeaders = requestHeaders,
        RequestBodyPreview = requestBodyPreview,
        RequestBodySize = request.Content?.Headers.ContentLength ?? -1,
        StatusCode = (int)response.StatusCode,
        StatusText = response.ReasonPhrase ?? "",
        ResponseHeaders = responseHeaders,
        ResponseBodyPreview = bodyPreview,
        ResponseBodySize = response.Content?.Headers.ContentLength ?? -1,
        DurationMs = sw.Elapsed.TotalMilliseconds,
        CorrelationId = correlationId,
    });
}
```

`RecordingManager` is a new static class:

```csharp
/// <summary>
/// Manages the active recording session. Thread-safe. At most one active session.
/// Writes are non-blocking — entry serialization and file I/O happen on a background channel.
/// </summary>
public static class RecordingManager
{
    private static volatile RecordingSession _active;
    private static readonly Channel<RecordingEntry> _writeChannel =
        Channel.CreateBounded<RecordingEntry>(new BoundedChannelOptions(10000)
        { FullMode = BoundedChannelFullMode.DropOldest });

    public static bool IsActive => _active?.Status == RecordingStatus.Recording;

    /// <summary>Start a new recording. Stops any active session first.</summary>
    public static RecordingSession Start(RecordingConfig config) { /* ... */ }

    /// <summary>Stop the active recording. Flushes pending writes.</summary>
    public static RecordingSession Stop() { /* ... */ }

    /// <summary>Non-blocking append. Drops if channel is full (DropOldest).</summary>
    public static void TryAppend(RecordingEntry entry) { /* ... */ }
}
```

**Background writer:** A `Task.Run` loop reads from `_writeChannel` and appends serialized JSON lines to the JSONL file. This ensures zero blocking on the HTTP pipeline — `TryAppend` is a non-blocking channel write.

#### HAR 1.2 Export Format

The export maps `RecordingEntry` → HAR 1.2 `entry`:

```json
{
  "log": {
    "version": "1.2",
    "creator": {
      "name": "EDOG Studio",
      "version": "1.0.0",
      "comment": "FabricLiveTable Developer Cockpit — https://edog-studio.dev"
    },
    "pages": [
      {
        "startedDateTime": "2025-07-24T10:30:00.000Z",
        "id": "page_0",
        "title": "FLT Recording: onelake-baseline-2025-07-24",
        "pageTimings": { "onContentLoad": -1, "onLoad": -1 }
      }
    ],
    "entries": [
      {
        "pageref": "page_0",
        "startedDateTime": "2025-07-24T10:30:01.234Z",
        "time": 145.32,
        "request": {
          "method": "PUT",
          "url": "https://onelake.dfs.fabric.microsoft.com/ws-guid/lh-guid/Tables/...",
          "httpVersion": "HTTP/2.0",
          "cookies": [],
          "headers": [
            { "name": "Content-Type", "value": "application/octet-stream" },
            { "name": "Authorization", "value": "[redacted]" }
          ],
          "queryString": [],
          "headersSize": -1,
          "bodySize": 1048576
        },
        "response": {
          "status": 201,
          "statusText": "Created",
          "httpVersion": "HTTP/2.0",
          "cookies": [],
          "headers": [
            { "name": "x-ms-request-id", "value": "abc-123" },
            { "name": "Content-Length", "value": "0" }
          ],
          "content": {
            "size": 0,
            "mimeType": "",
            "text": ""
          },
          "redirectURL": "",
          "headersSize": -1,
          "bodySize": 0
        },
        "cache": {},
        "timings": {
          "send": -1,
          "wait": 145.32,
          "receive": -1,
          "comment": "EDOG captures total round-trip only; sub-timings unavailable inside DelegatingHandler"
        },
        "serverIPAddress": "",
        "connection": "",
        "comment": ""
      }
    ],
    "comment": "Exported from EDOG Studio. EDOG-specific extensions in _edog fields are non-standard."
  }
}
```

**Field mapping table:**

| HAR Field | Source | Notes |
|-----------|--------|-------|
| `entry.startedDateTime` | `RecordingEntry.StartedDateTime` | ISO 8601 UTC |
| `entry.time` | `RecordingEntry.DurationMs` | Total round-trip ms |
| `request.method` | `RecordingEntry.Method` | Verbatim |
| `request.url` | `RecordingEntry.Url` | SAS-redacted |
| `request.httpVersion` | `RecordingEntry.HttpVersion` | Prefixed with `"HTTP/"` |
| `request.headers` | `RecordingEntry.RequestHeaders` | Dict → `[{name, value}]` array |
| `request.bodySize` | `RecordingEntry.RequestBodySize` | `-1` if unknown |
| `response.status` | `RecordingEntry.StatusCode` | Integer |
| `response.statusText` | `RecordingEntry.StatusText` | From `ReasonPhrase` |
| `response.headers` | `RecordingEntry.ResponseHeaders` | Dict → `[{name, value}]` array |
| `response.content.text` | `RecordingEntry.ResponseBodyPreview` | First 4KB or `""` |
| `response.content.size` | `RecordingEntry.ResponseBodySize` | `-1` if unknown |
| `response.bodySize` | `RecordingEntry.ResponseBodySize` | `-1` if unknown |
| `timings.wait` | `RecordingEntry.DurationMs` | Only timing available from inside `DelegatingHandler` |
| `timings.send` / `timings.receive` | `-1` | Not decomposable at our interception layer |
| `serverIPAddress` | `""` | DNS resolution invisible inside `DelegatingHandler` |

**Limitations:**
- No sub-timing decomposition (DNS, connect, TLS, send, wait, receive). `DelegatingHandler` only sees total round-trip. All timing goes into `timings.wait`.
- No `serverIPAddress` — resolved by `HttpClient` internals, not exposed.
- Body preview truncated at 4KB — HAR `content.text` will be partial for large responses.
- Binary responses (Parquet, protobuf) will have empty `content.text`.
- Spark/GTS traffic (GAP-1) NOT captured — `GTSBasedSparkClient` bypasses `IHttpClientFactory`.

#### REST API

```
POST   /api/recordings/start       { name, filter?, maxEntries?, maxSizeMB? }
POST   /api/recordings/stop        {}
GET    /api/recordings              → RecordingSession[]  (list all)
GET    /api/recordings/{id}         → RecordingSession metadata
GET    /api/recordings/{id}/entries?skip=0&take=100   → RecordingEntry[] (paginated)
GET    /api/recordings/{id}/export/har                → HAR 1.2 JSON (streaming download)
DELETE /api/recordings/{id}         → 204
```

#### Edge Cases

| Condition | Behavior |
|-----------|----------|
| Start recording while one is active | Stop current (with auto-name suffix), start new |
| FLT crashes mid-recording | Status → `interrupted`, JSONL is valid up to last complete line |
| Disk full | Recording auto-stops, status → `truncated`, `truncationReason: "disk full"` |
| >100MB | Recording auto-stops, status → `truncated`, `truncationReason: "size limit"` |
| >50K entries | Recording auto-stops, status → `truncated`, `truncationReason: "entry limit"` |
| Binary response body | `responseBodyPreview: null`, `responseBodySize` still captured |
| Very long URL (>8KB) | Truncate URL in JSONL to 8KB, add `_edog.urlTruncated: true` |
| Concurrent HTTP requests during recording | `_writeChannel` is thread-safe; entries may arrive slightly out of order in JSONL — sorted by `sequenceId` on read |

#### Revert

Deleting a recording removes the `.jsonl` and `.meta.json` files. No FLT state is affected — recordings are purely observational.

---

### OB-02: Traffic Diff

**ID:** OB-02
**Name:** Traffic Diff
**One-liner:** Compare two recordings to see what changed
**Priority:** P0 — Critical for "before/after" validation of code changes

#### Description

The user selects two recordings (A = "before my change", B = "after my change") and the diff engine produces a structured comparison showing:

1. **New calls** — URLs in B that don't appear in A
2. **Removed calls** — URLs in A that don't appear in B
3. **Changed responses** — Same URL+method but different status code, body, or timing
4. **Timing shifts** — Same call pattern but statistically significant latency change
5. **Volume changes** — Same endpoint called more/fewer times

#### Diff Algorithm

The diff operates on **endpoint signatures**, not individual entries. An endpoint signature is:

```
signature = normalize(method + " " + urlTemplate)
```

Where `urlTemplate` replaces dynamic segments:
- GUIDs → `{guid}`
- Integers → `{int}`
- ISO dates → `{date}`
- SAS-redacted params → stripped entirely

**Examples:**
```
PUT https://onelake.dfs.fabric.microsoft.com/a1b2c3d4-e5f6/.../part-0001.parquet
  → PUT onelake.dfs.fabric.microsoft.com/{guid}/.../part-{int}.parquet

GET https://api.fabric.microsoft.com/v1/workspaces/a1b2c3d4/lakehouses/e5f6a7b8
  → GET api.fabric.microsoft.com/v1/workspaces/{guid}/lakehouses/{guid}
```

#### Diff Output Schema

```jsonc
{
  "diff": {
    "recordingA": { "id": "rec-before", "name": "Before DAG fix", "entryCount": 847 },
    "recordingB": { "id": "rec-after",  "name": "After DAG fix",  "entryCount": 792 },

    "summary": {
      "endpointsAdded": 2,
      "endpointsRemoved": 1,
      "endpointsChanged": 5,
      "endpointsUnchanged": 18,
      "totalCallCountDelta": -55,
      "avgLatencyDeltaMs": -12.3
    },

    "endpoints": [
      {
        "signature": "PUT onelake.dfs.fabric.microsoft.com/{guid}/.../Tables/{path}",
        "status": "changed",
        "a": {
          "callCount": 120,
          "avgLatencyMs": 145.2,
          "p50LatencyMs": 130.0,
          "p95LatencyMs": 280.0,
          "p99LatencyMs": 450.0,
          "errorCount": 3,
          "errorRate": 0.025,
          "statusCodes": { "201": 117, "429": 2, "503": 1 },
          "avgRequestBodySize": 1048576,
          "avgResponseBodySize": 0
        },
        "b": {
          "callCount": 95,
          "avgLatencyMs": 98.7,
          "p50LatencyMs": 85.0,
          "p95LatencyMs": 190.0,
          "p99LatencyMs": 310.0,
          "errorCount": 1,
          "errorRate": 0.011,
          "statusCodes": { "201": 94, "429": 1 },
          "avgRequestBodySize": 1048576,
          "avgResponseBodySize": 0
        },
        "delta": {
          "callCountDelta": -25,
          "avgLatencyDeltaMs": -46.5,
          "errorRateDelta": -0.014,
          "significantLatencyChange": true,
          "significantVolumeChange": true
        }
      },
      {
        "signature": "GET api.fabric.microsoft.com/v1/workspaces/{guid}/lakehouses/{guid}",
        "status": "removed",
        "a": { "callCount": 12, "avgLatencyMs": 230.0, "errorCount": 0 },
        "b": null,
        "delta": { "callCountDelta": -12 }
      },
      {
        "signature": "POST api.fabric.microsoft.com/v1/workspaces/{guid}/semanticModels",
        "status": "added",
        "a": null,
        "b": { "callCount": 3, "avgLatencyMs": 1200.0, "errorCount": 0 },
        "delta": { "callCountDelta": 3 }
      }
    ]
  }
}
```

#### Statistical Significance

Latency changes are flagged as `significantLatencyChange: true` when:
- Both A and B have ≥10 samples for the endpoint
- The difference in means exceeds **2× the pooled standard deviation** (simplified two-sample test)
- OR the p95 shifted by more than 50%

Volume changes are flagged when the call count changes by >20% or by an absolute value of >10.

This avoids false alarms from natural variance in small samples.

#### REST API

```
POST /api/recordings/diff  { recordingIdA, recordingIdB }  → DiffResult
```

Diff is computed on-demand, not persisted. Computation is O(A + B) — one pass to bucket entries by signature, one pass to compute statistics.

#### Visualization (Frontend)

Two-column table:

```
┌─────────────────────────────────────────────────────────────────────┐
│  Traffic Diff: "Before DAG fix" vs "After DAG fix"                  │
├─────────────────────────┬─────────┬──────────┬─────────┬───────────┤
│ Endpoint                │ Status  │ Calls Δ  │ Latency Δ│ Errors Δ │
├─────────────────────────┼─────────┼──────────┼─────────┼───────────┤
│ PUT onelake/.../Tables/ │ changed │ -25 ▼    │ -46ms ▼ │ -2 ▼     │
│ GET .../lakehouses/{id} │ removed │ -12 ✕    │    —    │    —     │
│ POST .../semanticModels │ added   │ +3  ▲    │    —    │    —     │
│ GET .../ListDirs        │ same    │ +1       │ -2ms    │  0       │
│ ...                     │         │          │         │          │
└─────────────────────────┴─────────┴──────────┴─────────┴───────────┘
```

Color coding: `added` = green, `removed` = red, `changed` = amber, `same` = grey.
Click any row → expands to show per-status-code breakdown, latency percentile comparison, and sample entries from each recording.

#### Edge Cases

| Condition | Behavior |
|-----------|----------|
| Comparing a recording with itself | Valid — all endpoints show `status: "same"`, all deltas zero |
| One recording empty | All endpoints marked `added` or `removed` |
| Very different URL patterns (unrelated recordings) | All endpoints `added`/`removed` — useless but valid. UI shows warning. |
| Signature collision (two different endpoints normalize to same template) | Possible but rare. URL template normalization preserves path structure. |
| Recordings from different FLT versions | Valid comparison — the diff will surface API changes |

---

### OB-03: Dependency Graph

**ID:** OB-03
**Name:** Dependency Graph
**One-liner:** Auto-build a visual map of all external services FLT talks to
**Priority:** P1 — High value for understanding, not blocking other scenarios

#### Description

From a recording (or live traffic), EDOG extracts every unique external service and builds a directed dependency graph. Each node is a service, each edge is a traffic flow with call count, latency stats, and error rates.

#### Service Identification

Services are identified by extracting the host + path prefix from URLs:

| URL Pattern | Service Name | Category |
|-------------|-------------|----------|
| `onelake.dfs.fabric.microsoft.com/*` | OneLake DFS | Storage |
| `api.fabric.microsoft.com/v1/*` | Fabric API | Control Plane |
| `*.pbidedicated.windows.net/*` | PBI Dedicated (Spark/GTS) | Compute |
| `*.analysis.windows.net/*` | Analysis Services | Compute |
| `*.dfs.core.windows.net/*` | Azure Data Lake | Storage |
| `*.blob.core.windows.net/*` | Azure Blob | Storage |
| `localhost:5555/*` | EDOG (self) | Internal |

The mapping is configured, not hardcoded — stored in `edog-config.json` under `observability.serviceMap`:

```jsonc
{
  "observability": {
    "serviceMap": [
      { "hostPattern": "onelake.dfs.fabric.microsoft.com", "name": "OneLake DFS", "category": "storage", "color": "oklch(0.72 0.15 145)" },
      { "hostPattern": "api.fabric.microsoft.com",         "name": "Fabric API",  "category": "control-plane", "color": "oklch(0.72 0.15 250)" },
      { "hostPattern": "*.pbidedicated.windows.net",       "name": "GTS/Spark",   "category": "compute", "color": "oklch(0.72 0.15 30)" },
      { "hostPattern": "*",                                "name": "Unknown",     "category": "other", "color": "oklch(0.60 0.01 260)" }
    ]
  }
}
```

#### Graph Data Schema

```jsonc
{
  "graph": {
    "source": "rec-2025-07-24-onelake-baseline",
    "generatedAt": "2025-07-24T10:40:00Z",

    "nodes": [
      {
        "id": "flt",
        "name": "FLT Service",
        "type": "origin",
        "totalOutboundCalls": 847
      },
      {
        "id": "onelake-dfs",
        "name": "OneLake DFS",
        "type": "dependency",
        "category": "storage",
        "totalCalls": 520,
        "avgLatencyMs": 145.2,
        "errorRate": 0.025,
        "healthStatus": "healthy"
      },
      {
        "id": "fabric-api",
        "name": "Fabric API",
        "type": "dependency",
        "category": "control-plane",
        "totalCalls": 67,
        "avgLatencyMs": 430.0,
        "errorRate": 0.0,
        "healthStatus": "healthy"
      }
    ],

    "edges": [
      {
        "from": "flt",
        "to": "onelake-dfs",
        "callCount": 520,
        "methods": { "PUT": 320, "GET": 180, "DELETE": 20 },
        "avgLatencyMs": 145.2,
        "p95LatencyMs": 280.0,
        "errorCount": 13,
        "errorRate": 0.025,
        "statusCodes": { "200": 180, "201": 320, "204": 7, "429": 10, "503": 3 },
        "httpClientNames": ["DatalakeDirectoryClient", "OneLakeRestClient"],
        "totalRequestBytes": 335_544_320,
        "totalResponseBytes": 12_800_000
      }
    ]
  }
}
```

#### Visualization

Radial layout with FLT at center:

```
                    ┌──────────┐
                    │ Fabric   │
                    │ API (67) │
                    └────┬─────┘
                         │
                         │ 430ms avg
                         │
              ┌──────────┴──────────────────────┐
              │                                  │
              │         ┌──────────┐             │
              │         │   FLT    │             │
              │         │ Service  │             │
              │         └──┬───┬───┘             │
              │            │   │                 │
              │    520 calls   260 calls         │
              │    145ms avg   89ms avg          │
              │            │   │                 │
         ┌────┴────┐  ┌───┴───┴──┐       ┌──────┴─────┐
         │OneLake  │  │ GTS/Spark│       │ PBI Shared │
         │DFS (520)│  │  (260)   │       │ API (67)   │
         └─────────┘  └──────────┘       └────────────┘
```

Each node shows:
- Service name
- Total call count (line thickness proportional)
- Average latency (label on edge)
- Error rate (node border color: green <1%, amber 1-5%, red >5%)

Built with vanilla JS canvas or inline SVG (no external dependencies). Nodes are draggable for layout adjustment.

#### REST API

```
GET /api/recordings/{id}/graph          → GraphData (from recording)
GET /api/traffic/graph?windowSeconds=60 → GraphData (from live ring buffer)
```

#### Edge Cases

| Condition | Behavior |
|-----------|----------|
| Unknown host (not in serviceMap) | Grouped under "Unknown" node with the raw hostname in a tooltip |
| Self-calls (localhost:5555) | Excluded from graph by default (configurable) |
| Single endpoint dominates | Edge thickness capped at visual maximum; tooltip shows exact count |
| No traffic captured | Empty graph with only FLT node; message "No traffic recorded" |

---

### OB-04: Regression Detection

**ID:** OB-04
**Name:** Regression Detection
**One-liner:** Alert when current traffic patterns deviate from a saved baseline
**Priority:** P1 — Builds on OB-01 (recording) and OB-02 (diff)

#### Description

The user marks a recording as a **baseline**. During subsequent sessions, EDOG continuously compares live traffic against the baseline and flags deviations:

- **Latency regression:** Endpoint P95 exceeds baseline P95 by >50% for >30 seconds
- **Error rate spike:** Error rate exceeds baseline by >3× for >10 seconds
- **New error endpoint:** An endpoint that had 0 errors in baseline now has errors
- **Missing endpoint:** An expected endpoint hasn't been called within 2× its baseline interval
- **Volume anomaly:** Call rate >3× or <0.3× the baseline rate for >60 seconds

#### Baseline Schema

A baseline is a recording with aggregated statistics per endpoint signature:

```jsonc
{
  "baseline": {
    "recordingId": "rec-2025-07-24-onelake-baseline",
    "name": "OneLake Baseline — Sprint 42 release",
    "createdAt": "2025-07-24T10:40:00Z",
    "durationSeconds": 312,

    "endpoints": {
      "PUT onelake.dfs.fabric.microsoft.com/{guid}/.../Tables/{path}": {
        "callCount": 120,
        "callsPerSecond": 0.38,
        "avgLatencyMs": 145.2,
        "p50LatencyMs": 130.0,
        "p95LatencyMs": 280.0,
        "p99LatencyMs": 450.0,
        "stddevLatencyMs": 65.4,
        "errorRate": 0.025,
        "statusCodeDistribution": { "201": 0.975, "429": 0.017, "503": 0.008 }
      }
    }
  }
}
```

#### Regression Alert Schema

```jsonc
{
  "alert": {
    "id": "alert-001",
    "type": "latency-regression",
    "severity": "warning",
    "endpoint": "PUT onelake.dfs.fabric.microsoft.com/{guid}/.../Tables/{path}",
    "message": "P95 latency 520ms exceeds baseline 280ms by 86%",
    "baseline": { "p95LatencyMs": 280.0 },
    "current":  { "p95LatencyMs": 520.0, "sampleCount": 45, "windowSeconds": 60 },
    "deviation": { "percent": 85.7, "threshold": 50.0 },
    "firstDetected": "2025-07-24T11:02:30Z",
    "lastSeen": "2025-07-24T11:03:45Z",
    "acknowledged": false
  }
}
```

#### Detection Mechanism

A **sliding window** aggregator runs on the `"http"` topic stream:

1. Maintain a 60-second rolling window of entries per endpoint signature.
2. Every 10 seconds, compute P50/P95/P99/error rate for each signature in the window.
3. Compare against baseline thresholds.
4. If deviation detected and sustained for the required duration, publish alert to `"observability"` topic.
5. Alert auto-clears when the metric returns to within 20% of baseline for 30 seconds.

**Performance:** The aggregator runs on the SignalR server side (C#). With ~100 active endpoint signatures and a 60s window, this is a few KB of memory and microseconds per check. No impact on FLT.

#### Regression Thresholds (Configurable)

| Metric | Default Threshold | Sustained Duration |
|--------|------------------|--------------------|
| P95 latency | >50% above baseline | 30 seconds |
| P99 latency | >100% above baseline | 30 seconds |
| Error rate | >3× baseline OR >5% absolute | 10 seconds |
| New errors | Any errors on a zero-error endpoint | 10 seconds |
| Missing endpoint | No calls within 2× baseline interval | 60 seconds |
| Volume spike | >3× baseline rate | 60 seconds |
| Volume drop | <0.3× baseline rate | 60 seconds |

#### REST API

```
POST   /api/baselines                   { recordingId, name }
GET    /api/baselines                    → Baseline[]
DELETE /api/baselines/{id}               → 204
POST   /api/baselines/{id}/activate      → Start regression detection against this baseline
POST   /api/baselines/deactivate         → Stop regression detection
GET    /api/alerts                        → Alert[] (active alerts)
POST   /api/alerts/{id}/acknowledge       → Acknowledge (suppress re-alerting)
```

#### Edge Cases

| Condition | Behavior |
|-----------|----------|
| No baseline active | Regression detection disabled; UI shows "Set a baseline to enable regression detection" |
| Baseline from different FLT version | Works — detects API changes as added/removed endpoints |
| Very short baseline (<30s) | Warning: "Baseline has limited samples. Results may be noisy." |
| Alert storm (>20 alerts in 10s) | Consolidate: "Multiple regressions detected across N endpoints" |
| Endpoint not in baseline | Ignored (new endpoints are not regressions; they're in OB-02 diff) |

---

### OB-05: Latency Heatmap

**ID:** OB-05
**Name:** Latency Heatmap
**One-liner:** Visual heatmap of response times per endpoint over time
**Priority:** P2 — Visualization enhancement

#### Description

A time-series heatmap where:
- **X-axis:** Time (30s/1min/5min buckets)
- **Y-axis:** Endpoint signatures (grouped by service)
- **Cell color:** Latency bucket (green <100ms, yellow 100-500ms, orange 500-2000ms, red >2000ms)
- **Cell opacity:** Call volume (more calls = more opaque)

#### Data Format

The heatmap is computed from a recording or from the live ring buffer:

```jsonc
{
  "heatmap": {
    "source": "live",
    "bucketWidthSeconds": 30,
    "timeRange": { "start": "2025-07-24T10:30:00Z", "end": "2025-07-24T10:35:00Z" },

    "endpoints": ["PUT onelake/.../{path}", "GET fabric-api/.../lakehouses/{guid}", "..."],

    "buckets": [
      {
        "time": "2025-07-24T10:30:00Z",
        "cells": [
          {
            "endpoint": "PUT onelake/.../{path}",
            "avgLatencyMs": 145.2,
            "p95LatencyMs": 280.0,
            "callCount": 12,
            "errorCount": 0
          }
        ]
      }
    ]
  }
}
```

#### Color Scale (OKLCH)

| Bucket | Latency Range | Color |
|--------|--------------|-------|
| Fast | 0–100ms | `oklch(0.80 0.18 145)` (green) |
| Normal | 100–500ms | `oklch(0.85 0.18 90)` (yellow) |
| Slow | 500–2000ms | `oklch(0.75 0.18 60)` (orange) |
| Critical | >2000ms | `oklch(0.65 0.22 25)` (red) |
| No data | — | `oklch(0.25 0.01 260)` (dark bg) |

Opacity: `0.3 + 0.7 * min(callCount / expectedCount, 1.0)` — faint if few calls, solid if many.

#### REST API

```
GET /api/recordings/{id}/heatmap?bucketSeconds=30   → HeatmapData
GET /api/traffic/heatmap?windowMinutes=5&bucketSeconds=30 → HeatmapData (live)
```

#### Edge Cases

| Condition | Behavior |
|-----------|----------|
| >50 endpoints | Show top 20 by call volume, collapse rest into "Other" row |
| No traffic in a bucket | Cell shows "no data" color, tooltip says "No calls in this period" |
| Extreme outlier (single 30s call) | Cell is red; tooltip shows sample count = 1 as context |

---

### OB-06: Error Rate Dashboard

**ID:** OB-06
**Name:** Error Rate Dashboard
**One-liner:** Real-time error rate per service and endpoint
**Priority:** P1 — Critical for monitoring chaos experiment impact

#### Description

A dashboard showing error rates across all services, updated in real-time from the `"http"` topic stream. This is the primary tool for watching chaos experiments — "I enabled a 429-storm rule; how fast is the error rate climbing?"

#### Dashboard Layout

```
┌───────────────────────────────────────────────────────────────────┐
│  Error Rate Dashboard                          [60s] [5m] [30m]  │
├──────────────────────┬──────┬──────┬──────┬──────┬───────────────┤
│ Service              │ Total│ 2xx  │ 4xx  │ 5xx  │ Error Rate    │
├──────────────────────┼──────┼──────┼──────┼──────┼───────────────┤
│ ● OneLake DFS        │  520 │  507 │   10 │    3 │ ██░░░ 2.5%   │
│ ● Fabric API         │   67 │   67 │    0 │    0 │ ░░░░░ 0.0%   │
│ ● GTS/Spark          │  260 │  245 │    8 │    7 │ ███░░ 5.8%   │
├──────────────────────┴──────┴──────┴──────┴──────┴───────────────┤
│                                                                   │
│  Error Sparkline (60s rolling):                                   │
│  OneLake:  ▁▁▂▁▁▃▇▅▂▁▁▁  (spike at T-40s)                      │
│  Spark:    ▁▂▃▅▇█▇▅▃▂▁▁  (elevated 30-50s ago)                 │
│                                                                   │
│  Recent Errors (latest 20):                                       │
│  10:31:05  429  PUT onelake/.../Tables/part-0042.parquet          │
│  10:31:03  503  GET onelake/.../ListDirs?directory=Tables         │
│  10:30:58  429  PUT onelake/.../Tables/part-0039.parquet          │
└───────────────────────────────────────────────────────────────────┘
```

#### Data Schema

```jsonc
{
  "errorDashboard": {
    "windowSeconds": 60,
    "services": [
      {
        "name": "OneLake DFS",
        "totalCalls": 520,
        "statusBuckets": { "2xx": 507, "3xx": 0, "4xx": 10, "5xx": 3 },
        "errorRate": 0.025,
        "sparkline": [0, 0, 1, 0, 0, 2, 5, 3, 1, 0, 0, 0],
        "topErrors": [
          { "timestamp": "2025-07-24T10:31:05Z", "statusCode": 429, "url": "PUT onelake/.../Tables/part-0042.parquet", "correlationId": "abc-123" }
        ]
      }
    ]
  }
}
```

#### REST API

```
GET /api/traffic/errors?windowSeconds=60   → ErrorDashboardData (live)
GET /api/recordings/{id}/errors            → ErrorDashboardData (from recording)
```

#### Real-time Updates

The error dashboard subscribes to the `"http"` SignalR topic and maintains a client-side rolling window. Updates are rendered at 1Hz (one UI refresh per second). No polling.

---

### OB-07: Payload Size Tracker

**ID:** OB-07
**Name:** Payload Size Tracker
**One-liner:** Monitor request/response sizes over time, detect size anomalies
**Priority:** P2 — Useful for detecting serialization regressions

#### Description

Tracks request and response body sizes per endpoint over time. Detects anomalies:
- Response size suddenly 10× larger (serialization bug? missing filter?)
- Request body grew significantly (new fields being sent?)
- Empty responses where they shouldn't be (deserialization failure?)

#### Data Schema

```jsonc
{
  "payloadTracker": {
    "windowSeconds": 300,
    "endpoints": [
      {
        "signature": "PUT onelake/.../Tables/{path}",
        "requestSize": {
          "avg": 1048576,
          "min": 524288,
          "max": 2097152,
          "p95": 1572864
        },
        "responseSize": {
          "avg": 0,
          "min": 0,
          "max": 128,
          "p95": 0
        },
        "anomalies": []
      },
      {
        "signature": "GET fabric-api/.../lakehouses/{guid}",
        "requestSize": { "avg": 0, "min": 0, "max": 0, "p95": 0 },
        "responseSize": {
          "avg": 2400,
          "min": 2100,
          "max": 15000,
          "p95": 3200
        },
        "anomalies": [
          {
            "type": "response-size-spike",
            "timestamp": "2025-07-24T10:33:15Z",
            "expected": 2400,
            "actual": 15000,
            "factor": 6.25
          }
        ]
      }
    ]
  }
}
```

#### Anomaly Thresholds

| Anomaly | Condition |
|---------|-----------|
| Size spike | Value > 5× rolling average |
| Size drop to zero | Response body empty where baseline avg > 100 bytes |
| Consistent growth | Average size increasing >10% per minute for >3 minutes |

#### REST API

```
GET /api/traffic/payloads?windowSeconds=300     → PayloadTrackerData (live)
GET /api/recordings/{id}/payloads               → PayloadTrackerData (from recording)
```

---

### OB-08: Request Correlation

**ID:** OB-08
**Name:** Request Correlation
**One-liner:** Link HTTP requests to the FLT code path (DAG node, iteration, operation) that made them
**Priority:** P2 — Deep debugging; requires cross-topic correlation

#### Description

Correlate HTTP requests with FLT execution context by joining across topic streams:

1. `"http"` topic — the HTTP request with `correlationId`
2. `"perf"` topic — perf markers with `correlationId` and `operationName`
3. `"telemetry"` topic — SSR telemetry with `correlationId` and `activityName`
4. `"spark"` topic — Spark sessions with `iterationId`
5. `"fileop"` topic — file operations with `iterationId`

The join key is the **correlationId** (when available) or the **iterationId** (extracted from URLs and log messages).

#### Correlation Chain Example

```
DAG Node "LoadCustomerData" (iteration: abc-123)
  ├─ OneLake: GET  /.../Tables/customers/_delta_log/   [corr: xyz-456]
  ├─ OneLake: GET  /.../Tables/customers/part-0001.parquet [corr: xyz-457]
  ├─ OneLake: GET  /.../Tables/customers/part-0002.parquet [corr: xyz-458]
  ├─ Spark:   PUT  /v1/workspaces/.../customTransformExecution/... [NOT INTERCEPTED]
  ├─ PerfMarker: "LoadCustomerData" completed in 3200ms [corr: xyz-456]
  └─ Telemetry: SSR "LoadCustomerData" Succeeded, 3200ms [corr: xyz-456]
```

#### Correlation Schema

```jsonc
{
  "correlation": {
    "rootOperation": "LoadCustomerData",
    "iterationId": "abc-123",
    "correlationId": "xyz-456",
    "totalDurationMs": 3200,

    "httpRequests": [
      {
        "sequenceId": 421,
        "method": "GET",
        "url": "onelake/.../Tables/customers/_delta_log/",
        "statusCode": 200,
        "durationMs": 45.0,
        "offsetFromRootMs": 0
      },
      {
        "sequenceId": 422,
        "method": "GET",
        "url": "onelake/.../Tables/customers/part-0001.parquet",
        "statusCode": 200,
        "durationMs": 120.0,
        "offsetFromRootMs": 50
      }
    ],

    "perfMarkers": [
      { "operationName": "LoadCustomerData", "durationMs": 3200, "result": "Succeeded" }
    ],

    "telemetryEvents": [
      { "activityName": "LoadCustomerData", "activityStatus": "Succeeded", "durationMs": 3200 }
    ],

    "gaps": [
      "Spark HTTP calls NOT INTERCEPTED — GTSBasedSparkClient bypasses IHttpClientFactory (GAP-1)"
    ]
  }
}
```

#### Implementation

Cross-topic correlation is computed **on-demand** (not continuously) because it requires scanning multiple topic ring buffers:

1. User clicks a perf marker or telemetry event in the Runtime View.
2. EDOG extracts the `correlationId` and `iterationId`.
3. Backend scans `"http"`, `"perf"`, `"telemetry"`, `"spark"`, `"fileop"` buffers for matching entries.
4. Results are assembled into a correlation tree and returned.

For recorded sessions, the correlation scan runs over the JSONL file instead of ring buffers, joining with other topic recordings if available.

#### REST API

```
GET /api/correlation?correlationId=xyz-456    → CorrelationResult
GET /api/correlation?iterationId=abc-123      → CorrelationResult
GET /api/recordings/{id}/correlation?correlationId=xyz-456 → CorrelationResult
```

#### Limitations

| Limitation | Impact | Mitigation |
|-----------|--------|------------|
| GAP-1: Spark HTTP calls not intercepted | Missing the most critical execution calls from the correlation chain | Planned: Subclass `GTSBasedSparkClient`, override `SendHttpRequestAsync()` |
| GAP-2: Notebook fetches not intercepted | Missing notebook content fetches | Planned: Hook into `NotebookApiClient` |
| correlationId not always present | Some requests have no correlation header | Fall back to `iterationId` extracted from URL path or log messages |
| Ring buffer size limits | Old entries evicted from `"http"` (2000) and `"perf"` (5000) | Use recordings for long correlation windows |
| Cross-topic timing skew | Events in different topics may have slightly different timestamps | Sort by timestamp; accept ±10ms skew |

---

## 3. New Topic: `"recording"`

Register a new topic for recording lifecycle events:

```csharp
// In EdogTopicRouter.Initialize()
RegisterTopic("recording", 200);
```

Events published to this topic:

| Event Type | When | Data |
|-----------|------|------|
| `recording-started` | User starts recording | `{ sessionId, name, filter }` |
| `recording-entry` | Each entry captured (throttled to 1/sec summary) | `{ sessionId, entryCount, latestUrl, latestStatusCode }` |
| `recording-stopped` | User stops / auto-stop | `{ sessionId, status, entryCount, durationSeconds, fileSizeBytes }` |
| `baseline-activated` | User activates baseline | `{ baselineId, name, endpointCount }` |
| `regression-alert` | Deviation detected | Alert object (see OB-04) |
| `regression-cleared` | Deviation resolved | `{ alertId, clearedAt }` |

The frontend subscribes to `"recording"` to show live recording status in the panel header and regression alerts as toast notifications.

---

## 4. New Topic: `"observability"`

Register a topic for alerts and observability analysis results:

```csharp
RegisterTopic("observability", 500);
```

This separates observability events (alerts, graph updates, diff results) from recording lifecycle events. The frontend subscribes to both `"recording"` and `"observability"`.

---

## 5. Security Considerations

| Concern | Mitigation |
|---------|------------|
| Recordings contain URL paths with workspace/lakehouse GUIDs | GUIDs are not secrets — they're resource identifiers. Acceptable. |
| Request headers contain `Authorization: [redacted]` | Already redacted by `EdogHttpPipelineHandler.RedactRequestHeaders()`. Safe. |
| SAS tokens in URLs | Already redacted by `EdogHttpPipelineHandler.RedactUrl()`. Safe. |
| Response bodies may contain PII | Body preview is first 4KB only. HAR export includes a warning banner. User's responsibility to handle exported files appropriately. |
| Recording files on disk | Stored in `.edog/recordings/` which is gitignored. Local only. |
| HAR export shared externally | HAR export adds a comment: "WARNING: This file may contain sensitive data (URLs, headers, response bodies). Review before sharing." |

---

## 6. Performance Budget

| Component | Target | Rationale |
|-----------|--------|-----------|
| Recording overhead per entry | <0.5ms | Non-blocking channel write. File I/O on background thread. |
| Diff computation (10K entries) | <2s | Single-pass bucketing + statistics computation |
| Graph generation | <500ms | Simple host extraction + aggregation |
| Regression detection (per check) | <5ms | Rolling window update on latest entries only |
| Heatmap generation | <1s | Pre-bucketed by time windows |
| HAR export (10K entries) | <5s | Streaming write, no in-memory buffering of full file |
| Memory: active recording | <50MB | Entries written to JSONL, not held in memory |
| Memory: regression detector | <10MB | Rolling windows per endpoint signature |

---

## 7. Implementation Priority

| # | Scenario | Priority | Depends On | Effort |
|---|----------|----------|------------|--------|
| 1 | OB-01: HAR Recording | **P0** | `RecordingManager` C# class, JSONL writer, HAR export | 3 days (Vex) |
| 2 | OB-02: Traffic Diff | **P0** | OB-01, URL normalizer, diff algorithm | 2 days (Vex + Pixel) |
| 3 | OB-06: Error Rate Dashboard | **P1** | Live `"http"` topic subscription | 1 day (Pixel) |
| 4 | OB-03: Dependency Graph | **P1** | Service map config, graph layout | 2 days (Pixel) |
| 5 | OB-04: Regression Detection | **P1** | OB-01, baseline schema, sliding window | 2 days (Vex) |
| 6 | OB-05: Latency Heatmap | **P2** | OB-01 or live buffer, heatmap renderer | 1 day (Pixel) |
| 7 | OB-07: Payload Size Tracker | **P2** | New fields in `EdogHttpPipelineHandler` | 1 day (Vex) |
| 8 | OB-08: Request Correlation | **P2** | Cross-topic join, correlation ID propagation | 3 days (Vex + Sana) |

**Total estimated effort:** 15 engineer-days.

**Critical path:** OB-01 → OB-02 → OB-04. Everything else is parallelizable after OB-01.

---

## 8. Interaction with Other Categories

| Category | Interaction |
|----------|-------------|
| C01 (Request Surgery) | Recording captures the *mutated* request (after chaos rules apply). The `_edog.chaosRulesMatched` field tracks which rules fired. |
| C02 (Response Forgery) | Recording captures the *forged* response. Diff can show "before chaos" vs "during chaos". |
| C03 (Traffic Control) | Blocked requests appear in recording with the canned response. Delayed requests show inflated `durationMs`. |
| C04 (Security Probing) | Token swap/strip results visible in request headers. Auth failures visible in status codes. |
| C06 (Advanced) | AD-02 (Response Cache Mode) uses recordings as mock data. AD-08 (Waterfall Timeline) is a visualization of OB-08 correlation data. |

---

## 9. Open Questions

| # | Question | Impact | Decision Needed From |
|---|----------|--------|---------------------|
| 1 | Should recordings capture request bodies by default, or opt-in? | Storage size vs. diff quality. Large PUT bodies (Parquet files) can be megabytes. | Sana — **Decision: opt-in, off by default. `includeRequestBody: false` is the safe default.** |
| 2 | Max recording file size: 100MB or configurable? | Developer machines vary. | Sana — **Decision: 100MB default, configurable in `edog-config.json`.** |
| 3 | Should regression alerts integrate with the chaos kill switch? | Auto-disable chaos rules when regression detected during chaos experiment? | Sana — **Decision: No automatic coupling. The user may WANT regressions (that's the point of chaos testing). Surface the alert; let the user decide.** |
| 4 | Should we record non-HTTP topics (telemetry, perf, flags) alongside HTTP? | Enables richer OB-08 correlation from recordings. Increases file size. | Sana — **Deferred to P2. Start with HTTP-only recordings. Multi-topic recording is an OB-08 enhancement.** |

---

*"You can't fix what you can't see. You can't compare what you didn't record."*

— Sana Reeves, EDOG Studio Architecture
