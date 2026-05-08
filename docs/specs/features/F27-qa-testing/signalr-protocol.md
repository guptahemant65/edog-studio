# QA Testing Panel — SignalR Protocol Specification (P2)

> **Status:** SPEC — READY FOR REVIEW
> **Author:** Vex (Backend Engineer)
> **Date:** 2025-07-14
> **Authority:** F24 `signalr-protocol.md` (pattern reference), ADR-006
> **Depends On:** `spec.md` (§4 scenario model, §5 execution, §8.4 SignalR sketch), `C03-execution-engine.md` (eight-phase loop), `C05-results-reporting.md` (result data model), `C06-frontend-panel.md` (panel integration)
> **Applies To:** `EdogPlaygroundHub.cs`, `SignalRManager.js`, `QATestingPanel`, `EdogQaEngine`

---

## Overview

The QA Testing Panel communicates with the `EdogQaEngine` via the **same** `/hub/playground` SignalR hub used by Runtime View and F24 Chaos Engineering. All QA methods are added to `EdogPlaygroundHub`. The protocol follows the same patterns established in F24:

- **JSON** over SignalR (same wire format)
- **`ChannelReader<T>` streaming** for live execution events (snapshot + live, same as Runtime View topics)
- **`invoke()` RPC** for analysis, curation, execution control, and history queries (request → response)
- **`connection.on()` push events** for progress updates, scenario results, and error notifications (fire-and-forget broadcast)
- **Localhost-only CORS** (same security model as existing hub)
- **`TopicEvent` envelope** for streaming data (same `sequenceId` / `timestamp` / `topic` / `data` shape)
- **`correlationId`** on every message for request/response pairing and reconnection resume

New topic: `qa` — published to by `EdogQaEngine` for analysis progress, scenario events, execution results, and assertion outcomes.

---

## Hub Method Naming Convention

All QA methods are prefixed with `Qa` to avoid collision with existing hub methods and F24 `Chaos` methods:

```
Existing:     Subscribe, Unsubscribe, SubscribeToTopic
F24 Chaos:    ChaosCreateRule, ChaosEnableRule, ChaosSubscribeTraffic, ...
F27 QA:       QaStartCodeAnalysis, QaStartRun, QaSubscribeExecution, ...
```

---

## 1. Hub Methods (Client → Server)

### 1.1 Code Analysis

#### `QaStartCodeAnalysis`

Begins the five-layer code understanding pipeline for a PR. Triggers L1 (code-review-graph) + L2 (Graphify) + L3 (OmniSharp/Roslyn) → L5 (Runtime DI) → L4 (GPT-5.4-pro) → scenario generation.

```
Name:        QaStartCodeAnalysis
Parameters:  request: QaAnalysisRequest
Return:      QaAnalysisResult
Description: Start code understanding for a PR. Fetches diff from ADO, runs the
             five-layer analysis pipeline, generates scenarios. Returns immediately
             with a correlationId — progress streams via QaAnalysisProgress events.
             Only ONE analysis can run at a time. Starting a new one cancels the previous.
```

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `request` | `QaAnalysisRequest` | Yes | Analysis configuration |

**`QaAnalysisRequest` shape:**

```json
{
  "correlationId": "corr-a1b2c3d4",
  "prUrl": "https://dev.azure.com/powerbi/MWC/_git/workload-fabriclivetable/pullrequest/12345",
  "prId": 12345,
  "options": {
    "maxScenarios": 30,
    "categories": ["happy_path", "error_path", "edge_case", "regression", "performance"],
    "priorityThreshold": 5,
    "includeChaosSuggestions": true,
    "timeoutMs": 120000
  }
}
```

`prUrl` and `prId` are mutually acceptable — provide either. `options` fields are all optional (defaults shown).

**Return:** `QaAnalysisResult`

```json
{
  "success": true,
  "correlationId": "corr-a1b2c3d4",
  "analysisId": "analysis-20250714-143022",
  "message": "Code analysis started for PR #12345.",
  "cancelledPreviousAnalysis": null
}
```

If a previous analysis was running:

```json
{
  "success": true,
  "correlationId": "corr-a1b2c3d4",
  "analysisId": "analysis-20250714-143022",
  "message": "Code analysis started. Previous analysis 'analysis-20250714-142500' cancelled.",
  "cancelledPreviousAnalysis": "analysis-20250714-142500"
}
```

**Error Cases:**

| Condition | Behavior |
|-----------|----------|
| Empty/invalid PR URL and no prId | `success: false`, `message: "Valid PR URL or PR ID required"` |
| ADO API unreachable | `success: false`, `message: "Cannot reach Azure DevOps API: {details}"` |
| PR not found (404) | `success: false`, `message: "PR #12345 not found in workload-fabriclivetable"` |
| Not in Connected phase | `success: false`, `message: "QA Testing requires Connected phase (FLT running)"` |
| Missing correlationId | `success: false`, `message: "correlationId is required"` |

**Side Effects:**
- Cancels any in-progress analysis (emits `QaAnalysisCancelled` event)
- Broadcasts `QaAnalysisProgress` events as each layer completes
- On completion, broadcasts `QaScenarioGenerated` event per scenario
- Publishes events to `qa` topic buffer

---

#### `QaCancelAnalysis`

Cancels an in-progress code analysis.

```
Name:        QaCancelAnalysis
Parameters:  correlationId: string
Return:      QaOperationResult
Description: Cancel a running code analysis. If analysis is already complete or
             not found, returns success with appropriate message.
```

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `correlationId` | `string` | Yes | The correlationId from `QaStartCodeAnalysis` |

**Return:** `QaOperationResult`

```json
{
  "success": true,
  "correlationId": "corr-a1b2c3d4",
  "message": "Analysis cancelled."
}
```

**Error Cases:**

| Condition | Behavior |
|-----------|----------|
| No matching analysis found | `success: true`, `message: "No active analysis with this correlationId"` |

**Side Effects:**
- Cancels background analysis tasks (CancellationToken)
- Broadcasts `QaAnalysisCancelled` event

---

### 1.2 Scenario Curation

#### `QaSubmitCuratedScenarios`

Submits the user-approved set of scenarios for execution. The frontend sends the curated list after the user reviews, edits, deletes, and reorders AI-generated scenarios.

```
Name:        QaSubmitCuratedScenarios
Parameters:  submission: QaScenarioSubmission
Return:      QaSubmissionResult
Description: Submit curated scenarios. Validates each scenario schema.
             Returns a runId that can be used with QaStartRun.
             Scenarios are stored in memory and persisted to disk.
```

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `submission` | `QaScenarioSubmission` | Yes | Curated scenario set |

**`QaScenarioSubmission` shape:**

```json
{
  "correlationId": "corr-e5f6g7h8",
  "analysisId": "analysis-20250714-143022",
  "scenarios": [
    {
      "id": "scn-write-file-correct-path",
      "title": "WriteFileAsync writes to correct OneLake path with expected content",
      "category": "happy_path",
      "priority": 1,
      "impactZone": "zone-001",
      "setup": [],
      "stimulus": {
        "type": "dag_trigger",
        "dagTrigger": { "iterationId": "current", "nodeFilter": ["MaterializeNode_Table1"] }
      },
      "expectations": [
        {
          "id": "exp-1",
          "type": "event_present",
          "topic": "fileop",
          "matcher": { "exact": { "operation": "WriteFile" }, "contains": { "path": "/Tables/Table1/" } },
          "timeWindow": { "withinMs": 15000 },
          "description": "File write to OneLake at correct path"
        }
      ],
      "teardown": [],
      "timeout": 20000,
      "metadata": { "generatedBy": "ai", "confidence": 0.92 }
    }
  ]
}
```

**Return:** `QaSubmissionResult`

```json
{
  "success": true,
  "correlationId": "corr-e5f6g7h8",
  "runId": "run-20250714-143500",
  "scenarioCount": 12,
  "validationErrors": [],
  "message": "12 scenarios queued for execution."
}
```

**Error Cases:**

| Condition | Behavior |
|-----------|----------|
| Empty scenarios array | `success: false`, `message: "At least one scenario is required"` |
| Invalid scenario schema (missing required fields) | `success: false`, `validationErrors` populated per scenario |
| Duplicate scenario IDs | `success: false`, `validationErrors: [{ "scenarioId": "scn-dup", "field": "id", "message": "Duplicate scenario ID" }]` |
| analysisId not found | `success: false`, `message: "Analysis 'analysis-...' not found or expired"` |
| Missing correlationId | `success: false`, `message: "correlationId is required"` |
| Scenario count exceeds limit (>50) | `success: false`, `message: "Maximum 50 scenarios per run"` |

**Validation per scenario:**

| Field | Rule |
|-------|------|
| `id` | Must match `^scn-[a-z0-9-]+$` |
| `title` | Required, max 120 chars |
| `category` | Must be one of: `happy_path`, `error_path`, `edge_case`, `regression`, `performance` |
| `stimulus.type` | Must be one of: `http_request`, `signalr_invoke`, `dag_trigger`, `file_event`, `timer_tick` |
| `expectations` | Min 1 item. Each must have `id`, `type`, `topic` |
| `expectations[].id` | Must match `^exp-[0-9]+$` |
| `expectations[].type` | Must be one of: `event_present`, `event_absent`, `event_count`, `event_order`, `timing`, `field_match` |
| `expectations[].topic` | Must be a registered topic name |
| `timeout` | 1000–60000 ms |

**Side Effects:**
- Persists scenarios to `~/.edog/qa/scenarios/{runId}.json`
- Broadcasts `QaRunCreated` event

---

### 1.3 Execution Control

#### `QaStartRun`

Begins sequential execution of curated scenarios.

```
Name:        QaStartRun
Parameters:  request: QaRunRequest
Return:      QaOperationResult
Description: Start executing the scenario run. Scenarios execute sequentially
             through the eight-phase loop (ISOLATE → SETUP → MARK → STIMULATE →
             CAPTURE → EVALUATE → TEARDOWN → REPORT). Only ONE run can execute at
             a time. Returns error if a run is already in progress.
```

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `request` | `QaRunRequest` | Yes | Run configuration |

**`QaRunRequest` shape:**

```json
{
  "correlationId": "corr-i9j0k1l2",
  "runId": "run-20250714-143500",
  "scenarioIds": null,
  "options": {
    "stopOnFirstFailure": false,
    "interScenarioDelayMs": 500,
    "globalTimeoutMs": 1800000
  }
}
```

`scenarioIds`: Optional. If `null`, runs all scenarios in submission order. If provided, runs only those IDs in the given order.

`options` fields are all optional (defaults shown).

**Return:** `QaOperationResult`

```json
{
  "success": true,
  "correlationId": "corr-i9j0k1l2",
  "message": "Run started. Executing 12 scenarios."
}
```

**Error Cases:**

| Condition | Behavior |
|-----------|----------|
| Run not found | `success: false`, `message: "Run 'run-...' not found"` |
| Another run in progress | `success: false`, `message: "Run 'run-...' is already executing. Cancel it first."` |
| No scenarios in run | `success: false`, `message: "Run has no scenarios to execute"` |
| Invalid scenarioId in list | `success: false`, `message: "Scenario 'scn-...' not found in run"` |
| Not in Connected phase | `success: false`, `message: "Execution requires Connected phase (FLT running)"` |
| Kill switch active (F24) | `success: false`, `message: "Cannot start QA run while chaos kill switch is active"` |
| Missing correlationId | `success: false`, `message: "correlationId is required"` |

**Side Effects:**
- Starts the execution engine's eight-phase loop
- Broadcasts `QaRunStarted` event
- Broadcasts `QaScenarioStarted` / `QaExpectationMatched` / `QaScenarioCompleted` per scenario
- Publishes all events to `qa` topic buffer
- Persists execution state to `~/.edog/qa/state.json` (crash recovery)

---

#### `QaCancelRun`

Aborts an in-progress execution run.

```
Name:        QaCancelRun
Parameters:  correlationId: string, runId: string
Return:      QaOperationResult
Description: Cancel a running execution. The current scenario completes its teardown
             phase (chaos rules removed, flags restored) before the run stops.
             Remaining scenarios are marked as 'skipped'. Results for completed
             scenarios are preserved.
```

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `correlationId` | `string` | Yes | Correlation ID |
| `runId` | `string` | Yes | Run ID to cancel |

**Return:** `QaOperationResult`

```json
{
  "success": true,
  "correlationId": "corr-i9j0k1l2",
  "message": "Run cancelled. 5 scenarios completed, 7 skipped."
}
```

**Error Cases:**

| Condition | Behavior |
|-----------|----------|
| Run not found | `success: false`, `message: "Run not found"` |
| Run not in progress | `success: true`, `message: "Run is not executing (current state: 'completed')"` |

**Side Effects:**
- Triggers CancellationToken on the execution engine
- Current scenario completes TEARDOWN phase (safety — chaos rules must be cleaned up)
- Remaining scenarios → `skipped` status
- Broadcasts `QaRunCompleted` with `cancelledByUser: true`
- Clears execution state from `~/.edog/qa/state.json`

---

### 1.4 History & Results

#### `QaGetRunHistory`

Retrieves past run results.

```
Name:        QaGetRunHistory
Parameters:  request: QaHistoryRequest
Return:      QaRunSummary[]
Description: Retrieve past run summaries. Returns metadata only (not full scenario
             details). Sorted by startedAt descending (newest first).
```

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `request` | `QaHistoryRequest` | Yes | History query |

**`QaHistoryRequest` shape:**

```json
{
  "correlationId": "corr-m3n4o5p6",
  "prId": null,
  "limit": 20,
  "offset": 0
}
```

`prId`: Optional. If set, returns only runs for that PR. `limit`: Max 100. `offset`: For pagination.

**Return:** `QaRunSummary[]`

```json
[
  {
    "runId": "run-20250714-143500",
    "prId": 12345,
    "prTitle": "Fix WriteFileAsync retry logic",
    "startedAt": "2025-07-14T14:35:00Z",
    "completedAt": "2025-07-14T14:37:23Z",
    "totalDurationMs": 143000,
    "summary": {
      "total": 12,
      "passed": 10,
      "failed": 1,
      "timedOut": 1,
      "partial": 0,
      "crashed": 0,
      "skipped": 0
    },
    "overallPass": false
  }
]
```

**Error Cases:** None. Returns empty array if no runs found.

---

#### `QaGetRunDetail`

Retrieves full results for a specific run.

```
Name:        QaGetRunDetail
Parameters:  correlationId: string, runId: string
Return:      QaRunResult | null
Description: Retrieve complete run results including all scenario details,
             expectation outcomes, and captured evidence references.
             Returns null if run not found.
```

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `correlationId` | `string` | Yes | Correlation ID |
| `runId` | `string` | Yes | Run ID to retrieve |

**Return:** Full `QaRunResult` object (see [§3 Message Schemas](#3-message-schemas)) or `null`.

**Error Cases:** Returns `null` if run not found (not an error — frontend handles gracefully).

---

### 1.5 Execution Streaming

#### `QaSubscribeExecution`

Starts streaming live execution events via `ChannelReader<T>`. Follows the **exact same** pattern as `SubscribeToTopic` and `ChaosSubscribeTraffic`.

```
Name:        QaSubscribeExecution
Parameters:  runId: string, CancellationToken
Return:      ChannelReader<TopicEvent>  (streaming)
Description: Server-to-client stream of execution events for a specific run.
             Yields snapshot (events already emitted for this run) then live events
             as scenarios execute. Each event is wrapped in the standard TopicEvent
             envelope with topic "qa". Cancel the stream to stop.
```

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `runId` | `string` | Yes | Run to stream events for |
| `cancellationToken` | `CancellationToken` | Yes (injected by SignalR) | Stream cancellation |

**Return:** `ChannelReader<TopicEvent>` — streaming. Each event wraps a QA-specific payload in the `data` field.

**C# Implementation:**

```csharp
public ChannelReader<TopicEvent> QaSubscribeExecution(
    string runId,
    CancellationToken cancellationToken)
{
    var qaBuffer = EdogTopicRouter.GetBuffer("qa");
    if (qaBuffer == null)
        throw new ArgumentException("QA topic not registered");

    var channel = Channel.CreateBounded<TopicEvent>(
        new BoundedChannelOptions(2000)
        {
            FullMode = BoundedChannelFullMode.DropOldest,
            SingleReader = true,
            SingleWriter = false
        });

    _ = Task.Run(async () =>
    {
        try
        {
            // Phase 1: Snapshot — events already emitted for this run
            foreach (var item in qaBuffer.GetSnapshot())
            {
                if (IsQaEventForRun(item, runId))
                    await channel.Writer.WriteAsync(item, cancellationToken);
            }

            // Phase 2: Live events as they arrive
            await foreach (var item in qaBuffer.ReadLiveAsync(cancellationToken))
            {
                if (IsQaEventForRun(item, runId))
                    await channel.Writer.WriteAsync(item, cancellationToken);
            }
        }
        catch (OperationCanceledException) { /* Client unsubscribed — clean */ }
        finally
        {
            channel.Writer.Complete();
        }
    }, cancellationToken);

    return channel.Reader;
}

private static bool IsQaEventForRun(TopicEvent evt, string runId)
{
    // Filter qa topic events to only those matching the requested runId
    if (evt.Topic != "qa") return false;
    if (evt.Data is QaEventBase qaEvt) return qaEvt.RunId == runId;
    return false;
}
```

**Cancellation:** Client calls `stream.dispose()` in JS → `CancellationToken` fires on server → stream ends. Same behavior as `ChaosSubscribeTraffic`.

**Error Cases:**

| Condition | Behavior |
|-----------|----------|
| Unknown runId | Stream opens but yields no events (no snapshot, no live matches) |

---

## 2. Hub Methods (Server → Client)

Events pushed from the server to connected clients. Clients register handlers via `connection.on('EventName', callback)`.

### Event Delivery Model

| Event Type | Delivery | Audience |
|------------|----------|----------|
| Analysis progress events | Broadcast to `qa` group | Clients subscribed to qa topic |
| Scenario generated events | Broadcast to `qa` group | Clients subscribed to qa topic |
| Execution events | Broadcast to `qa` group + streamed via `ChannelReader` | `qa` group subscribers + `QaSubscribeExecution` clients |
| Result events | Broadcast to `qa` group | Clients subscribed to qa topic |
| Error events | Broadcast to `qa` group | Clients subscribed to qa topic |

**Subscribing to QA events:** Client calls `connection.invoke('Subscribe', 'qa')` — same group mechanism as existing topics and F24 `chaos` group. The QA Panel JS module calls this on activation.

---

### 2.1 Analysis Events

#### `QaAnalysisProgress`

**When:** Each layer of the five-layer code understanding engine completes a phase.

```json
{
  "eventType": "QaAnalysisProgress",
  "correlationId": "corr-a1b2c3d4",
  "analysisId": "analysis-20250714-143022",
  "timestamp": "2025-07-14T14:30:25.123Z",
  "phase": "roslyn_blast_radius",
  "phaseIndex": 1,
  "totalPhases": 6,
  "percentComplete": 15,
  "detail": "Analyzing blast radius... 12 files, 340 lines changed",
  "metrics": {
    "filesAnalyzed": 12,
    "linesChanged": 340,
    "impactZonesFound": 3,
    "elapsedMs": 2500
  }
}
```

**`phase` values (in order):**

| Phase | phaseIndex | Description |
|-------|-----------|-------------|
| `fetching_diff` | 0 | Downloading PR diff from ADO |
| `roslyn_blast_radius` | 1 | L1+L2: Structural blast radius via code-review-graph + Graphify |
| `semantic_analysis` | 2 | L3: OmniSharp/Roslyn semantic enrichment |
| `di_validation` | 3 | L5: Runtime DI registry validation |
| `scenario_generation` | 4 | L4: GPT-5.4-pro reasoning + scenario generation |
| `complete` | 5 | All layers done, scenarios ready |

**Frequency:** 1-3 events per phase. Total: 6-18 events per analysis run. Low frequency — no throttling needed.

**Ordering:** Events are ordered by `phaseIndex`. Within a phase, multiple progress events may fire (e.g., for large diffs analyzed in batches).

---

#### `QaAnalysisCancelled`

**When:** Analysis is cancelled by user or superseded by a new analysis.

```json
{
  "eventType": "QaAnalysisCancelled",
  "correlationId": "corr-a1b2c3d4",
  "analysisId": "analysis-20250714-143022",
  "timestamp": "2025-07-14T14:31:00Z",
  "reason": "user_cancelled",
  "phasesCompleted": 2
}
```

**`reason` values:** `"user_cancelled"`, `"superseded"` (new analysis started), `"timeout"`, `"error"`

---

#### `QaScenarioGenerated`

**When:** A scenario is generated by the LLM (L4). Scenarios stream in one at a time as GPT-5.4-pro produces them.

```json
{
  "eventType": "QaScenarioGenerated",
  "correlationId": "corr-a1b2c3d4",
  "analysisId": "analysis-20250714-143022",
  "timestamp": "2025-07-14T14:31:15.456Z",
  "scenarioIndex": 0,
  "totalExpected": 12,
  "scenario": {
    "id": "scn-write-file-correct-path",
    "title": "WriteFileAsync writes to correct OneLake path with expected content",
    "description": "Verifies that the modified WriteFileAsync correctly writes parquet files to the OneLake path.",
    "category": "happy_path",
    "priority": 1,
    "impactZone": "zone-001",
    "setup": [],
    "stimulus": {
      "type": "dag_trigger",
      "dagTrigger": { "iterationId": "current", "nodeFilter": ["MaterializeNode_Table1"] }
    },
    "expectations": [
      {
        "id": "exp-1",
        "type": "event_present",
        "topic": "fileop",
        "matcher": {
          "exact": { "operation": "WriteFile" },
          "contains": { "path": "/Tables/Table1/" },
          "range": { "contentSizeBytes": { "min": 1 } }
        },
        "timeWindow": { "withinMs": 15000 },
        "description": "File write to OneLake at correct path with non-empty content"
      }
    ],
    "teardown": [],
    "timeout": 20000,
    "metadata": {
      "generatedBy": "ai",
      "confidence": 0.92,
      "relatedPRFiles": ["src/Services/OneLakeClient.cs"],
      "tags": ["fileop", "onelake"]
    }
  }
}
```

**Frequency:** One per scenario. For a typical PR: 5-30 events over ~10-15 seconds (as LLM streams responses).

**`totalExpected`:** Best-effort estimate. May change as generation proceeds. Frontend should not rely on this for progress bar completion — use `phase: "complete"` from `QaAnalysisProgress` instead.

**Ordering:** `scenarioIndex` is zero-based and monotonically increasing. Gaps indicate scenarios that were generated but filtered by deduplication.

---

### 2.2 Execution Events

#### `QaRunStarted`

**When:** `QaStartRun` begins execution.

```json
{
  "eventType": "QaRunStarted",
  "correlationId": "corr-i9j0k1l2",
  "runId": "run-20250714-143500",
  "timestamp": "2025-07-14T14:35:00Z",
  "prId": 12345,
  "prTitle": "Fix WriteFileAsync retry logic",
  "scenarioCount": 12,
  "scenarioIds": ["scn-write-file-correct-path", "scn-retry-on-429-throttle", "..."],
  "options": {
    "stopOnFirstFailure": false,
    "interScenarioDelayMs": 500,
    "globalTimeoutMs": 1800000
  }
}
```

**Frequency:** Once per run.

---

#### `QaScenarioStarted`

**When:** The execution engine begins a scenario's eight-phase loop.

```json
{
  "eventType": "QaScenarioStarted",
  "correlationId": "corr-i9j0k1l2",
  "runId": "run-20250714-143500",
  "timestamp": "2025-07-14T14:35:01.200Z",
  "scenarioId": "scn-write-file-correct-path",
  "scenarioIndex": 0,
  "totalScenarios": 12,
  "title": "WriteFileAsync writes to correct OneLake path with expected content",
  "category": "happy_path",
  "phase": "isolate",
  "expectationCount": 2
}
```

**`phase`:** Always `"isolate"` when this event fires. Subsequent phase transitions are communicated via `QaScenarioPhaseChanged`.

---

#### `QaScenarioPhaseChanged`

**When:** A scenario transitions between execution phases.

```json
{
  "eventType": "QaScenarioPhaseChanged",
  "correlationId": "corr-i9j0k1l2",
  "runId": "run-20250714-143500",
  "timestamp": "2025-07-14T14:35:01.500Z",
  "scenarioId": "scn-write-file-correct-path",
  "phase": "stimulate",
  "previousPhase": "mark",
  "phaseDurationMs": 12,
  "detail": "Delivering stimulus: dag_trigger (MaterializeNode_Table1)"
}
```

**`phase` values (in order):** `"isolate"`, `"setup"`, `"mark"`, `"stimulate"`, `"capture"`, `"evaluate"`, `"teardown"`, `"report"`

**Frequency:** 8 events per scenario (one per phase). During `capture` phase, additional `QaExpectationMatched` events fire.

---

#### `QaExpectationMatched`

**When:** During the CAPTURE phase, an interceptor event matches (or fails to match) an expectation. This is the real-time match indicator that powers the green/red expectation badges in the frontend.

```json
{
  "eventType": "QaExpectationMatched",
  "correlationId": "corr-i9j0k1l2",
  "runId": "run-20250714-143500",
  "timestamp": "2025-07-14T14:35:04.321Z",
  "scenarioId": "scn-write-file-correct-path",
  "expectationId": "exp-1",
  "status": "passed",
  "matchedEvent": {
    "sequenceId": 45678,
    "timestamp": "2025-07-14T14:35:04.100Z",
    "topic": "fileop",
    "data": {
      "operation": "WriteFile",
      "path": "/Tables/Table1/part-00001.parquet",
      "contentSizeBytes": 524288
    }
  },
  "matchLatencyMs": 3100,
  "description": "File write to OneLake at correct path with non-empty content"
}
```

**For failed expectations (evaluated at end of capture window):**

```json
{
  "eventType": "QaExpectationMatched",
  "correlationId": "corr-i9j0k1l2",
  "runId": "run-20250714-143500",
  "timestamp": "2025-07-14T14:35:24.000Z",
  "scenarioId": "scn-retry-on-429-throttle",
  "expectationId": "exp-3",
  "status": "failed",
  "matchedEvent": null,
  "closestMiss": {
    "sequenceId": 45690,
    "timestamp": "2025-07-14T14:35:22.800Z",
    "topic": "http",
    "data": {
      "method": "PUT",
      "statusCode": 500,
      "url": "https://dfs.fabric.microsoft.com/..."
    }
  },
  "failureReason": "Expected HTTP 201, observed HTTP 500 — retries did not recover",
  "matchLatencyMs": -1,
  "description": "Final request succeeds after retries"
}
```

**`status` values:** `"passed"`, `"failed"`, `"unmatched"`, `"skipped"`

**Frequency:** One per expectation per scenario. For a typical scenario with 3-5 expectations: 3-5 events. `passed` events fire in real-time as matches occur. `failed` and `unmatched` events fire after the capture window expires.

**Ordering:** `passed` events fire in the order matches occur (may differ from expectation ID order). `failed`/`unmatched` events fire after all positive evaluations complete.

---

#### `QaScenarioCompleted`

**When:** All eight phases complete for a scenario. Contains the full result.

```json
{
  "eventType": "QaScenarioCompleted",
  "correlationId": "corr-i9j0k1l2",
  "runId": "run-20250714-143500",
  "timestamp": "2025-07-14T14:35:10.500Z",
  "scenarioId": "scn-write-file-correct-path",
  "scenarioIndex": 0,
  "totalScenarios": 12,
  "result": {
    "scenarioId": "scn-write-file-correct-path",
    "title": "WriteFileAsync writes to correct OneLake path with expected content",
    "category": "happy_path",
    "verdict": "passed",
    "durationMs": 8432,
    "startedAt": "2025-07-14T14:35:01.200Z",
    "completedAt": "2025-07-14T14:35:09.632Z",
    "expectations": [
      {
        "expectationId": "exp-1",
        "description": "File write to OneLake at correct path with non-empty content",
        "status": "passed",
        "matchedEvent": {
          "sequenceId": 45678,
          "timestamp": "2025-07-14T14:35:04.100Z",
          "topic": "fileop",
          "data": { "operation": "WriteFile", "path": "/Tables/Table1/part-00001.parquet" }
        },
        "closestMiss": null,
        "failureReason": null,
        "matchLatencyMs": 3100
      }
    ],
    "eventsCaptured": 47,
    "errorMessage": null
  },
  "runProgress": {
    "completed": 1,
    "passed": 1,
    "failed": 0,
    "remaining": 11
  }
}
```

**`verdict` values:** `"passed"`, `"failed"`, `"partial"`, `"timed_out"`, `"crashed"`, `"skipped"`

**Frequency:** One per scenario. For 12 scenarios: 12 events.

---

#### `QaRunCompleted`

**When:** All scenarios have completed (or the run was cancelled/timed out).

```json
{
  "eventType": "QaRunCompleted",
  "correlationId": "corr-i9j0k1l2",
  "runId": "run-20250714-143500",
  "timestamp": "2025-07-14T14:37:23.000Z",
  "prId": 12345,
  "prTitle": "Fix WriteFileAsync retry logic",
  "prUrl": "https://dev.azure.com/powerbi/MWC/_git/workload-fabriclivetable/pullrequest/12345",
  "startedAt": "2025-07-14T14:35:00Z",
  "completedAt": "2025-07-14T14:37:23Z",
  "totalDurationMs": 143000,
  "cancelledByUser": false,
  "summary": {
    "total": 12,
    "passed": 10,
    "failed": 1,
    "timedOut": 1,
    "partial": 0,
    "crashed": 0,
    "skipped": 0,
    "overallPass": false
  },
  "performance": {
    "slowestScenarioMs": 30000,
    "slowestScenarioId": "scn-retry-on-429-throttle",
    "averageScenarioMs": 11917,
    "totalExecutionMs": 138000,
    "overheadMs": 5000
  },
  "unobservablePaths": [
    "src/Services/Internal/BackgroundSyncService.cs (no stimulus entry point)"
  ]
}
```

**Frequency:** Once per run.

---

### 2.3 Error Events

#### `QaError`

**When:** A non-recoverable error occurs during analysis, curation validation, or execution.

```json
{
  "eventType": "QaError",
  "correlationId": "corr-a1b2c3d4",
  "runId": "run-20250714-143500",
  "timestamp": "2025-07-14T14:35:05.000Z",
  "errorCode": "STIMULUS_DELIVERY_FAILED",
  "message": "Failed to deliver stimulus: POST /liveTableSchedule/runDAG/current returned 500",
  "scenarioId": "scn-write-file-correct-path",
  "phase": "stimulate",
  "severity": "error",
  "recoverable": true,
  "detail": "HTTP 500 Internal Server Error — FLT may be in a bad state. Scenario will be marked as crashed."
}
```

**Error codes:**

| Code | Severity | Description |
|------|----------|-------------|
| `ANALYSIS_DIFF_FETCH_FAILED` | `error` | Cannot retrieve PR diff from ADO |
| `ANALYSIS_ROSLYN_FAILED` | `warning` | Roslyn analysis failed — falling back to text diff |
| `ANALYSIS_LLM_FAILED` | `error` | GPT-5.4-pro timeout or error |
| `ANALYSIS_LLM_PARTIAL` | `warning` | LLM returned partial results — using what we have |
| `STIMULUS_DELIVERY_FAILED` | `error` | Could not deliver stimulus to FLT |
| `CAPTURE_TIMEOUT` | `warning` | Capture window expired before all expectations evaluated |
| `CHAOS_SETUP_FAILED` | `error` | Failed to inject F24 chaos rule |
| `TEARDOWN_INCOMPLETE` | `warning` | Teardown could not fully clean up (chaos rules may remain) |
| `RUN_GLOBAL_TIMEOUT` | `error` | Global run timeout (30min) exceeded |
| `FLT_PROCESS_UNRESPONSIVE` | `error` | FLT stopped responding during execution |
| `INTERNAL_ERROR` | `error` | Unexpected engine error |

**`severity` values:** `"info"`, `"warning"`, `"error"`

**`recoverable`:** If `true`, execution continues to the next scenario. If `false`, the entire run is aborted.

**Frequency:** 0 on happy path. One per error. Capped at 50 error events per run (after which remaining errors are suppressed with a single "error limit reached" event).

---

## 3. Message Schemas

### 3.1 TypeScript Interfaces

```typescript
// === Correlation ===

/** Every QA message carries a correlationId for request/response pairing */
interface QaCorrelated {
  correlationId: string;
}

// === Enums ===

type ScenarioCategory = 'happy_path' | 'error_path' | 'edge_case' | 'regression' | 'performance';

type StimulusType = 'http_request' | 'signalr_invoke' | 'dag_trigger' | 'file_event' | 'timer_tick';

type ExpectationType = 'event_present' | 'event_absent' | 'event_count'
  | 'event_order' | 'timing' | 'field_match';

type ExpectationStatus = 'passed' | 'failed' | 'unmatched' | 'skipped';

type ScenarioVerdict = 'passed' | 'failed' | 'partial' | 'timed_out' | 'crashed' | 'skipped';

type ExecutionPhase = 'isolate' | 'setup' | 'mark' | 'stimulate'
  | 'capture' | 'evaluate' | 'teardown' | 'report';

type AnalysisPhase = 'fetching_diff' | 'roslyn_blast_radius' | 'semantic_analysis'
  | 'di_validation' | 'scenario_generation' | 'complete';

type SetupStepType = 'chaos_rule' | 'flag_override' | 'state_seed' | 'wait';

type TeardownStepType = 'remove_chaos_rule' | 'restore_flag' | 'cleanup_state';

type QaErrorCode =
  | 'ANALYSIS_DIFF_FETCH_FAILED'
  | 'ANALYSIS_ROSLYN_FAILED'
  | 'ANALYSIS_LLM_FAILED'
  | 'ANALYSIS_LLM_PARTIAL'
  | 'STIMULUS_DELIVERY_FAILED'
  | 'CAPTURE_TIMEOUT'
  | 'CHAOS_SETUP_FAILED'
  | 'TEARDOWN_INCOMPLETE'
  | 'RUN_GLOBAL_TIMEOUT'
  | 'FLT_PROCESS_UNRESPONSIVE'
  | 'INTERNAL_ERROR';

type QaErrorSeverity = 'info' | 'warning' | 'error';

type ScenarioGeneratedBy = 'ai' | 'manual' | 'template';

// === Interceptor Topic Names ===

type TopicName = 'log' | 'telemetry' | 'fileop' | 'spark' | 'token' | 'cache'
  | 'http' | 'retry' | 'flag' | 'di' | 'perf' | 'capacity' | 'catalog'
  | 'dag' | 'flt-ops' | 'nexus' | 'qa' | 'chaos';

// === TopicEvent (existing envelope) ===

interface TopicEvent {
  sequenceId: number;
  timestamp: string;  // ISO 8601 UTC
  topic: string;
  data: unknown;
}

// === Client → Server: Request Types ===

interface QaAnalysisRequest extends QaCorrelated {
  prUrl?: string;
  prId?: number;
  options?: {
    maxScenarios?: number;           // default: 30
    categories?: ScenarioCategory[]; // default: all
    priorityThreshold?: number;      // default: 5
    includeChaosSuggestions?: boolean; // default: true
    timeoutMs?: number;              // default: 120000
  };
}

interface QaScenarioSubmission extends QaCorrelated {
  analysisId: string;
  scenarios: QaScenario[];
}

interface QaRunRequest extends QaCorrelated {
  runId: string;
  scenarioIds?: string[] | null;    // null = run all in order
  options?: {
    stopOnFirstFailure?: boolean;    // default: false
    interScenarioDelayMs?: number;   // default: 500
    globalTimeoutMs?: number;        // default: 1800000 (30 min)
  };
}

interface QaHistoryRequest extends QaCorrelated {
  prId?: number | null;
  limit?: number;   // default: 20, max: 100
  offset?: number;  // default: 0
}

// === Client → Server: Response Types ===

interface QaAnalysisResult extends QaCorrelated {
  success: boolean;
  analysisId?: string;
  message: string;
  cancelledPreviousAnalysis?: string | null;
}

interface QaSubmissionResult extends QaCorrelated {
  success: boolean;
  runId?: string;
  scenarioCount?: number;
  message: string;
  validationErrors: QaValidationError[];
}

interface QaOperationResult extends QaCorrelated {
  success: boolean;
  message: string;
}

interface QaValidationError {
  scenarioId?: string;
  field: string;
  message: string;
}

// === Scenario Model ===

interface QaScenario {
  id: string;                        // ^scn-[a-z0-9-]+$
  title: string;                     // max 120 chars
  description?: string;              // max 500 chars
  category: ScenarioCategory;
  priority: number;                  // 1 (critical) to 5 (nice-to-have)
  impactZone?: string;
  setup: QaSetupStep[];
  stimulus: QaStimulus;
  expectations: QaExpectation[];     // min 1
  teardown: QaTeardownStep[];
  timeout: number;                   // ms, 1000–60000
  metadata?: QaScenarioMetadata;
}

interface QaSetupStep {
  type: SetupStepType;
  chaosRule?: {
    target: string;
    fault: string;
    parameters: Record<string, unknown>;
  };
  flagOverride?: {
    flagName: string;
    value: boolean;
  };
  stateSeed?: {
    method: string;
    url: string;
    body?: Record<string, unknown>;
  };
  wait?: {
    durationMs: number;
  };
}

interface QaStimulus {
  type: StimulusType;
  httpRequest?: {
    method: string;
    path: string;
    headers?: Record<string, string>;
    body?: Record<string, unknown>;
  };
  signalrInvoke?: {
    hub: string;
    method: string;
    args: unknown[];
  };
  dagTrigger?: {
    iterationId: string;
    nodeFilter?: string[];
  };
  fileEvent?: {
    path: string;
    content?: string;
    sizeBytes?: number;
  };
  timerTick?: {
    advanceMs?: number;
    waitForNext?: boolean;
  };
}

interface QaExpectation {
  id: string;                        // ^exp-[0-9]+$
  type: ExpectationType;
  topic: TopicName;
  matcher?: QaMatcher;
  timeWindow?: {
    withinMs?: number;
    afterMs?: number;
  };
  count?: {
    min?: number;
    max?: number;
    exact?: number;
  };
  order?: {
    after?: string;                  // expectation ID
  };
  description: string;
}

interface QaMatcher {
  exact?: Record<string, unknown>;
  contains?: Record<string, string>;
  regex?: Record<string, string>;
  range?: Record<string, { min?: number; max?: number }>;
  exists?: string[];
}

interface QaTeardownStep {
  type: TeardownStepType;
}

interface QaScenarioMetadata {
  generatedBy: ScenarioGeneratedBy;
  confidence: number;                // 0.0 – 1.0
  relatedPRFiles?: string[];
  tags?: string[];
}

// === Server → Client: Event Types ===

interface QaAnalysisProgressEvent {
  eventType: 'QaAnalysisProgress';
  correlationId: string;
  analysisId: string;
  timestamp: string;
  phase: AnalysisPhase;
  phaseIndex: number;
  totalPhases: number;               // always 6
  percentComplete: number;           // 0–100
  detail: string;
  metrics?: {
    filesAnalyzed?: number;
    linesChanged?: number;
    impactZonesFound?: number;
    elapsedMs?: number;
  };
}

interface QaAnalysisCancelledEvent {
  eventType: 'QaAnalysisCancelled';
  correlationId: string;
  analysisId: string;
  timestamp: string;
  reason: 'user_cancelled' | 'superseded' | 'timeout' | 'error';
  phasesCompleted: number;
}

interface QaScenarioGeneratedEvent {
  eventType: 'QaScenarioGenerated';
  correlationId: string;
  analysisId: string;
  timestamp: string;
  scenarioIndex: number;
  totalExpected: number;
  scenario: QaScenario;
}

interface QaRunStartedEvent {
  eventType: 'QaRunStarted';
  correlationId: string;
  runId: string;
  timestamp: string;
  prId: number;
  prTitle: string;
  scenarioCount: number;
  scenarioIds: string[];
  options: {
    stopOnFirstFailure: boolean;
    interScenarioDelayMs: number;
    globalTimeoutMs: number;
  };
}

interface QaScenarioStartedEvent {
  eventType: 'QaScenarioStarted';
  correlationId: string;
  runId: string;
  timestamp: string;
  scenarioId: string;
  scenarioIndex: number;
  totalScenarios: number;
  title: string;
  category: ScenarioCategory;
  phase: 'isolate';
  expectationCount: number;
}

interface QaScenarioPhaseChangedEvent {
  eventType: 'QaScenarioPhaseChanged';
  correlationId: string;
  runId: string;
  timestamp: string;
  scenarioId: string;
  phase: ExecutionPhase;
  previousPhase: ExecutionPhase;
  phaseDurationMs: number;
  detail?: string;
}

interface QaExpectationMatchedEvent {
  eventType: 'QaExpectationMatched';
  correlationId: string;
  runId: string;
  timestamp: string;
  scenarioId: string;
  expectationId: string;
  status: ExpectationStatus;
  matchedEvent: TopicEvent | null;
  closestMiss?: TopicEvent | null;
  failureReason?: string | null;
  matchLatencyMs: number;           // -1 if not matched
  description: string;
}

interface QaScenarioCompletedEvent {
  eventType: 'QaScenarioCompleted';
  correlationId: string;
  runId: string;
  timestamp: string;
  scenarioId: string;
  scenarioIndex: number;
  totalScenarios: number;
  result: QaScenarioResult;
  runProgress: {
    completed: number;
    passed: number;
    failed: number;
    remaining: number;
  };
}

interface QaRunCompletedEvent {
  eventType: 'QaRunCompleted';
  correlationId: string;
  runId: string;
  timestamp: string;
  prId: number;
  prTitle: string;
  prUrl: string;
  startedAt: string;
  completedAt: string;
  totalDurationMs: number;
  cancelledByUser: boolean;
  summary: QaRunSummary;
  performance: QaPerformanceReport;
  unobservablePaths: string[];
}

interface QaErrorEvent {
  eventType: 'QaError';
  correlationId: string;
  runId?: string;
  timestamp: string;
  errorCode: QaErrorCode;
  message: string;
  scenarioId?: string;
  phase?: ExecutionPhase;
  severity: QaErrorSeverity;
  recoverable: boolean;
  detail?: string;
}

// === Result Types ===

interface QaScenarioResult {
  scenarioId: string;
  title: string;
  category: ScenarioCategory;
  verdict: ScenarioVerdict;
  durationMs: number;
  startedAt: string;
  completedAt: string;
  expectations: QaExpectationResult[];
  eventsCaptured: number;
  errorMessage?: string | null;
}

interface QaExpectationResult {
  expectationId: string;
  description: string;
  status: ExpectationStatus;
  matchedEvent: TopicEvent | null;
  closestMiss?: TopicEvent | null;
  failureReason?: string | null;
  matchLatencyMs: number;
}

interface QaRunSummary {
  total: number;
  passed: number;
  failed: number;
  timedOut: number;
  partial: number;
  crashed: number;
  skipped: number;
  overallPass: boolean;
}

interface QaRunResult {
  runId: string;
  prId: number;
  prTitle: string;
  prUrl: string;
  startedAt: string;
  completedAt: string;
  totalDurationMs: number;
  cancelledByUser: boolean;
  summary: QaRunSummary;
  scenarios: QaScenarioResult[];
  unobservablePaths: string[];
  performance: QaPerformanceReport;
}

interface QaPerformanceReport {
  slowestScenarioMs: number;
  slowestScenarioId: string;
  averageScenarioMs: number;
  totalExecutionMs: number;
  overheadMs: number;
}
```

### 3.2 C# Classes

```csharp
// src/backend/DevMode/QaSignalRModels.cs (NEW — to be created)

#nullable disable
#pragma warning disable // DevMode-only file

namespace Microsoft.LiveTable.Service.DevMode
{
    using System;
    using System.Collections.Generic;

    // === Enums ===

    public enum ScenarioCategory { HappyPath, ErrorPath, EdgeCase, Regression, Performance }
    public enum StimulusType { HttpRequest, SignalrInvoke, DagTrigger, FileEvent, TimerTick }
    public enum ExpectationType { EventPresent, EventAbsent, EventCount, EventOrder, Timing, FieldMatch }
    public enum ExpectationStatus { Passed, Failed, Unmatched, Skipped }
    public enum ScenarioVerdict { Passed, Failed, Partial, TimedOut, Crashed, Skipped }
    public enum ExecutionPhase { Isolate, Setup, Mark, Stimulate, Capture, Evaluate, Teardown, Report }
    public enum AnalysisPhase { FetchingDiff, RoslynBlastRadius, SemanticAnalysis, DiValidation, ScenarioGeneration, Complete }
    public enum QaErrorSeverity { Info, Warning, Error }

    // === Base class for qa topic events ===

    public abstract class QaEventBase
    {
        public string EventType { get; set; }
        public string CorrelationId { get; set; }
        public string RunId { get; set; }
        public DateTimeOffset Timestamp { get; set; }
    }

    // === Client → Server: Requests ===

    public sealed class QaAnalysisRequest
    {
        public string CorrelationId { get; set; }
        public string PrUrl { get; set; }
        public int? PrId { get; set; }
        public QaAnalysisOptions Options { get; set; }
    }

    public sealed class QaAnalysisOptions
    {
        public int MaxScenarios { get; set; } = 30;
        public List<string> Categories { get; set; }
        public int PriorityThreshold { get; set; } = 5;
        public bool IncludeChaosSuggestions { get; set; } = true;
        public int TimeoutMs { get; set; } = 120000;
    }

    public sealed class QaScenarioSubmission
    {
        public string CorrelationId { get; set; }
        public string AnalysisId { get; set; }
        public List<QaScenario> Scenarios { get; set; }
    }

    public sealed class QaRunRequest
    {
        public string CorrelationId { get; set; }
        public string RunId { get; set; }
        public List<string> ScenarioIds { get; set; }   // null = run all
        public QaRunOptions Options { get; set; }
    }

    public sealed class QaRunOptions
    {
        public bool StopOnFirstFailure { get; set; } = false;
        public int InterScenarioDelayMs { get; set; } = 500;
        public int GlobalTimeoutMs { get; set; } = 1800000;
    }

    public sealed class QaHistoryRequest
    {
        public string CorrelationId { get; set; }
        public int? PrId { get; set; }
        public int Limit { get; set; } = 20;
        public int Offset { get; set; } = 0;
    }

    // === Client → Server: Responses ===

    public sealed class QaAnalysisResult
    {
        public bool Success { get; set; }
        public string CorrelationId { get; set; }
        public string AnalysisId { get; set; }
        public string Message { get; set; }
        public string CancelledPreviousAnalysis { get; set; }
    }

    public sealed class QaSubmissionResult
    {
        public bool Success { get; set; }
        public string CorrelationId { get; set; }
        public string RunId { get; set; }
        public int ScenarioCount { get; set; }
        public string Message { get; set; }
        public List<QaValidationError> ValidationErrors { get; set; } = new();
    }

    public sealed class QaOperationResult
    {
        public bool Success { get; set; }
        public string CorrelationId { get; set; }
        public string Message { get; set; }
    }

    public sealed class QaValidationError
    {
        public string ScenarioId { get; set; }
        public string Field { get; set; }
        public string Message { get; set; }
    }

    // === Scenario Model ===

    public sealed class QaScenario
    {
        public string Id { get; set; }
        public string Title { get; set; }
        public string Description { get; set; }
        public string Category { get; set; }
        public int Priority { get; set; }
        public string ImpactZone { get; set; }
        public List<QaSetupStep> Setup { get; set; } = new();
        public QaStimulus Stimulus { get; set; }
        public List<QaExpectation> Expectations { get; set; }
        public List<QaTeardownStep> Teardown { get; set; } = new();
        public int Timeout { get; set; } = 30000;
        public QaScenarioMetadata Metadata { get; set; }
    }

    public sealed class QaSetupStep
    {
        public string Type { get; set; }
        public QaChaosRuleSetup ChaosRule { get; set; }
        public QaFlagOverride FlagOverride { get; set; }
        public QaStateSeed StateSeed { get; set; }
        public QaWaitStep Wait { get; set; }
    }

    public sealed class QaChaosRuleSetup
    {
        public string Target { get; set; }
        public string Fault { get; set; }
        public Dictionary<string, object> Parameters { get; set; }
    }

    public sealed class QaFlagOverride
    {
        public string FlagName { get; set; }
        public bool Value { get; set; }
    }

    public sealed class QaStateSeed
    {
        public string Method { get; set; }
        public string Url { get; set; }
        public Dictionary<string, object> Body { get; set; }
    }

    public sealed class QaWaitStep
    {
        public int DurationMs { get; set; }
    }

    public sealed class QaStimulus
    {
        public string Type { get; set; }
        public QaHttpStimulus HttpRequest { get; set; }
        public QaSignalrStimulus SignalrInvoke { get; set; }
        public QaDagStimulus DagTrigger { get; set; }
        public QaFileStimulus FileEvent { get; set; }
        public QaTimerStimulus TimerTick { get; set; }
    }

    public sealed class QaHttpStimulus
    {
        public string Method { get; set; }
        public string Path { get; set; }
        public Dictionary<string, string> Headers { get; set; }
        public Dictionary<string, object> Body { get; set; }
    }

    public sealed class QaSignalrStimulus
    {
        public string Hub { get; set; }
        public string Method { get; set; }
        public List<object> Args { get; set; }
    }

    public sealed class QaDagStimulus
    {
        public string IterationId { get; set; }
        public List<string> NodeFilter { get; set; }
    }

    public sealed class QaFileStimulus
    {
        public string Path { get; set; }
        public string Content { get; set; }
        public long? SizeBytes { get; set; }
    }

    public sealed class QaTimerStimulus
    {
        public int? AdvanceMs { get; set; }
        public bool WaitForNext { get; set; }
    }

    public sealed class QaExpectation
    {
        public string Id { get; set; }
        public string Type { get; set; }
        public string Topic { get; set; }
        public QaMatcher Matcher { get; set; }
        public QaTimeWindow TimeWindow { get; set; }
        public QaCountConstraint Count { get; set; }
        public QaOrderConstraint Order { get; set; }
        public string Description { get; set; }
    }

    public sealed class QaMatcher
    {
        public Dictionary<string, object> Exact { get; set; }
        public Dictionary<string, string> Contains { get; set; }
        public Dictionary<string, string> Regex { get; set; }
        public Dictionary<string, QaRange> Range { get; set; }
        public List<string> Exists { get; set; }
    }

    public sealed class QaRange
    {
        public double? Min { get; set; }
        public double? Max { get; set; }
    }

    public sealed class QaTimeWindow
    {
        public int? WithinMs { get; set; }
        public int? AfterMs { get; set; }
    }

    public sealed class QaCountConstraint
    {
        public int? Min { get; set; }
        public int? Max { get; set; }
        public int? Exact { get; set; }
    }

    public sealed class QaOrderConstraint
    {
        public string After { get; set; }
    }

    public sealed class QaTeardownStep
    {
        public string Type { get; set; }
    }

    public sealed class QaScenarioMetadata
    {
        public string GeneratedBy { get; set; }
        public double Confidence { get; set; }
        public List<string> RelatedPRFiles { get; set; }
        public List<string> Tags { get; set; }
    }

    // === Result Types ===

    public sealed class QaExpectationResult
    {
        public string ExpectationId { get; set; }
        public string Description { get; set; }
        public string Status { get; set; }
        public TopicEvent MatchedEvent { get; set; }
        public TopicEvent ClosestMiss { get; set; }
        public string FailureReason { get; set; }
        public long MatchLatencyMs { get; set; }
    }

    public sealed class QaScenarioResult
    {
        public string ScenarioId { get; set; }
        public string Title { get; set; }
        public string Category { get; set; }
        public string Verdict { get; set; }
        public long DurationMs { get; set; }
        public DateTimeOffset StartedAt { get; set; }
        public DateTimeOffset CompletedAt { get; set; }
        public List<QaExpectationResult> Expectations { get; set; }
        public int EventsCaptured { get; set; }
        public string ErrorMessage { get; set; }
    }

    public sealed class QaRunSummaryData
    {
        public int Total { get; set; }
        public int Passed { get; set; }
        public int Failed { get; set; }
        public int TimedOut { get; set; }
        public int Partial { get; set; }
        public int Crashed { get; set; }
        public int Skipped { get; set; }
        public bool OverallPass => Failed == 0 && Crashed == 0;
    }

    public sealed class QaPerformanceReport
    {
        public long SlowestScenarioMs { get; set; }
        public string SlowestScenarioId { get; set; }
        public long AverageScenarioMs { get; set; }
        public long TotalExecutionMs { get; set; }
        public long OverheadMs { get; set; }
    }

    public sealed class QaRunResult
    {
        public string RunId { get; set; }
        public int PrId { get; set; }
        public string PrTitle { get; set; }
        public string PrUrl { get; set; }
        public DateTimeOffset StartedAt { get; set; }
        public DateTimeOffset CompletedAt { get; set; }
        public long TotalDurationMs { get; set; }
        public bool CancelledByUser { get; set; }
        public QaRunSummaryData Summary { get; set; }
        public List<QaScenarioResult> Scenarios { get; set; }
        public List<string> UnobservablePaths { get; set; }
        public QaPerformanceReport Performance { get; set; }
    }
}
```

---

## 4. Event Sequences

### 4.1 Full QA Run — PR Input to Completion

```
Browser (QA Panel)                        FLT Process (EdogQaEngine)
──────────────────                        ──────────────────────────

Subscribe('qa')                ────────► Add to 'qa' group

QaStartCodeAnalysis({                  ► PrDiffFetcher.FetchAsync()
  correlationId: "corr-001",             │
  prUrl: "...pullrequest/12345"          │
})                                       │
  ◄──── QaAnalysisResult {              │
          success: true,                 │
          analysisId: "analysis-001"     │
        }                                │
                                         │
  ◄──── QaAnalysisProgress {            ◄─ ADO diff fetched
          phase: "fetching_diff",        │
          percentComplete: 5 }           │
                                         │
  ◄──── QaAnalysisProgress {            ◄─ L1+L2 complete
          phase: "roslyn_blast_radius",  │
          percentComplete: 25 }          │
                                         │
  ◄──── QaAnalysisProgress {            ◄─ L3 complete
          phase: "semantic_analysis",    │
          percentComplete: 50 }          │
                                         │
  ◄──── QaAnalysisProgress {            ◄─ L5 complete
          phase: "di_validation",        │
          percentComplete: 65 }          │
                                         │
  ◄──── QaScenarioGenerated {           ◄─ L4 streaming (scenario 1)
          scenarioIndex: 0,              │
          scenario: {...} }              │
                                         │
  ◄──── QaScenarioGenerated {           ◄─ L4 streaming (scenario 2)
          scenarioIndex: 1,              │
          scenario: {...} }              │
                                         │
  ... (repeat for each scenario) ...     │
                                         │
  ◄──── QaAnalysisProgress {            ◄─ All layers done
          phase: "complete",             │
          percentComplete: 100 }         │
                                         │
── User reviews/curates scenarios ──     │
                                         │
QaSubmitCuratedScenarios({     ────────► Validate + store scenarios
  correlationId: "corr-002",             │
  analysisId: "analysis-001",            │
  scenarios: [...]                       │
})                                       │
  ◄──── QaSubmissionResult {            │
          success: true,                 │
          runId: "run-001" }             │
                                         │
QaSubscribeExecution("run-001")────────► Open ChannelReader stream
  ◄ (stream opens, snapshot phase)       │
                                         │
QaStartRun({                   ────────► ExecutionEngine.StartAsync()
  correlationId: "corr-003",             │
  runId: "run-001"                       │
})                                       │
  ◄──── QaOperationResult { success }   │
  ◄──── QaRunStarted { ... }            │
                                         │
  ── Scenario 1: execution loop ──       │
                                         │
  ◄──── QaScenarioStarted {            ◄─ ISOLATE
          scenarioId: "scn-001" }        │
  ◄──── QaScenarioPhaseChanged {        ◄─ SETUP
          phase: "setup" }               │
  ◄──── QaScenarioPhaseChanged {        ◄─ MARK
          phase: "mark" }                │
  ◄──── QaScenarioPhaseChanged {        ◄─ STIMULATE
          phase: "stimulate" }           │
  ◄──── QaScenarioPhaseChanged {        ◄─ CAPTURE (events flowing)
          phase: "capture" }             │
  ◄──── QaExpectationMatched {          ◄─ exp-1 passes
          expectationId: "exp-1",        │
          status: "passed" }             │
  ◄──── QaExpectationMatched {          ◄─ exp-2 passes
          expectationId: "exp-2",        │
          status: "passed" }             │
  ◄──── QaScenarioPhaseChanged {        ◄─ EVALUATE
          phase: "evaluate" }            │
  ◄──── QaScenarioPhaseChanged {        ◄─ TEARDOWN
          phase: "teardown" }            │
  ◄──── QaScenarioCompleted {           ◄─ REPORT
          verdict: "passed",             │
          runProgress: { completed:1 } } │
                                         │
  ── 500ms inter-scenario gap ──         │
                                         │
  ... (repeat for each scenario) ...     │
                                         │
  ◄──── QaRunCompleted {                ◄─ All done
          summary: { total:12,           │
            passed:10, failed:1,         │
            timedOut:1 } }               │
                                         │
  stream.dispose()             ────────► ChannelReader cancelled
```

### 4.2 Scenario with Chaos Setup (Error Path)

```
Browser                                   FLT Process
───────                                   ───────────

  ◄──── QaScenarioStarted {
          scenarioId: "scn-retry-429" }

  ── ISOLATE: fresh recording session ──

  ── SETUP: inject chaos rule ──

  ◄──── QaScenarioPhaseChanged {
          phase: "setup",
          detail: "Injecting chaos: http_error 429" }

         (internally: ChaosRuleEngine.AddRule(...))

  ── MARK: record T0 ──

  ◄──── QaScenarioPhaseChanged {
          phase: "stimulate",
          detail: "DAG trigger: MaterializeNode_Table1" }

         (internally: POST /liveTableSchedule/runDAG/current)

  ── CAPTURE: interceptor events streaming ──

  ◄──── QaExpectationMatched {
          expectationId: "exp-1",
          status: "passed" }             (retry events detected)

  ◄──── QaExpectationMatched {
          expectationId: "exp-2",
          status: "passed" }             (backoff timing OK)

         ... capture window expires ...

  ◄──── QaExpectationMatched {
          expectationId: "exp-3",
          status: "failed",
          failureReason: "Expected HTTP 201, observed HTTP 500" }

  ── TEARDOWN: remove chaos rule ──

  ◄──── QaScenarioPhaseChanged {
          phase: "teardown",
          detail: "Removing chaos rule: http_error 429" }

         (internally: ChaosRuleEngine.RemoveRulesForScenario(...))

  ◄──── QaScenarioCompleted {
          verdict: "failed",
          result: { expectations: [...] } }
```

### 4.3 Cancel Mid-Run

```
Browser                                   FLT Process
───────                                   ───────────

  ◄──── QaScenarioStarted { scenarioId: "scn-005" }
  ◄──── QaScenarioPhaseChanged { phase: "capture" }

QaCancelRun("corr-003", "run-001") ────► CancellationToken.Cancel()
  ◄──── QaOperationResult { success }

         (engine finishes current scenario's TEARDOWN)

  ◄──── QaScenarioPhaseChanged { phase: "teardown" }
  ◄──── QaScenarioCompleted {
          verdict: "crashed",
          errorMessage: "Cancelled by user" }

         (remaining 7 scenarios → skipped)

  ◄──── QaRunCompleted {
          cancelledByUser: true,
          summary: { completed:5, skipped:7 } }
```

### 4.4 Error During Analysis

```
Browser                                   FLT Process
───────                                   ───────────

QaStartCodeAnalysis({...})     ────────► Start pipeline
  ◄──── QaAnalysisResult { success }

  ◄──── QaAnalysisProgress {
          phase: "fetching_diff" }

  ◄──── QaAnalysisProgress {
          phase: "roslyn_blast_radius" }

         (OmniSharp fails to load solution)

  ◄──── QaError {
          errorCode: "ANALYSIS_ROSLYN_FAILED",
          severity: "warning",
          message: "Roslyn failed — falling back to text diff" }

  ◄──── QaAnalysisProgress {
          phase: "scenario_generation" }
         (continues with reduced context)

  ◄──── QaScenarioGenerated { ... }
         (fewer/lower-confidence scenarios)

  ◄──── QaAnalysisProgress {
          phase: "complete" }
```

### 4.5 Reconnection Mid-Execution

```
Browser                                   FLT Process
───────                                   ───────────

  ◄──── QaScenarioStarted { scn-003 }
  ◄──── QaScenarioPhaseChanged { capture }
  ◄──── QaExpectationMatched { exp-1 passed }

         ╳ Connection drops ╳

         ... FLT continues executing ...
         (execution is NOT paused or cancelled)

         ... SignalR auto-reconnect ...
         [0, 1000, 2000, 5000, 10000, 30000] ms backoff

  ──── OnReconnected ────

  Subscribe('qa')              ────────► Re-add to 'qa' group

  QaSubscribeExecution("run-001") ────► Fresh ChannelReader
    ◄ snapshot: all qa events since    │ Phase 1: yields events from
      run started (from qa topic       │ qa TopicBuffer snapshot
      ring buffer — 1000 event cap)    │
                                       │ Phase 2: live events resume
  ◄──── QaScenarioCompleted { scn-003 }  (if still executing)
  ◄──── QaScenarioStarted { scn-004 }
  ...
```

**Key reconnection guarantees:**
1. Execution NEVER pauses on disconnect — it runs server-side to completion
2. `qa` topic ring buffer (1000 events) holds recent history for snapshot hydration
3. Client re-calls `QaSubscribeExecution(runId)` — gets snapshot of missed events + live stream
4. If ring buffer overflowed during disconnect (>1000 events missed), client calls `QaGetRunDetail(runId)` for complete state
5. `correlationId` lets client match response to original request after reconnection

---

## 5. Existing Protocol Integration

### 5.1 Hub Registration

All QA methods are added to the **same** `EdogPlaygroundHub` class, alongside existing and F24 methods:

```csharp
public sealed class EdogPlaygroundHub : Hub
{
    // === Existing Methods (unchanged) ===
    public async Task Subscribe(string topic) { ... }
    public async Task Unsubscribe(string topic) { ... }
    public ChannelReader<TopicEvent> SubscribeToTopic(string topic, CancellationToken ct) { ... }

    // === F24 Chaos Methods (unchanged) ===
    public Task<ChaosRuleResult> ChaosCreateRule(ChaosRuleInput rule) { ... }
    public Task<ChaosOperationResult> ChaosEnableRule(string ruleId) { ... }
    // ... (all other Chaos methods unchanged)

    // === F27 QA: Analysis ===
    public Task<QaAnalysisResult> QaStartCodeAnalysis(QaAnalysisRequest request) { ... }
    public Task<QaOperationResult> QaCancelAnalysis(string correlationId) { ... }

    // === F27 QA: Curation ===
    public Task<QaSubmissionResult> QaSubmitCuratedScenarios(QaScenarioSubmission submission) { ... }

    // === F27 QA: Execution ===
    public Task<QaOperationResult> QaStartRun(QaRunRequest request) { ... }
    public Task<QaOperationResult> QaCancelRun(string correlationId, string runId) { ... }
    public ChannelReader<TopicEvent> QaSubscribeExecution(string runId, CancellationToken ct) { ... }

    // === F27 QA: History ===
    public Task<QaRunSummary[]> QaGetRunHistory(QaHistoryRequest request) { ... }
    public Task<QaRunResult> QaGetRunDetail(string correlationId, string runId) { ... }
}
```

### 5.2 New Topic: `qa`

Registered with `EdogTopicRouter`:

```csharp
EdogTopicRouter.RegisterTopic("qa", 1000);  // 1000-event ring buffer for QA events
```

The `qa` topic carries all QA events: `QaAnalysisProgress`, `QaScenarioGenerated`, `QaRunStarted`, `QaScenarioStarted`, `QaScenarioPhaseChanged`, `QaExpectationMatched`, `QaScenarioCompleted`, `QaRunCompleted`, `QaError`. Clients subscribe via `connection.invoke('Subscribe', 'qa')`.

Buffer size rationale: 1000 events covers a full run (12 scenarios × ~15 events each = ~180 events) with room for history. Larger than `chaos` (500) because QA events include scenario generation which can burst.

### 5.3 Topic Naming Convention

| Feature | Topic | Buffer | Group |
|---------|-------|--------|-------|
| Runtime View | `log`, `telemetry`, `http`, ... (16 topics) | Varies | Per-topic groups |
| F24 Chaos | `chaos` | 500 | `chaos` group |
| F27 QA | `qa` | 1000 | `qa` group |

All QA events use `topic: "qa"` in the `TopicEvent` envelope. The `data` field contains the typed QA payload with `eventType` for discriminated dispatch.

### 5.4 Backward Compatibility

QA methods are **purely additive** — no existing hub methods are modified or removed:

- `Subscribe/Unsubscribe` — unchanged. Now also accepts `"qa"` as a topic.
- `SubscribeToTopic` — unchanged. `"qa"` returns QA events through the standard topic buffer mechanism.
- All 16 existing topic buffers — unchanged. QA's `RecordingSession` reads from them but never mutates them.
- F24 Chaos methods — unchanged. QA's chaos integration calls `ChaosRuleEngine` internally, not through hub methods.

**Cross-panel safety:** QA execution's `RecordingSession` creates additive snapshots of `TopicBuffer` positions. It never clears buffers, never disrupts `ChannelReader` streams, and never interferes with Runtime View or Chaos Panel streaming. Multiple panels can be active simultaneously.

### 5.5 CORS & Security

Same configuration as existing hub — no changes needed. All QA methods are protected by the localhost-only CORS policy. Kestrel binds to `localhost:5557`.

### 5.6 F24 Chaos Interaction

QA scenarios with `setup.type: "chaos_rule"` interact with F24's `ChaosRuleEngine` **internally** (not through SignalR):

```csharp
// During scenario SETUP phase
await _chaosEngine.AddRule(new ChaosRule {
    Id = $"qa-{scenario.Id}-{Guid.NewGuid():N}",
    Target = setup.ChaosRule.Target,
    Fault = setup.ChaosRule.Fault,
    Parameters = setup.ChaosRule.Parameters,
    Tags = new[] { $"qa-run:{runId}", $"qa-scenario:{scenario.Id}" }
});

// During scenario TEARDOWN phase
await _chaosEngine.RemoveRulesByTag($"qa-scenario:{scenario.Id}");
```

This means:
- QA chaos rules appear in the Chaos Panel (via `RuleCreated` broadcast) — visible but clearly tagged
- QA chaos rules are subject to the kill switch (F24 safety)
- QA will not start if `ChaosRuleEngine.KillSwitchActive == true`

---

## 6. Performance & Reliability

### 6.1 Message Rate Limits

| Event | Max Rate | Notes |
|-------|----------|-------|
| `QaAnalysisProgress` | 3/sec | Low frequency — one per analysis layer |
| `QaScenarioGenerated` | 5/sec | Bounded by LLM output speed |
| `QaScenarioPhaseChanged` | 16/sec | 8 phases × 2 concurrent (scenario + teardown overlap) |
| `QaExpectationMatched` | 20/sec | One per expectation. Typical: 3-5 per scenario |
| `QaScenarioCompleted` | 2/sec | One per scenario, 500ms gap between scenarios |
| `QaRunCompleted` | 1/run | Once |
| `QaError` | 10/sec | Capped at 50 per run then suppressed |

**Total sustained rate during execution:** ~30-40 events/sec peak (during rapid CAPTURE+EVALUATE cycles). Well within SignalR capacity.

### 6.2 Backpressure Handling

`QaSubscribeExecution` uses the same bounded channel pattern as `SubscribeToTopic` and `ChaosSubscribeTraffic`:

```csharp
var channel = Channel.CreateBounded<TopicEvent>(
    new BoundedChannelOptions(2000)
    {
        FullMode = BoundedChannelFullMode.DropOldest,
        SingleReader = true,
        SingleWriter = false
    });
```

If the client can't consume events fast enough:
1. Channel buffer absorbs burst (2000 events)
2. Oldest events are dropped (`DropOldest`)
3. `QaScenarioCompleted` and `QaRunCompleted` are the critical events — if these are dropped, client falls back to `QaGetRunDetail(runId)` on reconnect
4. Frontend should not do expensive DOM operations in event handlers — batch UI updates with `requestAnimationFrame`

### 6.3 Message Ordering Guarantees

| Guarantee | Scope |
|-----------|-------|
| Events for a single scenario are strictly ordered | Per scenario |
| `QaScenarioStarted` always precedes `QaExpectationMatched` | Per scenario |
| `QaExpectationMatched` always precedes `QaScenarioCompleted` | Per scenario |
| `QaScenarioCompleted` always precedes next `QaScenarioStarted` | Per run |
| `QaRunStarted` always precedes all scenario events | Per run |
| `QaRunCompleted` always follows all scenario events | Per run |
| Cross-scenario ordering matches execution order | Sequential guarantee |

**No ordering guarantees across:**
- Different runs (should not happen — only one run at a time)
- Analysis events vs execution events (different phases)

### 6.4 Reconnection Protocol

Same as existing hub reconnection, extended for QA:

1. SignalR auto-reconnects: `[0, 1000, 2000, 5000, 10000, 30000]` ms backoff
2. On reconnect, client re-subscribes: `connection.invoke('Subscribe', 'qa')`
3. Client re-calls `QaSubscribeExecution(runId)` — gets snapshot from `qa` topic buffer + live stream
4. If snapshot is insufficient (ring buffer overflow), client calls `QaGetRunDetail(runId)` for authoritative state
5. Frontend reconciles: compare `runProgress` from last received `QaScenarioCompleted` with snapshot data

**Execution continues server-side during disconnect.** The engine does not pause or cancel on client disconnect. Results are preserved in memory and on disk (`~/.edog/qa/state.json`).

### 6.5 Message Size Limits

| Message | Typical Size | Max Size | Notes |
|---------|-------------|----------|-------|
| `QaScenarioGenerated` | 2-5 KB | 20 KB | Includes full scenario JSON |
| `QaExpectationMatched` | 0.5-2 KB | 10 KB | Includes matched/closest-miss event |
| `QaScenarioCompleted` | 3-10 KB | 50 KB | Full result with all expectations |
| `QaRunCompleted` | 1-3 KB | 10 KB | Summary only (no scenario details) |
| `QaGetRunDetail` response | 10-100 KB | 500 KB | Full run with all scenarios |

**Mitigation for large payloads:**
- `QaScenarioCompleted` does NOT include `capturedEvents` array (that would be 50K events). It includes `eventsCaptured` count only. Full evidence is available via `QaGetRunDetail`.
- `QaRunCompleted` includes summary only, not individual scenario results. Frontend already has per-scenario results from `QaScenarioCompleted` events.
- `QaGetRunDetail` response for very large runs (50 scenarios) may approach 500KB. This is a one-time fetch, not streamed.

### 6.6 Performance Budget

| Metric | Target | Notes |
|--------|--------|-------|
| `QaStartCodeAnalysis` round-trip | < 100ms | Starts background pipeline, returns immediately |
| `QaSubmitCuratedScenarios` round-trip | < 200ms | Schema validation + disk persist |
| `QaStartRun` round-trip | < 50ms | Starts execution loop, returns immediately |
| `QaCancelRun` round-trip | < 100ms | Triggers CancellationToken |
| `QaGetRunHistory` round-trip | < 100ms | Reads from in-memory cache |
| `QaGetRunDetail` round-trip | < 500ms | Reads from disk if not in memory |
| Event latency (engine → browser) | < 100ms | Through ChannelReader stream |
| `qa` topic buffer writes | < 1ms | Same as existing TopicRouter.Publish() |

### 6.7 Error Handling

**Server-Side:** All hub methods use structured error responses (`success: false` + `message`), NOT `HubException` throws. This matches the F24 pattern and ensures the frontend always gets a parseable response.

**Exception:** Only `QaSubscribeExecution` throws `ArgumentException` for an unregistered topic (following existing `SubscribeToTopic` pattern). All other methods return result objects.

**Client-Side:**

```javascript
try {
  const result = await signalr.qaStartRun(request);
  if (!result.success) {
    this._showError(result.message);
  }
} catch (err) {
  // SignalR transport error (disconnected, timeout)
  this._showConnectionError(err);
}
```

---

## 7. JS Client Integration

### 7.1 SignalRManager Extensions

New methods added to `SignalRManager` (same class, same file):

```javascript
// === QA: Analysis ===
qaStartCodeAnalysis(request)      { return this.connection.invoke('QaStartCodeAnalysis', request); }
qaCancelAnalysis(correlationId)   { return this.connection.invoke('QaCancelAnalysis', correlationId); }

// === QA: Curation ===
qaSubmitCuratedScenarios(submission) { return this.connection.invoke('QaSubmitCuratedScenarios', submission); }

// === QA: Execution ===
qaStartRun(request)               { return this.connection.invoke('QaStartRun', request); }
qaCancelRun(correlationId, runId) { return this.connection.invoke('QaCancelRun', correlationId, runId); }

// === QA: History ===
qaGetRunHistory(request)          { return this.connection.invoke('QaGetRunHistory', request); }
qaGetRunDetail(correlationId, id) { return this.connection.invoke('QaGetRunDetail', correlationId, id); }
```

### 7.2 Execution Streaming

Uses the same `ChannelReader` streaming pattern as `subscribeTopic()` and `chaosSubscribeTraffic()`:

```javascript
qaSubscribeExecution(runId) {
  if (this._qaExecutionStream) return;  // already streaming

  const stream = this.connection.stream('QaSubscribeExecution', runId);
  this._qaExecutionStream = stream;

  stream.subscribe({
    next: (event) => {
      const cbs = this._listeners.get('qa');
      if (cbs) cbs.forEach(cb => {
        try { cb(event); } catch (e) { console.error('[qa-stream]', e); }
      });
    },
    error: (err) => {
      console.error('[qa-stream error]', err);
      this._qaExecutionStream = null;
    },
    complete: () => {
      this._qaExecutionStream = null;
    }
  });
}

qaUnsubscribeExecution() {
  if (this._qaExecutionStream) {
    try { this._qaExecutionStream.dispose(); } catch (e) { /* already closed */ }
    this._qaExecutionStream = null;
  }
}
```

### 7.3 Event Handlers

Registered during QA panel initialization:

```javascript
// QA events (via qa group broadcast)
this.connection.on('QaAnalysisProgress',    (e) => this._dispatch('qa', e));
this.connection.on('QaAnalysisCancelled',   (e) => this._dispatch('qa', e));
this.connection.on('QaScenarioGenerated',   (e) => this._dispatch('qa', e));
this.connection.on('QaRunStarted',          (e) => this._dispatch('qa', e));
this.connection.on('QaScenarioStarted',     (e) => this._dispatch('qa', e));
this.connection.on('QaScenarioPhaseChanged',(e) => this._dispatch('qa', e));
this.connection.on('QaExpectationMatched',  (e) => this._dispatch('qa', e));
this.connection.on('QaScenarioCompleted',   (e) => this._dispatch('qa', e));
this.connection.on('QaRunCompleted',        (e) => this._dispatch('qa', e));
this.connection.on('QaError',               (e) => this._dispatch('qa', e));
```

**Note:** Unlike F24's `KillSwitchActivated` (which is global), QA events are panel-scoped. They are registered when the QA panel activates and unregistered on deactivate.

### 7.4 Reconnection

On reconnect, the QA panel module re-hydrates:

```javascript
async _onReconnected() {
  // Re-subscribe to qa group
  this._signalr.subscribe('qa');

  // Re-start execution stream if a run was active
  if (this._activeRunId) {
    this._signalr.qaSubscribeExecution(this._activeRunId);

    // Fetch authoritative state in case events were missed
    const detail = await this._signalr.qaGetRunDetail(
      this._correlationId, this._activeRunId
    );
    if (detail) {
      this._reconcileState(detail);
    }
  }
}
```

---

## Appendix A: Method Quick Reference

### Client → Server (Hub Methods)

| Method | Parameters | Return | Category |
|--------|-----------|--------|----------|
| `QaStartCodeAnalysis` | `request: QaAnalysisRequest` | `QaAnalysisResult` | Analysis |
| `QaCancelAnalysis` | `correlationId: string` | `QaOperationResult` | Analysis |
| `QaSubmitCuratedScenarios` | `submission: QaScenarioSubmission` | `QaSubmissionResult` | Curation |
| `QaStartRun` | `request: QaRunRequest` | `QaOperationResult` | Execution |
| `QaCancelRun` | `correlationId: string, runId: string` | `QaOperationResult` | Execution |
| `QaSubscribeExecution` | `runId: string, CancellationToken` | `ChannelReader<TopicEvent>` | Execution |
| `QaGetRunHistory` | `request: QaHistoryRequest` | `QaRunSummary[]` | History |
| `QaGetRunDetail` | `correlationId: string, runId: string` | `QaRunResult?` | History |

### Server → Client (Events)

| Event | Payload | Delivery | Audience |
|-------|---------|----------|----------|
| `QaAnalysisProgress` | See §2.1 | Group broadcast | `qa` group |
| `QaAnalysisCancelled` | See §2.1 | Group broadcast | `qa` group |
| `QaScenarioGenerated` | See §2.1 | Group broadcast | `qa` group |
| `QaRunStarted` | See §2.2 | Group broadcast | `qa` group |
| `QaScenarioStarted` | See §2.2 | Group broadcast + stream | `qa` group + stream clients |
| `QaScenarioPhaseChanged` | See §2.2 | Group broadcast + stream | `qa` group + stream clients |
| `QaExpectationMatched` | See §2.2 | Group broadcast + stream | `qa` group + stream clients |
| `QaScenarioCompleted` | See §2.2 | Group broadcast + stream | `qa` group + stream clients |
| `QaRunCompleted` | See §2.2 | Group broadcast + stream | `qa` group + stream clients |
| `QaError` | See §2.3 | Group broadcast | `qa` group |
