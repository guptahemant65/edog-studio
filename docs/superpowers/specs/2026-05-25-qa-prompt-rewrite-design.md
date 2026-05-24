# QA LLM Prompt Rewrite — First Principles Design

**Date:** 2026-05-25
**Status:** Approved
**Scope:** Full-stack — prompts + schema + validator + downstream

---

## 1. First Principles

Three axioms govern the rewrite:

| # | Axiom | Current Problem | Solution |
|---|-------|-----------------|----------|
| 1 | **Stimulus must be real** | `stimulusSpec` is a JSON string — LLM generates GET-with-body, hallucinated params, invalid JSON | Typed `stimulus` object — method, path, body, headers as separate schema-enforced fields |
| 2 | **Expectation must be decidable** | `matcherSpec` is a string — LLM puts natural language, nulls, empty objects | Typed `matcher` object per expectation — topicField (enum), assertion (enum), value (typed union) |
| 3 | **Coverage must be intentional** | 115 lines of "DON'T" rules, lost-in-the-middle, LLM still violates | Schema constrains structure. Prompt teaches intent. Exemplars show quality. |

**Design principle:** Schema constrains structure → prompt teaches intent → exemplars show quality → validator catches what slips through.

---

## 2. Schema Restructure

### 2A. stimulusSpec (string) → stimulus (typed object)

Replace the opaque `stimulusSpec` string with a discriminated union keyed on `stimulusType`:

**Important strict-mode constraints:**
- OpenAI strict mode forbids `if/then`, so GET body-null cannot be schema-enforced — validator S2 handles it
- Strict mode forbids `additionalProperties` on map-type objects — `headers` uses array-of-pairs (same pattern as `TopicHashPairConverter` for `catalogHashes`)
- The discriminator (`stimulusType`) is embedded INSIDE the `stimulus` object so `anyOf` can match on it — not a sibling field

**HttpRequest:**
```json
{
  "stimulus": {
    "stimulusType": "HttpRequest",
    "method": "GET",
    "path": "/liveTable/insights/summary?startDate=2024-01-01",
    "contentType": "application/json",
    "body": null,
    "headers": [
      { "name": "Accept", "value": "application/json" }
    ]
  }
}
```

Schema enforces:
- `body` is nullable — prompt + exemplars teach `null` for GET; validator S2 quarantines any GET-with-body
- `method` is enum: `["GET", "POST", "PUT", "DELETE", "PATCH"]`
- `path` is a string
- `headers` is array of `{ name: string, value: string }` objects (strict-mode compatible)
- `stimulusType` is enum inside the stimulus object — enables `anyOf` discrimination

**SignalRBroadcast:**
```json
{
  "stimulus": {
    "stimulusType": "SignalRBroadcast",
    "hub": "EdogPlaygroundHub",
    "method": "SubscribeToTopic",
    "args": ["dag_execution_status"]
  }
}
```

**DiInvocation:**
```json
{
  "stimulus": {
    "stimulusType": "DiInvocation",
    "serviceType": "IMetricsCalculationService",
    "method": "ComputeFraction",
    "args": [100, 0]
  }
}
```

Other types: DagTrigger, FileEvent, TimerTick — analogous typed shapes with `stimulusType` inside.

**Note:** The outer `stimulusType` field on `GeneratedScenario` is kept for backward compat with projector/orchestrator code that reads it — but it is now redundant with `stimulus.stimulusType` and the validator ensures they match.

### 2B. matcherSpec (string) → matcher (typed object)

Each expectation gains a typed `matcher` field replacing the `matcherSpec` string:

```json
{
  "type": "FieldMatch",
  "topic": "http",
  "matcher": {
    "topicField": "http.statusCode",
    "assertion": "Equals",
    "value": { "kind": "integer_literal", "literal": 200 }
  },
  "rationale": "Valid request returns 200 OK"
}
```

The `matcher` object uses the existing `Matcher` schema shape (topicField enum, assertion enum, value discriminated union).

### 2C. Drop top-level matchers[] from LLM output

The LLM no longer generates `matchers[]` at the scenario level. Instead, the **projector** auto-derives it:

```csharp
scenario.Matchers = scenario.Expectations
    .Where(e => e.Matcher != null)
    .Select(e => e.Matcher)
    .ToList();
```

Single source of truth — no drift between expectations and matchers.

---

## 3. Prompt Rewrite

### 3.1 Analyst (v6 → v7) — Light touch

**Changes:**
- Reorder: critical enumeration rules at TOP (not buried in middle)
- Cut redundant phrases
- Tighten stimulus-kind preference: make DiInvocation-last-resort more prominent
- ~25 lines → ~20 lines

### 3.2 Architect (v15 → v16) — Moderate rewrite

**Changes:**
- Move category/verb/technique selection rules to Editor (materialization, not sketching)
- Keep the 2 existing worked examples
- Add a third worked example: HttpRequest stimulus (most common type, currently unexampled)
- Keep coverage rules R1-R4 as-is
- ~50 lines → ~35 lines

### 3.3 Editor (v23 → v24) — Full rewrite from scratch

The current 115-line wall becomes a 4-section architecture (~50 lines total):

**Section 1: Persona + Role** (~3 lines)
```
You are a senior API test engineer materializing scenario sketches into
executable test specifications. The Architect planned what to test; you
decide exactly how to test it. The schema constrains structure — you
supply intent.
```

**Section 2: Gold Exemplars** (~25 lines)

Four synthetic perfect scenarios — one per stimulus type:

#### Exemplar 1: HappyPath — GET HttpRequest
```json
{
  "id": "scn-001",
  "title": "GetInsightsSummary returns 200 with aggregated metrics",
  "description": "Exercises the nominal success path for the insights summary endpoint with valid date range.",
  "category": "HappyPath",
  "priority": 1,
  "impactZone": "InsightsQueryService",
  "technique": "HappyPath",
  "stimulusType": "HttpRequest",
  "stimulus": {
    "stimulusType": "HttpRequest",
    "method": "GET",
    "path": "/liveTable/insights/summary?startDate=2024-01-01&endDate=2024-01-07",
    "contentType": "application/json",
    "body": null,
    "headers": []
  },
  "stimulusId": "st-1",
  "expectations": [
    {
      "type": "FieldMatch",
      "topic": "http",
      "matcher": {
        "topicField": "http.statusCode",
        "assertion": "Equals",
        "value": { "kind": "integer_literal", "literal": 200 }
      },
      "rationale": "Valid date range returns 200 OK"
    },
    {
      "type": "EventPresent",
      "topic": "telemetry",
      "matcher": {
        "topicField": "telemetry.eventName",
        "assertion": "Equals",
        "value": { "kind": "string_literal", "literal": "GetInsightsSummary" }
      },
      "rationale": "Telemetry event proves the handler executed"
    }
  ],
  "timeoutMs": 30000,
  "confidence": 0.95,
  "groundingEvidenceRefs": ["ev-1", "ev-2"],
  "sketchId": "sketch-001",
  "featureFlagOverrides": [],
  "invariantsAddressed": []
}
```
**Teaches:** `body: null` for GET, query params in URL path, typed matcher values, dual assertions (structural + behavioral), `stimulusType` inside stimulus object.

#### Exemplar 2: ErrorPath — POST HttpRequest with flag override
```json
{
  "id": "scn-002",
  "title": "CreateSchedule rejects invalid cron expression with 400",
  "description": "Tests the validation guard on the schedule creation endpoint when cron expression is malformed.",
  "category": "ErrorPath",
  "priority": 2,
  "impactZone": "ScheduleService",
  "technique": "ErrorPath",
  "stimulusType": "HttpRequest",
  "stimulus": {
    "stimulusType": "HttpRequest",
    "method": "POST",
    "path": "/liveTable/schedules",
    "contentType": "application/json",
    "body": { "cronExpression": "INVALID", "enabled": true },
    "headers": []
  },
  "stimulusId": "st-2",
  "expectations": [
    {
      "type": "FieldMatch",
      "topic": "http",
      "matcher": {
        "topicField": "http.statusCode",
        "assertion": "Equals",
        "value": { "kind": "integer_literal", "literal": 400 }
      },
      "rationale": "Invalid cron expression is a client error"
    },
    {
      "type": "FieldMatch",
      "topic": "log",
      "matcher": {
        "topicField": "log.message",
        "assertion": "ContainsAll",
        "value": { "kind": "array_literal", "items": ["InvalidCronExpression", "INVALID"] }
      },
      "rationale": "Error log captures the specific validation failure with the offending input"
    }
  ],
  "timeoutMs": 10000,
  "confidence": 0.9,
  "groundingEvidenceRefs": ["ev-3"],
  "sketchId": "sketch-002",
  "featureFlagOverrides": [{ "flagName": "AdvancedScheduling", "value": "true" }],
  "invariantsAddressed": ["inv-explicit_error-1"]
}
```
**Teaches:** POST with concrete body, flag overrides in `featureFlagOverrides[]` only (projector renders headers), ContainsAll matcher with concrete values, lower timeout for fast validation, invariantsAddressed.

#### Exemplar 3: EdgeCase — DiInvocation stimulus
```json
{
  "id": "scn-003",
  "title": "ComputeFraction returns 0 when denominator is zero",
  "description": "Tests the divide-by-zero guard that returns 0 instead of throwing.",
  "category": "EdgeCase",
  "priority": 2,
  "impactZone": "MetricsCalculationService",
  "technique": "BoundaryTriplet",
  "stimulusType": "DiInvocation",
  "stimulus": {
    "stimulusType": "DiInvocation",
    "serviceType": "IMetricsCalculationService",
    "method": "ComputeFraction",
    "args": [100, 0]
  },
  "stimulusId": "st-3",
  "expectations": [
    {
      "type": "FieldMatch",
      "topic": "di",
      "matcher": {
        "topicField": "di.returnValue",
        "assertion": "Equals",
        "value": { "kind": "integer_literal", "literal": 0 }
      },
      "rationale": "Guard returns 0 instead of throwing DivideByZeroException"
    }
  ],
  "timeoutMs": 5000,
  "confidence": 0.98,
  "groundingEvidenceRefs": ["ev-4"],
  "sketchId": "sketch-003",
  "featureFlagOverrides": [],
  "invariantsAddressed": ["inv-comparison_predicate-1"]
}
```
**Teaches:** DiInvocation uses interface name, concrete args, BoundaryTriplet technique, short timeout, high confidence for well-grounded test.

#### Exemplar 4: Regression — SignalRBroadcast stimulus
```json
{
  "id": "scn-004",
  "title": "SubscribeToTopic emits subscription confirmation in hub log",
  "description": "Verifies that invoking SubscribeToTopic on EdogPlaygroundHub emits the expected subscription-confirmation log entry.",
  "category": "Regression",
  "priority": 3,
  "impactZone": "EdogPlaygroundHub",
  "technique": "LogAssertion",
  "stimulusType": "SignalRBroadcast",
  "stimulus": {
    "stimulusType": "SignalRBroadcast",
    "hub": "EdogPlaygroundHub",
    "method": "SubscribeToTopic",
    "args": ["dag_execution_status"]
  },
  "stimulusId": "st-4",
  "expectations": [
    {
      "type": "EventPresent",
      "topic": "log",
      "matcher": {
        "topicField": "log.message",
        "assertion": "Contains",
        "value": { "kind": "string_literal", "literal": "SubscribeToTopic" }
      },
      "rationale": "Hub logs every subscription attempt; absence signals broken routing"
    },
    {
      "type": "FieldMatch",
      "topic": "signalr",
      "matcher": {
        "topicField": "signalr.method",
        "assertion": "Equals",
        "value": { "kind": "string_literal", "literal": "SubscribeToTopic" }
      },
      "rationale": "SignalR telemetry captures the invocation method"
    }
  ],
  "timeoutMs": 15000,
  "confidence": 0.85,
  "groundingEvidenceRefs": ["ev-5"],
  "sketchId": "sketch-004",
  "featureFlagOverrides": [],
  "invariantsAddressed": []
}
```
**Teaches:** SignalR stimulus shape (hub + method + args), exact hub/method names from framework-endpoints, dual log+signalr assertions, 15s timeout for SignalR round-trip.

**Section 3: Negative Exemplars** (~10 lines)

Three anti-patterns with WHY annotations:

1. **GET with body:**
   `BAD: stimulus: { method: "GET", body: { "filter": "active" } }`
   `WHY: GET MUST have body: null. Move params to path as query string.`

2. **Vague matcher value:**
   `BAD: value: { kind: "string_literal", literal: "string" }`
   `WHY: "string" is the TYPE name, not a concrete value. Use actual expected value.`

3. **Hallucinated topic field:**
   `BAD: topicField: "token.oboAcquired"`
   `WHY: This field does not exist. Use fields from TOPIC FIELD SCHEMA block only.`

**Section 4: Mechanical Rules** (~10 lines)

Only rules the schema cannot enforce:
- Evidence binding: every `groundingEvidenceRefs` must reference an Architect evidence ID
- Sketch ID preservation: `sketchId` must match byte-for-byte from Architect sketch
- 1:1 sketch-to-scenario mapping: one scenario per sketch, no merging or splitting
- Feature flag overrides go in `featureFlagOverrides[]` array only — projector renders headers/setup steps
- Repair mode: when REPAIR_FEEDBACK is present, fix the cited issues only

**Total: ~50 lines** (down from 115 — 57% reduction)

---

## 4. Validator Enhancements

### Layer 1: Schema-Level (handled by Section 2)

Structurally impossible after rewrite:
- Natural language matcherSpec (now typed object)
- Priority > 5, timeoutMs > 60000 (min/max)

**Note:** GET-with-body and wrong-stimulus-type-fields are NOT schema-enforced (strict mode lacks `if/then`). These are caught by Layer 2 semantic checks.

### Layer 2: Semantic Checks (new code in ValidateScenarioBatchShape)

| ID | Check | Action |
|----|-------|--------|
| S1 | HttpRequest path starts with `/` | Auto-repair: prepend `/` |
| S2 | HttpRequest GET has non-null body | Quarantine (any body on GET, not just query params) |
| S3 | SignalR hub exists in framework-endpoints.json | Quarantine |
| S4 | SignalR method exists in hub's methods list | Quarantine |
| S5 | topicField in AllValidTopicFields enum | Double-check (schema already enforces) |
| S6 | Every expectation has non-null matcher with non-null value | Quarantine |
| S7 | sketchId matches an Architect sketch ID | Quarantine |
| S8 | stimulusId matches an Architect st-N ID | Quarantine |
| S9 | expectation.topic must be a prefix of matcher.topicField | Quarantine (e.g. topic "http" must match topicField "http.statusCode") |
| S10 | outer stimulusType matches stimulus.stimulusType | Quarantine (discriminator consistency) |

### Layer 3: Auto-Derive (projector)

```csharp
scenario.Matchers = scenario.Expectations
    .Where(e => e.Matcher != null)
    .Select(e => e.Matcher)
    .ToList();
```

### Layer 4: Repair Feedback (existing, enhanced messages)

Quarantined scenarios get richer error messages for the new semantic checks. Existing REPAIR_FEEDBACK mechanism re-sends to Editor.

---

## 5. Downstream Changes

### 5A. C# DTO Updates

| DTO | Change |
|-----|--------|
| `GeneratedScenario.StimulusSpec` | Removed. New: `Stimulus` (typed object with `stimulusType` inside) |
| `GeneratedScenario.StimulusType` | Kept for projector/orchestrator compat — validator ensures it matches `stimulus.stimulusType` |
| `GeneratedScenario.Matchers` | Stays but auto-derived by projector, not populated by LLM |
| `GeneratedExpectation.MatcherSpec` | Removed. New: `Matcher` (typed GeneratedMatcher) |
| New DTOs | `HttpRequestStimulus`, `SignalRBroadcastStimulus`, `DiInvocationStimulus`, `DagTriggerStimulus`, `FileEventStimulus`, `TimerTickStimulus` |

Deserialization: The `Stimulus` property deserializes using `stimulus.stimulusType` as the discriminator (inside the object, not a sibling). Custom JsonConverter reads `stimulusType` from the object, then deserializes into the matching DTO subclass.

### 5B. Backend Pipeline Files (Projector / Validator / Orchestrator)

These files reference `StimulusSpec` (string) and `MatcherSpec` (string) extensively:

| File | Changes |
|------|---------|
| `EdogQaScenarioProjector.cs` | Replace `TryParseJson(src.StimulusSpec)` → read typed `src.Stimulus` directly. Replace `TryParseJson(expSrc.MatcherSpec)` → read typed `expSrc.Matcher` directly. Remove all `PROJECTION_STIMULUS_SPEC_MALFORMED` / `PROJECTION_MATCHER_SPEC_MALFORMED` error paths (structurally impossible with typed objects). Keep projection logic but simplify from JSON-parsing to direct property access. |
| `EdogQaScenarioValidator.cs` | Replace `string.IsNullOrWhiteSpace(scenario.StimulusSpec)` → null-check `scenario.Stimulus`. Replace `string.IsNullOrWhiteSpace(exp.MatcherSpec)` → null-check `exp.Matcher`. Update `CanonicalisePayload()` calls for deduplication hashing. |
| `EdogQaScenarioOrchestrator.cs` | Replace `JsonDocument.Parse(scenario.StimulusSpec)` → read typed `scenario.Stimulus`. Update stimulus fingerprinting in dedup logic. |

### 5C. Schema Builder Updates

| Method | Change |
|--------|--------|
| `BuildSingleScenarioSchema()` | `stimulusSpec: string` → `stimulus: { anyOf: [...] }` with `stimulusType` inside each variant |
| `BuildSingleScenarioSchema()` | `matcherSpec: string` → `matcher: { $ref: Matcher }` |
| `BuildSingleScenarioSchema()` | Drop `matchers` from required |
| `BuildScenarioBatchSchema()` | Add stimulus sub-schemas to `$defs` |

### 5D. Frontend

| File | Change |
|------|--------|
| `qa-editor.js` | Read `exp.matcher` instead of `exp.matcherSpec` |
| `qa-execution.js` | Read `exp.matcher` instead of `exp.matcherSpec` |
| `qa-curation.js` | No change (reads `scn.matchers`, still populated by projector) |

### 5E. Cache Keys

| Key | Old → New |
|-----|-----------|
| Analyst | `qa_analyst_v6` → `qa_analyst_v7` |
| Architect | `qa_architect_v15` → `qa_architect_v16` |
| Editor | `qa_editor_v23` → `qa_editor_v24` |

Test assertion on line 722 updated accordingly.

### 5F. No Backward Compatibility

Clean break. Old cached scenarios with string-typed `stimulusSpec`/`matcherSpec` will not parse. Users re-run analysis.

### 5G. Implementation Order (Schema Canary First)

Before rewriting everything, validate the proposed schema against the actual Azure OpenAI deployment:
1. Build the `stimulus.anyOf` schema with all 6 variants + `headers` as array-of-pairs
2. Run `FindStrictSchemaViolations()` locally
3. Send a minimal request to Azure OpenAI with the new schema to confirm API acceptance
4. Only then proceed with DTO migration, projector, validator, prompts, frontend

### 5H. Atomic Commit

All changes in one commit:
```
feat(qa): rewrite LLM prompts from first principles + typed schema

- Analyst v6→v7: reorder rules, trim redundancy
- Architect v15→v16: move materialization rules to Editor, add HTTP exemplar
- Editor v23→v24: full rewrite — persona + 4 gold exemplars + 3 anti-patterns
- Schema: stimulusSpec→typed stimulus (anyOf with internal discriminator), matcherSpec→typed matcher
- Headers: additionalProperties→array-of-pairs (strict-mode compat)
- Validator: 10 semantic checks (S1-S10), auto-derive matchers from expectations
- Projector/Validator/Orchestrator: string parsing→typed property access
- Frontend: qa-editor/qa-execution read typed matcher
- No backward compat — clean break
```
