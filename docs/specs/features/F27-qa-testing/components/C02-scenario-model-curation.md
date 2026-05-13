# C02: Scenario Model & Curation — Component Deep Spec

> **Agent:** Sana (Architecture & FLT Internals)
> **Priority:** P1
> **Status:** Design Complete
> **Parent:** F27 QA Testing — AI-Driven Scenario Generation & Execution
> **Dependencies:** C01 (Code Understanding Engine), C03 (Execution Engine), C04 (Assertion Engine), C05 (Results & Reporting), C06 (PR Integration)
> **Date:** 2025-07-13

---

## Overview

C02 is the data backbone of F27. It defines the typed structures for every scenario — from the moment the AI generates a draft to the moment results are archived. It governs:

1. **Data structures** — the JSON schema for scenarios, setup steps, stimuli, expectations, matchers
2. **Curation UI contract** — how AI-generated scenarios are presented for user review/edit
3. **Scenario lifecycle** — `GENERATED` → `CURATED` → `QUEUED` → `EXECUTING` → `COMPLETED` → `ARCHIVED`
4. **Categories** — `happy_path`, `error_path`, `edge_case`, `regression`, `performance`
5. **Hybrid approach** — AI suggests scenarios, user confirms/adjusts (viability analysis §3 decision)

The hybrid model is the day-one strategy. AI generates scenarios with confidence scores; users curate (approve/edit/reject) before execution. This achieves ~95% accuracy vs ~85-90% for fully-automated (viability analysis §3, "Three Approaches to Stimulus Delivery").

---

## Table of Contents

1. [S01: Scenario JSON Schema](#s01-scenario-json-schema)
2. [S02: AI Scenario Generation Pipeline](#s02-ai-scenario-generation-pipeline)
3. [S03: User Curation Flow](#s03-user-curation-flow)
4. [S04: Scenario Validation](#s04-scenario-validation)
5. [S05: Stimulus Type Resolution](#s05-stimulus-type-resolution)
6. [S06: Expectation Generation from Code Understanding](#s06-expectation-generation-from-code-understanding)
7. [S07: Scenario Persistence](#s07-scenario-persistence)
8. [S08: Scenario Deduplication](#s08-scenario-deduplication)
9. [S09: Batch Operations](#s09-batch-operations)
10. [S10: Scenario Templates](#s10-scenario-templates)
11. [S11: Import/Export](#s11-importexport)
12. [S12: Confidence Scoring](#s12-confidence-scoring)
13. [S13: Error Handling](#s13-error-handling)

---

## S01: Scenario JSON Schema

**ID:** `C02-S01`
**One-liner:** Complete type definitions for scenarios, setup steps, stimuli, expectations, and matchers.

### Detailed Description

The scenario JSON schema is the canonical contract between every F27 component. C01 (Code Understanding) produces scenarios conforming to this schema. C03 (Execution Engine) consumes them. C04 (Assertion Engine) reads expectations and matchers. C05 (Results) maps results back to scenario IDs. Every field is typed, constrained, and documented so that validation can be done without executing the scenario. The schema uses JSON Schema draft-07 with `$ref` definitions for composability.

### Technical Mechanism

The full schema is defined in spec §4.1 (`spec.md:232-472`). Below is the typed breakdown with implementation-level additions:

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "required": ["id", "title", "category", "stimulus", "expectations"],
  "properties": {
    "id": {
      "type": "string",
      "pattern": "^scn-[a-z0-9-]+$",
      "description": "Unique scenario identifier. Generated as scn-{slug-from-title}-{4-char-hash}."
    },
    "title": {
      "type": "string",
      "maxLength": 120
    },
    "description": {
      "type": "string",
      "maxLength": 500
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
      "description": "Reference to Roslyn impact zone (zone-NNN)"
    },
    "setup": {
      "type": "array",
      "items": { "$ref": "#/definitions/SetupStep" }
    },
    "stimulus": { "$ref": "#/definitions/Stimulus" },
    "expectations": {
      "type": "array",
      "items": { "$ref": "#/definitions/Expectation" },
      "minItems": 1
    },
    "teardown": {
      "type": "array",
      "items": { "$ref": "#/definitions/TeardownStep" }
    },
    "timeout": {
      "type": "integer",
      "default": 30000,
      "minimum": 1000,
      "maximum": 60000
    },
    "metadata": {
      "type": "object",
      "properties": {
        "generatedBy": { "type": "string", "enum": ["ai", "manual", "template"] },
        "confidence": { "type": "number", "minimum": 0, "maximum": 1 },
        "relatedPRFiles": { "type": "array", "items": { "type": "string" } },
        "tags": { "type": "array", "items": { "type": "string" } },
        "schemaVersion": { "type": "integer", "default": 1 },
        "generatedAt": { "type": "string", "format": "date-time" },
        "curatedBy": { "type": "string", "description": "null if auto-approved" },
        "curatedAt": { "type": "string", "format": "date-time" },
        "templateId": { "type": "string", "description": "Source template ID if generated from template" }
      }
    },
    "lifecycle": {
      "type": "string",
      "enum": ["generated", "curated", "queued", "executing", "completed", "failed", "timed_out", "archived", "deleted"],
      "default": "generated"
    }
  },
  "definitions": {
    "SetupStep": {
      "type": "object",
      "required": ["type"],
      "properties": {
        "type": { "type": "string", "enum": ["chaos_rule", "flag_override", "state_seed", "wait"] },
        "chaosRule": {
          "type": "object",
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
          "properties": {
            "method": { "type": "string" },
            "url": { "type": "string" },
            "body": { "type": "object" }
          }
        },
        "wait": {
          "type": "object",
          "properties": {
            "durationMs": { "type": "integer", "minimum": 0, "maximum": 30000 }
          }
        }
      }
    },
    "Stimulus": {
      "type": "object",
      "required": ["type"],
      "properties": {
        "type": { "type": "string", "enum": ["http_request", "signalr_invoke", "dag_trigger", "file_event", "timer_tick"] },
        "httpRequest": {
          "type": "object",
          "properties": {
            "method": { "type": "string", "enum": ["GET", "POST", "PUT", "DELETE", "PATCH"] },
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
        },
        "fileEvent": {
          "type": "object",
          "properties": {
            "path": { "type": "string" },
            "content": { "type": "string" },
            "operation": { "type": "string", "enum": ["create", "update", "delete"] }
          }
        },
        "timerTick": {
          "type": "object",
          "properties": {
            "tickCount": { "type": "integer", "minimum": 1 },
            "waitMs": { "type": "integer" }
          }
        }
      }
    },
    "Expectation": {
      "type": "object",
      "required": ["id", "type", "topic"],
      "properties": {
        "id": { "type": "string", "pattern": "^exp-[0-9]+$" },
        "type": { "type": "string", "enum": ["event_present", "event_absent", "event_count", "event_order", "timing", "field_match"] },
        "topic": { "type": "string", "enum": ["http", "token", "flag", "perf", "spark", "log", "telemetry", "retry", "cache", "fileop", "catalog", "dag", "flt-ops", "di", "capacity", "nexus"] },
        "matcher": { "$ref": "#/definitions/Matcher" },
        "timeWindow": {
          "type": "object",
          "properties": {
            "withinMs": { "type": "integer" },
            "afterMs": { "type": "integer" }
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
            "after": { "type": "string", "description": "Expectation ID this must appear after" }
          }
        },
        "description": { "type": "string" }
      }
    },
    "Matcher": {
      "type": "object",
      "properties": {
        "exact": { "type": "object", "additionalProperties": true },
        "contains": { "type": "object", "additionalProperties": { "type": "string" } },
        "regex": { "type": "object", "additionalProperties": { "type": "string" } },
        "range": {
          "type": "object",
          "additionalProperties": {
            "type": "object",
            "properties": { "min": { "type": "number" }, "max": { "type": "number" } }
          }
        },
        "exists": { "type": "array", "items": { "type": "string" } }
      }
    },
    "TeardownStep": {
      "type": "object",
      "required": ["type"],
      "properties": {
        "type": { "type": "string", "enum": ["remove_chaos_rule", "restore_flag", "cleanup_state"] }
      }
    }
  }
}
```

**Expectation topic enum alignment:** The `topic` enum in `Expectation` maps exactly to the 16 topics registered in `EdogTopicRouter.Initialize()` (`EdogTopicRouter.cs:26-44`). This is a hard contract — an expectation cannot reference a topic that doesn't exist in the router.

### Source Code Path

- **Schema definition (spec):** `docs/specs/features/F27-qa-testing/spec.md:232-472`
- **TopicEvent envelope:** `src/backend/DevMode/TopicEvent.cs:17-30`
- **Topic registry:** `src/backend/DevMode/EdogTopicRouter.cs:26-44`
- **TopicBuffer (ring + live channel):** `src/backend/DevMode/TopicBuffer.cs:20-74`
- **Runtime implementation (new):** `src/backend/DevMode/QA/ScenarioModel.cs` (to be created)

### Edge Cases

1. **Expectation references non-existent topic** — validation rejects at curation time. The topic enum is closed, not extensible by users.
2. **ID collision** — `scn-` prefix + 4-char hash from title+timestamp makes collisions improbable. If collision detected at insert, append incrementing suffix (`-a`, `-b`).
3. **Expectation order cycle** — `exp-1.order.after = exp-2` + `exp-2.order.after = exp-1` creates a deadlock. Validation must detect cycles via topological sort.
4. **Empty matcher** — a `Matcher` with no fields specified matches ALL events for that topic. Valid but dangerous — warn user during curation.
5. **Timeout < expected timeWindow** — if an expectation has `timeWindow.withinMs = 20000` but scenario `timeout = 10000`, the expectation can never succeed. Validation flags this.
6. **Schema version mismatch** — `metadata.schemaVersion` enables forward compatibility. Loader rejects schemas with version > current supported version.

### Interactions with Other Components

| Component | Interaction |
|-----------|-------------|
| **C01 (Code Understanding)** | Produces scenario objects conforming to this schema. Impact zone IDs (`impactZone`) link back to C01's Roslyn analysis output. |
| **C03 (Execution Engine)** | Consumes `stimulus`, `setup`, `teardown`, `timeout` fields. Updates `lifecycle` state during execution. |
| **C04 (Assertion Engine)** | Consumes `expectations` array and `Matcher` definitions. Reports per-expectation PASS/FAIL. |
| **C05 (Results)** | Maps results back to `scenario.id` and `expectation.id`. Stores alongside scenario data. |
| **C06 (PR Integration)** | Reads `title`, `category`, `description` for PR comment formatting. Uses `metadata.relatedPRFiles` for diff context. |

### Revert/Undo Mechanism

Schema changes are versioned via `metadata.schemaVersion`. Old scenarios with older schema versions are migrated forward on load by a `ScenarioMigrator` that applies transforms sequentially (v1→v2, v2→v3, etc.). No destructive migration — original JSON preserved in `~/.edog/qa/scenarios/{runId}.json.bak` before migration.

### Priority

**P0** — Every other component depends on this schema. Blocks all F27 work.

---

## S02: AI Scenario Generation Pipeline

**ID:** `C02-S02`
**One-liner:** Transform LLM output into validated, structured scenario objects.

### Detailed Description

The AI scenario generation pipeline bridges C01 (Code Understanding Engine) and the scenario model. GPT-5.4-pro receives the enriched graph (Roslyn impact zones + Graphify context + interceptor schema) and returns raw scenario JSON. This pipeline parses, validates, enriches (adds IDs, metadata, confidence scores), and deduplicates the output before presenting it to the user. The pipeline must handle partial LLM output (streaming), malformed JSON (retry with correction prompt), and hallucinated field values (validation against known enums).

### Technical Mechanism

```
Input from C01:
  ├── Impact zones (Roslyn): zone-001, zone-002, ...
  ├── Context bundles (Graphify): historical bugs, coverage gaps
  ├── Interceptor schema: topic→field mappings (from P0 §2.1)
  └── Scenario JSON schema (this document, S01)

Pipeline steps:
  1. PROMPT: Construct GPT-5.4-pro system prompt + user prompt
     - System prompt: QA engineer persona + interceptor schema + scenario schema
     - User prompt: PR diff + impact zones + context bundles
     - Token budget: ~8K input, ~4K output per zone cluster (spec §3.3)

  2. CALL: Send to GPT-5.4-pro (Azure OpenAI endpoint)
     - Streaming response (SSE) for progressive UI update
     - Timeout: 30s per call, retry once with reduced context on timeout

  3. PARSE: Extract JSON from LLM response
     - Response may contain markdown fences (```json ... ```) — strip them
     - Response may contain explanatory text before/after JSON — extract JSON array
     - If invalid JSON: send correction prompt "Fix this JSON: {error} {partial}"

  4. VALIDATE: Per-scenario validation (see S04)
     - Schema validation (required fields, type checks, enum membership)
     - Semantic validation (topic exists, expectation order is acyclic)
     - Reject invalid scenarios, log reason

  5. ENRICH: Add metadata
     - Generate unique IDs (scn-{slug}-{hash})
     - Set metadata.generatedBy = "ai"
     - Set metadata.generatedAt = now()
     - Set metadata.schemaVersion = CURRENT_VERSION
     - Compute confidence score (see S12)

  6. DEDUPLICATE: Remove near-duplicates (see S08)
     - Compare against existing scenarios for this run
     - Compare against recently-executed scenarios for this PR

  7. EMIT: Send each validated scenario to frontend via SignalR
     - Server→Client: ScenarioGenerated(Scenario) event
     - spec §8.4, EdogPlaygroundHub (EdogPlaygroundHub.cs:22)
```

### Source Code Path

- **GPT-5.4-pro prompt structure:** `docs/specs/features/F27-qa-testing/spec.md:173-202`
- **Composition pipeline:** `docs/specs/features/F27-qa-testing/spec.md:206-224`
- **SignalR hub (base):** `src/backend/DevMode/EdogPlaygroundHub.cs:22-73`
- **Interceptor schema registry:** `docs/specs/features/F27-qa-testing/research/p0-foundation.md:741-900` (topic→field mappings)
- **Runtime implementation (new):** `src/backend/DevMode/QA/ScenarioGenerator.cs` (to be created)

### Edge Cases

1. **LLM returns empty array** — valid but useless. Log warning, present "No scenarios generated — try manual creation" in UI.
2. **LLM returns > 50 scenarios** — hard cap at 50 (spec §8.6). Truncate by priority (keep P1-P2, drop P4-P5 first).
3. **LLM hallucinates a topic** (e.g., `"topic": "database"`) — validation rejects expectation. Topic enum is closed to the 16 registered topics in `EdogTopicRouter.Initialize()`.
4. **LLM generates duplicate stimuli** — deduplication catches these. Two scenarios with identical stimulus + identical expectations collapse to one.
5. **Streaming JSON is incomplete** (connection drop mid-stream) — buffer partial output. If parseable as partial array, keep valid scenarios. If not, retry entire call.
6. **All scenarios fail validation** — present empty scenario list with "Generation produced invalid scenarios. Try manual creation or re-generate." Log full LLM output for debugging.

### Interactions with Other Components

| Component | Interaction |
|-----------|-------------|
| **C01 (Code Understanding)** | Provides input (impact zones, context bundles). Generation cannot start until C01 completes at least one zone. |
| **C03 (Execution Engine)** | Not directly involved — generated scenarios enter curation before execution. |
| **C04 (Assertion Engine)** | Indirectly — expectations in generated scenarios must conform to what C04 can evaluate. |
| **C05 (Results)** | Stores generation metadata (how many generated, how many passed validation, generation latency). |
| **C06 (PR Integration)** | PR diff is the primary input. `metadata.relatedPRFiles` links back to changed files. |

### Revert/Undo Mechanism

Generation is idempotent — re-running generation for the same PR produces a new batch. Previous batches remain in the scenario store under their original `runId`. User can discard the new batch and revert to the previous one. No destructive override.

### Priority

**P0** — Generation is the entry point for all AI-driven scenarios.

---

## S03: User Curation Flow

**ID:** `C02-S03`
**One-liner:** Review, edit, approve, or reject AI-generated scenarios before execution.

### Detailed Description

The curation flow is the human-in-the-loop safety net for the hybrid approach. AI generates scenarios (S02); users review them in a list view with per-scenario actions. The default posture is "approve all" — generated scenarios are pre-approved, and users only intervene when something looks wrong. This keeps friction low while maintaining human oversight. The curation UI must support: inline viewing of scenario details, inline editing of expectations/stimulus, batch operations (approve all, reject by category), drag-to-reorder, and manual scenario creation from templates.

### Technical Mechanism

```
Curation UI Contract (frontend → backend):

Actions per scenario:
  ├── APPROVE — lifecycle: generated → curated (default for all)
  ├── EDIT    — opens inline JSON editor; on save: lifecycle → curated
  ├── REJECT  — lifecycle: generated → deleted (stored for negative feedback)
  ├── REORDER — drag handle changes execution order (array index in run)
  └── CLONE   — duplicate scenario with new ID for variant creation

Batch actions:
  ├── APPROVE ALL     — all generated → curated
  ├── REJECT CATEGORY — all scenarios in category X → deleted
  ├── RE-GENERATE     — discard current batch, re-invoke S02
  └── ADD MANUAL      — open template picker (see S10)

State transitions (lifecycle field):
  generated ──APPROVE──► curated
  generated ──EDIT+SAVE──► curated
  generated ──REJECT──► deleted
  curated ──EDIT+SAVE──► curated (stays curated, updates curatedAt)
  curated ──REJECT──► deleted

SignalR methods (spec §8.4):
  Client → Server:
    UpdateScenario(scenarioId, updatedScenario)  — edit
    DeleteScenario(scenarioId)                    — reject
  
  Server → Client:
    ScenarioGenerated(scenario)                   — streaming generation

UI data model:
  {
    scenarios: Scenario[],        // from S02 generation
    selectedIds: Set<string>,     // multi-select for batch ops
    sortOrder: string[],          // scenario IDs in execution order
    filterCategory: string|null,  // active category filter
    editingId: string|null,       // scenario being edited inline
    isDirty: boolean              // unsaved edits present
  }
```

**Inline editor contract:** The editor exposes the full scenario JSON but highlights editable sections (expectations, stimulus parameters, setup steps). Read-only fields: `id`, `metadata.generatedBy`, `metadata.generatedAt`. The editor validates on every keystroke using the schema from S01 and shows inline errors.

### Source Code Path

- **Spec user journey (curation step):** `docs/specs/features/F27-qa-testing/spec.md:66-76`
- **SignalR methods:** `docs/specs/features/F27-qa-testing/spec.md:1009-1027`
- **Frontend panel architecture:** `docs/specs/features/F27-qa-testing/spec.md:986-993`
- **SignalR hub (base):** `src/backend/DevMode/EdogPlaygroundHub.cs:22`
- **Frontend state pattern (reference):** `src/frontend/js/state.js:125-257`
- **Runtime implementation (new):** `src/frontend/js/qa/scenario-list.js`, `src/frontend/js/qa/scenario-editor.js` (to be created)

### Edge Cases

1. **User edits JSON to invalid state** — editor shows inline validation errors and blocks save. `UpdateScenario()` server method also validates and rejects invalid payloads.
2. **User rejects all scenarios** — valid. Execution starts with an empty run queue. UI shows "No scenarios to execute. Add manual scenarios or re-generate."
3. **User edits during re-generation** — dirty edits block re-generation. UI prompts: "Discard unsaved edits and re-generate?"
4. **User adds an expectation referencing a topic not covered by interceptors** — validation rejects (topic enum is closed).
5. **Large scenario count (50)** — virtual scrolling for scenario list (reuse pattern from `src/frontend/js/renderer.js:514-610`).
6. **Network disconnect during curation** — edits are local-first (in-memory). Reconnect triggers sync to backend. Conflict resolution: last-write-wins with timestamp.

### Interactions with Other Components

| Component | Interaction |
|-----------|-------------|
| **C01 (Code Understanding)** | Impact zone context displayed alongside each scenario for review context. |
| **C03 (Execution Engine)** | Receives curated scenarios in execution order. Only `curated` lifecycle scenarios are eligible for queuing. |
| **C04 (Assertion Engine)** | User edits to expectations directly affect what C04 evaluates. |
| **C05 (Results)** | Tracks curation actions (approve/edit/reject) as feedback signals for the learning loop (spec §7.4). |
| **C06 (PR Integration)** | Not directly involved during curation. PR metadata visible in UI for context. |

### Revert/Undo Mechanism

Every edit creates a revision. Undo stack (max 20 operations) stored in frontend state. Backend stores the original generated version and the latest curated version. User can "Reset to AI version" to discard all edits for a single scenario.

### Priority

**P0** — The curation step is the core differentiator of the hybrid approach.

---

## S04: Scenario Validation

**ID:** `C02-S04`
**One-liner:** Verify a scenario is well-formed, internally consistent, and executable.

### Detailed Description

Validation runs at two points: (a) during AI generation (S02, step 4) to filter invalid LLM output, and (b) during user curation (S03) to prevent saving broken scenarios. Validation has three tiers: structural (JSON schema compliance), semantic (cross-field consistency), and executable (references resolve to real infrastructure). A scenario must pass all three tiers before it can transition to `curated` lifecycle.

### Technical Mechanism

```
Tier 1 — Structural Validation (JSON Schema):
  ├── Required fields present: id, title, category, stimulus, expectations
  ├── Type checks: id is string matching ^scn-[a-z0-9-]+$
  ├── Enum membership: category in [happy_path, error_path, edge_case, regression, performance]
  ├── Stimulus type in [http_request, signalr_invoke, dag_trigger, file_event, timer_tick]
  ├── Each expectation has id (^exp-[0-9]+$), type, topic
  ├── Expectation topic in registered topics (16-topic enum)
  ├── Timeout in range [1000, 60000]
  └── Expectations array has minItems: 1

Tier 2 — Semantic Validation (cross-field consistency):
  ├── Expectation IDs are unique within scenario
  ├── Order references (exp.order.after) point to existing expectation IDs
  ├── Order graph is acyclic (topological sort; cycle → reject)
  ├── TimeWindow constraints are satisfiable (withinMs > afterMs if both set)
  ├── Timeout >= max(all expectation.timeWindow.withinMs) — warn if not
  ├── Count constraints valid (min <= max if both set; exact not combined with min/max)
  ├── Setup type-payload match: chaos_rule type has chaosRule field, etc.
  ├── Teardown matches setup: chaos_rule in setup → remove_chaos_rule in teardown
  └── Stimulus type-payload match: http_request type has httpRequest field, etc.

Tier 3 — Executable Validation (infrastructure checks, Connected phase only):
  ├── Stimulus http_request path resolves to a Kestrel route
  ├── Stimulus signalr_invoke hub method exists on EdogPlaygroundHub
  ├── Stimulus dag_trigger iterationId is valid or "current"
  ├── Setup chaos_rule target matches a known interceptor pattern
  ├── Setup flag_override flagName is a registered feature flag
  └── Expectation topic has events in the TopicBuffer (at least historically)

Validation result:
  {
    valid: boolean,
    errors: [{ tier: 1|2|3, field: string, message: string, severity: "error"|"warning" }],
    warnings: [{ ... }]  // tier 3 issues are warnings in Disconnected phase
  }
```

### Source Code Path

- **Schema definition:** `docs/specs/features/F27-qa-testing/spec.md:232-472`
- **Topic registry (enum source):** `src/backend/DevMode/EdogTopicRouter.cs:26-44`
- **TopicEvent envelope:** `src/backend/DevMode/TopicEvent.cs:17-30`
- **EdogPlaygroundHub (hub method validation):** `src/backend/DevMode/EdogPlaygroundHub.cs:22-73`
- **Runtime implementation (new):** `src/backend/DevMode/QA/ScenarioValidator.cs` (to be created)

### Edge Cases

1. **Matcher with regex that doesn't compile** — catch `RegexParseException` at validation time, report as Tier 1 error.
2. **Expectation references `dag` topic but stimulus is `http_request`** — valid (cross-topic assertion). No validation error, but warn user ("Stimulus and expectation target different subsystems").
3. **Scenario with only `event_absent` expectations** — valid but suspicious. Warning: "All expectations are absence checks — consider adding at least one positive expectation."
4. **Setup has `wait` with `durationMs: 0`** — technically valid (no-op). Warning.
5. **Tier 3 validation in Disconnected phase** — FLT is not running, so route resolution and flag checks are impossible. Tier 3 issues become warnings, not errors. Re-validated on transition to Connected phase.
6. **Matcher `range` with `min > max`** — Tier 2 error: impossible range.

### Interactions with Other Components

| Component | Interaction |
|-----------|-------------|
| **C01 (Code Understanding)** | Tier 3 validation uses C01's Roslyn data to verify stimulus paths resolve. |
| **C03 (Execution Engine)** | Only validated scenarios are queued. C03 trusts that scenarios are well-formed. |
| **C04 (Assertion Engine)** | Validation ensures expectations are evaluable (valid matcher structure, valid topic). |
| **C05 (Results)** | Validation errors stored as generation quality metrics. |
| **C06 (PR Integration)** | N/A. |

### Revert/Undo Mechanism

Validation is stateless and non-destructive. It reads a scenario and returns a result. No state to revert.

### Priority

**P0** — Prevents invalid scenarios from reaching the execution engine.

---

## S05: Stimulus Type Resolution

**ID:** `C02-S05`
**One-liner:** Map PR code changes to the correct stimulus type and parameters.

### Detailed Description

Stimulus type resolution is the bridge between "what code changed" (C01 output) and "how to trigger it" (stimulus definition). The five-layer code understanding engine (viability analysis §1) traces the reverse call graph from the changed code up to the nearest entry point, then maps that entry point to a stimulus type. This is the hardest inference problem in F27 — the hybrid approach means the AI suggests and the user confirms, providing a safety net for inaccurate resolution.

### Technical Mechanism

```
Resolution algorithm (executed by GPT-5.4-pro with structured graph input):

Step 1: Identify changed methods (from PR diff via C01 Roslyn analysis)
  Input:  zone.primaryChange.method = "WriteFileAsync"
  Source: OneLakeClient.cs

Step 2: Reverse call-graph traversal (Roslyn callHierarchy/incomingCalls)
  WriteFileAsync
    ← LakehouseFileWriter.FlushBufferAsync() (depth 1)
      ← DagExecutionEngine.ExecuteNode() (depth 2)
        ← DagController.RunDAG() (depth 3, ENTRY POINT)

Step 3: Entry point classification
  Map entry point to stimulus type:

  | Entry Point Pattern | Stimulus Type | Detection |
  |---------------------|---------------|-----------|
  | Controller method with [HttpGet/Post/Put/Delete] | http_request | Roslyn attribute inspection |
  | Hub method on SignalR hub | signalr_invoke | Base class = Hub |
  | DagController.RunDAG or /liveTableSchedule/* | dag_trigger | Route pattern match |
  | IFileSystem method at top of chain | file_event | Interface type check |
  | Timer callback or scheduled task | timer_tick | IHostedService, Timer patterns |
  | Internal service (no external entry point) | dag_trigger (fallback) | No HTTP/SignalR ancestor |

Step 4: Parameter extraction
  For http_request: extract method, path from route template, body from parameter types
  For dag_trigger: extract iterationId from context, nodeFilter from call chain
  For signalr_invoke: extract hub name, method name, arg types
  For file_event: extract path pattern from IFileSystem call
  For timer_tick: extract interval from timer configuration

Step 5: Confidence assignment
  - Direct entry point (depth 1): confidence 0.95
  - Depth 2-3 entry point: confidence 0.85
  - Depth 4+ or ambiguous: confidence 0.70
  - No entry point found (internal service): confidence 0.50

Output per impact zone:
  {
    "suggestedStimulus": { "type": "dag_trigger", "dagTrigger": { ... } },
    "entryPoint": "DagController.RunDAG",
    "callChainDepth": 3,
    "confidence": 0.85,
    "alternativeStimuli": [
      { "type": "http_request", "httpRequest": { "method": "POST", "path": "/api/dag/run" }, "confidence": 0.75 }
    ]
  }
```

### Source Code Path

- **Viability analysis (reverse call-graph):** `docs/specs/features/F27-qa-testing/research/viability-analysis.md:106-148`
- **Stimulus types (spec):** `docs/specs/features/F27-qa-testing/spec.md:344-376`
- **Execution mechanism:** `docs/specs/features/F27-qa-testing/spec.md:664-680`
- **DAG interceptor (entry point example):** `src/backend/DevMode/EdogDagExecutionInterceptor.cs:43-116`
- **HTTP handler (entry point example):** `src/backend/DevMode/EdogHttpPipelineHandler.cs:46-87`
- **Runtime implementation (new):** `src/backend/DevMode/QA/StimulusResolver.cs` (to be created)

### Edge Cases

1. **Changed code has no external entry point** — internal utility class, helper method. Resolution falls back to `dag_trigger` (triggers a full DAG which exercises most code paths) with low confidence (0.50). User must confirm or provide custom stimulus.
2. **Multiple entry points with equal depth** — present all as alternatives. User picks. LLM ranks by "most direct path" heuristic.
3. **Entry point is behind a feature flag** — resolution must check if the flag is enabled. If flag is OFF, suggest setup step with `flag_override` to enable it.
4. **Entry point is in untestable code** (no interceptor covers it) — flag as "manual verification required" (viability analysis §4, Remaining Risks).
5. **Interface indirection breaks call chain** — Roslyn resolves `IRetryPolicy` → `ExponentialRetryPolicy` via `textDocument/implementation`. If multiple implementations exist, Runtime DI registry (`EdogDiRegistryCapture.cs:33-107`) disambiguates.
6. **Conditional reachability** — code in a catch block requires fault injection to reach. LLM detects "this code is in a catch block for TimeoutException" and adds a chaos rule to the scenario setup.

### Interactions with Other Components

| Component | Interaction |
|-----------|-------------|
| **C01 (Code Understanding)** | Provides the reverse call graph, interface resolution, and DI registry data that this resolution depends on. |
| **C03 (Execution Engine)** | Executes the resolved stimulus. If stimulus fails, C03 reports back and user may need to re-resolve. |
| **C04 (Assertion Engine)** | N/A — stimulus resolution is input, not assertion. |
| **C05 (Results)** | Tracks stimulus resolution accuracy (did the stimulus actually trigger the expected code path?). |
| **C06 (PR Integration)** | N/A. |

### Revert/Undo Mechanism

Resolution is part of generation (S02). User can edit the stimulus in the curation step (S03) to override the AI's resolution. Original suggestion preserved in `metadata`.

### Priority

**P0** — Without stimulus resolution, scenarios cannot be generated automatically.

---

## S06: Expectation Generation from Code Understanding

**ID:** `C02-S06`
**One-liner:** Generate typed expectations by reading code structure, config values, and return types.

### Detailed Description

Expectation generation is the second output of the code understanding engine (the first being stimulus resolution). The LLM reads the enriched call graph, method signatures, return types, configuration values, and error handling patterns to formulate expectations that verify correct behavior. This leverages all five layers of the code understanding engine (viability analysis §1-3). The key insight from the viability analysis is that the same engine that finds "what to trigger" also knows "what should happen" — because it reads the code that defines correct behavior.

### Technical Mechanism

```
Expectation generation by category:

1. STRUCTURAL expectations (event fired):
   Input:  Call graph shows WriteFileAsync → IFileSystem.CreateOrUpdateFileAsync
   Output: { type: "event_present", topic: "fileop", matcher: { exact: { operation: "Write" } } }
   Source: EdogFileSystemInterceptor.cs:97 wraps CreateOrUpdateFileAsync

2. VALUE expectations (specific data):
   Input:  LLM reads method body — path pattern is "/Tables/{tableName}/"
   Output: { type: "field_match", topic: "fileop", matcher: { contains: { path: "/Tables/" } } }
   Source: Code reading of method parameters and string constants

3. COUNT expectations (occurrences):
   Input:  LLM reads RetryPolicy config — maxRetries = 3
   Output: { type: "event_count", topic: "retry", count: { min: 2, max: 3 } }
   Source: Config value reading via Roslyn symbol resolution

4. SEQUENCE expectations (order):
   Input:  Call graph shows: DI resolve → HTTP call → SQL query
   Output: exp-1 (di topic), exp-2 (http topic, order.after: exp-1), exp-3 (log topic, order.after: exp-2)
   Source: Call graph edge ordering

5. TIMING expectations (duration bounds):
   Input:  LLM reads timeout config — requestTimeout = 30000ms
   Output: { type: "timing", topic: "http", timeWindow: { withinMs: 30000 } }
   Source: Config value reading

6. ABSENCE expectations (negative assertions):
   Input:  Error path scenario — after retry succeeds, no permanent failure
   Output: { type: "event_absent", topic: "log", matcher: { exact: { level: "Error" }, contains: { message: "failed permanently" } } }
   Source: Error handling pattern recognition in code

7. RETURN VALUE expectations (method returned expected value):
   Input:  Method signature: Task<bool> ValidateAsync(...)
   Output: { type: "field_match", topic: "http", matcher: { exact: { statusCode: 200 } } }
   Source: Return type analysis + controller pattern recognition
   Note: Requires return value capture extension (viability analysis §3)

LLM prompt enrichment for expectations:
  "For the method {name} with return type {type}:
   - What should it return on success? (from code logic)
   - What interceptor events should it produce? (from call graph)
   - What should NOT happen? (from error handling patterns)
   - What timing constraints apply? (from config values)"
```

### Source Code Path

- **Viability analysis (expectation generation):** `docs/specs/features/F27-qa-testing/research/viability-analysis.md:162-256`
- **Expectation categories:** `docs/specs/features/F27-qa-testing/research/viability-analysis.md:226-236`
- **Expectation schema:** `docs/specs/features/F27-qa-testing/spec.md:378-420`
- **Matcher schema:** `docs/specs/features/F27-qa-testing/spec.md:424-460`
- **Assertion engine (consumer):** `docs/specs/features/F27-qa-testing/spec.md:746-845`
- **Interceptor event payloads (match targets):** `docs/specs/features/F27-qa-testing/research/p0-foundation.md:741-900`
- **Runtime implementation (new):** `src/backend/DevMode/QA/ExpectationGenerator.cs` (to be created)

### Edge Cases

1. **Method has no observable side effects** — no interceptor events in call chain. LLM generates a timing-only expectation ("execution completes within timeout") as a minimal assertion.
2. **Config value not statically determinable** — loaded from environment variable or external service. LLM uses reasonable defaults and flags confidence as low.
3. **Polymorphic dispatch** — `IHandler.Handle()` with 5 implementations. LLM uses Runtime DI registry to determine which implementation is active and generates expectations for that path.
4. **Async fire-and-forget** — method returns before side effects complete. Expectations need generous `timeWindow.withinMs` values. LLM detects `Task.Run()` or `_ = SomeAsync()` patterns and adds buffer.
5. **No return value capture yet** — viability analysis identifies return value capture as a needed extension. Until implemented, expectations rely on side-effect observation only. Confidence reduced for methods where return value is the primary indicator of correctness.

### Interactions with Other Components

| Component | Interaction |
|-----------|-------------|
| **C01 (Code Understanding)** | Provides call graph, method signatures, config values, return types. All expectation generation depends on C01 output. |
| **C03 (Execution Engine)** | N/A — expectations are evaluated by C04, not C03. |
| **C04 (Assertion Engine)** | C04 evaluates the expectations generated here. The matcher structure must match what C04's `MatcherSatisfied()` supports (spec §6.2). |
| **C05 (Results)** | Expectation match/mismatch data feeds the learning loop for future generation quality. |
| **C06 (PR Integration)** | Failed expectations are highlighted in PR comments with "expected vs observed" detail. |

### Revert/Undo Mechanism

Generated expectations are part of the scenario object. User edits expectations during curation (S03). Original AI-generated expectations preserved in generation history.

### Priority

**P0** — Expectations define what "correct" means. Without them, scenarios are stimulus-only with no verification.

---

## S07: Scenario Persistence

**ID:** `C02-S07`
**One-liner:** Store scenarios on disk with versioning, indexed by run ID.

### Detailed Description

Scenario persistence bridges the gap between in-memory scenario state (during active use) and durable storage (for crash recovery, historical analysis, and the learning loop). Scenarios are persisted as JSON files organized by run ID. The persistence layer supports CRUD operations on individual scenarios within a run, atomic batch writes, and crash recovery via a write-ahead intent log. Storage follows the directory layout defined in spec §8.5.

### Technical Mechanism

```
Storage layout (from spec §8.5):
  ~/.edog/qa/
    ├── scenarios/
    │   ├── {runId}.json          — all scenarios for a run (array)
    │   └── {runId}.json.bak      — pre-migration backup
    ├── results/
    │   └── {runId}.json          — execution results
    ├── feedback.jsonl             — learning loop signals
    ├── state.json                 — in-progress execution state (crash recovery)
    ├── templates/                 — user-defined scenario templates
    │   └── {templateId}.json
    └── roslyn-cache/              — cached Roslyn analysis (7-day TTL)

Scenario file format ({runId}.json):
  {
    "runId": "run-20250615-143022",
    "prId": 12345,
    "prUrl": "https://dev.azure.com/.../pullrequest/12345",
    "createdAt": "2025-06-15T14:30:22Z",
    "schemaVersion": 1,
    "scenarios": [ /* Scenario[] — full schema from S01 */ ]
  }

Operations:
  SAVE_RUN(runId, scenarios[])    — atomic write (write to .tmp, rename)
  LOAD_RUN(runId) → scenarios[]   — load + migrate schema if needed
  UPDATE_SCENARIO(runId, scenario) — load, replace by ID, save
  DELETE_SCENARIO(runId, scenarioId) — load, remove by ID, save
  LIST_RUNS() → RunSummary[]      — scan directory, read headers only
  ARCHIVE_RUN(runId)              — move to ~/.edog/qa/archive/

Crash recovery:
  - state.json tracks: { currentRunId, executingScenarioId, completedIds[], startedAt }
  - On startup: if state.json exists and executingScenarioId is set,
    mark that scenario as FAILED with reason: "process_crash"
    resume from next unexecuted scenario (spec §5.5)

Atomic write pattern:
  1. Write to {runId}.json.tmp
  2. fsync
  3. Rename {runId}.json.tmp → {runId}.json (atomic on NTFS and ext4)
  4. If rename fails, keep .tmp for manual recovery
```

### Source Code Path

- **Spec storage layout:** `docs/specs/features/F27-qa-testing/spec.md:1029-1038`
- **Crash recovery spec:** `docs/specs/features/F27-qa-testing/spec.md:717-724`
- **EDOG config path pattern:** `src/backend/edog.py:104-106` (`get_config_path()`)
- **P0 audit (storage gaps):** `docs/specs/features/F27-qa-testing/research/p0-foundation.md:586-588` (in-memory only, no persistence)
- **Runtime implementation (new):** `src/backend/DevMode/QA/ScenarioStore.cs` (to be created)

### Edge Cases

1. **Disk full** — write to .tmp fails. Catch `IOException`, report to UI, scenarios remain in memory only.
2. **Concurrent access** — single EDOG instance per FLT process, so no multi-writer contention. File locking via `FileShare.None` during writes as safety measure.
3. **Corrupt JSON on disk** — load fails with parse error. Fall back to `.bak` file if available. Log corruption event.
4. **Schema version mismatch** — loader detects `schemaVersion > CURRENT`. Refuse to load (forward incompatible). `schemaVersion < CURRENT` triggers migration pipeline.
5. **Very large run (50 scenarios, each with 20 expectations)** — estimated file size ~200KB. Well within filesystem limits.
6. **Run ID collision** — timestamp-based ID (`run-YYYYMMDD-HHMMSS`) has 1-second resolution. If two runs start within 1 second, append `-{N}` suffix.
7. **`~/.edog` directory doesn't exist** — create on first write (`Directory.CreateDirectory`, idempotent).

### Interactions with Other Components

| Component | Interaction |
|-----------|-------------|
| **C01 (Code Understanding)** | Roslyn cache stored alongside scenarios. Cache invalidation on new PR analysis. |
| **C03 (Execution Engine)** | Reads scenarios from store. Writes execution state to `state.json` for crash recovery. |
| **C04 (Assertion Engine)** | N/A — assertions operate in-memory. |
| **C05 (Results)** | Results stored in parallel `results/{runId}.json`. Linked by `runId`. |
| **C06 (PR Integration)** | Reads scenarios + results for PR comment formatting. |

### Revert/Undo Mechanism

`.bak` files created before schema migrations. `archive/` preserves old runs. Feedback signals in `feedback.jsonl` are append-only (never deleted). State.json is deleted on successful run completion.

### Priority

**P1** — Persistence enables crash recovery and the learning loop, but in-memory-only works for MVP.

---

## S08: Scenario Deduplication

**ID:** `C02-S08`
**One-liner:** Detect and eliminate duplicate scenarios within and across runs.

### Detailed Description

The LLM may generate duplicate or near-duplicate scenarios, especially when a PR touches multiple impact zones that share common code paths. Deduplication operates at two levels: intra-run (within a single generation batch) and inter-run (across previous runs for the same PR). Exact duplicates are easy; near-duplicates require structural comparison of stimulus + expectations, ignoring cosmetic differences (title wording, description phrasing, expectation ordering).

### Technical Mechanism

```
Deduplication algorithm:

Step 1: Compute scenario fingerprint
  fingerprint = hash(
    stimulus.type,
    stimulus[typePayload],    // e.g., httpRequest.method + httpRequest.path
    sort(expectations.map(e => hash(e.type, e.topic, e.matcher)))
  )
  
  Hash function: SHA-256 truncated to 16 hex chars.
  Ignores: id, title, description, metadata, priority, timeout, teardown.

Step 2: Intra-run dedup (during generation, S02 step 6)
  seen = Set<string>()
  for each scenario in generated_batch:
    fp = fingerprint(scenario)
    if fp in seen:
      discard scenario (keep first occurrence)
      log: "Dedup: {scenario.id} is duplicate of existing scenario"
    else:
      seen.add(fp)

Step 3: Inter-run dedup (optional, against recent runs)
  recent_fingerprints = load fingerprints from last 5 runs for this PR
  for each scenario in current_batch:
    fp = fingerprint(scenario)
    if fp in recent_fingerprints:
      mark scenario with metadata.tag = "previously_tested"
      lower priority by 1 (cosmetic — user still sees it)
      // Don't auto-discard — user may want to re-test

Near-duplicate detection (fuzzy):
  Two scenarios are near-duplicates if:
    - Same stimulus type AND
    - Same expectation topics (set equality) AND
    - Matchers differ only in threshold values (range min/max within 20%)
  
  Near-duplicates are flagged, not removed. UI shows: "Similar to {other.id}"
```

### Source Code Path

- **Spec deduplication step:** `docs/specs/features/F27-qa-testing/spec.md:217` (composition pipeline)
- **Scenario fingerprint target fields:** `docs/specs/features/F27-qa-testing/spec.md:232-376` (schema fields used)
- **Runtime implementation (new):** `src/backend/DevMode/QA/ScenarioDeduplicator.cs` (to be created)

### Edge Cases

1. **Two scenarios with same stimulus but different expectations** — NOT duplicates. Different expectations test different aspects of the same code path.
2. **Two scenarios with same expectations but different stimulus** — NOT duplicates. Different entry points may exercise the same assertion differently.
3. **Template-generated scenario duplicates AI-generated one** — template scenarios are never auto-deduped. User explicitly chose to add them.
4. **Hash collision** — SHA-256 truncated to 16 chars = 64 bits. Collision probability negligible for <1000 scenarios.
5. **Scenario fingerprint changes after user edit** — re-fingerprint on save. If edited scenario now matches an existing one, warn but don't block.

### Interactions with Other Components

| Component | Interaction |
|-----------|-------------|
| **C01 (Code Understanding)** | N/A — dedup operates on generated scenarios, not code analysis. |
| **C03 (Execution Engine)** | Fewer duplicates = faster execution. |
| **C04 (Assertion Engine)** | N/A. |
| **C05 (Results)** | Dedup count tracked as generation quality metric. |
| **C06 (PR Integration)** | N/A. |

### Revert/Undo Mechanism

Deduplication removes scenarios from the generation batch before presenting to user. Discarded duplicates are logged but not recoverable in the UI. Re-generation produces a fresh batch.

### Priority

**P1** — Improves UX (fewer redundant scenarios to review) but not blocking.

---

## S09: Batch Operations

**ID:** `C02-S09`
**One-liner:** Approve all, reject by category, re-generate, and other bulk curation actions.

### Detailed Description

With 5-30 scenarios generated per PR (spec §1, success metrics), reviewing each individually is tedious. Batch operations allow the user to act on groups of scenarios at once. The default posture ("all pre-approved") means batch operations are primarily used for narrowing — rejecting a category of scenarios that the user knows are irrelevant, or re-generating after discovering the AI missed a key code path.

### Technical Mechanism

```
Batch operations:

1. APPROVE_ALL
   Action: Set all scenarios with lifecycle=generated → curated
   UI: "Approve All" button, prominent position
   Backend: PATCH /api/qa/scenarios/batch { action: "approve", filter: { lifecycle: "generated" } }

2. REJECT_CATEGORY(category)
   Action: Set all scenarios with matching category → deleted
   UI: Category badge click → "Reject all {category}?" confirmation
   Backend: PATCH /api/qa/scenarios/batch { action: "reject", filter: { category: "performance" } }

3. APPROVE_CATEGORY(category)
   Action: Set all scenarios with matching category → curated
   UI: Category badge click → "Approve all {category}?"
   Backend: PATCH /api/qa/scenarios/batch { action: "approve", filter: { category: "happy_path" } }

4. RE-GENERATE
   Action: Discard current generated batch, re-invoke S02
   Precondition: No scenarios in executing/queued lifecycle
   UI: "Re-generate" button with confirmation ("Discard N scenarios?")
   Backend: POST /api/qa/scenarios/regenerate { runId, options: { preserveCurated: true } }
   Note: If preserveCurated=true, only generated (uncurated) scenarios are discarded

5. SELECT_BY_PRIORITY(minPriority, maxPriority)
   Action: Multi-select all scenarios within priority range
   UI: Priority slider → selects matching scenarios for bulk action

6. REORDER_BY_PRIORITY
   Action: Sort execution order by priority (P1 first)
   UI: "Sort by priority" in order dropdown

Batch result:
  {
    affected: number,     // count of scenarios modified
    action: string,       // what was done
    scenarioIds: string[] // which scenarios were affected
  }
```

### Source Code Path

- **Spec curation actions:** `docs/specs/features/F27-qa-testing/spec.md:66-76`
- **Frontend panel (scenario list):** `docs/specs/features/F27-qa-testing/spec.md:989`
- **Runtime implementation (new):** `src/frontend/js/qa/scenario-list.js` (to be created)

### Edge Cases

1. **Approve all when some scenarios have validation errors** — skip invalid scenarios. Report: "Approved N of M. K scenarios have validation errors."
2. **Reject all when some are already executing** — executing scenarios cannot be rejected. Skip them. Report count.
3. **Re-generate while user has unsaved edits** — prompt: "You have unsaved edits on N scenarios. Discard and re-generate?"
4. **Re-generate with preserveCurated=true but all scenarios are curated** — no-op for generation. Existing curated scenarios remain.
5. **Empty batch** — filter matches zero scenarios. No-op. UI shows toast: "No scenarios matched the filter."

### Interactions with Other Components

| Component | Interaction |
|-----------|-------------|
| **C01 (Code Understanding)** | Re-generate triggers a new C01 → S02 pipeline. |
| **C03 (Execution Engine)** | Batch approve feeds C03's execution queue. |
| **C04 (Assertion Engine)** | N/A. |
| **C05 (Results)** | Batch actions logged as curation signals for learning loop (spec §7.4). |
| **C06 (PR Integration)** | N/A. |

### Revert/Undo Mechanism

Batch operations are undoable via the same undo stack as individual operations (S03). "Undo last batch: Rejected 8 performance scenarios" restores them to `generated` lifecycle.

### Priority

**P1** — Quality-of-life for curation. Individual operations work for MVP.

---

## S10: Scenario Templates

**ID:** `C02-S10`
**One-liner:** Reusable scenario patterns for common PR types.

### Detailed Description

Templates are pre-defined scenario skeletons for common FLT change patterns (retry logic changes, DAG node changes, file operation changes, auth flow changes). When a user creates a manual scenario, they can pick a template instead of writing JSON from scratch. Templates have placeholder fields (marked with `{{placeholder}}`) that the user fills in. Over time, templates can be auto-populated by the AI based on the PR context, bridging manual and AI-generated scenarios.

### Technical Mechanism

```
Template schema (extends Scenario schema):
  {
    "templateId": "tpl-retry-verification",
    "templateName": "Retry Logic Verification",
    "templateDescription": "Verifies retry behavior with chaos fault injection",
    "applicableCategories": ["error_path"],
    "placeholders": [
      { "key": "targetEndpoint", "type": "string", "description": "HTTP endpoint to inject fault on" },
      { "key": "faultStatusCode", "type": "integer", "description": "HTTP status code to inject (e.g., 429, 503)" },
      { "key": "expectedRetryCount", "type": "integer", "description": "Expected number of retry attempts" }
    ],
    "scenario": {
      "id": "scn-{{slug}}",
      "title": "{{targetEndpoint}} {{faultStatusCode}} triggers retry",
      "category": "error_path",
      "setup": [{
        "type": "chaos_rule",
        "chaosRule": {
          "target": "{{targetEndpoint}}",
          "fault": "http_error",
          "parameters": { "statusCode": "{{faultStatusCode}}", "failCount": 2 }
        }
      }],
      "stimulus": { "type": "dag_trigger", "dagTrigger": { "iterationId": "current" } },
      "expectations": [{
        "id": "exp-1",
        "type": "event_count",
        "topic": "retry",
        "matcher": { "exact": { "statusCode": "{{faultStatusCode}}" } },
        "count": { "min": "{{expectedRetryCount}}" }
      }],
      "teardown": [{ "type": "remove_chaos_rule" }],
      "metadata": { "generatedBy": "template", "templateId": "tpl-retry-verification" }
    }
  }

Built-in templates (shipped with EDOG):
  tpl-retry-verification      — Fault injection → retry count verification
  tpl-happy-path-dag          — DAG trigger → node completion assertions
  tpl-flag-toggle             — Flag override → behavior change verification
  tpl-file-write-correctness  — DAG trigger → file operation assertions
  tpl-auth-flow               — HTTP request → token lifecycle assertions
  tpl-cache-behavior          — Operation → cache hit/miss assertions
  tpl-performance-regression  — Operation → timing bound assertions

Storage: ~/.edog/qa/templates/{templateId}.json
User can create custom templates by saving any curated scenario as template.
```

### Source Code Path

- **Spec manual scenario creation:** `docs/specs/features/F27-qa-testing/spec.md:72` ("Add Manual — user writes a scenario from scratch (template provided)")
- **Template storage location:** `docs/specs/features/F27-qa-testing/spec.md:1033`
- **F24 chaos rule patterns (template source):** `docs/specs/features/F27-qa-testing/research/p0-foundation.md:664-676`
- **Concrete scenario examples (template inspiration):** `docs/specs/features/F27-qa-testing/spec.md:475-627`
- **Runtime implementation (new):** `src/backend/DevMode/QA/ScenarioTemplateEngine.cs` (to be created)

### Edge Cases

1. **Placeholder not filled** — validation (S04) catches missing required fields after template expansion. Block save until all placeholders resolved.
2. **Template references a chaos fault type not supported by F24** — validation flags at Tier 3. Template may be outdated.
3. **User saves a scenario with circular order dependencies as template** — template validation runs S04 checks. Reject.
4. **Template schema version drift** — templates versioned independently. Loader migrates old templates.
5. **Template expansion produces invalid JSON** — placeholder values must be type-safe. `"statusCode": "{{faultStatusCode}}"` where faultStatusCode="abc" fails type validation.

### Interactions with Other Components

| Component | Interaction |
|-----------|-------------|
| **C01 (Code Understanding)** | AI can suggest which template applies based on impact zone analysis (future enhancement). |
| **C03 (Execution Engine)** | Expanded templates are indistinguishable from regular scenarios during execution. |
| **C04 (Assertion Engine)** | Expanded expectations evaluated identically. |
| **C05 (Results)** | Template-sourced scenarios tagged with `metadata.templateId` for quality tracking. |
| **C06 (PR Integration)** | N/A. |

### Revert/Undo Mechanism

Template expansion creates a new scenario object. The template itself is never modified. User can delete the expanded scenario and re-expand with different placeholder values.

### Priority

**P2** — Convenience feature. AI generation is the primary path; templates are the manual fallback.

---

## S11: Import/Export

**ID:** `C02-S11`
**One-liner:** Share scenario definitions between developers via JSON files.

### Detailed Description

Scenarios are portable JSON. A developer who crafts a good set of scenarios for a code area can export them as a file, share with teammates (via repo, chat, email), and teammates can import them into their own EDOG instance. Import validates the scenario schema, resolves any ID conflicts, and optionally adapts stimulus parameters to the local environment. Export produces a self-contained JSON file with all scenarios and their metadata.

### Technical Mechanism

```
Export format:
  {
    "exportVersion": 1,
    "exportedAt": "2025-06-15T14:30:22Z",
    "exportedBy": "hemantg@microsoft.com",
    "sourceRunId": "run-20250615-143022",
    "sourcePrId": 12345,
    "scenarios": [ /* Scenario[] */ ]
  }

Export operation:
  1. User selects scenarios (multi-select or "export all")
  2. System serializes to JSON with export wrapper
  3. File saved to user-chosen path (default: {prId}-scenarios.json)
  4. Strip execution state (lifecycle reset to "generated")
  5. Strip run-specific metadata (runId, executionResults)

Import operation:
  1. User provides file path or drags file onto EDOG UI
  2. System parses JSON, validates export wrapper version
  3. For each scenario:
     a. Validate against S04 (all three tiers)
     b. Check for ID conflicts with current run
     c. If conflict: generate new ID (preserve title linkage)
     d. Set lifecycle = "generated" (requires curation before execution)
     e. Set metadata.generatedBy = "import"
  4. Present imported scenarios in curation UI alongside existing ones

SignalR methods:
  Client → Server:
    ImportScenarios(string jsonContent) → ImportResult
    ExportScenarios(string[] scenarioIds) → string (JSON)
```

### Source Code Path

- **Storage format:** `docs/specs/features/F27-qa-testing/spec.md:1029-1038`
- **Schema (import must conform to):** `docs/specs/features/F27-qa-testing/spec.md:232-472`
- **Runtime implementation (new):** `src/backend/DevMode/QA/ScenarioImportExport.cs` (to be created)

### Edge Cases

1. **Import file with unknown schemaVersion** — reject if version > current. Migrate if version < current.
2. **Import file with scenarios referencing topics not in this EDOG build** — Tier 1 validation catches invalid topic enum.
3. **Import 100 scenarios into a run that already has 40** — hard cap at 50 per run (spec §8.6). Reject import with "Would exceed 50-scenario limit."
4. **Exported scenario references a chaos rule configuration not available in F24** — Tier 3 validation warns (Connected phase). Scenario still importable but may fail execution.
5. **Import same file twice** — deduplication (S08) detects fingerprint matches. Flagged but not blocked.
6. **File encoding** — UTF-8 only. BOM stripped if present. Non-UTF-8 files rejected.

### Interactions with Other Components

| Component | Interaction |
|-----------|-------------|
| **C01 (Code Understanding)** | Imported scenarios bypass C01 (they weren't generated from code analysis). Impact zone references may be stale. |
| **C03 (Execution Engine)** | Imported scenarios execute identically to generated ones after curation. |
| **C04 (Assertion Engine)** | No special handling. |
| **C05 (Results)** | Source tracking: `metadata.generatedBy = "import"` differentiates from AI-generated. |
| **C06 (PR Integration)** | Imported scenarios may reference a different PR. PR context shown as informational. |

### Revert/Undo Mechanism

Import adds scenarios to the current run. User can reject (delete) individual imported scenarios. Bulk undo: "Undo import of N scenarios" removes the entire batch.

### Priority

**P2** — Team workflow enhancement. Not needed for single-developer use.

---

## S12: Confidence Scoring

**ID:** `C02-S12`
**One-liner:** Quantify how confident the AI is about each generated scenario.

### Detailed Description

Every AI-generated scenario carries a confidence score (0.0 to 1.0) that reflects how certain the system is that the scenario is correct (well-targeted stimulus, accurate expectations, meaningful assertions). The score is a composite of sub-scores from the code understanding engine. High-confidence scenarios can eventually be auto-approved; low-confidence scenarios are flagged for user attention. The confidence score is stored in `metadata.confidence` (spec §4.1, line 297).

### Technical Mechanism

```
Confidence score composition:

score = w1 * stimulus_confidence
      + w2 * expectation_confidence
      + w3 * coverage_confidence
      + w4 * historical_confidence

where w1=0.35, w2=0.30, w3=0.20, w4=0.15

Sub-scores:

1. stimulus_confidence (0.0 - 1.0):
   - 0.95: Direct entry point (call chain depth 1)
   - 0.85: Depth 2-3 entry point with confirmed DI chain
   - 0.70: Depth 4+ or ambiguous interface resolution
   - 0.50: No entry point found, using fallback stimulus
   - Source: S05 stimulus type resolution output

2. expectation_confidence (0.0 - 1.0):
   - 0.95: Expectations derived from explicit code assertions (assert/throw)
   - 0.85: Expectations from method signatures + config values (Roslyn grounded)
   - 0.70: Expectations from LLM inference (code pattern recognition)
   - 0.50: Expectations from general heuristics (e.g., "HTTP call should return 200")
   - Source: S06 expectation generation metadata

3. coverage_confidence (0.0 - 1.0):
   - 0.95: Scenario covers primary change + direct callers
   - 0.80: Scenario covers secondary blast radius
   - 0.60: Scenario covers tangential code (community-detected connection)
   - Source: C01 impact zone proximity to primary change

4. historical_confidence (0.0 - 1.0):
   - 0.90: Similar scenario passed in previous runs for similar PRs
   - 0.70: No historical data (first time for this pattern)
   - 0.40: Similar scenario was previously deleted/rejected by users
   - Source: feedback.jsonl analysis (spec §7.4)

UI presentation:
  score >= 0.85: Green badge "High confidence"
  score 0.60-0.84: Yellow badge "Medium confidence — review recommended"
  score < 0.60: Red badge "Low confidence — manual review required"

Auto-approval threshold (configurable, default disabled):
  If confidence >= 0.90 AND generatedBy == "ai":
    auto-set lifecycle = "curated" (skip manual approval)
  Setting: ~/.edog/qa/config.json { "autoApproveThreshold": 0.90 | null }
```

### Source Code Path

- **Confidence field in schema:** `docs/specs/features/F27-qa-testing/spec.md:297`
- **Learning loop (historical confidence):** `docs/specs/features/F27-qa-testing/spec.md:951-959`
- **Viability analysis (confidence discussion):** `docs/specs/features/F27-qa-testing/research/viability-analysis.md:150-158`
- **Feedback storage:** `docs/specs/features/F27-qa-testing/spec.md:1035`
- **Runtime implementation (new):** `src/backend/DevMode/QA/ConfidenceScorer.cs` (to be created)

### Edge Cases

1. **No historical data** — `historical_confidence` defaults to 0.70 (neutral). Common for new code areas.
2. **Conflicting historical signals** — same pattern approved by user A, rejected by user B. Weight by recency (recent signals weighted 2x).
3. **LLM reports its own confidence** — GPT-5.4-pro may include reasoning about certainty in its output. Parse this as a signal but don't use it directly (LLM self-assessment is unreliable). Blend with structural confidence.
4. **Score exactly at threshold boundary** — auto-approve at >= 0.90, not > 0.90. This is configurable by the user.
5. **All scenarios have low confidence** — valid (complex PR, new code area). UI shows warning: "All scenarios have low confidence. Careful review recommended."

### Interactions with Other Components

| Component | Interaction |
|-----------|-------------|
| **C01 (Code Understanding)** | Provides call chain depth, DI resolution certainty, impact zone proximity — inputs to sub-scores. |
| **C03 (Execution Engine)** | N/A — confidence doesn't affect execution behavior. |
| **C04 (Assertion Engine)** | N/A. |
| **C05 (Results)** | Confidence vs actual outcome correlation tracked for model improvement. |
| **C06 (PR Integration)** | PR comment includes confidence badges for each scenario. |

### Revert/Undo Mechanism

Confidence scores are computed, not user-editable. Recalculated on re-generation. Auto-approval is configurable and can be disabled.

### Priority

**P1** — Enables progressive trust and eventual auto-approval. Not blocking for MVP (default: no auto-approval).

---

## S13: Error Handling

**ID:** `C02-S13`
**One-liner:** Handle malformed JSON, invalid references, stale scenarios, and infrastructure failures gracefully.

### Detailed Description

Error handling in C02 covers three domains: (a) data errors — malformed JSON from LLM, invalid field values, schema violations; (b) reference errors — scenarios pointing to topics/flags/routes that don't exist; (c) staleness errors — scenarios generated for a PR version that no longer matches the current code. Each error type has a detection mechanism, a user-facing message, and a recovery path. The principle is: never crash, always explain, always offer a way forward.

### Technical Mechanism

```
Error taxonomy:

Category A — Data Errors (malformed input):
  A1: Invalid JSON from LLM
      Detection: JSON.parse throws
      Recovery: Send correction prompt to LLM ("Fix: {parse_error}. Original: {partial_json}")
      Max retries: 1
      Fallback: Discard scenario, log raw output for debugging

  A2: Schema validation failure
      Detection: S04 Tier 1 validation
      Recovery: Strip invalid fields, re-validate. If still invalid, discard.
      User message: "N scenarios failed validation and were removed."

  A3: Type coercion failure
      Detection: e.g., timeout = "thirty seconds" instead of 30000
      Recovery: LLM correction prompt with type hint
      Fallback: Use default value (30000 for timeout)

Category B — Reference Errors (invalid pointers):
  B1: Unknown topic in expectation
      Detection: S04 Tier 1 validation (enum check against EdogTopicRouter topics)
      Recovery: Remove invalid expectation. If no expectations remain, discard scenario.
      User message: "Expectation references unknown topic '{topic}'. Removed."

  B2: Unknown flag name in setup
      Detection: S04 Tier 3 validation (Connected phase only)
      Recovery: Warning, not error. Flag may exist but isn't currently registered.
      User message: "Flag '{flagName}' not found in current FLT instance. May fail at execution."

  B3: Circular order dependency
      Detection: S04 Tier 2 validation (topological sort)
      Recovery: Remove all order constraints from cycle participants. Warn user.
      User message: "Circular dependency detected between {exp-ids}. Order constraints removed."

  B4: Stale impact zone reference
      Detection: impactZone ID doesn't match any zone from current C01 analysis
      Recovery: Clear impactZone field. Scenario still valid without it.
      User message: "Impact zone '{zoneId}' no longer exists. Scenario may be outdated."

Category C — Staleness Errors (scenario drift):
  C1: PR updated since generation
      Detection: PR iteration number changed since scenarios were generated
      Recovery: Warning banner: "PR has been updated since scenarios were generated. Re-generate recommended."
      Note: Don't auto-discard — user may want to run existing scenarios anyway.

  C2: Code changed since analysis
      Detection: File hashes in impact zones don't match current working tree
      Recovery: Warning on affected scenarios. Allow execution with risk acknowledgment.

  C3: Template version outdated
      Detection: Template schemaVersion < current
      Recovery: Auto-migrate template. If migration fails, flag as unusable.

Error reporting:
  All errors logged to ~/.edog/qa/error.log (append-only, rotated at 10MB)
  
  User-facing errors appear as:
  - Inline validation errors (during editing) — red underline + tooltip
  - Toast notifications (during generation/import) — dismissable
  - Banner warnings (staleness) — persistent until addressed
  
  Error event published to SignalR:
    Server → Client: QaError({ category, code, message, scenarioId?, recoveryAction })
```

### Source Code Path

- **Spec failure modes:** `docs/specs/features/F27-qa-testing/spec.md:220-224`
- **Validation (error detection):** S04 in this document
- **Crash recovery:** `docs/specs/features/F27-qa-testing/spec.md:717-724`
- **TopicRouter (topic enum source):** `src/backend/DevMode/EdogTopicRouter.cs:26-44`
- **P0 audit (gap analysis):** `docs/specs/features/F27-qa-testing/research/p0-foundation.md:71-78`
- **Runtime implementation (new):** `src/backend/DevMode/QA/ScenarioErrorHandler.cs` (to be created)

### Edge Cases

1. **LLM returns HTML instead of JSON** (model hallucination) — detected as parse error (A1). Strip HTML tags, attempt re-parse. If still fails, discard.
2. **Scenario references a chaos rule type added in a newer F24 version** — unknown enum value in `SetupStep.chaosRule.fault`. Validation warns; scenario importable but setup step may fail.
3. **All error recovery paths fail** — scenario marked as `failed` with comprehensive error detail. User sees: "This scenario could not be processed. [View Error Details] [Delete] [Edit Manually]"
4. **Disk full during error log write** — swallow silently. Error logging failure must never propagate to the user experience.
5. **Race condition: PR updated between generation start and completion** — generation uses the PR diff snapshot from the initial fetch. Staleness check runs after generation completes.

### Interactions with Other Components

| Component | Interaction |
|-----------|-------------|
| **C01 (Code Understanding)** | Reference errors (B4, C2) detected by comparing against C01's current analysis. |
| **C03 (Execution Engine)** | Setup step failures (unknown chaos rules) are runtime errors handled by C03, not C02. C02 prevents preventable errors via validation. |
| **C04 (Assertion Engine)** | Invalid matcher structures caught by C02 validation before reaching C04. |
| **C05 (Results)** | Error counts and types tracked as quality metrics. |
| **C06 (PR Integration)** | Staleness warnings (C1) visible in PR comment context. |

### Revert/Undo Mechanism

Error recovery actions (field stripping, default substitution) are logged. User can view what was auto-corrected and manually fix via the editor. Original LLM output preserved in generation logs for debugging.

### Priority

**P0** — Robust error handling prevents user frustration and data loss. Must be solid from day one.

---

## Appendix A: Scenario Lifecycle State Machine

```
                    ┌──────────────────────────────────────────────────┐
                    │                                                  │
                    ▼                                                  │
  ┌───────────┐  APPROVE   ┌──────────┐  QUEUE   ┌────────┐          │
  │ GENERATED ├───────────►│ CURATED  ├─────────►│ QUEUED │          │
  │           │  EDIT+SAVE │          │          │        │          │
  └─────┬─────┘           └────┬─────┘          └───┬────┘          │
        │                      │                     │               │
        │ REJECT               │ REJECT              │ START         │
        │                      │                     ▼               │
        │                      │              ┌───────────┐          │
        │                      │              │ EXECUTING │          │
        │                      │              └─────┬─────┘          │
        ▼                      ▼                    │                │
  ┌──────────┐          ┌──────────┐         ┌──────┴───────┐       │
  │ DELETED  │          │ DELETED  │         │              │       │
  └──────────┘          └──────────┘    SUCCESS         FAILURE     │
                                             │              │       │
                                             ▼              ▼       │
                                       ┌───────────┐ ┌──────────┐  │
                                       │ COMPLETED │ │  FAILED  │  │
                                       └─────┬─────┘ └──────┬───┘  │
                                             │              │       │
                                             │   ARCHIVE    │       │
                                             ▼              ▼       │
                                       ┌───────────────────────┐    │
                                       │      ARCHIVED         │    │
                                       └───────────────────────┘    │
                                                                    │
                                       ┌───────────────────────┐    │
                                       │     TIMED_OUT         ├────┘
                                       │  (treated as FAILED   │ RETRY
                                       │   with timeout reason)│
                                       └───────────────────────┘
```

States defined in spec §4.3 (`spec.md:629-645`).

---

## Appendix B: Topic-to-Interceptor Mapping

Complete mapping of `Expectation.topic` enum values to source interceptors, for scenario authoring reference.

| Topic | Interceptor Source | Source File | Key Event Fields |
|-------|-------------------|-------------|------------------|
| `http` | `EdogHttpPipelineHandler` | `EdogHttpPipelineHandler.cs:46-87` | method, url, statusCode, durationMs, correlationId |
| `token` | `EdogTokenInterceptor` + `EdogTokenLifecycleInterceptor` | `EdogTokenInterceptor.cs:38-81`, `EdogTokenLifecycleInterceptor.cs:36-212` | @event, authScheme, audience, durationMs, success |
| `flag` | `EdogFeatureFlighterWrapper` | `EdogFeatureFlighterWrapper.cs:33-56` | flagName, result, durationMs |
| `perf` | `EdogPerfMarkerCallback` | `EdogPerfMarkerCallback.cs:35-75` | operationName, durationMs, result |
| `spark` | `EdogSparkSessionInterceptor` | `EdogSparkSessionInterceptor.cs:43-103` | @event, sessionTrackingId, durationMs, error |
| `log` | `EdogLogInterceptor` → `EdogLogServer` | `EdogLogServer.cs:174-196` | level, message, component, iterationId |
| `telemetry` | `EdogTelemetryInterceptor` | `EdogTelemetryInterceptor.cs:51-122` | activityName, activityStatus, durationMs |
| `retry` | `EdogRetryInterceptor` | `EdogRetryInterceptor.cs:107-201` | statusCode, retryAttempt, waitDurationMs, isThrottle |
| `cache` | `EdogCacheInterceptor` | `EdogCacheInterceptor.cs:36-59` | operation, key, hitOrMiss, durationMs |
| `fileop` | `EdogFileSystemInterceptor` | `EdogFileSystemInterceptor.cs:58-271` | operation, path, contentSizeBytes, durationMs |
| `catalog` | `EdogCatalogInterceptor` | `EdogCatalogInterceptor.cs:39-141` | @event, durationMs, totalTables |
| `dag` | `EdogDagExecutionInterceptor` | `EdogDagExecutionInterceptor.cs:43-209` | @event, dagId, nodeId, status, durationMs |
| `flt-ops` | `EdogFltOpsInterceptor` | `EdogFltOpsInterceptor.cs:32-911` | @event, operation, action, success |
| `di` | `EdogDiRegistryCapture` | `EdogDiRegistryCapture.cs:33-107` | (registration snapshot) |
| `capacity` | External | N/A | (capacity sync events) |
| `nexus` | `EdogNexusAggregator` | `EdogNexusAggregator.cs:469-476` | (aggregated snapshots) |

All topics registered in `EdogTopicRouter.Initialize()` (`EdogTopicRouter.cs:26-44`).

---

## Appendix C: New Files to Create

| File | Component | Description |
|------|-----------|-------------|
| `src/backend/DevMode/QA/ScenarioModel.cs` | S01 | C# record types for Scenario, SetupStep, Stimulus, Expectation, Matcher, TeardownStep |
| `src/backend/DevMode/QA/ScenarioGenerator.cs` | S02 | LLM orchestration: prompt construction, response parsing, enrichment |
| `src/backend/DevMode/QA/ScenarioValidator.cs` | S04 | Three-tier validation engine |
| `src/backend/DevMode/QA/StimulusResolver.cs` | S05 | Reverse call-graph traversal → stimulus type mapping |
| `src/backend/DevMode/QA/ExpectationGenerator.cs` | S06 | Code-aware expectation construction |
| `src/backend/DevMode/QA/ScenarioStore.cs` | S07 | Persistence (JSON files, crash recovery, archival) |
| `src/backend/DevMode/QA/ScenarioDeduplicator.cs` | S08 | Fingerprinting and duplicate detection |
| `src/backend/DevMode/QA/ScenarioTemplateEngine.cs` | S10 | Template loading, placeholder expansion, validation |
| `src/backend/DevMode/QA/ScenarioImportExport.cs` | S11 | JSON serialization with export wrapper, import validation |
| `src/backend/DevMode/QA/ConfidenceScorer.cs` | S12 | Composite confidence score calculation |
| `src/backend/DevMode/QA/ScenarioErrorHandler.cs` | S13 | Error taxonomy, recovery actions, logging |
| `src/frontend/js/qa/scenario-list.js` | S03, S09 | Curation UI: list, batch actions, drag-to-reorder |
| `src/frontend/js/qa/scenario-editor.js` | S03 | Inline JSON editor with live validation |
