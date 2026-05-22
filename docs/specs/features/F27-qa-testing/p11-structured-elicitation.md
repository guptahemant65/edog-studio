# F27 P11 — Structured Elicitation for Scenario Completeness

**Status:** Proposed
**Owner:** Sana (architecture) · Vex (C# implementation) · Pixel (UI rendering) · Sentinel (validation/tests)
**Depends on:** P9 (production-grade LLM pipeline), P10 (executable stimulus contract)
**Scope:** A schema + prompt change to the existing Architect call. **Zero new LLM calls.**

---

## 1. Problem Statement

The F27 QA scenario generation pipeline produces scenarios with **inconsistent coverage**:

- The Architect **oscillates between flow-only and edge-only outputs** depending on PR shape. A feature-flag PR yields two HappyPath scenarios; a defensive-null PR yields three EdgeCases; neither emits the *other* category even when the diff demands it.
- There is **no coverage guarantee mechanism**. Nothing in the pipeline checks "did we hit every changed code path?" or "did we exercise every feature-flag combination?" Curators discover gaps post-hoc and reject batches.
- **Curator approval rate sits at ~50–60%** across the eval corpus. The dominant rejection class is "obvious scenario missing," not "wrong technique on present scenario."
- The Editor's repair loop cannot recover from missing-scenario failures because **the missing scenarios were never enumerated upstream**.

Six rounds of expert-panel analysis (Anthropic, DeepMind/Palantir, Microsoft Research, Qodo, OpenAI) converged on the same conclusion:

> The Architect already has the diff, the analyst observations, and the freedom to emit any number of sketches. It does not need a new pipeline stage. **It needs to be asked the right questions, in a schema-enforced format, before it starts emitting sketches.**

P11 is that intervention.

---

## 2. Design Principles (from the panel)

1. **Elicitation > orchestration.** "Before adding a pipeline stage, ask whether structured elicitation in an existing prompt does the work." If the model can answer "what are the code paths?" in the same call where it generates scenarios, that round-trip is strictly cheaper, lower-latency, and lower-drift than a separate Coverage Planner call.

2. **Schema-enforced coverage.** Scenarios must reference enumerated paths **by ID**. Coverage becomes a structural property of the JSON — a validator can compute it in microseconds without re-asking the model.

3. **Separation of enumeration from generation.** Question 1 ("what code paths exist?") is a different cognitive task from Question 7 ("write a scenario for path #2"). Forcing the model to write the enumeration *first* breaks the path-degeneracy failure mode where it commits to one path and forgets the others.

4. **Six questions, not ten.** The panel rejected larger schemas as exceeding the model's working-memory window for a single call. Six is the empirically observed inflection point where elicitation completeness stops improving and recall on the actual scenarios starts degrading.

5. **Required fields in strict JSON schema, not optional prose instructions.** Optional prose ("please consider edge cases") is ignored under load. Required JSON fields with `additionalProperties: false` cannot be skipped by the model — schema-mode enforcement guarantees emission.

6. **No new LLM calls.** This is a pure expansion of the Architect's output schema and system prompt. Token cost is bounded and one-shot; latency is unchanged.

---

## 3. The Six Questions

Each question is a required object under `testingGuidance` in the Architect's output. The Architect must answer all six **before** it emits `scenarioSketches`. The schema's property order is preserved by `System.Text.Json` source generation (deterministic emission), giving the model a fixed thinking sequence.

### Q1 — `codePaths`

**Prompt fragment:**
> "Enumerate every distinct *executable code path* the diff introduces, modifies, or removes. A code path is a route a request can take through the changed code that produces a runtime-observable difference. Assign each a stable `pathId` (`cp-1`, `cp-2`, …). For each path, give a one-line `description` and mark `kind` as `Added`, `Modified`, or `Removed`. **Every `Added` path must be addressed by at least one scenarioSketch.**"

**Schema shape:**
```jsonc
{
  "type": "array",
  "items": {
    "type": "object",
    "additionalProperties": false,
    "required": ["pathId", "kind", "description"],
    "properties": {
      "pathId":      { "type": "string" },
      "kind":        { "type": "string", "enum": ["Added", "Modified", "Removed"] },
      "description": { "type": "string" }
    }
  }
}
```

**Failure mode it prevents:** path-degeneracy. The model used to bias toward whichever path the diff *visually* emphasized (e.g. the if-branch over the else-branch). Forcing explicit enumeration breaks the bias.

**Downstream consumption:** the plan validator asserts `every codePath.kind == "Added" has ≥1 scenarioSketch with addressesCodePathIds containing that pathId`.

---

### Q2 — `featureFlagMatrix`

**Prompt fragment:**
> "If the diff is gated behind one or more feature flags (or A/B experiments, kill-switches, capability checks), enumerate the *required* flag combinations the test suite must cover. A `combination` is a map from flag name to value plus a `mustCover` boolean. **For a new flag, you must include both the flag-on and flag-off combinations.** If no flags are involved, return an empty array."

**Schema shape:**
```jsonc
{
  "type": "array",
  "items": {
    "type": "object",
    "additionalProperties": false,
    "required": ["combinationId", "flags", "mustCover", "rationale"],
    "properties": {
      "combinationId": { "type": "string" },
      "flags":         { "type": "object", "additionalProperties": { "type": "string" } },
      "mustCover":     { "type": "boolean" },
      "rationale":     { "type": "string" }
    }
  }
}
```

**Failure mode it prevents:** "flag-on only" — the most common F27 regression in feature-flag PRs (PR #964068 historically emitted only the EnableLineageV2=on scenario; the v1-preservation scenario was missed by 4 of 5 sampled runs).

**Downstream consumption:** plan validator asserts every combination with `mustCover=true` has ≥1 scenarioSketch.

---

### Q3 — `stimuliRequired`

**Prompt fragment:**
> "Enumerate the stimulus shapes the test harness must produce to exercise the code paths. Each stimulus is one of the P10 typed stimulus types: `HttpRequest`, `SignalRBroadcast`, `DagTrigger`, `FileEvent`, `TimerTick`, `DiInvocation`. Give a stable `stimulusId` (`st-1`, …), the typed `stimulusType`, and a one-line `purpose` describing what behaviour it activates."

**Schema shape:**
```jsonc
{
  "type": "array",
  "items": {
    "type": "object",
    "additionalProperties": false,
    "required": ["stimulusId", "stimulusType", "purpose"],
    "properties": {
      "stimulusId":   { "type": "string" },
      "stimulusType": {
        "type": "string",
        "enum": ["HttpRequest", "SignalRBroadcast", "DagTrigger",
                 "FileEvent", "TimerTick", "DiInvocation"]
      },
      "purpose":      { "type": "string" }
    }
  }
}
```

**Failure mode it prevents:** stimulus-vocabulary drift between Architect and Editor. Pre-P11 the Architect described stimuli in prose ("call the endpoint"); the Editor occasionally chose a wrong stimulus type. Naming the stimulus type at the plan stage anchors the Editor's choice.

**Downstream consumption:** the Editor reads `stimuliRequired` in the user prompt; each emitted scenario's `stimulus.type` should appear in this set (Editor-side advisory check, not hard-validated in v1).

---

### Q4 — `observableSignals`

**Prompt fragment:**
> "Enumerate the *runtime signals* the test harness must observe to verify the diff. A signal is one of the closed expectation-topic vocabulary: `http`, `token`, `flag`, `perf`, `spark`, `log`, `telemetry`, `retry`, `cache`, `fileop`, `catalog`, `dag`, `flt-ops`, `nexus`, `di`, `capacity`. Give a stable `signalId` (`sig-1`, …), the `topic`, and a one-line `description` of what aspect of that topic is being asserted."

**Schema shape:**
```jsonc
{
  "type": "array",
  "items": {
    "type": "object",
    "additionalProperties": false,
    "required": ["signalId", "topic", "description"],
    "properties": {
      "signalId":    { "type": "string" },
      "topic": {
        "type": "string",
        "enum": ["http","token","flag","perf","spark","log","telemetry","retry",
                 "cache","fileop","catalog","dag","flt-ops","nexus","di","capacity"]
      },
      "description": { "type": "string" }
    }
  }
}
```

**Failure mode it prevents:** assertion-vocabulary collapse. Pre-P11 the Editor would default to `http` topics even when the changed behaviour was a `telemetry` emission or a `cache` invalidation, because no upstream signal said "this PR is about cache."

**Downstream consumption:** Editor reads `observableSignals` and is required (via prompt, not schema in v1) to choose matcher topics from this set.

---

### Q5 — `errorModesToTest`

**Prompt fragment:**
> "Enumerate failure conditions the diff *could* exhibit and a competent test suite would cover. Examples: null input, empty array, denominator zero, missing config, timeout, downstream 5xx, malformed JSON. Give each a stable `errorModeId` (`em-1`, …), a `trigger` (one line: what input/state activates it), and an `expectedBehaviour` (one line: what the code should do — return default, throw, log, retry). **If the diff is purely additive happy-path with no defensive code, return an empty array AND set the `noErrorModesRationale` field on the parent `testingGuidance` object.**"

**Schema shape:**
```jsonc
{
  "type": "array",
  "items": {
    "type": "object",
    "additionalProperties": false,
    "required": ["errorModeId", "trigger", "expectedBehaviour"],
    "properties": {
      "errorModeId":       { "type": "string" },
      "trigger":           { "type": "string" },
      "expectedBehaviour": { "type": "string" }
    }
  }
}
```

**Failure mode it prevents:** the "happy-path only" failure on defensive PRs. Pre-P11, a PR adding three null-coalescing guards would emit one HappyPath scenario; the actual changed behaviour (three EdgeCases) was silently dropped.

**Downstream consumption:** plan validator emits an advisory warning if `errorModesToTest.Count > 0` and no scenarioSketch references any of them. Hard-fail is deferred to v2.

---

### Q6 — `externalDependencyFailures`

**Prompt fragment:**
> "Enumerate failure modes of external dependencies the diff interacts with that the test suite should simulate. An external dependency is anything outside the FLT process boundary: GTS, OneLake, Nexus, SignalR hubs, downstream HTTP services, the DAG scheduler, the capacity broker. Give each a stable `depFailureId` (`df-1`, …), the `dependency` name, the `failureMode` (timeout/5xx/transient/permanent/throttle), and `expectedResilience` (one line: retry, fallback, propagate, swallow-and-log). **If the diff only touches in-process code with no external calls, return an empty array.**"

**Schema shape:**
```jsonc
{
  "type": "array",
  "items": {
    "type": "object",
    "additionalProperties": false,
    "required": ["depFailureId", "dependency", "failureMode", "expectedResilience"],
    "properties": {
      "depFailureId":       { "type": "string" },
      "dependency":         { "type": "string" },
      "failureMode": {
        "type": "string",
        "enum": ["timeout","5xx","transient","permanent","throttle","malformed_response","unavailable"]
      },
      "expectedResilience": { "type": "string" }
    }
  }
}
```

**Failure mode it prevents:** silent skipping of resilience scenarios. Q5 covers in-process error paths; Q6 covers cross-boundary ones. They are intentionally separate because the model conflates them under a single "error mode" question.

**Downstream consumption:** advisory only in v1 — surfaced in the curation UI so curators can demand resilience scenarios when present.

---

### PR #964068 worked example (the canonical fixture)

For PR #964068 (`EnableLineageV2` feature flag introducing a new `lineageVersion` response field), the model should emit:

```json
"testingGuidance": {
  "codePaths": [
    { "pathId": "cp-1", "kind": "Added",
      "description": "EnableLineageV2=on branch emits lineageVersion=2 on /lineage response" },
    { "pathId": "cp-2", "kind": "Modified",
      "description": "EnableLineageV2=off branch preserves v1 response shape (no lineageVersion field)" }
  ],
  "featureFlagMatrix": [
    { "combinationId": "fc-1", "flags": { "EnableLineageV2": "on"  }, "mustCover": true,
      "rationale": "Asserts new behaviour is emitted when flag is on." },
    { "combinationId": "fc-2", "flags": { "EnableLineageV2": "off" }, "mustCover": true,
      "rationale": "Asserts v1 shape is preserved when flag is off (regression guard)." }
  ],
  "stimuliRequired": [
    { "stimulusId": "st-1", "stimulusType": "HttpRequest",
      "purpose": "GET /api/lineage to invoke the gated branch." }
  ],
  "observableSignals": [
    { "signalId": "sig-1", "topic": "http",
      "description": "Response body lineageVersion field presence and value." },
    { "signalId": "sig-2", "topic": "flag",
      "description": "EnableLineageV2 flag-read telemetry confirms branch selection." }
  ],
  "errorModesToTest": [],
  "noErrorModesRationale": "Purely additive feature-flagged path; no new defensive code.",
  "externalDependencyFailures": []
}
```

Scenario sketches must then reference these IDs:

```json
"scenarioSketches": [
  { "sketchId": "sk-1", "title": "GetLineage with EnableLineageV2=on returns lineageVersion=2",
    "category": "HappyPath", "technique": "HappyPath",
    "addressesCodePathIds": ["cp-1"],
    "addressesErrorModeIds": [],
    "evidenceRefs": ["ev-1", "ev-2"],
    "rationale": "..." },
  { "sketchId": "sk-2", "title": "GetLineage with EnableLineageV2=off preserves v1 response shape",
    "category": "Regression", "technique": "RegressionGuard",
    "addressesCodePathIds": ["cp-2"],
    "addressesErrorModeIds": [],
    "evidenceRefs": ["ev-1", "ev-3"],
    "rationale": "..." }
]
```

---

## 4. Schema Changes

### 4.1 Architect Plan Schema (`BuildArchitectPlanSchema`)

**File:** `src/backend/DevMode/EdogQaLlmClient.cs` (around line 645)

Add `testingGuidance` to the top-level `required` and `properties`:

```csharp
internal static object BuildArchitectPlanSchema()
{
    return new
    {
        type = "object",
        additionalProperties = false,
        required = new[]
        {
            "zoneId", "zoneSummary", "planOutcome",
            "testingGuidance",                  // P11: new required field
            "behavioralChanges", "groundingEvidence", "scenarioSketches",
        },
        properties = new
        {
            zoneId = new { type = "string" },
            zoneSummary = new { type = "string" },
            planOutcome = new
            {
                type = "string",
                @enum = new[] { PlanOutcomeTestable, PlanOutcomeNoTestableChanges },
            },
            testingGuidance = BuildTestingGuidanceSchema(),   // P11
            behavioralChanges = /* unchanged */,
            groundingEvidence = /* unchanged */,
            scenarioSketches = /* see §4.2 */,
        },
    };
}
```

And add the helper:

```csharp
private static object BuildTestingGuidanceSchema()
{
    return new
    {
        type = "object",
        additionalProperties = false,
        required = new[]
        {
            "codePaths",
            "featureFlagMatrix",
            "stimuliRequired",
            "observableSignals",
            "errorModesToTest",
            "noErrorModesRationale",
            "externalDependencyFailures",
        },
        properties = new
        {
            codePaths = new
            {
                type = "array",
                items = new
                {
                    type = "object",
                    additionalProperties = false,
                    required = new[] { "pathId", "kind", "description" },
                    properties = new
                    {
                        pathId = new { type = "string" },
                        kind = new
                        {
                            type = "string",
                            @enum = new[] { "Added", "Modified", "Removed" },
                        },
                        description = new { type = "string" },
                    },
                },
            },
            featureFlagMatrix = new
            {
                type = "array",
                items = new
                {
                    type = "object",
                    additionalProperties = false,
                    required = new[] { "combinationId", "flags", "mustCover", "rationale" },
                    properties = new
                    {
                        combinationId = new { type = "string" },
                        flags = new
                        {
                            type = "object",
                            additionalProperties = new { type = "string" },
                        },
                        mustCover = new { type = "boolean" },
                        rationale = new { type = "string" },
                    },
                },
            },
            stimuliRequired = new
            {
                type = "array",
                items = new
                {
                    type = "object",
                    additionalProperties = false,
                    required = new[] { "stimulusId", "stimulusType", "purpose" },
                    properties = new
                    {
                        stimulusId = new { type = "string" },
                        stimulusType = new
                        {
                            type = "string",
                            @enum = new[]
                            {
                                "HttpRequest", "SignalRBroadcast", "DagTrigger",
                                "FileEvent", "TimerTick", "DiInvocation",
                            },
                        },
                        purpose = new { type = "string" },
                    },
                },
            },
            observableSignals = new
            {
                type = "array",
                items = new
                {
                    type = "object",
                    additionalProperties = false,
                    required = new[] { "signalId", "topic", "description" },
                    properties = new
                    {
                        signalId = new { type = "string" },
                        topic = new
                        {
                            type = "string",
                            @enum = new[]
                            {
                                "http","token","flag","perf","spark","log","telemetry","retry",
                                "cache","fileop","catalog","dag","flt-ops","nexus","di","capacity",
                            },
                        },
                        description = new { type = "string" },
                    },
                },
            },
            errorModesToTest = new
            {
                type = "array",
                items = new
                {
                    type = "object",
                    additionalProperties = false,
                    required = new[] { "errorModeId", "trigger", "expectedBehaviour" },
                    properties = new
                    {
                        errorModeId = new { type = "string" },
                        trigger = new { type = "string" },
                        expectedBehaviour = new { type = "string" },
                    },
                },
            },
            // String, not optional. Empty string is acceptable when errorModesToTest is non-empty.
            // Required so strict-mode emission does not skip it.
            noErrorModesRationale = new { type = "string" },
            externalDependencyFailures = new
            {
                type = "array",
                items = new
                {
                    type = "object",
                    additionalProperties = false,
                    required = new[]
                    {
                        "depFailureId", "dependency", "failureMode", "expectedResilience",
                    },
                    properties = new
                    {
                        depFailureId = new { type = "string" },
                        dependency = new { type = "string" },
                        failureMode = new
                        {
                            type = "string",
                            @enum = new[]
                            {
                                "timeout","5xx","transient","permanent",
                                "throttle","malformed_response","unavailable",
                            },
                        },
                        expectedResilience = new { type = "string" },
                    },
                },
            },
        },
    };
}
```

**Strict-mode contract:** every nested object sets `additionalProperties = false` and lists every property in `required`. Empty arrays are the legal "no items in this category" representation; the model is forbidden from omitting the field.

### 4.2 Scenario Sketch Schema

In `scenarioSketches.items` (around line 713), add two fields:

```csharp
items = new
{
    type = "object",
    additionalProperties = false,
    required = new[]
    {
        "sketchId", "title", "category", "technique",
        "rationale", "evidenceRefs",
        "addressesCodePathIds",     // P11: required
        "addressesErrorModeIds",    // P11: required (empty array if none)
    },
    properties = new
    {
        sketchId = new { type = "string" },
        title = new { type = "string" },
        category = /* unchanged */,
        technique = /* unchanged */,
        rationale = new { type = "string" },
        evidenceRefs = new { type = "array", items = new { type = "string" } },
        addressesCodePathIds = new
        {
            type = "array",
            items = new { type = "string" },
        },
        addressesErrorModeIds = new
        {
            type = "array",
            items = new { type = "string" },
        },
    },
},
```

Both fields are **required**. An empty array means "this sketch does not address any item in that category" — legal but advisory-flagged by the validator.

### 4.3 ArchitectPlan DTO

**File:** `src/backend/DevMode/EdogQaLlmClient.cs` (around line 336)

```csharp
#nullable disable
#pragma warning disable

internal sealed class ArchitectPlan
{
    public string ZoneId { get; set; }
    public string ZoneSummary { get; set; }
    public string PlanOutcome { get; set; }
    public TestingGuidance TestingGuidance { get; set; } = new();   // P11
    public List<BehavioralChange> BehavioralChanges { get; set; } = new();
    public List<ArchitectGroundingEvidence> GroundingEvidence { get; set; } = new();
    public List<ScenarioSketch> ScenarioSketches { get; set; } = new();
}

internal sealed class TestingGuidance
{
    public List<CodePathItem> CodePaths { get; set; } = new();
    public List<FeatureFlagCombination> FeatureFlagMatrix { get; set; } = new();
    public List<StimulusRequirement> StimuliRequired { get; set; } = new();
    public List<ObservableSignal> ObservableSignals { get; set; } = new();
    public List<ErrorModeItem> ErrorModesToTest { get; set; } = new();
    public string NoErrorModesRationale { get; set; } = string.Empty;
    public List<ExternalDependencyFailure> ExternalDependencyFailures { get; set; } = new();
}

internal sealed class CodePathItem
{
    public string PathId { get; set; }
    public string Kind { get; set; }            // "Added" | "Modified" | "Removed"
    public string Description { get; set; }
}

internal sealed class FeatureFlagCombination
{
    public string CombinationId { get; set; }
    public Dictionary<string, string> Flags { get; set; } = new();
    public bool MustCover { get; set; }
    public string Rationale { get; set; }
}

internal sealed class StimulusRequirement
{
    public string StimulusId { get; set; }
    public string StimulusType { get; set; }
    public string Purpose { get; set; }
}

internal sealed class ObservableSignal
{
    public string SignalId { get; set; }
    public string Topic { get; set; }
    public string Description { get; set; }
}

internal sealed class ErrorModeItem
{
    public string ErrorModeId { get; set; }
    public string Trigger { get; set; }
    public string ExpectedBehaviour { get; set; }
}

internal sealed class ExternalDependencyFailure
{
    public string DepFailureId { get; set; }
    public string Dependency { get; set; }
    public string FailureMode { get; set; }
    public string ExpectedResilience { get; set; }
}
```

And on `ScenarioSketch`:

```csharp
internal sealed class ScenarioSketch
{
    public string SketchId { get; set; }
    public string Title { get; set; }
    public string Category { get; set; }
    public string Technique { get; set; }
    public string Rationale { get; set; }
    public List<string> EvidenceRefs { get; set; } = new();
    public List<string> AddressesCodePathIds { get; set; } = new();   // P11
    public List<string> AddressesErrorModeIds { get; set; } = new();  // P11
}
```

`System.Text.Json` camelCase naming applies via the existing `JsonSerializerOptions`; no per-property attributes required.

---

## 5. Prompt Changes

### 5.1 Architect System Prompt Extension

**File:** `src/backend/DevMode/EdogQaLlmClient.cs` (the `ArchitectSystemPrompt` const around line 1736)

Append the following block **before** the trailing "If the user message includes ROLE SETTINGS …" sentence. The block must appear after the existing CATEGORY / EVIDENCE rules so the model has the closed-set vocabularies in context when answering Q4.

```
TESTING GUIDANCE — REQUIRED ELICITATION (answer all six before emitting scenarioSketches):
Before you emit any sketches, populate the testingGuidance object with six required sections.
Treat this as your structured thinking pass: each section narrows the scenario surface you must cover.
The scenarioSketches you emit afterwards MUST reference the IDs you assign here.

(1) codePaths — enumerate every distinct executable code path the diff introduces, modifies, or removes.
A code path is a route a request can take through the changed code that produces a runtime-observable
difference. Assign stable pathIds (cp-1, cp-2, ...). For each: description (one line) and kind in
{Added, Modified, Removed}. Every Added path MUST be addressed by at least one scenarioSketch.

(2) featureFlagMatrix — if the diff is gated behind feature flag(s), enumerate the required flag
combinations. For a new flag you MUST include both the flag-on and the flag-off combination.
Each item: combinationId (fc-1, ...), flags (map of flag-name -> value-string), mustCover (boolean),
rationale (one line). Return [] if no flags are involved.

(3) stimuliRequired — enumerate the stimulus shapes needed to exercise the code paths, using only
the typed stimulus vocabulary {HttpRequest, SignalRBroadcast, DagTrigger, FileEvent, TimerTick,
DiInvocation}. Each item: stimulusId (st-1, ...), stimulusType, purpose (one line).

(4) observableSignals — enumerate the runtime signals the test must observe, drawn ONLY from the
closed expectation-topic vocabulary {http, token, flag, perf, spark, log, telemetry, retry,
cache, fileop, catalog, dag, flt-ops, nexus, di, capacity}. Each item: signalId (sig-1, ...),
topic, description (one line).

(5) errorModesToTest — enumerate in-process failure conditions a competent test suite would cover
(null input, empty array, denominator zero, missing config, malformed payload). Each item:
errorModeId (em-1, ...), trigger (one line), expectedBehaviour (one line). If the diff is purely
additive happy-path with no defensive code, return [] AND set noErrorModesRationale to a one-line
explanation. Otherwise set noErrorModesRationale to an empty string.

(6) externalDependencyFailures — enumerate failure modes of external dependencies (GTS, OneLake,
Nexus, SignalR, downstream HTTP, DAG scheduler, capacity broker) the diff interacts with. Each item:
depFailureId (df-1, ...), dependency, failureMode in {timeout, 5xx, transient, permanent, throttle,
malformed_response, unavailable}, expectedResilience (one line). Return [] if the diff only touches
in-process code with no external calls.

RULES FOR TESTING GUIDANCE:
- Answer all six questions strictly in order; do not interleave with sketch generation.
- IDs must be stable, unique within their section, and referenced exactly by downstream sketches.
- Empty arrays are legal answers; omitting a section is not. If a category does not apply, return [].
- Do not invent items you cannot point at in the diff — enumeration must be diff-grounded.
- After filling testingGuidance, emit scenarioSketches such that:
  (a) every codePath with kind=Added is referenced by at least one sketch's addressesCodePathIds;
  (b) every featureFlagMatrix combination with mustCover=true is exercised by at least one sketch;
  (c) every errorModeId is referenced by at least one sketch's addressesErrorModeIds, OR the
      category is empty.
- addressesCodePathIds and addressesErrorModeIds are REQUIRED on every sketch. Use [] when none apply.
```

### 5.2 Editor System Prompt (minimal change)

**File:** `src/backend/DevMode/EdogQaLlmClient.cs` (the `EditorSystemPrompt` const around line 1770)

Append exactly one sentence (after the existing TITLE LENGTH HARD CAP line):

```
The Architect plan includes a testingGuidance block enumerating codePaths, featureFlagMatrix, stimuliRequired, observableSignals, errorModesToTest, and externalDependencyFailures; treat it as authoritative for stimulus type and matcher topic selection and choose values from those enumerated sets.
```

The Editor's existing schema is unchanged in v1. Compliance with the testing guidance is prompt-guided, not schema-enforced, on the Editor side. (Schema-enforcing it would require duplicating the IDs into the Editor's per-scenario schema; deferred to v2.)

---

## 6. Validator Changes

### 6.1 Plan Validation (`ValidateArchitectPlan`)

**File:** `src/backend/DevMode/EdogQaLlmClient.cs` (around line 2328)

Extend the existing method (it already returns `List<string>` and is called from the analyse path at line 1423):

```csharp
private static List<string> ValidateArchitectPlan(ArchitectPlan plan)
{
    var errors = new List<string>();
    if (plan == null) { errors.Add("plan is null"); return errors; }

    // … existing zoneId / planOutcome / no_testable_changes branch unchanged …

    // P11: testingGuidance must be present on testable plans.
    if (plan.PlanOutcome == PlanOutcomeTestable)
    {
        if (plan.TestingGuidance == null)
        {
            errors.Add("testingGuidance missing on testable plan");
            return errors;
        }

        var tg = plan.TestingGuidance;

        // Build sketch reference sets once.
        var sketchPathRefs = new HashSet<string>(StringComparer.Ordinal);
        var sketchErrorRefs = new HashSet<string>(StringComparer.Ordinal);
        if (plan.ScenarioSketches != null)
        {
            foreach (var s in plan.ScenarioSketches)
            {
                if (s == null) continue;
                if (s.AddressesCodePathIds != null)
                    foreach (var id in s.AddressesCodePathIds) sketchPathRefs.Add(id);
                if (s.AddressesErrorModeIds != null)
                    foreach (var id in s.AddressesErrorModeIds) sketchErrorRefs.Add(id);
            }
        }

        // (a) Every Added codePath must be addressed.
        if (tg.CodePaths != null)
        {
            var allPathIds = new HashSet<string>(StringComparer.Ordinal);
            foreach (var cp in tg.CodePaths)
            {
                if (cp == null || string.IsNullOrWhiteSpace(cp.PathId)) continue;
                if (!allPathIds.Add(cp.PathId))
                    errors.Add($"duplicate codePath pathId '{cp.PathId}'");
                if (string.Equals(cp.Kind, "Added", StringComparison.Ordinal)
                    && !sketchPathRefs.Contains(cp.PathId))
                {
                    errors.Add(
                        $"codePath '{cp.PathId}' kind=Added has no scenarioSketch addressing it");
                }
            }
            // Every addressesCodePathIds entry must point at a known pathId.
            foreach (var refId in sketchPathRefs)
            {
                if (!allPathIds.Contains(refId))
                    errors.Add($"scenarioSketch references unknown codePath '{refId}'");
            }
        }

        // (b) Every mustCover feature-flag combination must be exercised.
        //     (Title-substring match is fragile; v1 requires sketches to embed
        //      the combinationId in addressesCodePathIds is too restrictive,
        //      so v1 only emits an *advisory* warning here, surfaced via the
        //      AdvisoryWarnings sink — not appended to errors.)
        if (tg.FeatureFlagMatrix != null)
        {
            foreach (var fc in tg.FeatureFlagMatrix)
            {
                if (fc == null || !fc.MustCover) continue;
                // Advisory only — see §8 "empty categories" mitigation.
                // Surfaced via plan.TestingGuidance for curator UI display.
            }
        }

        // (c) Every errorMode must be referenced; advisory in v1.
        if (tg.ErrorModesToTest != null)
        {
            var allErrorIds = new HashSet<string>(StringComparer.Ordinal);
            foreach (var em in tg.ErrorModesToTest)
            {
                if (em == null || string.IsNullOrWhiteSpace(em.ErrorModeId)) continue;
                if (!allErrorIds.Add(em.ErrorModeId))
                    errors.Add($"duplicate errorMode '{em.ErrorModeId}'");
                if (!sketchErrorRefs.Contains(em.ErrorModeId))
                {
                    // Advisory in v1 — hard-fail in v2 after baseline measurement.
                    // For now log to errors with an explicit prefix so callers can filter.
                    errors.Add(
                        $"ADVISORY: errorMode '{em.ErrorModeId}' has no scenarioSketch addressing it");
                }
            }
            foreach (var refId in sketchErrorRefs)
            {
                if (!allErrorIds.Contains(refId))
                    errors.Add($"scenarioSketch references unknown errorMode '{refId}'");
            }
        }

        // errorModesToTest empty + rationale empty is a soft violation.
        if ((tg.ErrorModesToTest == null || tg.ErrorModesToTest.Count == 0)
            && string.IsNullOrWhiteSpace(tg.NoErrorModesRationale))
        {
            errors.Add(
                "ADVISORY: errorModesToTest is empty but noErrorModesRationale was not provided");
        }
    }

    // … existing evidence-ID dedup loop unchanged …

    return errors;
}
```

**Caller behavior:** the analyse pipeline at line 1423 already treats `planErrors` as hard-fail conditions. Entries prefixed with `"ADVISORY: "` MUST be filtered out before hard-fail evaluation in v1 and instead routed to the plan-render payload for curator UI display (see §7.2). This is the single line that gates v1 vs v2 strictness.

### 6.2 Scenario Validation (`EdogQaScenarioValidator`)

**File:** `src/backend/DevMode/EdogQaScenarioValidator.cs` (around line 233)

The public signature stays:

```csharp
public static ValidationResult Validate(
    EdogQaLlmClient.ArchitectPlan plan,
    IReadOnlyList<EdogQaLlmClient.GeneratedScenario> scenarios,
    string unifiedDiff,
    ValidationContext context)
```

After the existing per-scenario loop, add a batch-level **advisory** coverage gate (not appended to per-scenario quarantine reasons, but recorded on `result.BatchInformational` for UI surfacing):

```csharp
// P11 batch-level coverage advisory.
// Hard-fail behavior deferred to v2 — see spec §6.2.
if (plan?.TestingGuidance?.CodePaths != null)
{
    var addressed = scenarios
        .Where(s => s != null)
        .SelectMany(s => s.GroundingEvidenceRefs ?? new List<string>())
        .ToHashSet(StringComparer.Ordinal);
    // (Note: scenario-level addressesCodePathIds is on the sketch, not the
    //  emitted scenario. v1 cross-checks via sketch->scenario mapping in the
    //  caller. The validator surfaces only the plan-level advisory here.)
    foreach (var cp in plan.TestingGuidance.CodePaths)
    {
        if (cp == null || !string.Equals(cp.Kind, "Added", StringComparison.Ordinal)) continue;
        // The caller is responsible for joining sketches to emitted scenarios
        // by sketchId; the advisory string here records the codePath inventory
        // for UI display.
    }
    result.BatchInformational.Add(new QuarantineReason
    {
        Code = "P11_COVERAGE_REPORT",
        Message = $"testingGuidance enumerated {plan.TestingGuidance.CodePaths.Count} codePaths.",
    });
}
```

Add `BatchInformational` to `ValidationResult` if not already present (advisory channel mirroring `BatchErrors`).

**v1 hard-fail policy:** none of the new gates hard-fail v1. Curator approval data over the first 50 PRs will drive the v2 threshold-setting before promotion.

---

## 7. Frontend Changes

### 7.1 Curation UI (`qa-curation.js`)

**File:** `src/frontend/js/qa-curation.js`

Insert a new collapsible **"Testing Guidance"** panel above the scenario list, between the bulk-action bar (line 142) and the batch-findings panel (line 146). The pattern mirrors `_renderBatchFindings()`.

```javascript
// After the bulkBar append, before _batchFindings:
if (this._testingGuidance) {
  this._container.appendChild(this._renderTestingGuidance());
}
```

`this._testingGuidance` is wired in via the existing analysis-result payload (the orchestrator already passes the architect plan through; pluck `testingGuidance` from it during construction).

New method:

```javascript
_renderTestingGuidance() {
  var tg = this._testingGuidance;
  var wrap = document.createElement('div');
  wrap.className = 'qa-panel qa-testing-guidance';

  var header = document.createElement('button');
  header.className = 'qa-panel-header qa-collapsible-header';
  header.setAttribute('aria-expanded', 'false');
  header.innerHTML =
    '<span class="qa-panel-title">Testing Guidance</span>'
    + '<span class="qa-panel-meta">'
    +   (tg.codePaths.length) + ' code paths \u00B7 '
    +   (tg.featureFlagMatrix.length) + ' flag combos \u00B7 '
    +   (tg.errorModesToTest.length) + ' error modes'
    + '</span>'
    + '<span class="qa-collapsible-chevron">\u25BE</span>';

  var body = document.createElement('div');
  body.className = 'qa-panel-body qa-collapsible-body';
  body.style.display = 'none';

  body.appendChild(this._renderGuidanceList('Code Paths',
    tg.codePaths, function (cp) {
      return '<span class="qa-chip qa-chip-' + cp.kind.toLowerCase() + '">'
        + cp.pathId + '</span> '
        + '<span class="qa-chip-kind">' + cp.kind + '</span> '
        + '<span class="qa-chip-desc">' + cp.description + '</span>';
    }));

  body.appendChild(this._renderGuidanceList('Feature-Flag Matrix',
    tg.featureFlagMatrix, function (fc) {
      var flagStr = Object.keys(fc.flags).map(function (k) {
        return k + '=' + fc.flags[k];
      }).join(', ');
      return '<span class="qa-chip">' + fc.combinationId + '</span> '
        + (fc.mustCover ? '<span class="qa-chip qa-chip-must">must-cover</span> ' : '')
        + '<code>' + flagStr + '</code> '
        + '<span class="qa-chip-desc">' + fc.rationale + '</span>';
    }));

  body.appendChild(this._renderGuidanceList('Error Modes',
    tg.errorModesToTest, function (em) {
      return '<span class="qa-chip">' + em.errorModeId + '</span> '
        + '<span class="qa-chip-trigger">' + em.trigger + '</span> '
        + '<span class="qa-chip-arrow">\u2192</span> '
        + '<span class="qa-chip-expected">' + em.expectedBehaviour + '</span>';
    }));

  // External-dependency failures, observable signals, stimuli rendered identically.

  header.addEventListener('click', function () {
    var shown = body.style.display !== 'none';
    body.style.display = shown ? 'none' : 'block';
    header.setAttribute('aria-expanded', String(!shown));
  });

  wrap.appendChild(header);
  wrap.appendChild(body);
  return wrap;
}

_renderGuidanceList(title, items, formatItem) {
  var section = document.createElement('div');
  section.className = 'qa-guidance-section';
  var h = document.createElement('div');
  h.className = 'qa-guidance-section-title';
  h.textContent = title + ' (' + items.length + ')';
  section.appendChild(h);
  if (items.length === 0) {
    var empty = document.createElement('div');
    empty.className = 'qa-guidance-empty';
    empty.textContent = '\u2014';   // em-dash for "none"
    section.appendChild(empty);
    return section;
  }
  for (var i = 0; i < items.length; i++) {
    var row = document.createElement('div');
    row.className = 'qa-guidance-row';
    row.innerHTML = formatItem(items[i]);
    section.appendChild(row);
  }
  return section;
}
```

**Per-scenario chips.** In `_createScenarioCard` (line 189) add a chip strip immediately under the title showing which `codePathIds` and `errorModeIds` the scenario addresses (the sketch IDs are joined by the caller before the card array is handed in):

```javascript
if (scn.addressesCodePathIds && scn.addressesCodePathIds.length > 0) {
  var chipStrip = document.createElement('div');
  chipStrip.className = 'qa-card-chips';
  for (var i = 0; i < scn.addressesCodePathIds.length; i++) {
    var chip = document.createElement('span');
    chip.className = 'qa-chip qa-chip-pathref';
    chip.textContent = scn.addressesCodePathIds[i];
    chipStrip.appendChild(chip);
  }
  // …same for addressesErrorModeIds with qa-chip-errorref…
  titleRow.appendChild(chipStrip);
}
```

**Styling.** Add tokens to `qa-curation.css` (or the shared `qa-panel.css`) using the design-bible scales:

- `.qa-chip-added` background `var(--accent-success-bg)`
- `.qa-chip-modified` background `var(--accent-warn-bg)`
- `.qa-chip-removed` background `var(--accent-danger-bg)`
- `.qa-chip-must` background `var(--accent-primary)` color `var(--bg-primary)`
- `.qa-chip-pathref` and `.qa-chip-errorref` use `var(--border-subtle)` outline, monospace font

No emoji. Use unicode `▾`, `▸`, `→`.

### 7.2 Analysis UI (`qa-analysis.js`)

When the Architect-completed event arrives, surface a summary line in the analysis progress stream:

```
Architect complete · 4 code paths · 2 flag combinations · 3 error modes · 2 stimulus types
```

Pluck the counts from `analysisResult.architectPlan.testingGuidance` and render them via the existing progress-line renderer. No new UI primitives required.

---

## 8. Failure Modes and Mitigations

| # | Failure mode | Mitigation |
|---|---|---|
| 1 | **Prompt bloat on large PRs** (50+ code paths) | The Architect prompt explicitly says "diff-grounded enumeration." Beyond ~30 entries in any category the orchestrator clips the user-message diff (existing P9 behaviour) before the model sees it. If `codePaths.Count > 50` the validator emits an `ADVISORY: testingGuidance.codePaths exceeds 50 entries — consider zone re-decomposition` and the curator UI surfaces a warning chip on the testing-guidance panel header. |
| 2 | **Enumeration over-confidence** (model lists code paths that aren't actually in the diff) | The curator UI (§7.1) renders the full enumeration *before* the scenario list, with the diff anchor visible. Curators can reject the whole batch with one click if the enumeration is wrong. Long-term: an evidence-anchoring requirement (`codePaths[*].anchorEvidenceId`) can be added in v2 if needed. |
| 3 | **Plan-scenario drift** (sketches don't actually reference the enumerated IDs) | The plan validator (§6.1) hard-fails on any `addressesCodePathIds` entry referencing an unknown `pathId`, and on any `Added` codePath with no addressing sketch. The strict-schema requirement on `addressesCodePathIds` (required field, every sketch) prevents the model from silently skipping it. |
| 4 | **Empty categories** (model returns `[]` for everything to satisfy the schema cheaply) | (a) Schema requires `noErrorModesRationale` to be filled when `errorModesToTest=[]`. (b) The Architect prompt explicitly enumerates the diff signals — a non-trivial PR should have at least `codePaths.Count >= 1`. (c) Plan validator emits an `ADVISORY: testingGuidance is empty across all six sections on a testable plan` warning that surfaces in the curation UI. v2 may promote this to hard-fail. |
| 5 | **Cross-call drift on Editor repair** | The repair prompt (existing P9 partial-repair path) MUST include the full `testingGuidance` block in the user message, prefixed with `[ARCHITECT TESTING GUIDANCE — DO NOT MODIFY, USE AS REFERENCE]:`. This is a one-line addition to the repair-prompt builder; the schema and content are unchanged from the original Architect call. |
| 6 | **Schema reject on a single hallucinated enum value** | All enums in §4.1 use the existing pipeline's closed-set vocabularies (stimulus types, topic vocab, plan-outcome enum). No new vocabulary is introduced; the model has been trained on these tokens via the existing prompts. |

---

## 9. Cost and Token Budget

**Output tokens (per Architect call):**

- Base architect plan (pre-P11): ~3–5K tokens of structured output on a representative PR.
- `testingGuidance` block on a 4-codepath / 2-flag / 3-error-mode PR: ~1.2K tokens.
- Worst-case (large PR with 30 codepaths, 10 flag combos, 15 error modes): ~2K tokens.
- **Headroom check:** Architect output budget is 192K tokens (gpt-5 family). P11 consumes < 1.1% of the budget at worst case, and < 0.7% on a representative PR. **Acceptable.**

**Input tokens (per Architect call):**

- System-prompt addition (§5.1): ~800 tokens.
- Editor system-prompt addition (§5.2): ~80 tokens.
- Architect repair-path now includes the `testingGuidance` block in the user message (§8 row 5): ~1.2K tokens additional on repair calls only.

**LLM calls:** **zero new calls.** P11 is a schema + prompt expansion on the existing Architect and Editor calls.

**Net comparison vs. the Coverage Planner alternative** (the option the panel rejected): the Coverage Planner approach would have added one new Architect-class call per analysis — at gpt-5 pricing, ~$0.02–0.05 per PR depending on diff size. P11 saves that entire delta while delivering the same coverage signal.

**Latency:** unchanged. Output-token deltas are dominated by the existing scenario-batch emission, not the elicitation block. Architect p95 stays at its P9 baseline.

---

## 10. Files Changed

| File | Change | Est. LOC |
|---|---|---|
| `src/backend/DevMode/EdogQaLlmClient.cs` | Schema additions (`BuildTestingGuidanceSchema`, `scenarioSketches.items` extension), DTO additions (`TestingGuidance` + 6 nested classes, two fields on `ScenarioSketch`), prompt extensions (Architect + Editor), validator coverage checks. | +320 |
| `src/backend/DevMode/EdogQaScenarioValidator.cs` | Batch-level advisory coverage report; `ValidationResult.BatchInformational` channel. | +40 |
| `src/backend/DevMode/EdogQaAnalysisOrchestrator.cs` (or equivalent caller of `ValidateArchitectPlan`) | Filter `ADVISORY:`-prefixed entries from hard-fail path; route to plan-render payload. | +15 |
| `src/frontend/js/qa-curation.js` | `_renderTestingGuidance`, `_renderGuidanceList`, per-card chip strip, `_testingGuidance` field on ctor. | +180 |
| `src/frontend/js/qa-analysis.js` | One-line guidance summary in the analysis progress stream. | +25 |
| `src/frontend/css/qa-curation.css` (or shared `qa-panel.css`) | Chip / panel tokens (see §7.1). | +60 |
| `tests/backend/DevMode/EdogQaLlmClient_SchemaTests.cs` | Strict-schema-violation test for the new schema; round-trip DTO test. | +100 |
| `tests/backend/DevMode/EdogQaLlmClient_ValidatorTests.cs` | Plan-validator coverage-check cases (Added-without-sketch, dup pathId, unknown ref, empty-with-rationale, empty-without-rationale). | +120 |
| `tests/backend/DevMode/EdogQaLlmClient_PromptTests.cs` | Six-question-keyword presence test on `ArchitectSystemPrompt`. | +30 |
| `tests/integration/F27/P11_TestingGuidanceIntegrationTests.cs` | Mock Architect response with `testingGuidance` → run validator → run projector → assert curation-payload shape. | +150 |
| `docs/specs/features/F27-qa-testing/p11-structured-elicitation.md` | This spec. | +1 file |

**Total:** ~1040 LOC across 11 files.

---

## 11. Testing Strategy

1. **Schema strictness test** — `FindStrictSchemaViolations(BuildArchitectPlanSchema())` returns empty. Every nested object has `additionalProperties: false` and every property appears in `required`. This test already exists for the pre-P11 schema; the assertion stands on the extended one.

2. **DTO round-trip test** — Serialize a canonical `ArchitectPlan` populated with PR #964068 testing-guidance shape (see §3 worked example) to JSON, deserialize it, assert deep equality. Catches camelCase-naming drift on the new DTO classes.

3. **Validator coverage-check tests** — Table-driven:
   - codePath kind=Added with no sketch addressing it → 1 hard error.
   - codePath kind=Modified with no sketch addressing it → 0 errors.
   - Sketch references unknown pathId → 1 hard error.
   - Duplicate pathId → 1 hard error.
   - errorModesToTest non-empty, no sketch addresses any → 1 advisory.
   - errorModesToTest empty + noErrorModesRationale empty → 1 advisory.
   - errorModesToTest empty + noErrorModesRationale non-empty → 0 errors.

4. **Prompt-structure test** — assert the string `ArchitectSystemPrompt` contains all six question section keywords (`codePaths`, `featureFlagMatrix`, `stimuliRequired`, `observableSignals`, `errorModesToTest`, `externalDependencyFailures`) and the closed-set vocabularies (`HttpRequest`, `SignalRBroadcast`, … and `http`, `token`, `flag`, …). This test guards against prompt drift.

5. **Integration test** — feed a mock Architect response containing a populated `testingGuidance` block for PR #964068 (see §3) plus 2 matching sketches into the analyse pipeline. Assert:
   - Validator returns 0 hard errors, 0 advisories.
   - Projector outputs include `addressesCodePathIds` on each scenario.
   - Curation-payload includes `testingGuidance` at the top level.

6. **Negative integration test** — same as 5 but with one `Added` codePath unreferenced. Assert validator returns exactly 1 hard error and the analysis result is marked `Quarantined`.

7. **Eval-corpus regression test** — run the existing eval corpus through the P11 pipeline with the new schema. Assert recall on the gold-corpus expectations does not regress by more than 2 percentage points (the noise floor we measured in P9). Promotion to v2 strictness gates on a positive delta here.

---

## 12. Build Sequence

Phased landing to keep blast radius small and reversible at each step:

1. **Phase 1 — Schema + DTO + prompt (Architect-side, no downstream impact).**
   - Land §4.1, §4.2, §4.3, §5.1, §5.2.
   - The Architect now emits `testingGuidance`, but no downstream code reads it. Editor unaffected because the user-message change is additive context, not a contract change.
   - **Reversibility:** revert the const string + the schema helper + the DTO classes. ~3 file revert.

2. **Phase 2 — Validator coverage checks.**
   - Land §6.1 and the orchestrator advisory-filtering line (§10 row 3).
   - All new errors land as `ADVISORY:` prefixed in v1, so no batch is hard-failed by P11 alone in this phase.
   - **Verification:** run 20 PRs through the pipeline, confirm advisory rate ~10–20% (a 0% rate means the model is gaming the schema, a >40% rate means the prompt rules are too strict).

3. **Phase 3 — Frontend rendering.**
   - Land §7.1 and §7.2.
   - Curation UI now shows the testing-guidance panel and per-card chips. No behaviour change for curators who don't expand the panel.

4. **Phase 4 — Eval substrate measurement.**
   - Run the full eval corpus, compute curator approval delta vs. P10 baseline, write up the result.
   - **Gate to v2 strictness promotion** (converting advisories to hard-fails on `featureFlagMatrix` and `errorModesToTest`): requires +15 pp approval-rate improvement at 95% CI and no recall regression on the gold corpus.

---

## 13. Success Criteria

| Metric | Baseline (P10) | Target (steady state) | Hard floor |
|---|---|---|---|
| Curator approval rate | 50–60% | +20 to +30 pp (i.e. 70–85%) | No regression |
| `Added` codePath coverage | not measured | every Added codePath has ≥1 scenario in ≥95% of analyses | ≥80% |
| Feature-flag matrix coverage | not measured | every `mustCover` combination has ≥1 scenario in ≥95% of flag PRs | ≥80% |
| Eval-corpus recall (gold expectations) | P10 baseline | within ±2 pp | no >5 pp regression |
| Architect p95 latency | P10 baseline | within ±5% | no >15% regression |
| Net LLM cost per analysis | P10 baseline | within ±5% | no >10% increase |

**Promotion to v2 (advisories → hard-fails)** requires hitting the "steady state" column on the first three rows over 50 consecutive analyses and the bottom three "hard floor" guarantees holding throughout.

---

## Appendix A — PR #964068 reference payload

The full Architect output for PR #964068 (`EnableLineageV2`) after P11 should look like the worked example in §3, plus the following `behavioralChanges` / `groundingEvidence` (unchanged from P10):

```json
{
  "zoneId": "lineage-v2",
  "zoneSummary": "Adds EnableLineageV2 feature flag gating a new lineageVersion=2 response field.",
  "planOutcome": "testable",
  "testingGuidance": { /* see §3 */ },
  "behavioralChanges": [
    { "summary": "GetLineageAsync emits lineageVersion=2 when EnableLineageV2 is on",
      "evidenceRefs": ["ev-1", "ev-2"] },
    { "summary": "GetLineageAsync preserves v1 response shape when EnableLineageV2 is off",
      "evidenceRefs": ["ev-1", "ev-3"] }
  ],
  "groundingEvidence": [
    { "evidenceId": "ev-1", "repoRelativePath": "src/.../Flags.cs",
      "side": "right", "baseSha": "<sha>", "hunkId": "h1", "newLine": 42,
      "excerpt": "public const string EnableLineageV2 = \"...\";",
      "reason": "Flag constant declaration." },
    { "evidenceId": "ev-2", "repoRelativePath": "src/.../LineageController.cs",
      "side": "right", "baseSha": "<sha>", "hunkId": "h2", "newLine": 87,
      "excerpt": "response.LineageVersion = 2;",
      "reason": "Flag-on branch sets new response field." },
    { "evidenceId": "ev-3", "repoRelativePath": "src/.../LineageController.cs",
      "side": "right", "baseSha": "<sha>", "hunkId": "h2", "newLine": 91,
      "excerpt": "// else: leave response shape unchanged",
      "reason": "Flag-off branch preserves v1 shape." }
  ],
  "scenarioSketches": [ /* see §3 worked example */ ]
}
```

This payload is the canonical fixture for the integration tests in §11 row 5.

---

*End of spec.*
