# Feature 27: QA Testing — AI-Driven Scenario Generation & Execution

> **Phase:** V2
> **Status:** Design Complete
> **Owner:** Hemant Gupta
> **Spec:** docs/specs/features/F27-qa-testing.md
> **Dependencies:** F24 (Chaos Engineering), All 11 interceptors, EdogPlaygroundHub (SignalR)

---

## 1. Product Vision & Why

### Problem Statement

FabricLiveTable has 400K+ lines of C# across 50+ services. PRs merge with manual testing that covers the happy path but misses blast-radius side effects. Code reviewers can't predict whether a change to `LakehouseFileWriter` silently breaks the retry logic in `OneLakeClient` three layers away. Integration tests exist but are coarse-grained (whole-DAG runs), slow (5-10 minutes), and don't validate internal behavior — only final output.

EDOG Studio sits INSIDE the FLT process. It already captures every HTTP call, every log, every telemetry event, every file operation — in real-time. The QA Testing feature (F27) weaponizes this position: given a PR diff, it understands what changed, generates precise test scenarios with explicit expectations, executes them one-by-one against the live process, and compares interceptor traces against expectations. Binary PASS/FAIL. No ambiguity.

### Persona

**Primary:** FLT engineer (the PR author). Runs F27 locally before requesting code review to catch regressions early.
**Secondary:** FLT code reviewer. Looks at F27 results posted to the PR comment thread to assess coverage.
**Tertiary:** CI system. Runs F27 automatically on PR creation/update as a gate check.

### Success Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| Scenarios generated per PR | 5-30 depending on diff size | Average across 50 PRs |
| Scenario generation latency | < 45 seconds for < 500-line diff | p95 |
| Scenario execution time (single) | < 30 seconds | p95 |
| False positive rate | < 5% | Scenarios marked FAIL that are actually correct behavior |
| User curation rate | > 60% of generated scenarios kept as-is | Tracks AI quality |
| Regressions caught pre-merge | > 1 per 10 PRs | Validated by post-merge incident analysis |

---

## 2. User Journey (End-to-End Flow)

### Step 1: Provide PR Input

User opens EDOG Studio → navigates to QA Testing panel (sidebar icon: ◆ with checkmark). Enters an Azure DevOps PR URL or selects from recent PRs auto-detected from their git branch.

**Input format:** `https://dev.azure.com/powerbi/MWC/_git/workload-fabriclivetable/pullrequest/{id}` or just PR number `#12345`.

**System action:** Fetches PR diff via ADO REST API. Displays: title, author, files changed (count), lines added/removed.

### Step 2: Code Understanding (Automatic)

System immediately begins three parallel analyses:

1. **Roslyn blast radius** — parses the diff, resolves all affected symbols, traces call graphs to find every method that could be impacted. Returns a ranked list of "impact zones" (clusters of related affected code).

2. **Graphify context** — queries the knowledge graph for each impact zone: related tests, documentation, recent bugs in the same area, architectural patterns. Returns context bundles.

3. **File classification** — categorizes changed files: production code, test code, config, documentation. Filters test-only PRs (offer abbreviated flow).

**UI:** Progress indicator showing "Analyzing blast radius... (12 files, 340 lines)" → "Building context graph..." → "Generating scenarios..."

### Step 3: Scenario Generation

GPT-5.4-pro receives: (a) the diff with 3 levels of call-graph context, (b) Graphify context bundles, (c) interceptor schema (what's observable), (d) the scenario JSON schema. Returns 5-30 scenarios.

**UI:** Scenarios appear in a list as they stream in (SSE from backend). Each shows: title, category badge (happy/error/edge/perf), expected event count, estimated execution time.

### Step 4: User Curation

User reviews each scenario. Actions per scenario:
- **Approve** (default) — will run as generated
- **Edit** — inline JSON editor for expectations; can modify stimulus, add/remove expectations
- **Delete** — remove from run queue
- **Add Manual** — user writes a scenario from scratch (template provided)
- **Reorder** — drag to change execution order (matters when scenarios have state dependencies)

**Default behavior:** All generated scenarios are pre-approved. User only intervenes if something looks wrong. "Run All" button prominent.

### Step 5: Execution

User clicks "Run All" or "Run Selected." Scenarios execute sequentially. UI shows:
- Current scenario highlighted with spinner
- Live interceptor events streaming in the right panel (filtered to relevant topics)
- Real-time expectation matching (expectations turn green/red as events arrive)
- Progress: "3/12 complete — 2 passed, 1 failed"

### Step 6: Results Review

After all scenarios complete, results summary:
- Overall: PASSED (10/12) or FAILED (2/12)
- Per scenario: status, duration, matched expectations (with evidence links)
- Failed scenarios: which expectations didn't match, what WAS observed instead, suggested fix
- Timeline view: all intercepted events during execution, with scenario boundaries marked

### Step 7: Post to PR

User clicks "Post Results to PR." System formats results as an ADO PR comment using markdown. Includes: summary table, per-scenario details for failures, link back to EDOG Studio for full trace exploration.

---

## 3. Code Understanding Engine

### 3.1 Roslyn Analyzer

**Input:** PR diff (unified diff format from ADO API).

**Process:**
1. Parse diff to extract: modified files, added/removed/changed lines, method-level changes.
2. Load the FLT solution (`workload-fabriclivetable.sln`) into a Roslyn workspace.
3. For each changed method/class:
   - Find all callers (up to 4 levels deep) via `SymbolFinder.FindCallersAsync`
   - Find all implementations of interfaces that the changed code implements
   - Find all DI registrations that resolve to the changed type
   - Find all override chains (virtual/abstract hierarchy)
4. Cluster results into "impact zones" — groups of related affected code that form a logical unit.

**Output (per impact zone):**
```json
{
  "zoneId": "zone-001",
  "primaryChange": {
    "file": "src/Services/OneLakeClient.cs",
    "method": "WriteFileAsync",
    "changeType": "modified",
    "linesChanged": [142, 143, 155, 156, 157]
  },
  "affectedCallers": [
    {
      "file": "src/Services/LakehouseFileWriter.cs",
      "method": "FlushBufferAsync",
      "depth": 1,
      "callSite": "line 89"
    }
  ],
  "affectedInterfaces": ["IFileSystemClient", "IOneLakeWriter"],
  "diRegistrations": [
    "services.AddScoped<IOneLakeWriter, OneLakeClient>()"
  ],
  "relatedTests": ["OneLakeClientTests.cs", "LakehouseFileWriterTests.cs"],
  "interceptorTopics": ["fileop", "http", "retry"]
}
```

**Performance:** Roslyn workspace load: ~10s (cached after first load). Per-zone analysis: ~2s. Total for typical PR: < 20s.

### 3.2 Graphify Knowledge Graph

**Input:** Impact zone IDs from Roslyn.

**Process:**
1. Query the persistent knowledge graph (Neo4j-backed, incrementally updated on each commit).
2. For each impact zone, retrieve:
   - Community cluster (what subsystem does this belong to?)
   - Historical bugs in the same cluster (last 6 months)
   - Related documentation (design docs, ADRs, wiki pages)
   - Common failure patterns (from past incident post-mortems)
   - Test coverage gaps (methods with no unit test referencing them)

**Output (per zone):**
```json
{
  "zoneId": "zone-001",
  "community": "OneLake Storage Layer",
  "historicalBugs": [
    {"id": "BUG-4521", "title": "WriteFileAsync silent failure on 409 conflict", "resolution": "Added retry with exponential backoff"}
  ],
  "relatedDocs": ["docs/architecture/onelake-integration.md"],
  "failurePatterns": ["409 conflicts under concurrent writes", "token expiry during long uploads"],
  "coverageGaps": ["No test for WriteFileAsync with >4MB payload"]
}
```

**Performance:** Graph query: < 3s per zone (indexed traversal).

### 3.3 GPT-5.4-pro Scenario Generation

**Input:** Combined Roslyn zones + Graphify context + interceptor schema + scenario JSON schema + system prompt.

**System Prompt (core structure):**
```
You are a senior QA engineer analyzing a code change in FabricLiveTable.
You have access to the following interceptor topics that capture events in real-time:
{interceptor_schema}

For each impact zone, generate test scenarios that verify the change works correctly.
Each scenario must have:
1. A clear STIMULUS (what triggers the behavior)
2. Explicit EXPECTATIONS (what interceptor events should appear)
3. Category (happy_path | error_path | edge_case | regression | performance)

Rules:
- Expectations must reference OBSERVABLE events (interceptor topics only)
- Every expectation must be binary verifiable (matched or not matched)
- Include timing constraints only when behavior is time-sensitive
- Generate absence assertions for error paths ("this error log should NOT appear")
- Reference the specific code change to justify why this scenario matters
- If the change affects retry logic, include a chaos scenario (inject failure → verify retry)
```

**Output:** Array of Scenario objects (see §4 for schema).

**Token budget:** ~8K input (diff + context + schema), ~4K output per generation call. Multiple calls for large PRs (one per impact zone cluster).

**Performance:** GPT-5.4-pro latency: ~10-15s per call. Parallelized across zones: total < 25s for typical PR.

### 3.4 Composition Pipeline

```
PR Diff (ADO API)
    │
    ├──→ [Roslyn Analyzer] ──→ Impact Zones (parallel)
    │                              │
    │                              ├──→ [Graphify Query] ──→ Context Bundles
    │                              │
    │                              └──→ [File Classifier] ──→ Change Categories
    │
    └──→ (wait for all) ──→ [GPT-5.4-pro] ──→ Scenarios
                                                    │
                                                    └──→ [Deduplication] ──→ Final Scenario List
```

**Failure modes:**
- Roslyn fails to parse: Fall back to text-based diff analysis (regex extraction of method names). Reduced quality, still functional.
- Graphify unavailable: Skip historical context. Scenarios generated from code alone.
- GPT-5.4-pro timeout: Retry once with reduced context. If still fails, present partial results + offer manual scenario creation.
- All three fail: Show error with "Create Manual Scenarios" CTA.

### 3.5 Pinnacle Quality Pipeline (F27 items 1–6)

The plain pipeline above produces plausible scenarios but, without
extra discipline, drifts into hallucinated endpoints, missed boundary
triplets, and scenarios untethered from contract requirements. The
pinnacle layer hardens it in three stages:

```
PR Diff
   │
   ├──→ [PR Contract Context]   item 1 — description + ACs + OpenAPI + prior tests
   │
   ├──→ [Invariant Extractor]   item 2 — regex scan of diff hunks for numeric
   │                                     constants, comparisons, temporal thresholds,
   │                                     explicit errors, added/removed parameters.
   │
   ├──→ [Few-shot Exemplars]    item 4 — three exemplars (boundary triplet,
   │                                     counterfactual, 2×2 truth table) inject
   │                                     concrete patterns into the system prompt.
   │
   ├──→ [LLM (GPT-5.4-pro)]     emits scenarios with:
   │                              - technique (item 3) — taxonomy of techniques
   │                              - invariantsAddressed — links to extracted invariants
   │                              - groundingEvidence (item 6) — file:line + reason
   │
   └──→ [Scenario Linter]       item 5 — 10 deterministic rules that catch drift
                                 before scenarios reach the curation UI.
```

The linter rules are catalogued in §11. The schema additions (technique,
invariantsAddressed, groundingEvidence) appear in §4.1.

---

## 4. Scenario Model

### 4.1 Scenario JSON Schema

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "required": ["id", "title", "category", "stimulus", "expectations"],
  "properties": {
    "id": {
      "type": "string",
      "pattern": "^scn-[a-z0-9-]+$",
      "description": "Unique scenario identifier"
    },
    "title": {
      "type": "string",
      "maxLength": 120,
      "description": "Human-readable scenario name"
    },
    "description": {
      "type": "string",
      "maxLength": 500,
      "description": "What this scenario verifies and why"
    },
    "category": {
      "type": "string",
      "enum": ["happy_path", "error_path", "edge_case", "regression", "performance"]
    },
    "priority": {
      "type": "integer",
      "minimum": 1,
      "maximum": 5,
      "description": "1=critical, 5=nice-to-have"
    },
    "impactZone": {
      "type": "string",
      "description": "Reference to the Roslyn impact zone that motivated this scenario"
    },
    "setup": {
      "type": "array",
      "items": { "$ref": "#/definitions/SetupStep" },
      "description": "Pre-conditions to establish before stimulus. Includes F24 chaos rules."
    },
    "stimulus": {
      "$ref": "#/definitions/Stimulus",
      "description": "The action that triggers the behavior under test"
    },
    "expectations": {
      "type": "array",
      "items": { "$ref": "#/definitions/Expectation" },
      "minItems": 1,
      "description": "What should be observed in the interceptor trace"
    },
    "teardown": {
      "type": "array",
      "items": { "$ref": "#/definitions/TeardownStep" },
      "description": "Cleanup actions after scenario completes"
    },
    "timeout": {
      "type": "integer",
      "default": 30000,
      "description": "Max execution time in milliseconds"
    },
    "technique": {
      "type": "string",
      "enum": [
        "NotSpecified", "BoundaryTriplet", "Counterfactual", "TruthTable",
        "EquivalencePartition", "ErrorPath", "RegressionGuard", "HappyPath"
      ],
      "default": "NotSpecified",
      "description": "Test technique applied (F27 pinnacle item 3). Surfaced as a colored pill on the curation UI and required by linter rule LNT003."
    },
    "invariantsAddressed": {
      "type": "array",
      "items": { "type": "string", "pattern": "^inv-[a-z_]+-[a-f0-9]{6}$" },
      "description": "Invariant IDs (from EdogQaInvariantExtractor) that this scenario verifies. Linter rule LNT002 fails if any extracted invariant has zero coverage; LNT008 fails if GroundingEvidence cites an invariant not listed here."
    },
    "groundingEvidence": {
      "type": "array",
      "items": { "$ref": "#/definitions/GroundingEvidence" },
      "description": "File:line ranges from the diff that ground this scenario in real code (F27 pinnacle item 6). LNT004 enforces >=1 entry with non-empty file+reason; LNT005 cross-checks each file against the diff."
    },
    "metadata": {
      "type": "object",
      "properties": {
        "generatedBy": { "type": "string", "enum": ["ai", "manual", "template"] },
        "confidence": { "type": "number", "minimum": 0, "maximum": 1 },
        "relatedPRFiles": { "type": "array", "items": { "type": "string" } },
        "tags": { "type": "array", "items": { "type": "string" } },
        "schemaVersion": { "type": "integer", "default": 2, "description": "Bumped to 2 when technique + grounding fields were added." }
      }
    }
  },
  "definitions": {
    "SetupStep": {
      "type": "object",
      "required": ["type"],
      "properties": {
        "type": {
          "type": "string",
          "enum": ["chaos_rule", "flag_override", "state_seed", "wait"]
        },
        "chaosRule": {
          "type": "object",
          "description": "F24 chaos rule to inject (fault injection, latency, etc.)",
          "properties": {
            "target": { "type": "string" },
            "fault": { "type": "string", "enum": ["http_error", "latency", "timeout", "partial_response"] },
            "parameters": { "type": "object" }
          }
        },
        "flagOverride": {
          "type": "object",
          "properties": {
            "flagName": { "type": "string" },
            "value": { "type": "boolean" }
          }
        },
        "stateSeed": {
          "type": "object",
          "description": "API call to establish precondition state",
          "properties": {
            "method": { "type": "string" },
            "url": { "type": "string" },
            "body": { "type": "object" }
          }
        },
        "wait": {
          "type": "object",
          "properties": {
            "durationMs": { "type": "integer" }
          }
        }
      }
    },
    "Stimulus": {
      "type": "object",
      "required": ["type"],
      "properties": {
        "type": {
          "type": "string",
          "enum": ["http_request", "signalr_invoke", "dag_trigger", "file_event", "timer_tick"]
        },
        "httpRequest": {
          "type": "object",
          "properties": {
            "method": { "type": "string" },
            "path": { "type": "string" },
            "headers": { "type": "object" },
            "body": { "type": "object" }
          }
        },
        "signalrInvoke": {
          "type": "object",
          "properties": {
            "hub": { "type": "string" },
            "method": { "type": "string" },
            "args": { "type": "array" }
          }
        },
        "dagTrigger": {
          "type": "object",
          "properties": {
            "iterationId": { "type": "string" },
            "nodeFilter": { "type": "array", "items": { "type": "string" } }
          }
        }
      }
    },
    "Expectation": {
      "type": "object",
      "required": ["id", "type", "topic"],
      "properties": {
        "id": {
          "type": "string",
          "pattern": "^exp-[0-9]+$"
        },
        "type": {
          "type": "string",
          "enum": ["event_present", "event_absent", "event_count", "event_order", "timing", "field_match"]
        },
        "topic": {
          "type": "string",
          "enum": ["http", "token", "flag", "perf", "spark", "log", "telemetry", "retry", "cache", "fileop"]
        },
        "matcher": {
          "$ref": "#/definitions/Matcher"
        },
        "timeWindow": {
          "type": "object",
          "properties": {
            "withinMs": { "type": "integer", "description": "Must appear within N ms of stimulus" },
            "afterMs": { "type": "integer", "description": "Must appear at least N ms after stimulus" }
          }
        },
        "count": {
          "type": "object",
          "properties": {
            "min": { "type": "integer" },
            "max": { "type": "integer" },
            "exact": { "type": "integer" }
          }
        },
        "order": {
          "type": "object",
          "properties": {
            "after": { "type": "string", "description": "Must appear after this expectation ID" }
          }
        },
        "description": {
          "type": "string",
          "description": "Human-readable explanation of what this expectation verifies"
        }
      }
    },
    "Matcher": {
      "type": "object",
      "description": "Field-level matching rules against interceptor event properties",
      "properties": {
        "exact": {
          "type": "object",
          "description": "Fields that must match exactly",
          "additionalProperties": true
        },
        "contains": {
          "type": "object",
          "description": "Fields that must contain the specified substring",
          "additionalProperties": { "type": "string" }
        },
        "regex": {
          "type": "object",
          "description": "Fields that must match the regex pattern",
          "additionalProperties": { "type": "string" }
        },
        "range": {
          "type": "object",
          "description": "Numeric fields that must be within range",
          "additionalProperties": {
            "type": "object",
            "properties": {
              "min": { "type": "number" },
              "max": { "type": "number" }
            }
          }
        },
        "exists": {
          "type": "array",
          "items": { "type": "string" },
          "description": "Fields that must be present (non-null)"
        }
      }
    },
    "TeardownStep": {
      "type": "object",
      "required": ["type"],
      "properties": {
        "type": {
          "type": "string",
          "enum": ["remove_chaos_rule", "restore_flag", "cleanup_state"]
        }
      }
    },
    "GroundingEvidence": {
      "type": "object",
      "required": ["file", "reason"],
      "description": "A file:line range from the diff that the LLM cited as justification for a scenario. Validated by linter rules LNT004 (non-empty) and LNT005 (file appears in diff).",
      "properties": {
        "file": { "type": "string", "description": "Repo-relative file path from PrContext.Invariants[].file or PriorTests[].file." },
        "startLine": { "type": "integer", "minimum": 1 },
        "endLine":   { "type": "integer", "minimum": 1 },
        "reason":    { "type": "string", "maxLength": 240, "description": "Why this range motivates the scenario." },
        "invariantId": { "type": "string", "pattern": "^inv-[a-z_]+-[a-f0-9]{6}$", "description": "Optional invariant linkage. If set, must appear in Scenario.invariantsAddressed (LNT008)." }
      }
    }
  }
}
```

### 4.2 Concrete Scenario Examples

**Example 1: Data flow correctness (happy path)**
```json
{
  "id": "scn-write-file-correct-path",
  "title": "WriteFileAsync writes to correct OneLake path with expected content",
  "category": "happy_path",
  "priority": 1,
  "impactZone": "zone-001",
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
    },
    {
      "id": "exp-2",
      "type": "event_present",
      "topic": "http",
      "matcher": {
        "exact": { "method": "PUT", "statusCode": 201 },
        "regex": { "url": ".*dfs\\.fabric\\.microsoft\\.com.*/Tables/Table1/.*\\.parquet" }
      },
      "timeWindow": { "withinMs": 15000 },
      "description": "HTTP PUT to OneLake DFS endpoint returns 201 Created"
    }
  ],
  "timeout": 20000
}
```

**Example 2: Error handling with chaos injection**
```json
{
  "id": "scn-retry-on-429-throttle",
  "title": "OneLake 429 triggers exponential backoff retry",
  "category": "error_path",
  "priority": 1,
  "impactZone": "zone-001",
  "setup": [
    {
      "type": "chaos_rule",
      "chaosRule": {
        "target": "http://*/dfs.fabric.microsoft.com/*",
        "fault": "http_error",
        "parameters": { "statusCode": 429, "retryAfterMs": 1000, "failCount": 2 }
      }
    }
  ],
  "stimulus": {
    "type": "dag_trigger",
    "dagTrigger": { "iterationId": "current", "nodeFilter": ["MaterializeNode_Table1"] }
  },
  "expectations": [
    {
      "id": "exp-1",
      "type": "event_count",
      "topic": "retry",
      "matcher": {
        "exact": { "statusCode": 429, "isThrottle": true }
      },
      "count": { "min": 2, "max": 3 },
      "description": "At least 2 retry attempts logged for 429 throttle"
    },
    {
      "id": "exp-2",
      "type": "event_present",
      "topic": "retry",
      "matcher": {
        "range": { "waitDurationMs": { "min": 900, "max": 5000 } }
      },
      "order": { "after": "exp-1" },
      "description": "Retry wait duration respects exponential backoff"
    },
    {
      "id": "exp-3",
      "type": "event_present",
      "topic": "http",
      "matcher": {
        "exact": { "statusCode": 201 },
        "regex": { "url": ".*dfs\\.fabric\\.microsoft\\.com.*" }
      },
      "description": "Final request succeeds after retries"
    },
    {
      "id": "exp-4",
      "type": "event_absent",
      "topic": "log",
      "matcher": {
        "exact": { "level": "Error" },
        "contains": { "message": "WriteFileAsync failed permanently" }
      },
      "description": "No permanent failure error logged — retries recovered"
    }
  ],
  "teardown": [
    { "type": "remove_chaos_rule" }
  ],
  "timeout": 30000
}
```

**Example 3: Feature flag behavior**
```json
{
  "id": "scn-flag-off-skips-cache",
  "title": "When EnableResultCache flag is OFF, no cache writes occur",
  "category": "edge_case",
  "priority": 2,
  "setup": [
    { "type": "flag_override", "flagOverride": { "flagName": "EnableResultCache", "value": false } }
  ],
  "stimulus": {
    "type": "dag_trigger",
    "dagTrigger": { "iterationId": "current" }
  },
  "expectations": [
    {
      "id": "exp-1",
      "type": "event_present",
      "topic": "flag",
      "matcher": {
        "exact": { "flagName": "EnableResultCache", "result": false }
      },
      "description": "Flag evaluation returns false (override active)"
    },
    {
      "id": "exp-2",
      "type": "event_absent",
      "topic": "cache",
      "matcher": {
        "exact": { "operation": "Set" }
      },
      "description": "No cache Set operations when flag is OFF"
    }
  ],
  "teardown": [
    { "type": "restore_flag" }
  ]
}
```

### 4.3 Scenario Lifecycle

```
GENERATED → CURATED → QUEUED → EXECUTING → COMPLETED → ARCHIVED
                ↓                              ↓
             DELETED                    FAILED / TIMED_OUT
```

- **Generated:** AI produced it; awaiting user review.
- **Curated:** User approved (possibly edited). Ready to queue.
- **Queued:** In the execution pipeline, waiting its turn.
- **Executing:** Currently running. Interceptors capturing. Clock ticking.
- **Completed:** All expectations evaluated. Has a PASS/FAIL result.
- **Failed:** Scenario could not execute (FLT crash, setup failure). Distinct from expectations not met.
- **Timed_out:** Exceeded timeout. Treated as FAIL with "timeout" reason.
- **Archived:** Historical record. Used for learning loop.
- **Deleted:** User explicitly removed. Stored for negative feedback signal.

---

## 5. Execution Engine

### 5.1 Execution Flow (Per Scenario)

```
1. ISOLATE: Clear interceptor buffers for relevant topics (fresh recording window)
2. SETUP: Execute setup steps sequentially (chaos rules, flag overrides, state seeds)
3. MARK: Record timestamp T0 (stimulus start)
4. STIMULATE: Execute the stimulus action
5. CAPTURE: Stream interceptor events for `timeout` duration or until all expectations are met (whichever first)
6. EVALUATE: Run assertion engine against captured events
7. TEARDOWN: Execute teardown steps (remove chaos, restore flags)
8. REPORT: Emit result to frontend via SignalR
```

### 5.2 Stimulus Execution

| Stimulus Type | Mechanism |
|---------------|-----------|
| `http_request` | EDOG sends HTTP request to FLT's internal Kestrel endpoints (localhost:5555 proxies to FLT port) |
| `signalr_invoke` | Invoke hub method on EdogPlaygroundHub with specified args |
| `dag_trigger` | `POST /liveTableSchedule/runDAG/{iterationId}` via the existing DAG trigger mechanism |
| `file_event` | Write a file to the watched OneLake path to trigger file-change detection |
| `timer_tick` | Advance the internal timer / wait for the next scheduled tick |

**Key insight:** EDOG is inside the process. It can call internal methods directly via DI resolution, not just HTTP endpoints. For stimuli that need to invoke internal services:

```csharp
// Resolve service from DI and invoke directly
var writer = serviceProvider.GetRequiredService<IOneLakeWriter>();
await writer.WriteFileAsync(path, content, cancellationToken);
```

### 5.3 Scoped Recording

Each scenario gets a **recording session**:
- On START: `TopicBuffer.CreateSnapshot()` — marks current position in each ring buffer
- During execution: all new events after snapshot are captured
- On END: collect all events between snapshot and now

This avoids clearing buffers (which would lose data for Runtime View). Recording is additive, not destructive.

```csharp
public class RecordingSession : IDisposable
{
    public string ScenarioId { get; }
    public DateTime StartedAt { get; }
    public Dictionary<string, int> StartPositions { get; } // topic → buffer position at start
    
    public IReadOnlyList<InterceptorEvent> GetCapturedEvents(string topic);
    public IReadOnlyList<InterceptorEvent> GetAllCapturedEvents(); // across all topics
}
```

### 5.4 Sequential Execution with Isolation

Scenarios run one at a time. Between scenarios:
1. Wait 500ms (allow async operations from previous scenario to flush)
2. Verify no active chaos rules remain (safety check)
3. Verify flag overrides are restored
4. Start fresh recording session

If a scenario times out, the engine:
1. Force-completes the recording session
2. Evaluates whatever was captured (partial results)
3. Marks scenario as TIMED_OUT
4. Proceeds to next scenario after cleanup

### 5.5 FLT Crash Recovery

If FLT crashes during execution:
- The EDOG process (which runs inside FLT) also dies
- On restart, EDOG checks for in-progress execution state (persisted to `~/.edog/qa-state.json`)
- Resumes from the next unexecuted scenario
- Crashed scenario marked as FAILED with `reason: "process_crash"`

### 5.6 F24 Chaos Integration

Chaos rules in `setup` steps use the existing F24 Chaos Engineering subsystem:

```csharp
// Setup: inject chaos
await chaosEngine.AddRule(new ChaosRule {
    Target = scenario.Setup[0].ChaosRule.Target,
    Fault = scenario.Setup[0].ChaosRule.Fault,
    Parameters = scenario.Setup[0].ChaosRule.Parameters,
    ScenarioId = scenario.Id  // tagged for cleanup
});

// Teardown: remove all rules tagged with this scenario
await chaosEngine.RemoveRulesForScenario(scenario.Id);
```

The chaos engine (F24) already supports: HTTP error injection, latency injection, timeout simulation, partial response truncation, and intermittent failures (fail N of M requests).

---

## 6. Assertion Engine

### 6.1 Matching Logic

The assertion engine processes each expectation against the captured events:

```
For each Expectation E in scenario.expectations:
    candidateEvents = capturedEvents.Where(e => e.topic == E.topic)
    matchedEvents = candidateEvents.Where(e => MatcherSatisfied(e, E.matcher))
    
    switch E.type:
        case "event_present":
            PASS if matchedEvents.Count >= 1
            Apply timeWindow filter if specified
            Apply order constraint if specified
            
        case "event_absent":
            PASS if matchedEvents.Count == 0
            
        case "event_count":
            PASS if E.count.exact ? matchedEvents.Count == exact
                   : matchedEvents.Count >= min && matchedEvents.Count <= max
                   
        case "event_order":
            PASS if matchedEvents are ordered according to E.order constraints
            
        case "timing":
            PASS if matchedEvents[0].timestamp - T0 satisfies E.timeWindow
            
        case "field_match":
            PASS if first matched event has all specified field values
```

### 6.2 Matcher Evaluation

```csharp
bool MatcherSatisfied(InterceptorEvent evt, Matcher matcher)
{
    // All specified conditions must be true (AND logic)
    if (matcher.Exact != null)
        foreach (var (field, value) in matcher.Exact)
            if (evt.GetField(field)?.ToString() != value.ToString()) return false;
    
    if (matcher.Contains != null)
        foreach (var (field, substring) in matcher.Contains)
            if (!evt.GetField(field)?.ToString().Contains(substring)) return false;
    
    if (matcher.Regex != null)
        foreach (var (field, pattern) in matcher.Regex)
            if (!Regex.IsMatch(evt.GetField(field)?.ToString() ?? "", pattern)) return false;
    
    if (matcher.Range != null)
        foreach (var (field, range) in matcher.Range)
        {
            var numVal = Convert.ToDouble(evt.GetField(field));
            if (range.Min.HasValue && numVal < range.Min) return false;
            if (range.Max.HasValue && numVal > range.Max) return false;
        }
    
    if (matcher.Exists != null)
        foreach (var field in matcher.Exists)
            if (evt.GetField(field) == null) return false;
    
    return true;
}
```

### 6.3 Time Window Handling

Events are timestamped by the interceptor at capture time (high-resolution `DateTime.UtcNow`). Time window evaluation:

- `withinMs`: event.timestamp must be <= T0 + withinMs
- `afterMs`: event.timestamp must be >= T0 + afterMs

For `event_absent` with a time window: wait the FULL time window before concluding absence (don't short-circuit).

### 6.4 Absence Assertions

Critical for error-path scenarios. "This error should NOT appear."

Implementation: after the scenario timeout expires (or all positive expectations are met + 2s grace period), evaluate absence assertions against the full captured trace. This prevents false passes where the error event simply hasn't arrived yet.

### 6.5 Scoring

```
Per expectation: PASS (1.0) or FAIL (0.0)
Per scenario: ALL expectations must PASS for scenario to PASS (AND logic, not percentage)
Overall run: count of PASSED / total scenarios
```

No partial credit. A scenario either passes completely or fails. This eliminates ambiguity.

### 6.6 False Positive Mitigation

1. **Background noise filtering:** Events captured BEFORE T0 (stimulus start) are excluded.
2. **Correlation ID scoping:** If the stimulus generates a correlationId, expectations can optionally scope to events with that correlationId only.
3. **Topic specificity:** Expectations target specific topics, reducing cross-topic noise.
4. **Grace period for absence:** 2-second grace period after last positive expectation matches before evaluating absence assertions.
5. **Retry on timing failures:** If ONLY timing expectations fail (all other expectations pass), offer automatic retry with 2x timeout.

---

## 7. Results & Reporting

### 7.1 Result Data Model

```json
{
  "runId": "run-20250615-143022",
  "prId": 12345,
  "prTitle": "Fix WriteFileAsync retry logic",
  "startedAt": "2025-06-15T14:30:22Z",
  "completedAt": "2025-06-15T14:32:45Z",
  "totalDurationMs": 143000,
  "summary": {
    "total": 12,
    "passed": 10,
    "failed": 1,
    "timedOut": 1,
    "skipped": 0
  },
  "scenarios": [
    {
      "scenarioId": "scn-write-file-correct-path",
      "title": "WriteFileAsync writes to correct OneLake path",
      "status": "passed",
      "durationMs": 8432,
      "expectations": [
        {
          "id": "exp-1",
          "status": "passed",
          "matchedEvent": {
            "topic": "fileop",
            "timestamp": "2025-06-15T14:30:25.123Z",
            "fields": { "operation": "WriteFile", "path": "/Tables/Table1/part-00001.parquet" }
          },
          "matchLatencyMs": 3100
        }
      ]
    },
    {
      "scenarioId": "scn-retry-on-429-throttle",
      "title": "OneLake 429 triggers exponential backoff retry",
      "status": "failed",
      "durationMs": 30000,
      "expectations": [
        {
          "id": "exp-1",
          "status": "passed",
          "matchedEvents": [/* ... */]
        },
        {
          "id": "exp-3",
          "status": "failed",
          "reason": "No event matched. Expected HTTP 201 to dfs.fabric.microsoft.com but observed HTTP 500.",
          "closestMatch": {
            "topic": "http",
            "fields": { "statusCode": 500, "url": "https://dfs.fabric.microsoft.com/..." }
          }
        }
      ]
    }
  ]
}
```

### 7.2 ADO PR Comment Format

Posted as a markdown comment on the PR:

```markdown
## ◆ EDOG QA Testing Results

**PR:** #12345 — Fix WriteFileAsync retry logic
**Run:** 2025-06-15 14:30 UTC | Duration: 2m 23s

### Summary: 10/12 PASSED ● 1 FAILED ● 1 TIMED OUT

| # | Scenario | Category | Result | Duration |
|---|----------|----------|--------|----------|
| 1 | WriteFileAsync writes to correct OneLake path | happy_path | ● PASS | 8.4s |
| 2 | OneLake 429 triggers exponential backoff retry | error_path | ● FAIL | 30.0s |
| 3 | ... | ... | ... | ... |

### Failures

**scn-retry-on-429-throttle** — OneLake 429 triggers exponential backoff retry
- ✕ exp-3: Expected HTTP 201 to `dfs.fabric.microsoft.com` after retries
- Observed: HTTP 500 (retries did not recover)
- Suggestion: Check if retry count exceeds `MaxRetryAttempts` config value

---
*Generated by EDOG Studio F27 | [View Full Results](http://localhost:5555/#/qa/run-20250615-143022)*
```

### 7.3 Local UI

The QA Testing panel in EDOG Studio shows:
- **Run History:** list of past runs with summary badges
- **Scenario Detail:** click any scenario to see full expectation breakdown
- **Event Timeline:** horizontal timeline showing all captured events, with expectation match highlights (green = matched, red = expected but missing)
- **Trace Explorer:** click any matched event to see the full interceptor payload
- **Diff View:** for failed expectations, side-by-side "expected vs observed"

### 7.4 Learning Loop

Every user action feeds back into scenario quality:
- **Kept scenario:** positive signal. Similar scenarios for similar code patterns in future.
- **Deleted scenario:** negative signal. The pattern was not useful.
- **Edited scenario:** partial signal. The direction was right but details wrong.
- **False positive marked:** strong negative signal. Adjust matching strictness for this pattern.

Storage: `~/.edog/qa-feedback.jsonl` — append-only log of (scenario_hash, action, timestamp). Periodically aggregated and fed back to GPT-5.4-pro as few-shot examples in the system prompt.

---

## 8. Architecture & Data Flow

### 8.1 C# Backend Components (Inside FLT Process)

```
EdogQaEngine (orchestrator)
├── PrDiffFetcher          — ADO REST API client for PR diffs
├── RoslynAnalyzer         — Blast radius computation
├── GraphifyClient         — Knowledge graph query client
├── ScenarioGenerator      — GPT-5.4-pro orchestration
├── ScenarioStore          — In-memory + JSON file persistence
├── ExecutionEngine        — Sequential scenario runner
│   ├── RecordingSession   — Scoped interceptor capture
│   ├── StimulusExecutor   — Trigger actions against FLT
│   └── ChaosIntegration   — F24 chaos rule management
├── AssertionEngine        — Expectation evaluation
├── ResultStore            — Execution results persistence
└── AdoReporter            — PR comment posting via ADO API
```

### 8.2 Frontend Components

```
qa-testing-panel.js (main panel)
├── pr-input.js            — PR URL/number input + recent PRs
├── analysis-progress.js   — Code understanding progress display
├── scenario-list.js       — Generated scenarios with curation controls
├── scenario-editor.js     — Inline JSON editor for expectations
├── execution-monitor.js   — Live execution display with event stream
├── results-view.js        — Results summary, timeline, trace explorer
└── qa-settings.js         — Configuration (timeout defaults, auto-post, etc.)
```

### 8.3 External Services

| Service | Protocol | Purpose | Fallback |
|---------|----------|---------|----------|
| Azure DevOps | REST API | PR diff fetch, comment posting | Manual diff paste |
| GPT-5.4-pro | HTTPS (Azure OpenAI) | Scenario generation | Manual scenario creation |
| Roslyn | In-process (NuGet) | Code analysis | Text-based diff parsing |
| Graphify | HTTP (localhost:7474) | Knowledge graph | Skip context enrichment |

### 8.4 SignalR Protocol

New hub methods on `EdogPlaygroundHub`:

```csharp
// Client → Server
Task<string> StartQaRun(string prUrl);                    // Returns runId
Task<ScenarioList> GenerateScenarios(string prUrl);       // Returns generated scenarios
Task UpdateScenario(string scenarioId, Scenario updated); // User edits
Task DeleteScenario(string scenarioId);                   // User deletes
Task ExecuteRun(string runId, string[] scenarioIds);      // Start execution
Task CancelRun(string runId);                             // Cancel in-progress
Task PostToPr(string runId);                              // Post results to ADO

// Server → Client (streaming)
event AnalysisProgress(string phase, int percentComplete);
event ScenarioGenerated(Scenario scenario);               // Streams as generated
event LintFindings(List<LintFinding> findings);           // F27 item 5 — emitted once
event ExecutionStarted(string scenarioId);
event EventCaptured(string scenarioId, InterceptorEvent evt);
event ExpectationMatched(string scenarioId, string expectationId, bool passed);
event ScenarioCompleted(string scenarioId, ScenarioResult result);
event RunCompleted(string runId, RunResult result);
```

---

## 11. Scenario Linter (F27 pinnacle item 5)

`EdogQaScenarioLinter` is a deterministic post-LLM validator. It runs
after scenario generation and emits findings before the curation UI
loads. The linter is a pure function of `(scenarios, prContext)` — no
I/O, no model call-back — which makes its output reproducible and
trivially unit-testable.

### 11.1 Severity model

| Severity | Meaning | Curator action |
|---|---|---|
| `Error`   | Scenario is unusable as-is.           | Must fix or discard before running. |
| `Warning` | Scenario will execute but quality is below the contract bar. | Recommended fix. |
| `Info`    | Informational; style or hint.         | Optional. |

### 11.2 Rule catalog

| Code | Severity | What it checks |
|---|---|---|
| `LNT001_PathInCatalog`        | Error   | HTTP `stimulus.path` matches an endpoint template in `PrContext.ApiCatalog` (with `{name}` wildcards). Catches hallucinated routes. |
| `LNT002_InvariantCoverage`    | Warning | Every invariant extracted by `EdogQaInvariantExtractor` is cited by at least one scenario via `invariantsAddressed`. Catches coverage gaps. |
| `LNT003_TechniqueRequired`    | Error   | `Scenario.technique` is set to a value other than `NotSpecified`. Forces every scenario to declare its testing pattern. |
| `LNT004_GroundingEvidenceMissing` | Error | `Scenario.groundingEvidence` has at least one entry with non-empty `file` and `reason`. Forces grounding. |
| `LNT005_GroundingFileInDiff`  | Warning | Each evidence `file` appears in `PrContext.Invariants[].file`, `PrContext.PriorTests[].file`, or matches a controller in `PrContext.ApiCatalog.Controllers` (fuzzy). Catches fabricated file paths. |
| `LNT006_BoundaryTripletComplete` | Warning | Any `BoundaryTriplet` technique bucket per invariant has ≥3 scenarios (just-below / at / just-above). |
| `LNT007_CounterfactualHasAbsent` | Warning | `Counterfactual` technique requires at least one `EventAbsent` expectation. |
| `LNT008_EvidenceConsistency`  | Warning | `GroundingEvidence.invariantId`, when set, is in the scenario's `invariantsAddressed` list. |
| `LNT009_NoDuplicateStimulus`  | Warning | No two scenarios share the same (method, path, body-hash) — or shape-equivalent key for non-HTTP stimuli. |
| `LNT010_TruthTableCells`      | Warning | If the diff added N≥2 parameters (`added_parameter` invariants), the batch contains ≥2^min(N,3) `TruthTable` scenarios. |
| `LNT999_RuleFailed`           | Warning | Safety net — each rule runs under `SafeRun`; a buggy rule cannot poison the entire lint pass. |

### 11.3 Output shape

`Lint(scenarios, prContext)` returns `List<LintFinding>` capped at 200
entries, stably ordered by `(code, scenarioId, message)` for diff-able
runs. Each finding carries `{ code, severity, message, scenarioId?,
invariantId? }`. Findings with no `scenarioId` are batch-level — the
curation UI renders them in a panel above the scenario list.

The findings list is also surfaced on the C# `AnalysisResult` and
broadcast over SignalR as a `QaLintFindings` event after the per-
scenario `QaScenarioGenerated` stream and before the `complete`
progress event.

### 8.5 Storage

| Data | Location | Format | Retention |
|------|----------|--------|-----------|
| Scenarios (active) | Memory + `~/.edog/qa/scenarios/{runId}.json` | JSON | Until archived |
| Results | `~/.edog/qa/results/{runId}.json` | JSON | 30 days |
| Feedback | `~/.edog/qa/feedback.jsonl` | JSONL | Indefinite |
| Execution state | `~/.edog/qa/state.json` | JSON | Until run completes |
| Roslyn cache | `~/.edog/qa/roslyn-cache/` | Binary | 7 days |
| Graphify snapshots | Managed by Graphify | Neo4j | Persistent |

### 8.6 Performance & Resource Limits

| Constraint | Limit | Rationale |
|------------|-------|-----------|
| Max scenarios per run | 50 | Prevents runaway generation |
| Max execution time per scenario | 60s | Hard kill after this |
| Max total run time | 30 minutes | Safety valve |
| Max interceptor events per recording | 50,000 | Memory bound |
| GPT-5.4-pro token budget per run | 100K input + 50K output | Cost control |
| Concurrent Roslyn analysis threads | 4 | CPU bound on dev machine |
| Recording session memory | < 100MB per scenario | Ring buffer limits |

---

## 9. Integration Points

### 9.1 Existing EDOG Features

| Feature | Integration |
|---------|-------------|
| **Runtime View** | Shared interceptor infrastructure. QA recording does NOT interfere with live Runtime View display. Both see the same events. |
| **DAG Studio** | `dag_trigger` stimulus type uses DAG Studio's existing `runDag()` API. DAG execution state visible in both panels simultaneously. |
| **Command Palette** | Commands: `qa:start`, `qa:generate`, `qa:run`, `qa:post`, `qa:cancel`. Quick access without navigating to panel. |
| **Token Inspector** | Token events captured during QA execution visible in Token Inspector for debugging auth issues. |
| **Spark Inspector** | Spark session events during QA visible in Spark Inspector. Helps diagnose scenarios involving Spark jobs. |

### 9.2 F24 Chaos Engineering

F24 provides the engine; F27 provides the REASON to use it:

- F27 scenarios include chaos rules in `setup` steps
- F27 uses F24's `ChaosEngine.AddRule()` / `RemoveRule()` API
- F27 validates that behavior UNDER chaos is correct (the assertion)
- F24 can also be used standalone (manual chaos injection without assertions)

Shared infrastructure: `EdogFeatureFlighterWrapper` (flag overrides), future HTTP fault injection middleware.

### 9.3 Azure DevOps Integration

**PR Diff Fetch:**
```
GET https://dev.azure.com/{org}/{project}/_apis/git/repositories/{repo}/pullRequests/{id}/iterations
GET https://dev.azure.com/{org}/{project}/_apis/git/repositories/{repo}/diffs/commits?baseVersionType=Commit&baseVersion={base}&targetVersionType=Commit&targetVersion={target}
```

**Comment Posting:**
```
POST https://dev.azure.com/{org}/{project}/_apis/git/repositories/{repo}/pullRequests/{id}/threads
Body: { "comments": [{ "parentCommentId": 0, "content": "{markdown}", "commentType": "text" }], "status": "active" }
```

**Authentication:** Uses the same PAT/Azure CLI token that EDOG already uses for Fabric API access. Stored in `~/.edog/config.json`.

### 9.4 CI/CD Integration

**Phase 1 (Manual):** Developer runs F27 locally, posts to PR manually.

**Phase 2 (Automated):** ADO pipeline task that:
1. Starts FLT in DevMode with EDOG enabled
2. Calls EDOG's QA API: `POST /api/qa/run?pr={prId}`
3. Waits for completion (polling or webhook)
4. Posts results to PR
5. Fails the pipeline stage if pass rate < threshold (configurable, default 100%)

Pipeline YAML snippet:
```yaml
- task: EdogQaTesting@1
  inputs:
    prId: $(System.PullRequest.PullRequestId)
    edogPort: 5555
    passThreshold: 100
    timeout: 1800
```

---

## 10. Edge Cases & Risks

### 10.1 Code Understanding Misses

**Risk:** Roslyn misses affected paths (dynamic dispatch, reflection, string-based DI resolution).
**Mitigation:** Graphify's community detection catches related code even without explicit call edges. GPT-5.4-pro is prompted to consider "non-obvious impacts." Users can add manual scenarios for known gaps.

### 10.2 Refactors with No Observable Change

**Risk:** PR renames a class or moves code — no behavior change expected.
**Mitigation:** AI detects refactor-only changes and generates "regression" scenarios that verify existing behavior STILL works (smoke tests). Fewer scenarios generated (3-5 instead of 15-30). UI shows "Refactor detected — generating regression smoke tests."

### 10.3 Interceptor Coverage Gaps

**Risk:** Spark/GTS calls via `Get1PWorkloadHttpClientAsync` bypass IHttpClientFactory — NOT intercepted.
**Mitigation:**
1. Document known gaps in scenario generation prompt (AI won't generate expectations for unobservable events).
2. For Spark scenarios, use `EdogSparkSessionInterceptor` (topic: "spark") which DOES capture session-level events.
3. Long-term: wire additional interceptors for the 1P client path (separate work item, not F27 scope).

### 10.4 External State Dependencies

**Risk:** Scenario requires a lakehouse to exist, or specific data to be present.
**Mitigation:**
1. `state_seed` setup steps can make API calls to establish preconditions.
2. For complex state (existing lakehouse with data), scenarios document "prerequisites" that must be manually verified.
3. Future: snapshot/restore mechanism for OneLake state (not in F27 scope).

### 10.5 Flaky Scenarios

**Risk:** Timing-dependent scenarios pass/fail non-deterministically.
**Mitigation:**
1. Default time windows are generous (2x expected duration).
2. Timing-only failures trigger automatic single retry with 2x timeout.
3. After 3 runs, if a scenario is flaky (passes sometimes, fails sometimes), it's flagged as "unstable" and excluded from PR gate (but still shown in results).
4. User can mark scenarios as "timing_sensitive" to apply relaxed matching.

### 10.6 Security

**Risks:**
1. **LLM sees source code:** PR diffs sent to Azure OpenAI. Same security posture as GitHub Copilot (Microsoft-hosted, SOC2 compliant, no training on customer data).
2. **Token in scenarios:** Scenarios should NEVER contain real tokens. Stimulus uses EDOG's existing auth context (already authenticated).
3. **Chaos injection safety:** Chaos rules only active during scenario execution. Hard timeout ensures cleanup. `teardown` is ALWAYS executed, even on failure.
4. **ADO PAT scope:** PAT needs only `Code (Read)` + `Pull Request Threads (Read & Write)`. No broader access.

---

## 11. Design Decisions (Resolved)

| # | Question | Decision | Rationale |
|---|----------|----------|-----------|
| 1 | Scenario persistence across PRs | **Yes — reuse as templates** | Scenarios from PR #100 available as templates when similar code changes appear in PR #200. Reduces generation time. Stale scenarios auto-detected by Roslyn (if referenced method no longer exists). |
| 2 | PR gate strictness | **100% strict** | ANY failure blocks the PR. No configurable threshold. If a scenario fails, it must be investigated. Zero-tolerance ensures trust in the system. |
| 3 | Multi-developer conflict | **Not a concern** | Each developer uses their own capacity + workspace + lakehouse + notebook. Single FLT instance per dev. No shared state, no concurrency issue. |
| 4 | Roslyn analysis scope | **Full solution always** | Analyze all 400K lines. Thoroughness over speed. Long-range effects must not be missed. Cache the workspace after first load to amortize cost (~10s first run, <2s subsequent). |
| 5 | Cost allocation | **Not a concern for now** | GPT-5.4-pro costs absorbed. No metering, no budgets. Revisit if usage explodes. |
| 6 | Scenario library | **Purely PR-diff-driven** | No blessed regression suite. Every run is fresh, driven by what THIS PR changes. Templates from Q1 provide continuity without a static library. |
| 7 | Notification on completion | **Configurable** | Default: PR comment only. Optionally: Teams webhook, email. Configured in `~/.edog/config.json` under `qa.notifications`. |
| 8 | Coverage gap indicator | **Yes — prominent warning** | Results display a visible "⚠ Unobservable Paths" section listing code touched by the PR that interceptors cannot observe (Spark/GTS, Notebook API, Orchestrator). Sets honest expectations about what F27 CAN'T test. |

---

## Appendix A: Interceptor Topic → Observable Event Fields

| Topic | Key Fields Available for Matching |
|-------|-----------------------------------|
| `http` | method, url, statusCode, durationMs, requestHeaders, responseHeaders, responseBodyPreview, httpClientName, correlationId |
| `token` | tokenType, scheme, audience, expiryUtc, issuedUtc, httpClientName, endpoint |
| `flag` | flagName, tenantId, capacityId, workspaceId, result, durationMs |
| `perf` | operationName, durationMs, result, correlationId, dimensions |
| `spark` | sessionTrackingId, event, tenantId, workspaceId, artifactId, iterationId, durationMs, error |
| `log` | timestamp, level, message, component, rootActivityId, eventId, customData, iterationId, codeMarkerName |
| `telemetry` | operationStartTime, activityName, activityStatus, durationMs, resultCode, correlationId, attributes, userId, iterationId |
| `retry` | endpoint, statusCode, retryAttempt, totalAttempts, waitDurationMs, strategyName, reason, isThrottle, retryAfterMs, iterationId |
| `cache` | cacheName, operation, key, hitOrMiss, valueSizeBytes, ttlSeconds, durationMs |
| `fileop` | operation, path, contentSizeBytes, durationMs, hasContent, contentPreview, ttlSeconds, iterationId |

## Appendix B: Scenario Category Distribution (Expected)

Based on analysis of 14 real FLT PRs:

| Category | % of Generated Scenarios | Typical Count per PR |
|----------|--------------------------|----------------------|
| happy_path | 35% | 5-10 |
| error_path | 25% | 3-8 |
| edge_case | 20% | 2-6 |
| regression | 15% | 2-5 |
| performance | 5% | 1-2 |

## Appendix C: Command Palette Commands

| Command | Action |
|---------|--------|
| `qa:start` | Open QA panel and focus PR input |
| `qa:generate [pr-url]` | Generate scenarios for given PR |
| `qa:run` | Execute all curated scenarios |
| `qa:run-failed` | Re-run only previously failed scenarios |
| `qa:post` | Post latest results to PR |
| `qa:cancel` | Cancel in-progress execution |
| `qa:history` | Show run history |
| `qa:clear` | Clear current scenarios and results |
