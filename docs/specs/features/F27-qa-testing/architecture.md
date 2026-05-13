# F27 QA Testing — P2 Architecture

> **Author:** Sana (Architecture & FLT Internals)
> **Date:** 2025-07-14
> **Status:** P2 Architecture
> **Parent:** `docs/specs/features/F27-qa-testing/spec.md`
> **Inputs:** P0 Foundation (`research/p0-foundation.md`), Viability Analysis (`research/viability-analysis.md`), Components C01–C06
> **Goal:** A senior engineer can implement from this spec without asking questions.

---

## Table of Contents

1. [Data Model](#1-data-model)
2. [Core Engine — Code Understanding Pipeline](#2-core-engine--code-understanding-pipeline)
3. [Core Engine — Execution Pipeline](#3-core-engine--execution-pipeline)
4. [Storage & Persistence](#4-storage--persistence)
5. [Safety Mechanisms](#5-safety-mechanisms)

---

## 1. Data Model

This section defines every domain object in the system. All C# classes live in namespace `Microsoft.LiveTable.Service.DevMode` with `#nullable disable` and `#pragma warning disable` per project convention (`TopicEvent.cs:5`, `EdogTopicRouter.cs:5`).

### 1.1 C# Domain Objects

```csharp
// ═══════════════════════════════════════════════════════════════════
// File: src/backend/DevMode/QaModels.cs (NEW)
// All domain objects for F27.
// ═══════════════════════════════════════════════════════════════════

#nullable disable
#pragma warning disable

namespace Microsoft.LiveTable.Service.DevMode;

using System;
using System.Collections.Generic;
using System.Text.Json.Serialization;

// ───────────────────────── Enums ─────────────────────────

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum ScenarioCategory
{
    HappyPath,
    ErrorPath,
    EdgeCase,
    Regression,
    Performance
}

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum ScenarioLifecycle
{
    Generated,
    Curated,
    Queued,
    Executing,
    Completed,
    Failed,
    TimedOut,
    Archived,
    Deleted
}

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum StimulusType
{
    HttpRequest,
    SignalrInvoke,
    DagTrigger,
    FileEvent,
    TimerTick,
    DirectInvoke
}

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum SetupStepType
{
    ChaosRule,
    FlagOverride,
    StateSeed,
    Wait
}

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum TeardownStepType
{
    RemoveChaosRule,
    RestoreFlag,
    CleanupState
}

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum ExpectationType
{
    EventPresent,
    EventAbsent,
    EventCount,
    EventOrder,
    Timing,
    FieldMatch
}

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum ScenarioVerdict
{
    Passed,
    Failed,
    Partial,
    TimedOut,
    Crashed,
    Skipped
}

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum ExpectationStatus
{
    Passed,
    Failed,
    Unmatched,
    Skipped
}

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum ExecutionPhase
{
    Isolate,
    Setup,
    Mark,
    Stimulate,
    Capture,
    Evaluate,
    Teardown,
    Report
}

// ───────────────────────── Scenario Model ─────────────────────────

/// <summary>
/// Root scenario object. Contract between C01 (generator), C02 (curation),
/// C03 (execution), C04 (assertion), and C06 (frontend).
/// Pattern: scn-{slug}-{4-char-hash}, e.g. "scn-write-file-correct-path-a1b2"
/// </summary>
public sealed class Scenario
{
    public string Id { get; set; }              // "scn-write-file-correct-path-a1b2"
    public string Title { get; set; }           // max 120 chars
    public string Description { get; set; }     // max 500 chars
    public ScenarioCategory Category { get; set; }
    public int Priority { get; set; }           // 1=critical, 5=nice-to-have
    public string ImpactZone { get; set; }      // "zone-001" — back-reference to Roslyn zone
    public ScenarioLifecycle Lifecycle { get; set; }
    public List<SetupStep> Setup { get; set; } = new();
    public Stimulus Stimulus { get; set; }
    public List<Expectation> Expectations { get; set; } = new();
    public List<TeardownStep> Teardown { get; set; } = new();
    public int TimeoutMs { get; set; } = 30_000;  // default 30s, min 1000, max 60000
    public ScenarioMetadata Metadata { get; set; } = new();
}

public sealed class ScenarioMetadata
{
    public string GeneratedBy { get; set; }     // "ai", "manual", "template"
    public double Confidence { get; set; }      // 0.0–1.0
    public List<string> RelatedPRFiles { get; set; } = new();
    public List<string> Tags { get; set; } = new();
    public int SchemaVersion { get; set; } = 1;
    public DateTimeOffset GeneratedAt { get; set; }
    public string CuratedBy { get; set; }       // null if auto-approved
    public DateTimeOffset? CuratedAt { get; set; }
}

// ───────────────────────── Setup / Teardown ─────────────────────────

public sealed class SetupStep
{
    public SetupStepType Type { get; set; }
    public ChaosRuleSpec ChaosRule { get; set; }
    public FlagOverrideSpec FlagOverride { get; set; }
    public StateSeedSpec StateSeed { get; set; }
    public WaitSpec Wait { get; set; }
}

public sealed class ChaosRuleSpec
{
    public string Target { get; set; }          // URL pattern or service name
    public string Fault { get; set; }           // "http_error", "latency", "timeout", "partial_response"
    public Dictionary<string, object> Parameters { get; set; } = new();
}

public sealed class FlagOverrideSpec
{
    public string FlagName { get; set; }
    public bool Value { get; set; }
}

public sealed class StateSeedSpec
{
    public string Method { get; set; }          // HTTP method
    public string Url { get; set; }
    public object Body { get; set; }
}

public sealed class WaitSpec
{
    public int DurationMs { get; set; }
}

public sealed class TeardownStep
{
    public TeardownStepType Type { get; set; }
}

// ───────────────────────── Stimulus ─────────────────────────

public sealed class Stimulus
{
    public StimulusType Type { get; set; }
    public HttpRequestSpec HttpRequest { get; set; }
    public SignalRInvokeSpec SignalrInvoke { get; set; }
    public DagTriggerSpec DagTrigger { get; set; }
    public FileEventSpec FileEvent { get; set; }
    public TimerTickSpec TimerTick { get; set; }
    public DirectInvokeSpec DirectInvoke { get; set; }
}

public sealed class HttpRequestSpec
{
    public string Method { get; set; } = "GET";
    public string Path { get; set; }            // relative to FLT Kestrel
    public Dictionary<string, string> Headers { get; set; } = new();
    public object Body { get; set; }
    public string ContentType { get; set; } = "application/json";
}

public sealed class SignalRInvokeSpec
{
    public string Hub { get; set; }
    public string Method { get; set; }
    public List<object> Args { get; set; } = new();
    public string ConnectionId { get; set; }    // null = broadcast
}

public sealed class DagTriggerSpec
{
    public string IterationId { get; set; }     // "current" resolves at runtime
    public List<string> NodeFilter { get; set; } // null = full DAG
}

public sealed class FileEventSpec
{
    public string Path { get; set; }            // OneLake watched path
    public string Content { get; set; }         // file content (string or base64)
    public string Encoding { get; set; } = "utf8"; // "utf8" or "base64"
    public bool Cleanup { get; set; } = true;   // delete file in teardown
}

public sealed class TimerTickSpec
{
    public string TickSource { get; set; }      // "EvictionManager", "CacheRefresh"
    public string Topic { get; set; } = "perf"; // topic to watch for tick
    public int MaxWaitMs { get; set; } = 10_000;
}

public sealed class DirectInvokeSpec
{
    public string ServiceType { get; set; }     // "IOneLakeWriter" — DI interface
    public string Method { get; set; }          // "WriteFileAsync"
    public List<object> Args { get; set; } = new();
}

// ───────────────────────── Expectations ─────────────────────────

/// <summary>
/// Single expectation. Evaluated by C04 AssertionEngine against captured TopicEvents.
/// All predicates within a Matcher use AND logic.
/// </summary>
public sealed class Expectation
{
    public string Id { get; set; }              // "exp-1", "exp-2", etc.
    public ExpectationType Type { get; set; }
    public string Topic { get; set; }           // "http", "retry", "cache", "log", etc.
    public Matcher Matcher { get; set; }
    public TimeWindowSpec TimeWindow { get; set; }
    public CountSpec Count { get; set; }
    public OrderSpec Order { get; set; }
    public string Description { get; set; }     // human-readable
}

public sealed class Matcher
{
    /// <summary>Field→value pairs requiring exact equality. Case-sensitive.</summary>
    public Dictionary<string, object> Exact { get; set; }
    /// <summary>Field→substring pairs. Case-insensitive.</summary>
    public Dictionary<string, string> Contains { get; set; }
    /// <summary>Field→regex pairs.</summary>
    public Dictionary<string, string> Regex { get; set; }
    /// <summary>Field→{min?,max?} numeric range pairs.</summary>
    public Dictionary<string, RangeBounds> Range { get; set; }
    /// <summary>Fields that must be present and non-null.</summary>
    public List<string> Exists { get; set; }
}

public sealed class RangeBounds
{
    public double? Min { get; set; }
    public double? Max { get; set; }
}

public sealed class TimeWindowSpec
{
    public int? WithinMs { get; set; }          // must appear within N ms of T0
    public int? AfterMs { get; set; }           // must appear at least N ms after T0
}

public sealed class CountSpec
{
    public int? Min { get; set; }
    public int? Max { get; set; }
    public int? Exact { get; set; }
}

public sealed class OrderSpec
{
    public string After { get; set; }           // must appear after this expectation ID
}

// ───────────────────────── Execution Results ─────────────────────────

public sealed class StimulusResult
{
    public bool Success { get; set; }
    public int? StatusCode { get; set; }        // HTTP status if applicable
    public long DurationMs { get; set; }
    public string ResponsePreview { get; set; } // truncated response (4KB max)
    public string Error { get; set; }           // non-null on transport failure
    public object Metadata { get; set; }        // stimulus-type-specific data
}

public sealed class ExpectationResult
{
    public string ExpectationId { get; set; }
    public string Description { get; set; }
    public ExpectationStatus Status { get; set; }
    public TopicEvent MatchedEvent { get; set; }    // null if Unmatched
    public TopicEvent ClosestMiss { get; set; }     // best-effort near-match for failures
    public string FailureReason { get; set; }       // "Expected HTTP 201, observed HTTP 500"
    public long MatchLatencyMs { get; set; }        // time from T0 to match
}

public sealed class ScenarioResult
{
    public string ScenarioId { get; set; }
    public string Title { get; set; }
    public string Category { get; set; }
    public ScenarioVerdict Verdict { get; set; }
    public long DurationMs { get; set; }
    public DateTimeOffset StartedAt { get; set; }
    public DateTimeOffset CompletedAt { get; set; }
    public List<ExpectationResult> Expectations { get; set; } = new();
    public List<TopicEvent> CapturedEvents { get; set; } = new();
    public string ErrorMessage { get; set; }    // non-null only for Crashed/Skipped
    public int EventsCaptured { get; set; }
    public ExecutionPhase FailedAtPhase { get; set; }  // which phase crashed
}

public sealed class RunResult
{
    public string RunId { get; set; }           // "run-20250615-143022"
    public int PrId { get; set; }
    public string PrTitle { get; set; }
    public string PrUrl { get; set; }
    public DateTimeOffset StartedAt { get; set; }
    public DateTimeOffset CompletedAt { get; set; }
    public long TotalDurationMs { get; set; }
    public RunSummary Summary { get; set; } = new();
    public List<ScenarioResult> Scenarios { get; set; } = new();
    public List<string> UnobservablePaths { get; set; } = new();
    public PerformanceReport Performance { get; set; } = new();
}

public sealed class RunSummary
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

public sealed class PerformanceReport
{
    public long SlowestScenarioMs { get; set; }
    public string SlowestScenarioId { get; set; }
    public long AverageScenarioMs { get; set; }
    public long TotalExecutionMs { get; set; }
    public long OverheadMs { get; set; }        // total - execution (setup/teardown)
}

// ───────────────────────── Code Understanding Models ─────────────────────────

public sealed class ImpactZone
{
    public string ZoneId { get; set; }          // "zone-001"
    public ChangedSymbol PrimaryChange { get; set; }
    public List<AffectedCaller> AffectedCallers { get; set; } = new();
    public List<string> AffectedInterfaces { get; set; } = new();
    public List<string> DiRegistrations { get; set; } = new();
    public List<string> RelatedTests { get; set; } = new();
    public List<string> InterceptorTopics { get; set; } = new();
    public string Community { get; set; }       // Graphify community name
    public List<EntryPoint> EntryPoints { get; set; } = new();
}

public sealed class ChangedSymbol
{
    public string File { get; set; }
    public string Method { get; set; }
    public string ChangeType { get; set; }      // "added", "modified", "deleted"
    public List<int> LinesChanged { get; set; } = new();
}

public sealed class AffectedCaller
{
    public string File { get; set; }
    public string Method { get; set; }
    public int Depth { get; set; }              // distance from changed code
    public string CallSite { get; set; }        // "line 89"
}

public sealed class EntryPoint
{
    public string Node { get; set; }            // "DagController.RunDAG"
    public StimulusType StimulusType { get; set; }
    public int Depth { get; set; }
    public List<string> Path { get; set; } = new();
    public double DirectnessScore { get; set; } // 1.0 / (depth + 1)
}

public sealed class GraphNode
{
    public string Id { get; set; }              // "file:method" compound key
    public string File { get; set; }
    public string Method { get; set; }
    public string NodeType { get; set; }        // "class", "method", "interface"
    public bool IsChanged { get; set; }
    public string Community { get; set; }       // Graphify Louvain community
    public Dictionary<string, string> SemanticData { get; set; } = new();
}

public sealed class GraphEdge
{
    public string Source { get; set; }
    public string Target { get; set; }
    public string EdgeType { get; set; }        // "direct_call", "interface_dispatch", "field_ref", "override"
    public string Source_ { get; set; }         // "l1", "l2", "l3", "l5" — which layer added it
}

// ───────────────────────── Crash Recovery State ─────────────────────────

public sealed class ExecutionState
{
    public int Version { get; set; } = 1;
    public string RunId { get; set; }
    public DateTimeOffset StartedAt { get; set; }
    public int TotalScenarios { get; set; }
    public List<CompletedScenarioRef> CompletedScenarios { get; set; } = new();
    public string CurrentScenario { get; set; }
    public ExecutionPhase CurrentPhase { get; set; }
    public List<string> PendingScenarios { get; set; } = new();
    public string ScenariosFilePath { get; set; }  // path to the full scenarios JSON
}

public sealed class CompletedScenarioRef
{
    public string Id { get; set; }
    public string Result { get; set; }          // "PASS", "FAIL", "TIMED_OUT"
    public DateTimeOffset CompletedAt { get; set; }
}
```

### 1.2 JSON Schemas

The canonical JSON schema is defined in `spec.md` §4.1 (lines 232–472). The C# classes above are the implementation-side mirror. Serialization uses `System.Text.Json` with `JsonNamingPolicy.CamelCase` (consistent with `EdogLogServer.cs:37`).

**Serialization options (shared singleton):**
```csharp
internal static readonly JsonSerializerOptions QaJsonOptions = new()
{
    PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    WriteIndented = true,
    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase) }
};
```

### 1.3 TypeScript Interfaces (Frontend State)

```typescript
// src/frontend/js/qa-panel-state.js — interfaces (documented via JSDoc)

/**
 * @typedef {Object} QaScenario
 * @property {string} id               — "scn-write-file-correct-path-a1b2"
 * @property {string} title
 * @property {string} description
 * @property {'happy_path'|'error_path'|'edge_case'|'regression'|'performance'} category
 * @property {number} priority          — 1–5
 * @property {string} impactZone
 * @property {'generated'|'curated'|'queued'|'executing'|'completed'|'failed'|'timed_out'|'archived'|'deleted'} lifecycle
 * @property {QaSetupStep[]} setup
 * @property {QaStimulus} stimulus
 * @property {QaExpectation[]} expectations
 * @property {QaTeardownStep[]} teardown
 * @property {number} timeoutMs
 * @property {QaMetadata} metadata
 */

/**
 * @typedef {Object} QaStimulus
 * @property {'http_request'|'signalr_invoke'|'dag_trigger'|'file_event'|'timer_tick'|'direct_invoke'} type
 * @property {Object} [httpRequest]
 * @property {Object} [signalrInvoke]
 * @property {Object} [dagTrigger]
 * @property {Object} [fileEvent]
 * @property {Object} [timerTick]
 * @property {Object} [directInvoke]
 */

/**
 * @typedef {Object} QaExpectation
 * @property {string} id                — "exp-1"
 * @property {'event_present'|'event_absent'|'event_count'|'event_order'|'timing'|'field_match'} type
 * @property {string} topic
 * @property {QaMatcher} matcher
 * @property {{withinMs?: number, afterMs?: number}} [timeWindow]
 * @property {{min?: number, max?: number, exact?: number}} [count]
 * @property {{after?: string}} [order]
 * @property {string} description
 */

/**
 * @typedef {Object} QaMatcher
 * @property {Object.<string, *>} [exact]
 * @property {Object.<string, string>} [contains]
 * @property {Object.<string, string>} [regex]
 * @property {Object.<string, {min?: number, max?: number}>} [range]
 * @property {string[]} [exists]
 */

/**
 * @typedef {Object} QaRunResult
 * @property {string} runId
 * @property {number} prId
 * @property {string} prTitle
 * @property {string} prUrl
 * @property {string} startedAt         — ISO 8601
 * @property {string} completedAt
 * @property {number} totalDurationMs
 * @property {QaRunSummary} summary
 * @property {QaScenarioResult[]} scenarios
 */

/**
 * @typedef {Object} QaRunSummary
 * @property {number} total
 * @property {number} passed
 * @property {number} failed
 * @property {number} timedOut
 * @property {number} partial
 * @property {number} crashed
 * @property {number} skipped
 */

/**
 * @typedef {Object} QaScenarioResult
 * @property {string} scenarioId
 * @property {string} title
 * @property {string} category
 * @property {'passed'|'failed'|'partial'|'timed_out'|'crashed'|'skipped'} verdict
 * @property {number} durationMs
 * @property {string} startedAt
 * @property {string} completedAt
 * @property {QaExpectationResult[]} expectations
 * @property {number} eventsCaptured
 * @property {string} [errorMessage]
 */

/**
 * @typedef {Object} QaExpectationResult
 * @property {string} expectationId
 * @property {string} description
 * @property {'passed'|'failed'|'unmatched'|'skipped'} status
 * @property {Object} [matchedEvent]
 * @property {Object} [closestMiss]
 * @property {string} [failureReason]
 * @property {number} matchLatencyMs
 */

/**
 * Frontend panel state shape.
 * Held in memory by QAPanelState (qa-panel-state.js).
 */

/**
 * @typedef {Object} QaPanelState
 * @property {'idle'|'analyzing'|'curating'|'executing'|'completed'} stage
 * @property {string|null} prUrl
 * @property {QaScenario[]} scenarios
 * @property {string|null} activeRunId
 * @property {QaRunResult|null} lastResult
 * @property {Object.<string, QaExpectationResult>} liveExpectations — keyed by exp ID
 * @property {Object[]} liveEvents    — streaming events during execution
 * @property {string|null} error
 */
```

### 1.4 Relationships Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         Object Relationships                           │
│                                                                        │
│  RunResult ◄──────── 1:N ──────── ScenarioResult                       │
│     │                                  │                               │
│     │ runId                            │ scenarioId                    │
│     │                                  │                               │
│     │                   ┌──────── 1:N ─┘                               │
│     │                   ▼                                              │
│     │             ExpectationResult                                    │
│     │                   │                                              │
│     │                   │ matchedEvent: TopicEvent                     │
│     │                   │                                              │
│  Scenario ◄────── identified by ────── ScenarioResult.scenarioId       │
│     │                                                                  │
│     ├── 0:N ── SetupStep (ChaosRuleSpec | FlagOverrideSpec | ...)      │
│     ├── 1 ──── Stimulus  (HttpRequestSpec | DagTriggerSpec | ...)       │
│     ├── 1:N ── Expectation ── Matcher ── {exact,contains,regex,range}  │
│     ├── 0:N ── TeardownStep                                           │
│     └── 1 ──── ScenarioMetadata                                       │
│                                                                        │
│  ImpactZone ◄── 1:1 ── Scenario.impactZone                            │
│     │                                                                  │
│     ├── 1 ──── ChangedSymbol                                          │
│     ├── 0:N ── AffectedCaller                                         │
│     └── 0:N ── EntryPoint (classified by StimulusType)                 │
│                                                                        │
│  ExecutionState ◄── persisted at ~/.edog/qa-state.json                 │
│     ├── references RunId                                               │
│     ├── 0:N ── CompletedScenarioRef                                   │
│     └── tracks CurrentScenario + CurrentPhase                          │
│                                                                        │
│  RecordingSession ◄── 1:1 per scenario execution                       │
│     ├── ScenarioId + RunId                                            │
│     ├── captures TopicEvent[] per topic via observer pattern           │
│     └── referenced by AssertionEngine during EVALUATE                  │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Core Engine — Code Understanding Pipeline

### 2.1 Class Architecture

```
EdogQaCodeEngine (orchestrator)
│
├── IPrDiffFetcher
│     └── AdoPrDiffFetcher          — ADO REST API for unified diff
│
├── IGraphBuilder
│     ├── CodeReviewGraphBuilder    — L1: recursive SQL CTE BFS
│     ├── GraphifyBuilder           — L2: NetworkX knowledge graph
│     └── MergedGraphBuilder        — merges L1+L2 by node identity
│
├── ISemanticEnricher
│     └── OmniSharpEnricher         — L3: LSP call hierarchy + implementations
│
├── IDiRegistryProvider
│     └── RuntimeDiProvider         — L5: wraps EdogDiRegistryCapture
│
├── IScenarioReasoner
│     └── GptScenarioReasoner       — L4: GPT-5.4-pro scenario generation
│
└── IEntryPointClassifier
      └── EntryPointClassifier      — reverse BFS + stimulus type classification
```

**Every interface is independently implementable.** Backend and frontend teams can develop in parallel using the interfaces below.

### 2.2 Interface Definitions

```csharp
// ═══════════════════════════════════════════════════════════════════
// File: src/backend/DevMode/QaCodeEngineInterfaces.cs (NEW)
// ═══════════════════════════════════════════════════════════════════

#nullable disable
#pragma warning disable

namespace Microsoft.LiveTable.Service.DevMode;

using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;

/// <summary>
/// Fetches a PR unified diff from Azure DevOps.
/// Latency target: < 3s for typical PRs (< 500 lines).
/// </summary>
public interface IPrDiffFetcher
{
    /// <summary>
    /// Fetch the unified diff for a PR.
    /// </summary>
    /// <param name="prUrl">Full ADO PR URL or PR number (e.g., "#12345")</param>
    /// <param name="ct">Cancellation token</param>
    /// <returns>Parsed diff with changed files and symbols</returns>
    Task<PrDiff> FetchDiffAsync(string prUrl, CancellationToken ct);
}

public sealed class PrDiff
{
    public int PrId { get; set; }
    public string Title { get; set; }
    public string Author { get; set; }
    public string BaseCommit { get; set; }
    public string TargetCommit { get; set; }
    public List<DiffFile> Files { get; set; } = new();
    public int TotalLinesAdded { get; set; }
    public int TotalLinesRemoved { get; set; }
}

public sealed class DiffFile
{
    public string Path { get; set; }
    public string ChangeType { get; set; }      // "add", "edit", "delete", "rename"
    public string OldPath { get; set; }         // non-null for renames
    public List<DiffHunk> Hunks { get; set; } = new();
}

public sealed class DiffHunk
{
    public int OldStart { get; set; }
    public int OldCount { get; set; }
    public int NewStart { get; set; }
    public int NewCount { get; set; }
    public string Content { get; set; }
}

/// <summary>
/// Builds structural graph from PR diff (L1 + L2).
/// Latency target: < 3s total (L1 and L2 run in parallel).
/// Memory target: < 50MB for PRs with < 100 files.
/// </summary>
public interface IGraphBuilder
{
    Task<MergedGraph> BuildAsync(PrDiff diff, CancellationToken ct);
}

public sealed class MergedGraph
{
    public List<GraphNode> Nodes { get; set; } = new();
    public List<GraphEdge> Edges { get; set; } = new();
    public List<string> Communities { get; set; } = new();  // Louvain cluster labels
    public List<ChangedSymbol> ChangedSymbols { get; set; } = new();
}

/// <summary>
/// Adds semantic edges to the structural graph via OmniSharp/Roslyn (L3).
/// Warm-up: 15–30s (once per Connected session). Per-query: < 500ms.
/// </summary>
public interface ISemanticEnricher
{
    /// <summary>Pre-warm the Roslyn workspace. Call on Connected phase start.</summary>
    Task WarmUpAsync(string solutionPath, CancellationToken ct);

    /// <summary>Enrich graph with semantic edges (call hierarchy, implementations).</summary>
    Task<MergedGraph> EnrichAsync(MergedGraph graph, CancellationToken ct);

    /// <summary>True after successful WarmUpAsync.</summary>
    bool IsReady { get; }
}

/// <summary>
/// Provides ground-truth DI registrations (L5).
/// Wraps EdogDiRegistryCapture.cs — instant lookup.
/// </summary>
public interface IDiRegistryProvider
{
    /// <summary>
    /// Validate/supplement interface→implementation mappings with actual DI registrations.
    /// </summary>
    Task<MergedGraph> ValidateAsync(MergedGraph graph, CancellationToken ct);

    /// <summary>Resolve which implementation is registered for a given interface type.</summary>
    string ResolveImplementation(string interfaceName);
}

/// <summary>
/// LLM-based reasoning to generate scenarios from the enriched graph (L4).
/// Latency target: 5–10s per impact zone.
/// Token budget: 8K input + 4K output per call.
/// </summary>
public interface IScenarioReasoner
{
    /// <summary>
    /// Generate scenarios for a set of impact zones.
    /// Streams scenarios as they are produced (one per zone, parallelized).
    /// </summary>
    IAsyncEnumerable<Scenario> GenerateScenariosAsync(
        MergedGraph graph,
        List<ImpactZone> zones,
        string interceptorSchema,
        CancellationToken ct);
}

/// <summary>
/// Classifies graph nodes as entry points and determines stimulus type.
/// Pure algorithm — no I/O. Latency target: < 10ms per changed symbol.
/// </summary>
public interface IEntryPointClassifier
{
    List<EntryPoint> FindEntryPoints(MergedGraph graph, ChangedSymbol symbol);
}
```

### 2.3 Orchestrator — `EdogQaCodeEngine`

```csharp
// ═══════════════════════════════════════════════════════════════════
// File: src/backend/DevMode/EdogQaCodeEngine.cs (NEW)
// ═══════════════════════════════════════════════════════════════════

#nullable disable
#pragma warning disable

namespace Microsoft.LiveTable.Service.DevMode;

/// <summary>
/// Orchestrates the five-layer code understanding pipeline.
/// Entry point: AnalyzePrAsync — called by EdogPlaygroundHub.GenerateScenarios().
///
/// Performance contract:
///   - Total latency for < 500-line PR: < 45 seconds (p95)
///   - Memory: < 200MB working set during analysis
///   - Output: 5–30 scenarios per PR
/// </summary>
public sealed class EdogQaCodeEngine
{
    private readonly IPrDiffFetcher _diffFetcher;
    private readonly IGraphBuilder _graphBuilder;
    private readonly ISemanticEnricher _semanticEnricher;
    private readonly IDiRegistryProvider _diRegistry;
    private readonly IScenarioReasoner _reasoner;
    private readonly IEntryPointClassifier _classifier;

    public EdogQaCodeEngine(
        IPrDiffFetcher diffFetcher,
        IGraphBuilder graphBuilder,
        ISemanticEnricher semanticEnricher,
        IDiRegistryProvider diRegistry,
        IScenarioReasoner reasoner,
        IEntryPointClassifier classifier)
    {
        _diffFetcher = diffFetcher;
        _graphBuilder = graphBuilder;
        _semanticEnricher = semanticEnricher;
        _diRegistry = diRegistry;
        _reasoner = reasoner;
        _classifier = classifier;
    }

    /// <summary>
    /// Full analysis pipeline: PR diff → scenarios.
    /// Streams scenarios to caller as they are generated.
    ///
    /// Pseudocode:
    /// 1. Fetch PR diff from ADO                         (< 3s)
    /// 2. Build structural graph (L1 + L2 parallel)      (< 3s)
    /// 3. Enrich with Roslyn semantics (L3)              (< 5s after warm-up)
    /// 4. Validate with DI registry (L5)                 (< 100ms)
    /// 5. Cluster into impact zones                      (< 200ms)
    /// 6. Classify entry points per zone                 (< 50ms)
    /// 7. Generate scenarios via LLM (L4, parallel)      (< 25s)
    /// 8. Deduplicate and validate                       (< 500ms)
    /// </summary>
    public async IAsyncEnumerable<Scenario> AnalyzePrAsync(
        string prUrl,
        IProgress<AnalysisProgress> progress,
        [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken ct)
    {
        // ── Step 1: Fetch diff ──
        progress?.Report(new AnalysisProgress("fetching_diff", 0));
        var diff = await _diffFetcher.FetchDiffAsync(prUrl, ct);
        progress?.Report(new AnalysisProgress("fetching_diff", 100,
            $"{diff.Files.Count} files, {diff.TotalLinesAdded + diff.TotalLinesRemoved} lines"));

        // ── Step 2: Build structural graph (L1 + L2 parallel) ──
        progress?.Report(new AnalysisProgress("building_graph", 0));
        var graph = await _graphBuilder.BuildAsync(diff, ct);
        progress?.Report(new AnalysisProgress("building_graph", 100,
            $"{graph.Nodes.Count} nodes, {graph.Edges.Count} edges"));

        // ── Step 3: Semantic enrichment (L3) — skip if OmniSharp not ready ──
        if (_semanticEnricher.IsReady)
        {
            progress?.Report(new AnalysisProgress("semantic_enrichment", 0));
            graph = await _semanticEnricher.EnrichAsync(graph, ct);
            progress?.Report(new AnalysisProgress("semantic_enrichment", 100));
        }
        else
        {
            progress?.Report(new AnalysisProgress("semantic_enrichment", -1,
                "Skipped — OmniSharp not ready. Accuracy reduced to ~70-80%."));
        }

        // ── Step 4: DI validation (L5) ──
        progress?.Report(new AnalysisProgress("di_validation", 0));
        graph = await _diRegistry.ValidateAsync(graph, ct);
        progress?.Report(new AnalysisProgress("di_validation", 100));

        // ── Step 5: Cluster into impact zones ──
        var zones = ClusterImpactZones(graph);

        // ── Step 6: Classify entry points per zone ──
        foreach (var zone in zones)
        {
            zone.EntryPoints = _classifier.FindEntryPoints(graph, zone.PrimaryChange);
        }

        // ── Step 7: Generate scenarios via LLM (L4) ──
        progress?.Report(new AnalysisProgress("generating_scenarios", 0));
        var interceptorSchema = BuildInterceptorSchema();
        var seen = new HashSet<string>();
        int count = 0;

        await foreach (var scenario in _reasoner.GenerateScenariosAsync(
            graph, zones, interceptorSchema, ct))
        {
            // ── Step 8: Deduplicate ──
            var key = $"{scenario.Stimulus.Type}:{scenario.ImpactZone}:{scenario.Category}";
            if (seen.Add(key))
            {
                scenario.Lifecycle = ScenarioLifecycle.Generated;
                scenario.Metadata.GeneratedAt = DateTimeOffset.UtcNow;
                count++;
                progress?.Report(new AnalysisProgress("generating_scenarios",
                    count * 100 / Math.Max(zones.Count * 3, 1),
                    $"{count} scenarios generated"));
                yield return scenario;
            }
        }

        progress?.Report(new AnalysisProgress("complete", 100,
            $"{count} scenarios from {zones.Count} impact zones"));
    }

    /// <summary>
    /// Cluster graph nodes into impact zones using Louvain communities from L2.
    /// Each changed symbol becomes the primary change of its zone.
    /// Symbols in the same community are merged into one zone.
    ///
    /// Pseudocode:
    ///   zones = {}
    ///   for each changedSymbol in graph.ChangedSymbols:
    ///     community = graph.Nodes[changedSymbol].Community
    ///     if community in zones:
    ///       zones[community].AffectedCallers.add(callers of changedSymbol)
    ///     else:
    ///       zones[community] = new ImpactZone { PrimaryChange = changedSymbol }
    ///   for zones with no community (L2 missed), create singleton zones
    ///   cap at MAX_ZONES (10) — take highest-impact first
    /// </summary>
    private List<ImpactZone> ClusterImpactZones(MergedGraph graph)
    {
        var zonesByCommunity = new Dictionary<string, ImpactZone>();
        int zoneCounter = 0;

        foreach (var symbol in graph.ChangedSymbols)
        {
            var node = graph.Nodes.Find(n => n.File == symbol.File && n.Method == symbol.Method);
            var community = node?.Community ?? $"singleton-{zoneCounter++}";

            if (!zonesByCommunity.TryGetValue(community, out var zone))
            {
                zone = new ImpactZone
                {
                    ZoneId = $"zone-{zonesByCommunity.Count + 1:D3}",
                    PrimaryChange = symbol,
                    Community = community,
                };
                zonesByCommunity[community] = zone;
            }

            // Accumulate callers from graph edges
            var callers = graph.Edges
                .Where(e => e.Target == $"{symbol.File}:{symbol.Method}")
                .Select(e => new AffectedCaller
                {
                    File = e.Source.Split(':')[0],
                    Method = e.Source.Contains(':') ? e.Source.Split(':')[1] : "",
                    Depth = 1,
                })
                .ToList();
            zone.AffectedCallers.AddRange(callers);

            // Determine relevant interceptor topics
            zone.InterceptorTopics = zone.InterceptorTopics
                .Union(InferTopics(symbol))
                .ToList();
        }

        return zonesByCommunity.Values
            .OrderByDescending(z => z.AffectedCallers.Count)
            .Take(10)  // MAX_ZONES cap
            .ToList();
    }

    /// <summary>
    /// Infer which interceptor topics are relevant for a changed symbol
    /// based on file path and method name heuristics.
    /// </summary>
    private static List<string> InferTopics(ChangedSymbol symbol)
    {
        var topics = new List<string>();
        var lower = (symbol.File + ":" + symbol.Method).ToLowerInvariant();
        if (lower.Contains("http") || lower.Contains("pipeline") || lower.Contains("controller"))
            topics.Add("http");
        if (lower.Contains("retry")) topics.Add("retry");
        if (lower.Contains("cache")) topics.Add("cache");
        if (lower.Contains("dag") || lower.Contains("schedule")) topics.Add("dag");
        if (lower.Contains("file") || lower.Contains("onelake")) topics.Add("fileop");
        if (lower.Contains("token") || lower.Contains("auth")) topics.Add("token");
        if (lower.Contains("flag") || lower.Contains("flight")) topics.Add("flag");
        if (lower.Contains("spark")) topics.Add("spark");
        if (lower.Contains("log")) topics.Add("log");
        if (lower.Contains("telemetry") || lower.Contains("perf")) topics.Add("perf");
        if (!topics.Any()) topics.Add("log"); // fallback — always capture logs
        return topics;
    }

    /// <summary>
    /// Build the interceptor schema string for the LLM prompt.
    /// Enumerates all 16 topics with their event payload shapes.
    /// </summary>
    private static string BuildInterceptorSchema()
    {
        // Assembled from P0 Foundation research §1.2
        return """
            Topics and event shapes:
            - http: { method, url, statusCode, durationMs, requestHeaders, responseHeaders, responseBodyPreview, httpClientName, correlationId }
            - retry: { endpoint, statusCode, retryAttempt, totalAttempts, waitDurationMs, strategyName, reason, isThrottle, retryAfterMs, iterationId }
            - cache: { cacheName, operation, key, hitOrMiss, valueSizeBytes, ttlSeconds, durationMs, evictionReason }
            - log: { timestamp, level, message, component, rootActivityId, eventId, customData, iterationId, codeMarkerName }
            - telemetry: { timestamp, activityName, activityStatus, durationMs, resultCode, correlationId, attributes, userId }
            - flag: { flagName, tenantId, capacityId, workspaceId, result, durationMs }
            - fileop: { operation, path, contentSizeBytes, durationMs }
            - dag: { event, nodeId, nodeName, status, durationMs, error, iterationId }
            - token: { authScheme, tokenType, audience, expiresIn, issuedAt, httpClientName, url }
            - perf: { operationName, durationMs, result, dimensions, correlationId }
            - spark: { sessionTrackingId, event, tenantId, workspaceId, artifactId, iterationId, durationMs, error }
            - di: { registrations[] }
            - flt-ops: { operation, details, durationMs }
            - catalog: { operation, entityType, entityId, durationMs }
            - capacity: { event, details }
            - nexus: { aggregation, details }
            """;
    }
}

public sealed class AnalysisProgress
{
    public string Phase { get; set; }
    public int PercentComplete { get; set; }    // -1 = skipped
    public string Detail { get; set; }

    public AnalysisProgress(string phase, int pct, string detail = null)
    {
        Phase = phase;
        PercentComplete = pct;
        Detail = detail;
    }
}
```

### 2.4 Entry Point Classifier — Pseudocode

```csharp
// ═══════════════════════════════════════════════════════════════════
// File: src/backend/DevMode/QaEntryPointClassifier.cs (NEW)
// ═══════════════════════════════════════════════════════════════════

/// <summary>
/// BFS upward from changed code → find API entry points.
/// Pure algorithm. No I/O.
///
/// Performance: < 10ms per changed symbol (graph is in-memory).
/// Memory: O(V) visited set where V = nodes within depth 4.
/// </summary>
public sealed class QaEntryPointClassifier : IEntryPointClassifier
{
    private const int MaxDepth = 4;

    /// <summary>
    /// Reverse BFS from a changed symbol through the enriched graph.
    ///
    /// Pseudocode:
    ///   queue = [(changedNode, depth=0, path=[changedNode])]
    ///   while queue not empty:
    ///     (node, depth, path) = queue.dequeue()
    ///     if depth > MAX_DEPTH: skip
    ///     if node already visited: skip
    ///     visit(node)
    ///     stimulusType = ClassifyNode(node)
    ///     if stimulusType != null:
    ///       yield EntryPoint { node, stimulusType, depth, path, score=1/(depth+1) }
    ///       do NOT traverse above entry points
    ///     else:
    ///       for each caller in graph.IncomingEdges(node):
    ///         queue.enqueue((caller, depth+1, path + [caller]))
    ///   sort results by directnessScore descending
    /// </summary>
    public List<EntryPoint> FindEntryPoints(MergedGraph graph, ChangedSymbol symbol)
    {
        var startId = $"{symbol.File}:{symbol.Method}";
        var visited = new HashSet<string>();
        var queue = new Queue<(string nodeId, int depth, List<string> path)>();
        queue.Enqueue((startId, 0, new List<string> { startId }));
        var results = new List<EntryPoint>();

        while (queue.Count > 0)
        {
            var (nodeId, depth, path) = queue.Dequeue();
            if (depth > MaxDepth || !visited.Add(nodeId))
                continue;

            var node = graph.Nodes.FirstOrDefault(n => n.Id == nodeId);
            var stimType = ClassifyNode(node);
            if (stimType.HasValue)
            {
                results.Add(new EntryPoint
                {
                    Node = nodeId,
                    StimulusType = stimType.Value,
                    Depth = depth,
                    Path = path,
                    DirectnessScore = 1.0 / (depth + 1),
                });
                continue; // don't traverse above entry points
            }

            // Traverse incoming edges (callers)
            foreach (var edge in graph.Edges.Where(e => e.Target == nodeId))
            {
                queue.Enqueue((edge.Source, depth + 1, new List<string>(path) { edge.Source }));
            }
        }

        // No entry point found — mark as direct_invoke
        if (results.Count == 0)
        {
            results.Add(new EntryPoint
            {
                Node = startId,
                StimulusType = StimulusType.DirectInvoke,
                Depth = 0,
                Path = new List<string> { startId },
                DirectnessScore = 1.0,
            });
        }

        return results.OrderByDescending(e => e.DirectnessScore).ToList();
    }

    /// <summary>
    /// Classify whether a graph node is an API entry point.
    /// Uses naming conventions + semantic metadata from L3.
    ///
    /// References:
    ///   - Controller endpoints: ASP.NET [HttpGet], [HttpPost] attributes
    ///   - Hub methods: SignalR [HubMethodName] or public methods on Hub subclasses
    ///   - DAG trigger: DagController.RunDAG (EdogDagExecutionInterceptor.cs:43)
    ///   - File event: IFileSystemWatcher implementations
    ///   - Timer tick: IHostedService, Timer callbacks
    /// </summary>
    private static StimulusType? ClassifyNode(GraphNode node)
    {
        if (node == null) return null;
        var id = node.Id.ToLowerInvariant();
        var semantics = node.SemanticData;

        if (semantics.ContainsKey("httpAttribute") || id.Contains("controller."))
            return StimulusType.HttpRequest;
        if (semantics.ContainsKey("hubMethod") || id.Contains("hub."))
            return StimulusType.SignalrInvoke;
        if (id.Contains("dagcontroller") || id.Contains("rundag"))
            return StimulusType.DagTrigger;
        if (id.Contains("filesystemwatcher") || id.Contains("filewatcher"))
            return StimulusType.FileEvent;
        if (id.Contains("ihostedservice") || id.Contains("timercallback"))
            return StimulusType.TimerTick;

        return null;
    }
}
```

### 2.5 Data Flow Summary

```
                         ┌──────────────────────────────────────────────┐
 User provides           │         EdogQaCodeEngine.AnalyzePrAsync()    │
 PR URL ────────────────►│                                              │
                         │  1. IPrDiffFetcher.FetchDiffAsync()          │
                         │     └─► ADO REST API → PrDiff                │
                         │                                              │
                         │  2. IGraphBuilder.BuildAsync()               │
                         │     ├─► L1: code-review-graph (SQL CTE BFS)  │
                         │     └─► L2: Graphify (NetworkX communities)  │
                         │          └─► MergedGraph (structural)        │
                         │                                              │
                         │  3. ISemanticEnricher.EnrichAsync()          │
                         │     └─► L3: OmniSharp/Roslyn (LSP queries)  │
                         │          └─► MergedGraph (+ semantic edges)  │
                         │                                              │
                         │  4. IDiRegistryProvider.ValidateAsync()      │
                         │     └─► L5: EdogDiRegistryCapture snapshot   │
                         │          └─► MergedGraph (+ DI ground truth) │
                         │                                              │
                         │  5. ClusterImpactZones()                     │
                         │     └─► List<ImpactZone>                     │
                         │                                              │
                         │  6. IEntryPointClassifier.FindEntryPoints()  │
                         │     └─► Zones enriched with EntryPoints      │
                         │                                              │
                         │  7. IScenarioReasoner.GenerateScenariosAsync │
                         │     └─► L4: GPT-5.4-pro → IAsyncEnum<Scn>   │
                         │                                              │
                         │  8. Deduplicate + validate + stream out      │
                         │     └─► IAsyncEnumerable<Scenario>           │
                         └──────────────────────────────────────────────┘
                                            │
                                            ▼
                              SignalR → ScenarioGenerated(scenario)
                                            │
                                            ▼
                              Frontend curation UI (C06)
```

---

## 3. Core Engine — Execution Pipeline

### 3.1 Class Architecture

```
EdogQaExecutionEngine (orchestrator)
│
├── ScenarioQueue                     — ordered list of approved scenarios
│
├── RecordingSessionFactory
│     └── RecordingSession            — scoped event capture via TopicBuffer observers
│
├── StimulusDispatcher
│     ├── HttpStimulusHandler         — HttpClient against FLT Kestrel
│     ├── SignalRStimulusHandler      — IHubContext<EdogPlaygroundHub>
│     ├── DagTriggerStimulusHandler   — POST /liveTableSchedule/runDAG
│     ├── FileEventStimulusHandler    — IFileSystem.WriteAsync
│     ├── TimerTickStimulusHandler    — wait-for-topic-event
│     └── DirectInvokeStimulusHandler — DI resolve + reflection invoke
│
├── AssertionEngine (C04)
│     ├── FieldMatcher                — exact/contains/regex/range/exists
│     ├── StreamingEvaluator          — real-time expectation matching
│     └── VerdictComputer             — final pass/fail per scenario
│
├── ChaosIntegration
│     └── wraps F24 ChaosEngine       — AddRule / RemoveRulesForScenario
│
├── FlagOverrideStore
│     └── wraps EdogFeatureFlighterWrapper (EdogFeatureFlighterWrapper.cs:33)
│
├── ExecutionStateManager
│     └── crash recovery via ~/.edog/qa-state.json
│
└── SignalR Progress Reporter
      └── emits events to EdogPlaygroundHub (spec §8.4)
```

### 3.2 The 8-Phase Execution Loop (State Machine)

```
                     ┌─────────────────────────────────────────────────────────┐
                     │               ExecutionRun (sequential)                 │
                     │                                                         │
  StartRun() ──►    │  for each scenario in queue:                            │
                     │                                                         │
                     │    ┌───────────┐  CreateRecordingSession()              │
                     │    │ 1.ISOLATE │  topics = scenario.expectations[].topic│
                     │    └─────┬─────┘  snapshot sequence IDs per topic       │
                     │          │        perf: < 5ms                           │
                     │          ▼                                              │
                     │    ┌───────────┐  ApplyChaosRules (F24)                 │
                     │    │ 2. SETUP  │  ApplyFlagOverrides                    │
                     │    │           │  ExecuteStateSeed (HTTP calls)         │
                     │    └─────┬─────┘  perf: < 2s per setup step            │
                     │          │                                              │
                     │     setup fails? ──► mark SKIPPED, goto TEARDOWN       │
                     │          │                                              │
                     │          ▼                                              │
                     │    ┌───────────┐  T0 = DateTimeOffset.UtcNow            │
                     │    │ 3. MARK   │  Persist state (phase=MARK)            │
                     │    └─────┬─────┘  perf: < 1ms                           │
                     │          ▼                                              │
                     │    ┌───────────┐  StimulusDispatcher.Execute(type,spec) │
                     │    │4.STIMULATE│  Returns StimulusResult                │
                     │    └─────┬─────┘  perf: varies (HTTP<1s, DAG<30s)       │
                     │          │                                              │
                     │     stimulus fails? ──► mark FAILED, goto TEARDOWN     │
                     │          │                                              │
                     │          ▼                                              │
                     │    ┌───────────┐  Poll 100ms: check expectations       │
                     │    │ 5.CAPTURE │  Stream events via observers           │
                     │    │           │  Exit: all met OR timeout expires      │
                     │    └─────┬─────┘  perf: bounded by scenario.timeoutMs   │
                     │          ▼                                              │
                     │    ┌───────────┐  AssertionEngine.Evaluate(             │
                     │    │6.EVALUATE │    session.GetAllCapturedEvents(),     │
                     │    │           │    scenario.expectations, T0)          │
                     │    └─────┬─────┘  perf: < 50ms for 50 expectations     │
                     │          ▼                                              │
                     │    ┌───────────┐  RemoveChaosRules(scenarioId)          │
                     │    │7.TEARDOWN │  RestoreFlagOverrides(scenarioId)      │
                     │    │           │  session.Dispose()                     │
                     │    └─────┬─────┘  ALWAYS runs, even on crash/timeout   │
                     │          ▼                                              │
                     │    ┌───────────┐  Emit ScenarioResult via SignalR       │
                     │    │ 8.REPORT  │  Persist state (completed)            │
                     │    └───────────┘  perf: < 10ms                          │
                     │                                                         │
                     │    ── 500ms inter-scenario gap ──                       │
                     │    ── safety checks (orphan rules, orphan flags) ──     │
                     │    ── next scenario ──                                  │
                     └─────────────────────────────────────────────────────────┘
```

### 3.3 `EdogQaExecutionEngine` — Full Pseudocode

```csharp
// ═══════════════════════════════════════════════════════════════════
// File: src/backend/DevMode/EdogQaExecutionEngine.cs (NEW)
// ═══════════════════════════════════════════════════════════════════

#nullable disable
#pragma warning disable

namespace Microsoft.LiveTable.Service.DevMode;

/// <summary>
/// Sequential scenario execution engine. Runs inside the FLT process.
/// MUST never crash the host. Every error path recovers or degrades.
///
/// Performance contract:
///   - Orchestration overhead per scenario: < 50ms (excluding stimulus + capture)
///   - Inter-scenario gap: 500ms (configurable)
///   - Max run duration: 30 minutes (hard ceiling)
///   - Memory per scenario: < 100MB (recording buffer limit)
/// </summary>
public sealed class EdogQaExecutionEngine
{
    private readonly StimulusDispatcher _stimulusDispatcher;
    private readonly EdogQaAssertionEngine _assertionEngine;
    private readonly RecordingSessionFactory _recordingFactory;
    private readonly ChaosIntegration _chaos;
    private readonly FlagOverrideStore _flagStore;
    private readonly ExecutionStateManager _stateManager;
    private readonly IProgress<ExecutionProgress> _progress;

    private CancellationTokenSource _killSwitch;  // global abort
    private bool _aborted;

    private const int InterScenarioGapMs = 500;
    private const int MaxRunDurationMs = 30 * 60 * 1000; // 30 minutes
    private const int MaxEventsPerScenario = 50_000;
    private const int SafetyCheckRetries = 3;
    private const int SafetyCheckDelayMs = 200;

    /// <summary>
    /// Execute a full run. Called by EdogPlaygroundHub.ExecuteRun().
    ///
    /// Pseudocode:
    ///   killSwitch = new CTS(MaxRunDuration)
    ///   check for interrupted run (crash recovery)
    ///   for each scenario in queue:
    ///     persist state (currentScenario)
    ///     result = ExecuteScenario(scenario)
    ///     persist state (completed)
    ///     emit result via SignalR
    ///     run inter-scenario gap + safety checks
    ///   aggregate RunResult
    ///   clean up state file
    ///   return RunResult
    /// </summary>
    public async Task<RunResult> ExecuteRunAsync(
        string runId,
        List<Scenario> scenarios,
        CancellationToken externalCt)
    {
        _killSwitch = CancellationTokenSource.CreateLinkedTokenSource(externalCt);
        _killSwitch.CancelAfter(MaxRunDurationMs);
        var ct = _killSwitch.Token;

        var runResult = new RunResult
        {
            RunId = runId,
            StartedAt = DateTimeOffset.UtcNow,
        };

        // Check for crash recovery
        var interrupted = _stateManager.CheckForInterruptedRun();
        if (interrupted != null && interrupted.RunId == runId)
        {
            // Resume: skip completed scenarios, mark crashed scenario
            scenarios = FilterResumedScenarios(scenarios, interrupted);
            runResult.Scenarios.AddRange(interrupted.CompletedScenarios.Select(ToResult));
        }

        string previousScenarioId = null;

        foreach (var scenario in scenarios)
        {
            ct.ThrowIfCancellationRequested();

            // Persist current state for crash recovery
            await _stateManager.PersistStateAsync(new ExecutionState
            {
                RunId = runId,
                StartedAt = runResult.StartedAt,
                TotalScenarios = scenarios.Count + runResult.Scenarios.Count,
                CurrentScenario = scenario.Id,
                CurrentPhase = ExecutionPhase.Isolate,
                PendingScenarios = scenarios.Skip(scenarios.IndexOf(scenario) + 1)
                    .Select(s => s.Id).ToList(),
            });

            // Execute the scenario
            ScenarioResult result;
            try
            {
                result = await ExecuteScenarioAsync(scenario, ct);
            }
            catch (OperationCanceledException) when (_aborted)
            {
                result = MakeCrashedResult(scenario, "Run aborted via kill switch");
                runResult.Scenarios.Add(result);
                break;
            }
            catch (Exception ex)
            {
                result = MakeCrashedResult(scenario, ex.Message);
            }

            runResult.Scenarios.Add(result);
            _progress?.Report(new ExecutionProgress(scenario.Id, result.Verdict,
                runResult.Scenarios.Count, scenarios.Count + runResult.Scenarios.Count));

            // Inter-scenario gap + safety checks
            if (previousScenarioId != null)
            {
                await RunInterScenarioGapAsync(previousScenarioId, ct);
            }
            previousScenarioId = scenario.Id;
        }

        runResult.CompletedAt = DateTimeOffset.UtcNow;
        runResult.TotalDurationMs = (long)(runResult.CompletedAt - runResult.StartedAt)
            .TotalMilliseconds;
        runResult.Summary = ComputeSummary(runResult.Scenarios);
        runResult.Performance = ComputePerformance(runResult.Scenarios);

        // Clean up state file
        _stateManager.DeleteState();

        return runResult;
    }

    /// <summary>
    /// Execute a single scenario through all 8 phases.
    ///
    /// Pseudocode:
    ///   Phase 1 (ISOLATE):  session = recording.Create(topics)
    ///   Phase 2 (SETUP):    apply chaos rules + flag overrides + state seeds
    ///   Phase 3 (MARK):     T0 = now
    ///   Phase 4 (STIMULATE): stimResult = dispatcher.Execute(stimulus)
    ///   Phase 5 (CAPTURE):  poll events until all expectations met or timeout
    ///   Phase 6 (EVALUATE): verdict = assertion.Evaluate(events, expectations, T0)
    ///   Phase 7 (TEARDOWN): remove chaos, restore flags, dispose session
    ///   Phase 8 (REPORT):   build ScenarioResult
    ///
    /// TEARDOWN always runs (finally block). No exception escapes to caller
    /// except OperationCanceledException from the kill switch.
    /// </summary>
    private async Task<ScenarioResult> ExecuteScenarioAsync(
        Scenario scenario,
        CancellationToken ct)
    {
        RecordingSession session = null;
        var result = new ScenarioResult
        {
            ScenarioId = scenario.Id,
            Title = scenario.Title,
            Category = scenario.Category.ToString(),
            StartedAt = DateTimeOffset.UtcNow,
        };

        try
        {
            // ── Phase 1: ISOLATE ──
            var topics = scenario.Expectations.Select(e => e.Topic).Distinct().ToArray();
            session = _recordingFactory.Create(scenario.Id, topics, MaxEventsPerScenario);

            // ── Phase 2: SETUP ──
            foreach (var step in scenario.Setup)
            {
                try
                {
                    await ExecuteSetupStepAsync(step, scenario.Id, ct);
                }
                catch (Exception ex)
                {
                    result.Verdict = ScenarioVerdict.Skipped;
                    result.ErrorMessage = $"Setup failed: {ex.Message}";
                    result.FailedAtPhase = ExecutionPhase.Setup;
                    return result;
                }
            }

            // ── Phase 3: MARK ──
            var t0 = DateTimeOffset.UtcNow;

            // ── Phase 4: STIMULATE ──
            StimulusResult stimResult;
            try
            {
                stimResult = await _stimulusDispatcher.ExecuteAsync(scenario.Stimulus, ct);
            }
            catch (Exception ex)
            {
                result.Verdict = ScenarioVerdict.Failed;
                result.ErrorMessage = $"Stimulus failed: {ex.Message}";
                result.FailedAtPhase = ExecutionPhase.Stimulate;
                return result;
            }

            if (!stimResult.Success)
            {
                result.Verdict = ScenarioVerdict.Failed;
                result.ErrorMessage = $"Stimulus returned error: {stimResult.Error}";
                result.FailedAtPhase = ExecutionPhase.Stimulate;
                return result;
            }

            // ── Phase 5: CAPTURE ──
            var captureResult = await RunCapturePhaseAsync(
                session, scenario.Expectations.ToArray(), scenario.TimeoutMs, ct);

            // ── Phase 6: EVALUATE ──
            var events = session.GetAllCapturedEvents();
            var expectationResults = _assertionEngine.Evaluate(
                events, scenario.Expectations, t0);

            result.Expectations = expectationResults;
            result.CapturedEvents = events.ToList();
            result.EventsCaptured = events.Count;

            // Determine verdict
            if (captureResult.Reason == "timeout")
            {
                result.Verdict = expectationResults.All(e => e.Status == ExpectationStatus.Passed)
                    ? ScenarioVerdict.Passed
                    : ScenarioVerdict.TimedOut;
            }
            else
            {
                result.Verdict = expectationResults.All(e => e.Status == ExpectationStatus.Passed)
                    ? ScenarioVerdict.Passed
                    : ScenarioVerdict.Failed;
            }

            return result;
        }
        catch (OperationCanceledException) { throw; } // propagate kill switch
        catch (Exception ex)
        {
            result.Verdict = ScenarioVerdict.Crashed;
            result.ErrorMessage = ex.ToString();
            return result;
        }
        finally
        {
            // ── Phase 7: TEARDOWN (always runs) ──
            try
            {
                foreach (var step in scenario.Teardown)
                    await ExecuteTeardownStepAsync(step, scenario.Id);
                _chaos.RemoveRulesForScenario(scenario.Id);
                _flagStore.ClearOverridesForScenario(scenario.Id);
            }
            catch { /* never propagate teardown errors */ }

            session?.Dispose();
            result.CompletedAt = DateTimeOffset.UtcNow;
            result.DurationMs = (long)(result.CompletedAt - result.StartedAt).TotalMilliseconds;
        }
    }

    /// <summary>
    /// Phase 5: Capture events until all expectations satisfied or timeout.
    ///
    /// Polls at 100ms intervals. For absence assertions, waits full timeout
    /// plus 2s grace period before concluding absence.
    ///
    /// Performance: polling overhead < 1ms per tick for < 50 expectations.
    /// </summary>
    private async Task<CaptureResult> RunCapturePhaseAsync(
        RecordingSession session,
        Expectation[] expectations,
        int timeoutMs,
        CancellationToken ct)
    {
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(timeoutMs);

        var positiveExps = expectations.Where(e => e.Type != ExpectationType.EventAbsent).ToArray();
        var absenceGraceMs = 2_000;

        try
        {
            while (!cts.Token.IsCancellationRequested)
            {
                var events = session.GetAllCapturedEvents();
                var metCount = positiveExps.Count(e =>
                    _assertionEngine.IsSatisfied(e, events));

                if (metCount == positiveExps.Length)
                {
                    // All positive expectations met — wait grace period for absence checks
                    await Task.Delay(absenceGraceMs, cts.Token).ConfigureAwait(false);
                    return new CaptureResult { Complete = true };
                }

                await Task.Delay(100, cts.Token).ConfigureAwait(false);
            }
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            // timeout, not external cancel
        }

        return new CaptureResult
        {
            Complete = false,
            Reason = "timeout",
            CapturedEventCount = session.GetAllCapturedEvents().Count,
        };
    }

    /// <summary>
    /// Inter-scenario gap: 500ms wait + 3-attempt safety check for orphan state.
    /// </summary>
    private async Task RunInterScenarioGapAsync(string previousScenarioId, CancellationToken ct)
    {
        await Task.Delay(InterScenarioGapMs, ct);

        for (int i = 0; i < SafetyCheckRetries; i++)
        {
            var orphanRules = _chaos.GetRulesForScenario(previousScenarioId);
            var orphanFlags = _flagStore.GetOverridesForScenario(previousScenarioId);

            if (!orphanRules.Any() && !orphanFlags.Any())
                return; // clean

            if (i == SafetyCheckRetries - 1)
            {
                _chaos.RemoveRulesForScenario(previousScenarioId);
                _flagStore.ClearOverridesForScenario(previousScenarioId);
                EdogTopicRouter.Publish("qa", new
                {
                    @event = "OrphanStateForceCleared",
                    scenarioId = previousScenarioId,
                    orphanRules = orphanRules.Count,
                    orphanFlags = orphanFlags.Count,
                });
            }
            else
            {
                await Task.Delay(SafetyCheckDelayMs, ct);
            }
        }
    }

    /// <summary>Abort the entire run immediately.</summary>
    public void KillSwitch()
    {
        _aborted = true;
        _killSwitch?.Cancel();
    }

    // Setup/teardown step execution omitted for brevity — follows patterns from
    // C03-S02 (HTTP), C03-S03 (SignalR), C03-S04 (DAG), C03-S05 (file), C03-S06 (timer/invoke)
    private async Task ExecuteSetupStepAsync(SetupStep step, string scenarioId, CancellationToken ct) { /* ... */ }
    private async Task ExecuteTeardownStepAsync(TeardownStep step, string scenarioId) { /* ... */ }
    private RunSummary ComputeSummary(List<ScenarioResult> results) { /* ... */ }
    private PerformanceReport ComputePerformance(List<ScenarioResult> results) { /* ... */ }
    private ScenarioResult MakeCrashedResult(Scenario s, string msg) { /* ... */ }
    private List<Scenario> FilterResumedScenarios(List<Scenario> all, ExecutionState interrupted) { /* ... */ }
    private ScenarioResult ToResult(CompletedScenarioRef r) { /* ... */ }
}

public sealed class CaptureResult
{
    public bool Complete { get; set; }
    public string Reason { get; set; }
    public int CapturedEventCount { get; set; }
}

public sealed class ExecutionProgress
{
    public string ScenarioId { get; set; }
    public ScenarioVerdict Verdict { get; set; }
    public int CompletedCount { get; set; }
    public int TotalCount { get; set; }

    public ExecutionProgress(string id, ScenarioVerdict v, int done, int total)
    {
        ScenarioId = id; Verdict = v; CompletedCount = done; TotalCount = total;
    }
}
```

### 3.4 Recording Session — Observer Pattern

The critical design constraint: recording sessions must NOT interfere with Runtime View's `ChannelReader` streaming (`EdogPlaygroundHub.cs:62–73`). Solution: observer callback on `TopicBuffer.Write()`.

```csharp
// ═══════════════════════════════════════════════════════════════════
// Extension to: src/backend/DevMode/TopicBuffer.cs
// Adds AddObserver() for non-destructive event tapping.
// ═══════════════════════════════════════════════════════════════════

// Add to TopicBuffer (existing class at TopicBuffer.cs:20-74):
//   private readonly List<Action<TopicEvent>> _observers = new();
//   private readonly object _observerLock = new();
//
//   public IDisposable AddObserver(Action<TopicEvent> callback)
//   {
//       lock (_observerLock) { _observers.Add(callback); }
//       return new ObserverRemoval(this, callback);
//   }
//
//   // Modify existing Write() method (TopicBuffer.cs:48-56):
//   public void Write(TopicEvent evt)
//   {
//       _ring.Enqueue(evt);
//       while (_ring.Count > _maxSize) _ring.TryDequeue(out _);
//       _liveChannel.Writer.TryWrite(evt);
//
//       // NEW: notify observers (recording sessions)
//       lock (_observerLock)
//       {
//           foreach (var obs in _observers)
//           {
//               try { obs(evt); }
//               catch { /* never propagate — same pattern as EdogTopicRouter.cs:88-93 */ }
//           }
//       }
//   }

/// <summary>
/// Scoped recording session. Captures events via TopicBuffer observer pattern.
/// Non-destructive — Runtime View streaming continues unaffected.
///
/// Performance:
///   - Create: < 5ms (snapshot sequence IDs)
///   - Per-event overhead: < 1μs (List.Add under lock)
///   - Memory: bounded by maxEvents parameter (default 50,000)
///   - Dispose: < 1ms (remove observers)
/// </summary>
public sealed class RecordingSession : IDisposable
{
    public string ScenarioId { get; }
    public string RunId { get; }
    public DateTimeOffset StartedAt { get; }
    public DateTimeOffset? ClosedAt { get; private set; }

    private readonly Dictionary<string, long> _startPositions = new();
    private readonly Dictionary<string, List<TopicEvent>> _captured = new();
    private readonly List<IDisposable> _subscriptions = new();
    private readonly int _maxEvents;
    private int _totalCaptured;
    private bool _disposed;

    private RecordingSession(string scenarioId, string runId, int maxEvents)
    {
        ScenarioId = scenarioId;
        RunId = runId;
        StartedAt = DateTimeOffset.UtcNow;
        _maxEvents = maxEvents;
    }

    public static RecordingSession Create(string scenarioId, string[] topics, int maxEvents = 50_000)
    {
        var session = new RecordingSession(scenarioId, "", maxEvents);

        foreach (var topic in topics)
        {
            var buffer = EdogTopicRouter.GetBuffer(topic);
            if (buffer == null) continue;

            // Snapshot current position
            var snapshot = buffer.GetSnapshot();
            long lastSeqId = snapshot.Length > 0 ? snapshot[^1].SequenceId : 0;
            session._startPositions[topic] = lastSeqId;
            session._captured[topic] = new List<TopicEvent>();

            // Subscribe via observer
            var topicCapture = topic; // capture for closure
            var sub = buffer.AddObserver(evt =>
            {
                if (evt.SequenceId <= session._startPositions[topicCapture])
                    return; // before our window
                if (session._totalCaptured >= session._maxEvents)
                    return; // memory cap

                lock (session._captured)
                {
                    session._captured[topicCapture].Add(evt);
                    Interlocked.Increment(ref session._totalCaptured);
                }
            });
            session._subscriptions.Add(sub);
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

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        ClosedAt = DateTimeOffset.UtcNow;
        foreach (var sub in _subscriptions)
            sub.Dispose();
        _subscriptions.Clear();
    }
}
```

### 3.5 Stimulus Dispatcher

```csharp
// ═══════════════════════════════════════════════════════════════════
// File: src/backend/DevMode/QaStimulusDispatcher.cs (NEW)
// Dispatches stimulus execution to the appropriate handler.
// ═══════════════════════════════════════════════════════════════════

/// <summary>
/// Routes stimulus execution to type-specific handlers.
/// Each handler is stateless — receives spec, returns result.
///
/// Performance targets per stimulus type:
///   - http_request:    < 1s (network round-trip)
///   - signalr_invoke:  < 100ms (in-process)
///   - dag_trigger:     < 30s (DAG execution, async)
///   - file_event:      < 500ms (disk I/O)
///   - timer_tick:      < 10s (wait for scheduled event)
///   - direct_invoke:   < 5s (service method execution)
/// </summary>
public sealed class StimulusDispatcher
{
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly IServiceProvider _serviceProvider;
    private readonly int _fltPort;

    /// <summary>
    /// Execute a stimulus.
    ///
    /// Pseudocode:
    ///   match stimulus.Type:
    ///     HttpRequest    → build HttpRequestMessage, send via HttpClient
    ///     SignalrInvoke  → resolve IHubContext, invoke method
    ///     DagTrigger     → POST /liveTableSchedule/runDAG/{iterationId}
    ///     FileEvent      → resolve IFileSystem, write content
    ///     TimerTick      → wait for topic event matching tick source
    ///     DirectInvoke   → resolve service from DI, invoke via reflection
    ///   return StimulusResult { success, statusCode?, durationMs, error? }
    /// </summary>
    public async Task<StimulusResult> ExecuteAsync(Stimulus stimulus, CancellationToken ct)
    {
        return stimulus.Type switch
        {
            StimulusType.HttpRequest    => await ExecuteHttpAsync(stimulus.HttpRequest, ct),
            StimulusType.SignalrInvoke  => await ExecuteSignalRAsync(stimulus.SignalrInvoke, ct),
            StimulusType.DagTrigger     => await ExecuteDagAsync(stimulus.DagTrigger, ct),
            StimulusType.FileEvent      => await ExecuteFileAsync(stimulus.FileEvent, ct),
            StimulusType.TimerTick      => await ExecuteTimerAsync(stimulus.TimerTick, ct),
            StimulusType.DirectInvoke   => await ExecuteDirectAsync(stimulus.DirectInvoke, ct),
            _ => new StimulusResult { Success = false, Error = $"Unknown stimulus type: {stimulus.Type}" }
        };
    }

    // Individual handler pseudocode follows C03-S02 through C03-S06.
    // HTTP: EdogHttpPipelineHandler.cs:46 captures automatically.
    // SignalR: IHubContext<EdogPlaygroundHub>.Clients.All.SendAsync().
    // DAG: POST to /liveTableSchedule/runDAG/{id} — returns 202 Accepted.
    // File: IFileSystem.WriteAsync(path, bytes) — EdogFileSystemInterceptor captures.
    // Timer: WaitForTopicEvent(topic, predicate, maxWaitMs).
    // DirectInvoke: DI resolve + method.Invoke() — see C03-S06 for full pseudocode.
    private async Task<StimulusResult> ExecuteHttpAsync(HttpRequestSpec spec, CancellationToken ct) { /* C03-S02 */ }
    private async Task<StimulusResult> ExecuteSignalRAsync(SignalRInvokeSpec spec, CancellationToken ct) { /* C03-S03 */ }
    private async Task<StimulusResult> ExecuteDagAsync(DagTriggerSpec spec, CancellationToken ct) { /* C03-S04 */ }
    private async Task<StimulusResult> ExecuteFileAsync(FileEventSpec spec, CancellationToken ct) { /* C03-S05 */ }
    private async Task<StimulusResult> ExecuteTimerAsync(TimerTickSpec spec, CancellationToken ct) { /* C03-S06 */ }
    private async Task<StimulusResult> ExecuteDirectAsync(DirectInvokeSpec spec, CancellationToken ct) { /* C03-S06 */ }
}
```

### 3.6 Assertion Engine Integration

The assertion engine (`EdogQaAssertionEngine`, designed in C04) plugs in at Phase 6. Its interface:

```csharp
/// <summary>
/// Evaluates captured events against scenario expectations.
/// Pure function — no side effects. Stateless.
///
/// Performance: O(E × M) where E = events, M = matcher predicates.
///   Target: < 50ms for 50,000 events × 50 expectations.
///   Achieved by: serialize each event to JsonElement once, cache across matchers.
/// </summary>
public sealed class EdogQaAssertionEngine
{
    /// <summary>
    /// Evaluate all expectations against captured events.
    ///
    /// Pseudocode:
    ///   for each expectation in expectations:
    ///     candidates = events.Where(e => e.Topic == expectation.Topic)
    ///     matched = candidates.Where(e => FieldMatcher.Satisfies(e, expectation.Matcher))
    ///     apply time window filter (relativeTo T0)
    ///     apply count constraints
    ///     apply order constraints (relative to other expectation matches)
    ///     match expectation.Type:
    ///       EventPresent  → PASS if matched.Count >= 1
    ///       EventAbsent   → PASS if matched.Count == 0
    ///       EventCount    → PASS if count within min/max/exact bounds
    ///       EventOrder    → PASS if matched events ordered per order.after
    ///       Timing        → PASS if first match within time window
    ///       FieldMatch    → PASS if first matched event satisfies all field predicates
    ///   for failures: compute closestMiss (event with most predicates satisfied)
    /// </summary>
    public List<ExpectationResult> Evaluate(
        IReadOnlyList<TopicEvent> events,
        List<Expectation> expectations,
        DateTimeOffset t0)
    {
        // Implementation per C04 spec — FieldMatcher, streaming evaluation, verdict
        // See components/C04-assertion-engine.md for complete pseudocode
    }

    /// <summary>Single-expectation check for capture-phase polling.</summary>
    public bool IsSatisfied(Expectation expectation, IReadOnlyList<TopicEvent> events)
    {
        // Subset of Evaluate — returns bool for a single expectation
    }
}
```

### 3.7 Event Correlation Strategy

Events from different interceptors are correlated using:

| Mechanism | Scope | Source |
|-----------|-------|--------|
| **Temporal** | Events captured between T0 and T0+timeout belong to the scenario | RecordingSession start/close timestamps |
| **Topic filtering** | Only events on topics listed in `expectations[].topic` are captured | RecordingSession topic subscription |
| **Sequence ID** | Events with `SequenceId > startPosition` are post-stimulus | TopicBuffer snapshot at session creation |
| **Correlation ID** | HTTP events carry `correlationId` from headers | `EdogHttpPipelineHandler.cs:171-188` |
| **Iteration ID** | DAG/retry/log events carry `iterationId` for FLT-level correlation | `EdogRetryInterceptor.cs:200`, `EdogDagExecutionInterceptor.cs:125` |

**Future enhancement (P2):** Inject a synthetic `X-Edog-Scenario-Id` header into HTTP stimuli. Interceptors that see this header tag their events, enabling per-scenario filtering even in concurrent execution.

---

## 4. Storage & Persistence

### 4.1 Storage Layout

```
~/.edog/qa/
├── scenarios/
│   └── {runId}.json           — curated scenario list per run
├── results/
│   └── {runId}.json           — execution results per run
├── state.json                 — crash recovery state (deleted on clean completion)
├── feedback.jsonl             — append-only learning loop log
└── roslyn-cache/
    └── {solutionHash}/        — cached OmniSharp workspace data
```

### 4.2 Scenario Storage

| Aspect | Detail |
|--------|--------|
| **Format** | JSON, one file per run: `~/.edog/qa/scenarios/{runId}.json` |
| **Content** | `{ "runId": "...", "prId": 12345, "scenarios": [Scenario, ...] }` |
| **When created** | After curation phase completes (all scenarios approved/edited) |
| **Versioning** | `metadata.schemaVersion` field (currently 1). Migration logic on load. |
| **CRUD** | Create on curation complete. Read on execution start + crash recovery. Update on re-curation. Delete after 30 days (archival). |
| **Size** | ~2–10 KB per scenario × 50 max = ~500 KB max per run |
| **Performance** | Write: < 50ms. Read: < 20ms. |

```csharp
/// <summary>
/// Scenario persistence. Write-to-temp-then-rename for atomicity.
///
/// Pseudocode:
///   SaveScenarios(runId, scenarios):
///     path = ~/.edog/qa/scenarios/{runId}.json
///     tempPath = path + ".tmp"
///     serialize scenarios to JSON with QaJsonOptions
///     File.WriteAllTextAsync(tempPath, json)
///     File.Move(tempPath, path, overwrite: true)  // atomic on NTFS/ext4
///
///   LoadScenarios(runId):
///     path = ~/.edog/qa/scenarios/{runId}.json
///     if !exists: return null
///     json = File.ReadAllTextAsync(path)
///     deserialize with QaJsonOptions
///     migrate if schemaVersion < current
/// </summary>
public sealed class QaScenarioStore
{
    private static readonly string BasePath =
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            ".edog", "qa", "scenarios");

    public async Task SaveAsync(string runId, List<Scenario> scenarios) { /* ... */ }
    public async Task<List<Scenario>> LoadAsync(string runId) { /* ... */ }
    public void Delete(string runId) { /* ... */ }
    public List<string> ListRunIds() { /* ... */ }
}
```

### 4.3 Run History

| Aspect | Detail |
|--------|--------|
| **Format** | JSON, one file per run: `~/.edog/qa/results/{runId}.json` |
| **Content** | Serialized `RunResult` object (§1.1) |
| **Retention** | 30 days. Cleanup on EDOG startup: delete files older than 30 days. |
| **Query patterns** | List all runs (directory listing). Get specific run (by runId). Filter by PR ID (load + check `prId` field). |
| **Size** | ~5–50 KB per run (depends on event count, capped at `MaxEventsPerScenario`) |
| **Performance** | Write: < 100ms. Read: < 50ms. List: < 10ms. |

```csharp
/// <summary>
/// Run result persistence and query.
///
/// Pseudocode:
///   SaveResult(result):
///     path = ~/.edog/qa/results/{result.RunId}.json
///     atomic write (temp + rename)
///
///   GetResult(runId) → RunResult:
///     read + deserialize
///
///   ListRuns() → List<RunSummaryRef>:
///     enumerate directory, read first 200 bytes of each file
///     to extract runId, prId, summary without full deserialization
///
///   CleanupOldRuns(retentionDays=30):
///     for each file in results/:
///       if File.GetLastWriteTimeUtc(file) < now - retentionDays:
///         File.Delete(file)
/// </summary>
public sealed class QaResultStore
{
    private static readonly string BasePath =
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            ".edog", "qa", "results");
    private const int RetentionDays = 30;

    public async Task SaveAsync(RunResult result) { /* atomic write */ }
    public async Task<RunResult> GetAsync(string runId) { /* read + deserialize */ }
    public List<RunSummaryRef> ListRuns() { /* directory enumeration, partial parse */ }
    public void CleanupOldRuns() { /* retention enforcement */ }
}

public sealed class RunSummaryRef
{
    public string RunId { get; set; }
    public int PrId { get; set; }
    public DateTimeOffset CompletedAt { get; set; }
    public int Total { get; set; }
    public int Passed { get; set; }
    public int Failed { get; set; }
}
```

### 4.4 Crash Recovery State

| Aspect | Detail |
|--------|--------|
| **File** | `~/.edog/qa/state.json` |
| **When written** | Before each scenario begins (phase transition) |
| **When deleted** | On clean run completion or explicit user cancellation |
| **Atomicity** | Write-to-temp-then-rename (`File.Move(temp, final, overwrite: true)`) |
| **On startup** | `ExecutionStateManager.CheckForInterruptedRun()` checks existence |
| **Recovery** | Crashed scenario → `FAILED` with `reason: "process_crash"`. Resume from next scenario. |
| **Schema** | `ExecutionState` class (§1.1). Version field for forward compatibility. |
| **Size** | < 5 KB |
| **Performance** | Write: < 10ms. Read: < 5ms. |

```csharp
/// <summary>
/// Manages crash recovery state.
///
/// Pseudocode:
///   PersistState(state):
///     serialize to JSON
///     write to ~/.edog/qa/state.tmp
///     File.Move(state.tmp, state.json, overwrite: true)
///
///   CheckForInterruptedRun():
///     if state.json exists:
///       deserialize → ExecutionState
///       mark currentScenario as FAILED (process_crash)
///       advance pendingScenarios
///       return state
///     return null
///
///   DeleteState():
///     File.Delete(state.json)
///     File.Delete(state.tmp)  // cleanup
/// </summary>
public sealed class ExecutionStateManager
{
    private static readonly string StatePath =
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            ".edog", "qa", "state.json");

    public async Task PersistStateAsync(ExecutionState state) { /* atomic write */ }
    public ExecutionState CheckForInterruptedRun() { /* load + mark crash */ }
    public void DeleteState() { /* cleanup */ }
}
```

### 4.5 Hot-Reload

**Question:** Can scenarios change while a run is executing?

**Answer:** No. Once execution begins, the scenario list is frozen. The curation phase must complete before execution starts. If the user wants to modify scenarios, they must cancel the run, edit, and re-execute. This is a deliberate simplification for V1.

**Rationale:** Modifying expectations or stimuli mid-run would invalidate already-completed scenario results and complicate crash recovery. The sequential execution model assumes a stable scenario list.

### 4.6 Cleanup & Archival

| Data | Retention | Cleanup trigger |
|------|-----------|-----------------|
| Scenarios | Until manually deleted or 30 days | EDOG startup |
| Results | 30 days | EDOG startup |
| Crash state | Until run completes | Clean completion or recovery |
| Feedback | Indefinite (append-only) | Manual: `edog qa cleanup --feedback --before=DATE` |
| Roslyn cache | 7 days | EDOG startup |

```csharp
/// <summary>
/// Runs on EDOG startup. Cleans up stale data.
///
/// Pseudocode:
///   delete results older than 30 days
///   delete scenarios older than 30 days
///   delete roslyn-cache entries older than 7 days
///   if state.json exists → flag for crash recovery (do NOT delete)
/// </summary>
public static void RunStartupCleanup() { /* ... */ }
```

---

## 5. Safety Mechanisms

### 5.1 Kill Switch (Abort All Execution)

```csharp
/// <summary>
/// Immediate abort of the entire run. Three trigger paths:
///   1. User clicks "Cancel" in UI → SignalR CancelRun(runId)
///   2. MaxRunDuration exceeded → CancellationTokenSource.CancelAfter
///   3. Resource monitor detects memory/CPU breach → automatic kill
///
/// Behavior:
///   - Sets _aborted = true
///   - Cancels the linked CancellationTokenSource
///   - Current scenario enters TEARDOWN immediately (finally block)
///   - All pending scenarios marked as SKIPPED
///   - Partial results preserved and reported
///   - State file updated with cancellation reason
///
/// Latency: < 10ms from kill to teardown entry.
/// </summary>
public void KillSwitch()
{
    _aborted = true;
    _killSwitch?.Cancel();
    // The linked CancellationToken propagates to all async operations:
    //   - Stimulus HTTP requests (HttpClient respects CT)
    //   - Task.Delay in capture polling
    //   - RecordingSession observer callbacks stop on next tick
    // TEARDOWN runs in finally block — NOT cancelled by kill switch.
}
```

**SignalR integration:**
```csharp
// In EdogPlaygroundHub:
public async Task CancelRun(string runId)
{
    _executionEngine.KillSwitch();
    await Clients.Caller.SendAsync("RunCancelled", runId);
}
```

### 5.2 Memory Limits

| Resource | Limit | Enforcement |
|----------|-------|-------------|
| Events per recording session | 50,000 | `RecordingSession._maxEvents` counter. Observer stops capturing at limit. |
| Recording session working memory | < 100 MB | Estimated: 50K events × ~2KB avg = ~100MB. If exceeded, oldest events evicted (LRU within topic). |
| Scenarios per run | 50 | Enforced at generation time. LLM output truncated. |
| Total event buffer (all topics) | Existing TopicBuffer ring sizes (p0-foundation.md §1.1) | Ring eviction per topic. No change needed. |
| LLM token budget per run | 100K input + 50K output | Token counter in `GptScenarioReasoner`. Abort generation at budget. |
| Roslyn workspace | ~500 MB (typical .NET solution) | Pre-existing OmniSharp process limit. Not controlled by F27. |

```csharp
// Memory cap enforcement in RecordingSession observer callback:
var sub = buffer.AddObserver(evt =>
{
    if (Interlocked.CompareExchange(ref _totalCaptured, 0, 0) >= _maxEvents)
    {
        // Memory cap reached. Stop capturing. Log once.
        return;
    }
    // ... capture logic
});
```

### 5.3 Timeout Enforcement

| Level | Timeout | Default | Max | Enforcement |
|-------|---------|---------|-----|-------------|
| Per-scenario | `scenario.timeoutMs` | 30,000 ms | 60,000 ms | `CancellationTokenSource.CancelAfter()` in CAPTURE phase |
| Per-run | Hard ceiling | 30 minutes | 30 minutes | `CancellationTokenSource.CancelAfter()` in `ExecuteRunAsync()` |
| Per-stimulus | Type-dependent | Varies | 60,000 ms | `HttpClient.Timeout` or per-handler `Task.WhenAny` |
| Per-setup-step | Fixed | 10,000 ms | 10,000 ms | `CancellationTokenSource.CancelAfter()` per step |
| OmniSharp warm-up | Fixed | 60,000 ms | 60,000 ms | Skip enrichment if exceeded |
| LLM call | Per-zone | 30,000 ms | 30,000 ms | HTTP timeout on Azure OpenAI call |

```csharp
// Per-scenario timeout (CAPTURE phase):
using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
timeoutCts.CancelAfter(Math.Min(scenario.TimeoutMs, 60_000)); // enforce max

// Special handling for timeout=0:
if (scenario.TimeoutMs <= 0)
    timeoutCts.CancelAfter(300_000); // 5-minute max ceiling

// Timeout does NOT skip teardown — it's in a finally block.
```

### 5.4 Chaos Cleanup Guarantee

The TEARDOWN phase is in a `finally` block. It runs even if:
- Stimulus throws an exception
- Capture phase times out
- Assertion engine crashes
- Kill switch is triggered

```csharp
// Guaranteed teardown pattern (from §3.3 ExecuteScenarioAsync):
try
{
    // Phases 1–6...
}
finally
{
    // Phase 7: TEARDOWN (always runs)
    try
    {
        // 1. Execute scenario-defined teardown steps
        foreach (var step in scenario.Teardown)
            await ExecuteTeardownStepAsync(step, scenario.Id);

        // 2. Force-remove any lingering chaos rules tagged with this scenario
        _chaos.RemoveRulesForScenario(scenario.Id);

        // 3. Force-restore any lingering flag overrides
        _flagStore.ClearOverridesForScenario(scenario.Id);
    }
    catch
    {
        // Teardown errors are logged but NEVER propagated.
        // If chaos rules can't be removed, the inter-scenario gap
        // safety check (§3.3 RunInterScenarioGapAsync) provides
        // a second cleanup pass with force-clear.
    }

    // 4. Always dispose the recording session
    session?.Dispose();
}
```

**Double-safety:** Even if teardown fails, the inter-scenario gap (500ms + 3 retries) performs a second cleanup pass. Orphan chaos rules and flag overrides are force-cleared before the next scenario.

### 5.5 Error Isolation (One Scenario Failure Does Not Crash the Run)

```csharp
// From §3.3 ExecuteRunAsync — each scenario is wrapped independently:
foreach (var scenario in scenarios)
{
    ScenarioResult result;
    try
    {
        result = await ExecuteScenarioAsync(scenario, ct);
    }
    catch (OperationCanceledException) when (_aborted)
    {
        // Kill switch — stop the run entirely
        result = MakeCrashedResult(scenario, "Run aborted via kill switch");
        runResult.Scenarios.Add(result);
        break; // exit loop
    }
    catch (Exception ex)
    {
        // ANY other exception — scenario crashed, but run continues
        result = MakeCrashedResult(scenario, ex.Message);
    }

    runResult.Scenarios.Add(result);
    // Continue to next scenario
}
```

**Error categories and handling:**

| Error | Phase | Impact | Recovery |
|-------|-------|--------|----------|
| Setup step fails | SETUP | Scenario skipped | `SKIPPED` verdict, continue run |
| Stimulus transport error | STIMULATE | Scenario failed | `FAILED` verdict, continue run |
| Stimulus returns 5xx | STIMULATE | Not an error | Assertions evaluate the 5xx response |
| Assertion engine exception | EVALUATE | Scenario crashed | `CRASHED` verdict, continue run |
| TopicBuffer observer throws | CAPTURE | Event missed | Swallowed per observer pattern. Logged. |
| Teardown fails | TEARDOWN | Lingering state | Inter-scenario gap force-clears |
| FLT process crash | Any | Run interrupted | Crash recovery on restart (§4.4) |
| Out of memory | Any | Process unstable | Resource monitor triggers kill switch |
| Cancellation token | Any | Run cancelled | Partial results preserved |

### 5.6 Resource Monitoring

```csharp
/// <summary>
/// Lightweight resource monitor. Checks at inter-scenario gap.
/// Does NOT continuously poll (that would consume resources).
///
/// Thresholds:
///   - Process memory > 2 GB: warn
///   - Process memory > 3 GB: kill switch (prevent OOM crash)
///   - CPU > 95% for > 10s: warn (logged, no action)
///
/// Performance: < 1ms per check (Process.GetCurrentProcess() is cached).
/// </summary>
public sealed class QaResourceMonitor
{
    private const long WarningMemoryBytes = 2L * 1024 * 1024 * 1024;  // 2 GB
    private const long KillMemoryBytes = 3L * 1024 * 1024 * 1024;     // 3 GB

    /// <summary>
    /// Check resource usage. Called once per inter-scenario gap.
    ///
    /// Pseudocode:
    ///   process = Process.GetCurrentProcess()
    ///   workingSet = process.WorkingSet64
    ///   if workingSet > KillMemoryBytes:
    ///     publish warning to qa topic
    ///     return ResourceStatus.Kill
    ///   if workingSet > WarningMemoryBytes:
    ///     publish warning to qa topic
    ///     return ResourceStatus.Warn
    ///   return ResourceStatus.Ok
    /// </summary>
    public ResourceStatus Check()
    {
        var process = System.Diagnostics.Process.GetCurrentProcess();
        var memoryBytes = process.WorkingSet64;

        if (memoryBytes > KillMemoryBytes)
        {
            EdogTopicRouter.Publish("qa", new
            {
                @event = "ResourceLimitExceeded",
                memoryMb = memoryBytes / (1024 * 1024),
                action = "kill",
            });
            return ResourceStatus.Kill;
        }

        if (memoryBytes > WarningMemoryBytes)
        {
            EdogTopicRouter.Publish("qa", new
            {
                @event = "ResourceWarning",
                memoryMb = memoryBytes / (1024 * 1024),
                action = "warn",
            });
            return ResourceStatus.Warn;
        }

        return ResourceStatus.Ok;
    }
}

public enum ResourceStatus { Ok, Warn, Kill }
```

Integration with execution loop:
```csharp
// In RunInterScenarioGapAsync, after safety checks:
var resourceStatus = _resourceMonitor.Check();
if (resourceStatus == ResourceStatus.Kill)
{
    KillSwitch(); // abort entire run
}
```

---

## Appendix A: Scenario Accountability Matrix

All 86 scenarios from P1 component specs are accountable in this architecture:

| Component | Scenario Count | Architecture Coverage |
|-----------|---------------|----------------------|
| C01: Code Understanding | 13 (S01–S13) | §2: Code engine interfaces + orchestrator |
| C02: Scenario Model & Curation | 13 (S01–S13) | §1: Data model + §4: Scenario storage |
| C03: Execution Engine | 14 (S01–S14) | §3: Execution pipeline + state machine |
| C04: Assertion Engine | 14 (S01–S14) | §3.6: Assertion integration + §1 Matcher types |
| C05: Results & Reporting | 13 (S01–S13) | §1: RunResult/ScenarioResult + §4: Result storage |
| C06: Frontend Panel | 15 (S01–S15) | §1.3: TypeScript interfaces (frontend-backend contract) |
| **Total** | **82** | **All covered** |

Remaining 4 scenarios (from cross-cutting concerns in spec §8–9):
- CI/CD integration (spec §9.4) → out of scope for V1 architecture, documented as Phase 2
- ADO PR comment posting (spec §7.2) → protocol spec (separate P2.5 document)
- Learning loop feedback (spec §7.4) → §4: feedback.jsonl storage
- Command palette integration (spec §9.1) → frontend registration pattern (C06-S01)

## Appendix B: Performance Budget

| Operation | Target | Measured By |
|-----------|--------|-------------|
| PR diff fetch | < 3s | ADO API round-trip |
| Structural graph build (L1+L2) | < 3s | Parallel execution |
| Semantic enrichment (L3) | < 5s (warm) | OmniSharp query batch |
| DI validation (L5) | < 100ms | In-memory lookup |
| Impact zone clustering | < 200ms | In-memory algorithm |
| Entry point classification | < 50ms total | BFS traversal |
| LLM scenario generation | < 25s | Parallelized across zones |
| **Total analysis pipeline** | **< 45s** | **p95 for < 500-line diff** |
| Scenario orchestration overhead | < 50ms | Excluding stimulus + capture |
| Per-scenario execution (typical) | < 30s | p95 |
| Inter-scenario gap | 500ms + up to 600ms safety | Fixed |
| Recording session create | < 5ms | Observer subscription |
| Recording per-event overhead | < 1μs | List.Add under lock |
| Assertion evaluation | < 50ms | 50K events × 50 expectations |
| Result persistence | < 100ms | Atomic file write |
| State persistence | < 10ms | Atomic file write |
| Kill switch to teardown | < 10ms | CT propagation |

## Appendix C: File Inventory

| File (NEW) | Purpose |
|------------|---------|
| `src/backend/DevMode/QaModels.cs` | All domain objects (§1) |
| `src/backend/DevMode/QaCodeEngineInterfaces.cs` | Code understanding interfaces (§2) |
| `src/backend/DevMode/EdogQaCodeEngine.cs` | Code understanding orchestrator (§2) |
| `src/backend/DevMode/QaEntryPointClassifier.cs` | Entry point BFS + classification (§2) |
| `src/backend/DevMode/EdogQaExecutionEngine.cs` | Execution pipeline (§3) |
| `src/backend/DevMode/QaStimulusDispatcher.cs` | Stimulus routing (§3) |
| `src/backend/DevMode/QaScenarioStore.cs` | Scenario persistence (§4) |
| `src/backend/DevMode/QaResultStore.cs` | Result persistence (§4) |
| `src/backend/DevMode/QaResourceMonitor.cs` | Resource monitoring (§5) |

| File (MODIFIED) | Change |
|-----------------|--------|
| `src/backend/DevMode/TopicBuffer.cs` | Add `AddObserver()` + `ObserverRemoval` (§3.4) |
| `src/backend/DevMode/EdogPlaygroundHub.cs` | Add QA SignalR methods (spec §8.4) |
| `src/backend/DevMode/EdogDevModeRegistrar.cs` | Register QA engine + OmniSharp pre-warm |
| `src/backend/DevMode/EdogTopicRouter.cs` | Register `qa` topic in `Initialize()` |
