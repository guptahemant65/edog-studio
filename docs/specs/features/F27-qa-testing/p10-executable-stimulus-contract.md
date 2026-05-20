# F27 P10 — Executable Stimulus & Expectation Contract

> **Status:** Design approved by Hemant 2026-05-20. **Revised post-expert-consultation 2026-05-20** (28 findings synthesized — Appendix C). Pending final Hemant approval before invoking writing-plans.
> **Date:** 2026-05-20 (rev 2)
> **Authors:** Donna (synthesis) + Sana (architecture lead) + Vex (impl C# / Python) + Pixel (frontend) + Sentinel (quality gates)
> **Driver:** PR 977882 surfaced hallucinated HTTP paths (`/api/v1/insights/summary`) and format-string matcher values (`yyyy-MM-dd`) that survived F27 P9's strict-mode schema. Root cause: `stimulusSpec` and `matcherSpec` declared as `{type: "string"}` — opaque JSON-encoded strings the LLM hallucinates inside, with zero schema enforcement on the content.
> **Scope:** Replace opaque stimulus / matcher strings with typed per-zone contracts, all 6 stimulus kinds, end to end. Workbench UI rebuild. Executor extension for non-HTTP stimuli via a single DevMode dispatch endpoint in FLT. Big-bang rollout with per-kind emergency disable.

---

## Locked decisions (one-line per section)

| § | Decision |
|---|---|
| **1** | Replace opaque `stimulusSpec`/`matcherSpec` strings with typed contract bound to a per-zone catalog; covers all 6 stimulus kinds. |
| **2** | Per-zone catalog assembled from 6 source providers (runtime swagger, DI registry filtered by `[EdogDirectInvokeSeam]`, framework-endpoints.json, DAG scanner, file/timer scanner, topic-field Roslyn scan). |
| **3** | Per-zone JSON schema uses Azure strict-mode-compatible primitives only: `anyOf` per slot with literal `slotId` discriminator first, composite `topic.field` enum, `$defs`/`$ref` factoring, zone partition at >30 anyOf branches. **Matcher `value` is a discriminated union over 5 typed shapes (`string`/`integer`/`datetime`/`range`/`array`); optional catalog params emit as nullable unions (`["T","null"]` + present in `required`).** |
| **3-bis** | Strict-mode compensation: **R1–R9** schema authoring rules + build-time caps (≤100 props / ≤5 depth / ≤14K name chars / ≤450 enum / ≤7K single-enum / ≤30 anyOf branches, **caps re-checked on the generated schema, not only the catalog**) + **P1–P7** prompt-layer patterns (annotated `plan` field with rich description, double-encoded soft constraints, informative retries with attempt-3 escalation, JSON-mode prelude, **temperature anneal 0.2→0.4→0.6**, slot-purpose system-message block, locked few-shot example). |
| **4** | Architect → Editor → Projector → Validator → Orchestrator pipeline (mostly already shipped under P9); Projector simplifies post-tightening; Validator retains all 5 gates as defense-in-depth + **active grounding-slot-match check** for R2; **scenarios-per-zone formula uses `min(2, floor(reachableSlotCount/8))` so diff-proportionality is not swamped**; partial-repair uses `PartialRepairSchema` with explicit `originalIndex`. |
| **5.1** | Workbench layout: three-column workbench (left = scenario list, middle = stimulus builder, right = matcher builder). |
| **5.2** | Matcher assertion vocabulary: 7 types — `equals`, `notEquals`, `exists`, `inRange`, `containsAll`, `oneOf`, `length`. Identical for LLM and human authoring. No regex / format-string surface. |
| **5.3** | Matchers per scenario: flat array, cap 6 enforced via system-prompt rule + Validator post-emission gate (strict mode rejects `maxItems`, so the cap cannot be a schema-level constraint). |
| **5.4** | Schema-violation feedback: inline markers + collapsible "Issues (N)" strip + transient toasts for orchestrator events. |
| **5.5** | Slot-picker: type-ahead combo with rich labels (slotId + path/signature + summary + capture-field names + idempotency dot). |
| **5.6** | Inline last-run result panels per scenario card; existing results view retained for cross-scenario analytics. |
| **5.7** | Replace existing workbench in place. No opaque-JSON authoring path remains. |
| **6.1** | Catalog hash granularity: **per-slot stimulus hash + per-matcher-topic hashes** (per-kind hash retained only as diagnostic). Reduces M5 stale rate on active areas. |
| **6.2** | Stimulus delivery: single FLT DevMode endpoint `POST /devmode/qa/dispatch` (synchronous for HTTP/DI/SignalR/FileEvent/TimerTick) + **`POST /devmode/qa/dispatch/async` returning `202 {dispatchId}` + `GET /devmode/qa/dispatch/{id}` poll for DagTrigger only** (5-min wait owned by EDOG client). **Secured by `X-EDOG-Control-Token` + localhost bind + per-kind+per-slot allowlist + per-kind concurrency caps + request-body size cap + redacted audit log.** |
| **6.2-bis** | No cleanup mechanism. Synchronous kinds have per-kind timeout (FileEvent=30s, DI=30s, SignalR=5s, TimerTick=10s) → verdict `inconclusive` on timeout. DAG via async poll with linked cancellation; EDOG-side 5-min budget. **Every dispatch wraps observer registration in `finally`-scoped disposal; all dispatch paths thread a linked cancellation token to the underlying invoker.** |
| **6.3** | Pre-contract scenario migration: quarantine all and force regeneration. |
| **6.4** | Catalog-hash mismatch handling: soft reject + `stale` verdict state + one-click regenerate. Per-slot granularity (a sibling slot change does not stale unrelated scenarios). |
| **6.5** | Catalog freshness: fresh fetch per run; single snapshot for the whole run **wrapped in a `CatalogSnapshot` envelope carrying FLT build SHA + EDOG repo SHA + per-provider status (`ok`/`degraded`/`empty`/`failed`) + canonical-JSON hash. Snapshot is immutable for the run's duration.** |
| **7.1** | LNT011 (format-string-literal) severity = **Error**. |
| **7.2** | LNT001 / LNT003 / LNT004 retained at **Error** as defense-in-depth. |
| **7.3** | Contract-health telemetry surface: logs only; in-product panel deferred to follow-up. **Telemetry payloads obey redaction rules: no raw params/bodies/headers/matcher values/LLM output; reason codes + truncated detail; sampling for high-volume outcome events; no sampling for rejects or security events.** |
| **8.1** | Rollout = big-bang. All 6 kinds shipped + enabled together. |
| **8.2** | Rollback = kill switch (`qa.contract.enabled`) + per-kind emergency disable (`qa.contract.disabledKinds`); default all-on. **Flags surfaced via `IQaContractOptionsProvider` exposing atomic immutable snapshots with monotonic `revision`. Each generation/run captures one revision at start; mid-run flips do not split state.** |
| **8.3** | Pre-merge bar: 8 named gates G1–G8 + 4-agent sign-off + sandbox smoke + ADR file + cross-repo FLT-first sequencing. **G3 is mandatory live CI-spun FLT** (recorded fixtures may supplement, never replace). **G7 asserts both swagger absence AND actual `404` in Release builds**; `QaDispatchController` registered via ADR-005 late DevMode path (NOT `AddAllControllersFromAssembly`). **New gate G9: capability-endpoint version skew detection.** |
| **8.4** | **FLT exposes `GET /devmode/qa/capabilities` returning `{contractVersion, supportedKinds[], fltBuildSha, schemaCapVersion}`.** EDOG CI pins a tagged FLT artifact; EDOG tests skip/fail explicitly on capability-version mismatch; FLT PR contract-compatibility tests run before EDOG PR opens. |
| **9.1** | 7 success metrics M1–M7 measured over first 4 weeks; M6 at ±5%. |
| **9.2** | **13-risk register (R1–R13)** accepted with stated mitigations. R2 mitigation reframed as Architect→Editor active grounding-slot-match. R4 expanded with full DevMode security checklist. R9 mitigation upgraded to latency-triggered fallback with explicit timeout budget. **R13 (new): catalog provider partial-degradation requires hard-fail on required providers unless kind explicitly disabled.** |
| **9.3** | Subagent expert consults (research agent for LLM/AI, rubber-duck for backend) completed; findings in Appendix C. **Spec body revised** to absorb all Critical + High findings. |

---

## 1. Problem statement & scope

### 1.1 The bug

F27 P9 shipped Architect + Editor with Azure `json_schema strict: true`. The Editor schema for a scenario looks roughly like:

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "scenarios": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "stimulusSpec":  { "type": "string" },   // ← opaque
          "matcherSpec":   { "type": "string" }    // ← opaque
        }
      }
    }
  }
}
```

Strict mode enforces field presence + type only. The string contents are unconstrained. The LLM fills them with JSON-encoded structures, and the JSON happens to contain hallucinated paths and format-string values. PR 977882 surfaced 4 such scenarios; the linter (LNT001/003/004) caught some after-the-fact, but each is a band-aid.

### 1.2 The proposition

Make every stimulus and every matcher a *typed* structure inside the schema, bound to a per-zone *catalog* assembled from real surfaces (runtime swagger, DI registry, framework registry, AST scans). The LLM cannot reference a slot that doesn't exist in the catalog, cannot type a parameter the slot doesn't declare, cannot assert on a topic field the catalog doesn't expose, and cannot put a format string where a typed value is required. Same constraint applies to humans authoring via the workbench.

### 1.3 In scope

All 6 stimulus kinds, end-to-end:

| Kind | Slot source | Dispatch path |
|---|---|---|
| `HttpRequest` | Runtime FLT swagger | Real HTTP over the wire |
| `DiInvocation` | FLT `IQaDirectInvokeRegistry` seam, filtered by `[EdogDirectInvokeSeam]` opt-in attribute | `POST /devmode/qa/dispatch` (sync) |
| `SignalRBroadcast` | `data/framework-endpoints.json` (existing FLT registry) | `POST /devmode/qa/dispatch` (sync) via `IQaSignalRObserver` seam |
| `DagTrigger` | New DAG scanner over FLT DAG definitions | `POST /devmode/qa/dispatch/async` (returns `202`) + `GET /devmode/qa/dispatch/{id}` poll via `IQaDagRunInvoker` seam |
| `FileEvent` | Scanner over FLT services tagged with `[EdogFileEventSeam]` | `POST /devmode/qa/dispatch` (sync) via `IQaFileEventInjector` seam |
| `TimerTick` | Scanner over FLT services tagged with `[EdogTimerSeam]` | `POST /devmode/qa/dispatch` (sync) via `IQaTimerInjector` seam |

Plus matcher topic.field catalog from Roslyn scan of anonymous-type member names in topic-router code paths.

### 1.4 Out of scope (deferred)

- Cleanup of test-induced state (DAG-run rows, OneLake files). Scenarios with side effects execute "for real"; operator accepts residue. Cleanup design becomes a follow-up ADR.
- TypeSpec migration. 12-month strategic suggestion, separate ADR.
- Typed-record migration for topic routers (current anonymous-type Roslyn scan covers us).
- In-product Contract Health panel UI (Section 7.3 logs only for v1).
- Reasoning-model-CoT visibility (vendor-side).

---

## 2. Catalog shape, pipeline, and hash strategy

### 2.1 Catalog shape

The per-zone catalog is the source of truth for what scenarios can reference. Shape:

```jsonc
{
  "zoneId": "...",
  "catalogVersion": 1,
  "snapshot": {
    "snapshotId":        "sha256(canonical-json-of-this-catalog)",
    "fltBuildSha":       "...",            // from FLT capability endpoint
    "edogRepoSha":       "...",            // git rev-parse HEAD at assemble time
    "schemaCapVersion":  "...",            // version of cap table from §2.4
    "assembledAtUtc":    "2026-05-20T..",
    "providerStatus": {                    // operator-visible degradation per Finding 6
      "HttpSlotProvider":      "ok",
      "DiSlotProvider":        "ok",
      "SignalRSlotProvider":   "ok",
      "DagSlotProvider":       "ok",
      "FileTimerSlotProvider": "ok",
      "TopicFieldProvider":    "ok"
    }
  },
  "perKind": {
    "HttpRequest": {
      "kindHash": "sha256(...)",                       // diagnostic only (§6.1 / §6.4)
      "slots": [
        {
          "slotId": "http.dag.runs.list",
          "slotHash": "sha256(...)",                   // primary stale-check key (§6.4)
          "method": "GET",
          "path": "/api/v1/dag/{dagId}/runs",
          "summary": "List recent runs for a DAG",
          "idempotency": "safe",         // safe | idempotent | destructive
          "mutates": false,
          "leavesState": false,
          "params": {
            "path":  { "dagId": { "type": "string", "required": true } },
            "query": { "limit": { "type": "integer", "required": false, "min": 1, "max": 100 } },
            "body":  null
          },
          "captures": {
            "topic": "http.response.dag.runs",
            "fields": ["status", "items[].runId", "items[].state", "items[].startedAt"]
          },
          "purpose": "List recent DAG runs. Used by UI dashboard."  // from XML doc-comment
        }
        // ...
      ]
    },
    "DiInvocation":     { "kindHash": "...", "slots": [...] },
    "SignalRBroadcast": { "kindHash": "...", "slots": [...] },
    "DagTrigger":       { "kindHash": "...", "slots": [...] },
    "FileEvent":        { "kindHash": "...", "slots": [...] },
    "TimerTick":        { "kindHash": "...", "slots": [...] }
  },
  "matcherTopics": {
    "topicHash": "sha256(...)",
    "topics": {
      "http.response.dag.runs": {
        "topicHash": "sha256(...)",                                       // per-topic granularity (§6.4)
        "fields": { "status": "integer", "items[].runId": "string", "items[].state": "string", "items[].startedAt": "datetime" }
      },
      "signalr.LiveTableHub.rowAdded": {
        "topicHash": "sha256(...)",
        "fields": { "tableId": "string", "rowId": "string", "ts": "datetime" }
      }
      // ...
    }
  }
}
```

**Snapshot semantics (Finding 6):** Providers run with deterministic ordering; outputs are canonicalised before hashing; `providerStatus` reports per-provider outcome. **Required providers** (HTTP, DI, TopicField for any zone that has slots of that kind) MUST be `ok` or the catalog assembler raises `CatalogAssemblyFailedException` — silent partial-degradation is forbidden. Non-required providers may degrade to `empty`/`degraded` with a warning telemetry event. The snapshot object is immutable for the run's duration and is the sole input to schema generation, hash comparison, and dispatch authorization.

### 2.2 Source providers (six)

| Provider | Source | Code location |
|---|---|---|
| `HttpSlotProvider` | `swagger_runtime.fetch_runtime_swagger` (MWC-token-authed `/swagger/v1/swagger.json` from FLT) | `scripts/swagger_runtime.py` (existing) |
| `DiSlotProvider` | FLT `/devmode/di-registry` filtered by `[EdogDirectInvokeSeam]` attribute (cross-repo dependency — see Appendix B) | `EdogQaDiRegistryProvider.cs` (extend) |
| `SignalRSlotProvider` | `data/framework-endpoints.json` (existing hand-curated registry) | `scripts/flt_catalog.py` (extend) |
| `DagSlotProvider` | New Roslyn scan over FLT DAG definitions (`*Dag.cs` files with `[DagDefinition]` attribute) | `EdogQaDagScanner.cs` (new) |
| `FileTimerSlotProvider` | New Roslyn scan over FLT services tagged with `[EdogFileEventSeam]` / `[EdogTimerSeam]` (the spec previously assumed `IFileSystemWatcher`/`ITimerService` DI surfaces — those do not exist; see Finding 4) | `EdogQaFileTimerScanner.cs` (new) |
| `TopicFieldProvider` | Existing OmniSharp/Roslyn scan over anonymous-type expressions in topic-router code paths (extends `EdogQaOmniSharpProvider`) | `EdogQaOmniSharpProvider.cs` (extend) |

All providers run inside the existing `EdogQaContractCatalog` assembler (new file). The assembler is invoked once per zone at orchestrator init time. Errors from any provider yield an *operator-visible* zone-degradation flag rather than a silent fallback.

### 2.3 Catalog hash strategy

Per Section 6.1: each scenario carries a `catalogHashes` object covering the catalogs it references — **at per-slot and per-topic granularity** (per-kind hash retained only as diagnostic):

```jsonc
{
  "stimulusSlotHash":    "sha256(catalog.perKind.HttpRequest.slots[slotId=http.dag.runs.list])",
  "matcherTopicHashes": {                  // only the topics this scenario's matchers reference
    "http.response.dag.runs":       "sha256(...)",
    "signalr.LiveTableHub.rowAdded": "sha256(...)"
  },
  "catalogSnapshotId":   "sha256(...)"     // diagnostic; lets the executor co-relate runs
}
```

**Why per-slot, not per-kind (Finding 8):** if HTTP has 47 slots and one unrelated endpoint changes, a per-kind hash stales all 47 HTTP scenarios in the zone. Per-slot hash stales only scenarios that actually reference the changed slot. Keeps M5 (`< 15 %` stale rate per week) achievable in active zones.

Executor compares against the freshly-assembled catalog at run start (Section 6.5). Any mismatch on the scenario's `stimulusSlotHash` or any of its referenced `matcherTopicHashes` → scenario verdict = `stale` (Section 6.4).

### 2.4 Catalog build-time invariants (Section 3-bis caps)

The assembler **must** assert these limits, and the schema generator **must** re-assert them against the generated schema object after `$defs`/`$ref`/`anyOf` factoring + zone partitioning (Finding 7 — partition restructuring can change property count, depth, and per-enum char count):

- Total object properties ≤ **100** (Azure strict cap = 100)
- Maximum nesting depth ≤ **5** (Azure strict cap = 5)
- Total string-name characters ≤ **14 000** (Azure strict cap = 15 000; we leave 1 000 slack)
- Total enum values across schema ≤ **450** (Azure strict cap = 500; 50 slack)
- Per-single-enum ≤ **7 000 chars** (Azure strict cap = 7 500; 500 slack)
- Per-`anyOf` branch count ≤ **30** (we partition the zone if exceeded)
- **NEW: Per-`topicField` composite enum ≤ 7 000 chars** explicitly checked (Finding 7 — composite values average 30–40 chars and a data-intensive zone can exceed the per-single-enum cap before total-enum cap)
- **NEW: Every `required: false` catalog parameter MUST emit a `["T","null"]` nullable union** in the generated schema, with the property present in `required[]` (Finding 2 — strict mode rejects properties declared-but-not-required). Violation → `CatalogSchemaCapacityException(limitTripped: "OPTIONAL_PARAM_MISSING_NULL_UNION")`.

Violation throws `CatalogSchemaCapacityException(zoneId, limitTripped, observedValue, phase: "assembler"|"generator")`. Orchestrator catches, marks zone `schema-overflow`, logs `catalog.schema.overflow` telemetry, and refuses to author contract scenarios for that zone with an operator-visible error pointing at the specific cap tripped. No silent degradation.

**Strict-mode caveat:** `min`/`max` on catalog parameters (e.g., `limit: min 1 max 100`) cannot be enforced via JSON schema (`minimum`/`maximum` rejected per §3.3). These constraints survive only via (a) `description` text consumed by the LLM and (b) post-emission semantic gates in the Validator. Document this gap in every catalog provider that emits numeric ranges.

---

## 3. Per-zone JSON schema (Editor request)

### 3.1 Shape

For a zone whose catalog has, say, HTTP slots `H1..Hn`, DI slots `D1..Dm`, the Editor schema's scenario shape is:

```jsonc
{
  "type": "object",
  "additionalProperties": false,
  "required": ["plan", "scenarios"],
  "properties": {
    "plan": {
      "type": "string",
      // P1 — substantive description so the model uses the reasoning channel (Finding 3 / CRANE ICML 2025)
      "description": "REQUIRED. Before generating scenarios, reason step by step: (1) Which changed symbols/lines are tested by each stimulus kind? (2) For each slot you will use, confirm its slotId is present in the enum and matches the Architect's recommended slot. (3) Which topic.field combinations are populated by each slot's invocation? (4) Identify any ambiguous slot pairs with identical param shapes and justify your selection. (5) If you intend to diverge from the Architect's recommended slot for any sketch, state that here. Emit this reasoning BEFORE the scenarios array."
    },
    "scenarios": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["scenarioId", "stimulus", "matchers", "catalogHashes"],
        "properties": {
          "scenarioId":     { "type": "string" },
          "stimulus":       { "anyOf": [ {"$ref": "#/$defs/HttpRequest"}, {"$ref": "#/$defs/DiInvocation"}, ... ] },
          "matchers":       { "type": "array", "items": {"$ref": "#/$defs/Matcher"} },
          "catalogHashes":  { "$ref": "#/$defs/CatalogHashes" }
        }
      }
    }
  },
  "$defs": {
    "HttpRequest":  { "type": "object", "required": ["kind","slotId","params"],
                      "properties": { "kind": {"type":"string","enum":["HttpRequest"]},
                                      "slotId": {"type":"string","enum":["http.dag.runs.list", ...]},   // R1 literal-discriminator-first
                                      "params": {"anyOf": [{"$ref":"#/$defs/Params_http_dag_runs_list"}, ...]} } },
    "Params_http_dag_runs_list": {
      // Optional params (catalog `required: false`) MUST emit as nullable union (R8 / Finding 2)
      "type": "object",
      "additionalProperties": false,
      "required": ["dagId", "limit"],                                       // every property present
      "properties": {
        "dagId": { "type": "string" },                                      // catalog required: true
        "limit": { "type": ["integer", "null"] }                            // catalog required: false → nullable union, present in required[]
      }
    },
    "Matcher":      {
      "type": "object",
      "additionalProperties": false,
      "required": ["topicField","assertion","value"],
      "properties": {
        "topicField": {"type":"string","enum":["http.response.dag.runs.status","http.response.dag.runs.items[].runId", ...]},
        "assertion":  {"type":"string","enum":["equals","notEquals","exists","inRange","containsAll","oneOf","length"]},
        "value":      { "anyOf": [
          {"$ref":"#/$defs/Value_string"},
          {"$ref":"#/$defs/Value_integer"},
          {"$ref":"#/$defs/Value_datetime"},
          {"$ref":"#/$defs/Value_range"},
          {"$ref":"#/$defs/Value_array"}
        ] }
      }
    },

    // ── Matcher value typed shapes (Finding 1) ─────────────────────────────────────────────────────
    // Discriminated union with literal `type` first (R1, R7). Covers all 7 assertion types:
    //   equals/notEquals/length/exists → string|integer|datetime
    //   inRange                        → range
    //   containsAll/oneOf              → array
    "Value_string":   { "type": "object", "additionalProperties": false, "required": ["type","scalar"],
                        "properties": { "type": {"type":"string","enum":["string"]},
                                        "scalar": {"type":"string"} } },
    "Value_integer":  { "type": "object", "additionalProperties": false, "required": ["type","scalar"],
                        "properties": { "type": {"type":"string","enum":["integer"]},
                                        "scalar": {"type":"integer"} } },
    "Value_datetime": { "type": "object", "additionalProperties": false, "required": ["type","scalar"],
                        "properties": { "type": {"type":"string","enum":["datetime"]},
                                        "scalar": {"type":"string"} } },
    "Value_range":    { "type": "object", "additionalProperties": false, "required": ["type","min","max"],
                        "properties": { "type": {"type":"string","enum":["range"]},
                                        "min":  {"type":"number"},
                                        "max":  {"type":"number"} } },
    "Value_array":    { "type": "object", "additionalProperties": false, "required": ["type","items"],
                        "properties": { "type": {"type":"string","enum":["array"]},
                                        "items": {"type":"array","items":{"type":"string"}} } }
    // ───────────────────────────────────────────────────────────────────────────────────────────────
  }
}
```

**Cross-field semantic constraints** (strict mode cannot express; Validator post-emission gate enforces — Finding 1):

| assertion | required `value` shape |
|---|---|
| `equals`, `notEquals` | `Value_string` \| `Value_integer` \| `Value_datetime` |
| `exists` | any (`scalar`/`min`/`max`/`items` ignored) |
| `length` | `Value_integer` (scalar = expected length) |
| `inRange` | `Value_range` |
| `containsAll`, `oneOf` | `Value_array` |

`EdogQaScenarioValidator` adds a `MatcherTypeConsistencyGate` that emits `qa.contract.validator.gate_failed { gate: "matcher_type_inconsistent", scenarioId, matcherIndex, expected, actual }` on violation.

### 3.2 Authoring rules (R1–R9 from Section 3-bis)

| Rule | Statement |
|---|---|
| **R1** | Every union uses `anyOf` with a **literal discriminator field first** (e.g., `"kind": {"const": "HttpRequest"}` ranked first in `properties`). FSM prefix coalescence is faster + more accurate than nested anyOf. |
| **R2** | Every bare `const` carries a sibling `type` declaration (empirically required by Azure strict mode despite docs being ambiguous). |
| **R3** | Aggressive `$defs` / `$ref` factoring. No duplicated typed value shapes. |
| **R4** | Topic.field uses **dotted composite enum** (`"http.response.dag.runs.status"`), not nested `topic` + `field` anyOf. **This is a structural requirement, not an optimization** (Finding 6): (a) correlating topic→field choices requires `if/then/else` or `oneOf` — both rejected by strict mode (§3.3); (b) the only valid alternative (discriminated anyOf per topic) would consume the 5th nesting level inside `Matcher` and bust Azure's depth cap. FSM prefix coalescence (sharing the `"http.response.dag.runs."` prefix across sibling fields) means the composite enum traverses hierarchically anyway with no cognitive penalty. |
| **R5** | Partition the zone schema if any `anyOf` exceeds **30 branches**. Partitioning splits the schema into multiple Editor requests, each with a slice of slots; results merged. **Matcher-side partitioning** (when the composite `topicField` enum exceeds the per-enum char cap from §2.4) splits the schema by topic prefix. |
| **R6** | Soft constraints (e.g., "use a realistic value, not a placeholder") encoded in the schema's `description` fields, where the model reads them; *also* repeated in the system-message rule list (R6 = double-encoding). |
| **R7** | Every Matcher `$def` (and every typed value shape) uses a **typed discriminator first** (literal `type` enum at index 0 of `properties`). Allows the FSM to coalesce prefixes across sibling shapes and reduces ambiguous-branch hesitation. |
| **R8** | Optional catalog parameters (`required: false`) MUST emit as `"type": ["T", "null"]` nullable union, MUST be listed in the property object's `required[]` array, and the LLM system message MUST state: "emit `null` for parameters you do not want to send." This is the only strict-mode-compatible way to express optionality (Finding 2). |
| **R9** | Slot `purpose` text (the XML doc-comment) is **NOT** concatenated into the `slotId` enum's `description` (JSON Schema cannot attach `description` per enum value). Instead the catalog assembler emits a per-kind **slot-purpose block** into the Editor's system message (P6) — see §3-bis.1. |

### 3.3 Strict-mode rejected primitives (empirically confirmed)

Do **not** use any of: `oneOf`, `allOf`, `not`, `if`/`then`/`else`, `minItems`, `maxItems`, `uniqueItems`, `minContains`, `maxContains`, `contains`, `pattern`, `format`, `minLength`, `maxLength`, `minimum`, `maximum`, `multipleOf`. Bare `const` without sibling `type` rejected.

Verified by `scripts/smoke_test_strict_schema.py` (chat-completions) and `scripts/smoke_test_strict_schema_pro.py` (responses). Both pass; both are retained as regression tests against future schema changes.

### 3.4 Wire protocol per model

| Model | Endpoint | Format envelope | API version | `temperature` | `reasoning_effort` | Latency budget |
|---|---|---|---|---|---|---|
| `gpt-5.4` (Editor) | `/chat/completions` | `response_format: {type: "json_schema", json_schema: {...}}` | `2025-04-01-preview` | **0.2** (attempt 1) → **0.4** (attempt 2) → **0.6** (attempt 3) — see P5 | n/a | 60 s total |
| `gpt-5.4-pro` (Architect) | `/responses` | `text.format: {type: "json_schema", ...}` (flat, no nested `json_schema`) | `v1` or `preview` | default | **`medium`** | 15 s to first token, 60 s total → latency fallback to `gpt-5.4` (Finding 12 / R9) |

**Latency-triggered fallback (Finding 12):** `EdogQaCapabilityProbe` measures time-to-first-token and total completion time per Architect call. If first-token > 15 s OR total > 60 s, raise `qa.contract.architect.fallback { reason: "latency_timeout", modelTried: "gpt-5.4-pro", latencyMs, phase }` and re-issue the call against `gpt-5.4`. This converts the previously-vague "falls back when slow" into measurable, testable behaviour.

Capability probe (`EdogQaCapabilityProbe.cs:36-255`) selects the right wire shape per role; the existing capability-availability fallback chain `ARCHITECT → PRO → default` runs ahead of the latency fallback.

---

## 3-bis. Strict-mode compensation patterns

The schema constraints in §3 cover *structural* validity. The patterns below close the gap on *semantic* validity that strict mode alone won't enforce.

### 3-bis.1 Prompt-layer patterns (P1–P7)

| Pattern | Implementation |
|---|---|
| **P1 — Early `plan` field with rich description** | Editor schema declares `plan: string` as the **first** property of the root with the multi-step instruction string shown in §3.1. CRANE (Banerjee et al., ICML 2025, arXiv:2502.09061) shows constrained-decoding grammar must contain explicit reasoning production rules or the model defaults to direct-answer mode. Tam et al. (NeurIPS 2024, arXiv:2408.02442) measure ~10 % accuracy loss when JSON-mode collapses CoT. The rich description is the single highest-leverage change available within strict mode. |
| **P2 — Double-encoded soft constraints** | Each soft rule (e.g., "use realistic identifiers, not `id-1`", "emit `null` for unused optional params per R8", "matcher array ≤ 6") appears both in the schema's `description` field *and* in the system message's rule list. Models attend to both surfaces. |
| **P3 — Informative retries** | On strict-schema violation or post-emission semantic-gate failure, the repair-loop user message includes the specific JSON-pointer path + violation reason: `"Rule violated at $.scenarios[2].stimulus.slotId — value 'foo' is not in the enum [...]. Re-emit only the affected scenarios using PartialRepairSchema (§4.6)."`. Not a blind "try again." Attempt 3 escalates per P3-bis below. |
| **P3-bis — Attempt-3 escalation** | If the first two informative retries fail on the same constraint, attempt 3 switches strategy (Finding 14): isolate the failing scenario to a single-scenario sub-call, present the failing constraint + the Architect's plan excerpt for that scenario only, ask the model to emit exactly that one corrected scenario. Decouples constrained slot choice from full-batch generation (CRANE-style "unconstrained reasoning → constrained output"). Costs one extra LLM call but recovers scenarios that would otherwise be quarantined. |
| **P4 — JSON-mode prelude** | System message contains the literal word "JSON" (Azure requirement when `response_format.type=json_schema`). Plus an explicit phrase: *"Emit only JSON conforming to the provided schema. Do not include explanatory prose."* |
| **P5 — Temperature anneal** | Editor calls run at `temperature=0.2` on attempt 1 (concentrates probability mass on the most likely valid enum value — well-known best practice for constrained slot selection). On repair-loop retry attempts the temperature escalates `0.2 → 0.4 → 0.6` to encourage diversity when the model has already failed at low temperature. Reversible if telemetry shows reduced diversity is unacceptable. |
| **P6 — Slot-purpose system-message block** | Per-kind purpose text injected into the Editor system message (Finding 13 — JSON Schema cannot attach `description` per enum value): *"The following HttpRequest slots are available. Use these purpose descriptions to choose semantically correct slots:\n- `http.dag.runs.list`: Lists recent runs for a DAG. Use when verifying run creation/status.\n- `http.tables.list`: Lists all tables. Use when verifying schema/table existence.\n..."* Catalog assembler builds this block from each slot's `purpose` field. ~30-40 tokens per slot; well within budget. |
| **P7 — Locked few-shot exemplar** | System message includes one canonical exemplar scenario built by the catalog assembler from the zone's "simplest idempotent slot" (first slot where `idempotency=safe` and `mutates=false`). Format: complete `{plan, scenarios:[{scenarioId, stimulus, matchers, catalogHashes}]}` object. Costs ~300–500 tokens per Editor call but reduces M2 (schema-reject rate) and M3 (repair-loop persistent failure) by demonstrating slot ID format, params structure, matcher shape, and hash field placement. Documented as optional; can be disabled via `qa.contract.fewShot.enabled` if token cost dominates. |

### 3-bis.2 Build-time guards

As §2.4. Catalog assembler enforces 6 numeric caps before emitting the schema.

### 3-bis.3 Three honest residuals (Section 9.2 R1/R2/R3)

The schema layer cannot catch:

1. **Cross-field semantic mismatch** (R1): scenario picks a GET slot but matcher asserts on a row mutation. Mitigated by `mutates: bool` flag on each slot, enforced post-projection by the Validator's existing topic-consistency gate.
2. **Reasoning-model self-argument** (R2): model "convinces itself" inside hidden CoT to emit a structurally-valid but contextually-wrong slot. **Primary mitigation: the Architect→Editor handoff** (Finding 10). The Architect's plan carries a recommended `slotId` per scenario sketch with grounding evidence. The Validator's grounding gate now performs an **active slot-match check**: for each emitted scenario, compare `stimulus.slotId` against the corresponding sketch's recommended slot. If they differ AND the Editor's `plan` field does not explicitly justify the divergence (substring match on "diverging from Architect" or "different slot than recommended"), emit `qa.contract.validator.gate_failed { gate: "grounding_slot_mismatch" }` and soft-reject the scenario into the repair loop. Secondary mitigation: low-confidence emissions still logged for audit.
3. **Structurally-identical slots, different semantics** (R3): two HTTP endpoints with identical typed shapes but different roles. Mitigated by P6 (slot-purpose system-message block) and by surfacing each slot's `purpose` text in the slot-picker UI rich label. The grounding-slot-match check from R2 above also catches a substantial subset of R3 failures.

---

## 4. Generation pipeline

The pipeline below is **mostly already shipped** under F27 P9. This section documents the *deltas* the contract introduces.

### 4.1 Pipeline diagram

```
EdogQaCodeAnalyzer  →  ImpactZones
       │
       ▼
EdogQaContractCatalog.BuildAsync(zone, devModeAuth)
       │   (per-zone, all 6 source providers, asserts §2.4 caps)
       ▼
EdogQaScenarioOrchestrator   ← per-zone driver, budget gating
       │
       ├──→ Architect (gpt-5.4-pro)  : plan + scenarioSketches
       │
       ├──→ Editor    (gpt-5.4)      : strict json_schema (§3) → typed scenarios
       │       │
       │       ├ on strict-mode reject → T1e repair loop with P3 informative retries
       │       ↓
       ├──→ Projector              : trivial (schema is typed); preserves audit fields
       │
       ├──→ Validator              : 5 gates (grounding / schema-constraint / topic / confidence / dedup)
       │                             — some unreachable post-tightening but retained as DiD
       ↓
   Persistent scenario  ← carries { catalogHashes, plan, audit trail }
```

### 4.2 Scenarios-per-zone budget formula

```
reachabilityBonus = min(2, floor(reachableSlotCount / 8))           // Finding 4
coveragePenalty   = count(scenarios already exercising a slot in this zone)
effectiveReach    = max(0, reachableSlotCount - coveragePenalty)
reachabilityTerm  = min(2, floor(effectiveReach / 8))

scenariosPerZone  = clamp(
    3
  + floor(linesChanged / 40)
  + floor(symbolsTouched / 3)
  + reachabilityTerm                                                // capped contribution
  + depthBonus,
  MIN=3, MAX=10
)
```

Where:
- `linesChanged` = diff lines in the zone
- `symbolsTouched` = distinct API/DI/topic symbols modified
- `reachableSlotCount` = total slots across all 6 kinds in this zone's catalog
- `coveragePenalty` = slots already exercised by an existing non-stale scenario (the Orchestrator knows the current scenario inventory at planning time)
- `reachabilityTerm` = capped at +2 so it cannot swamp the diff-proportionality terms (a 5-line edit and a 2000-line change must produce different scenario counts)
- `depthBonus` = `2` if the zone touches multiple stimulus kinds, else `0`

**Why the cap (Finding 4):** the prior formula used raw `reachableSlotCount` which immediately saturated the `clamp(…, 3, 10)` ceiling for any zone with >7 slots — making `linesChanged` and `symbolsTouched` computationally irrelevant for any non-trivial zone. The capped term restores diff-proportionality.

Budget gate at the orchestrator: `min(formulaResult, tokenBudget × 0.9 ÷ avgTokensPerScenario)`.

### 4.3 Architect / Editor handoff

- **Architect** receives: PR diff slice for this zone, the assembled catalog (read-only summary form), and prior-test excerpts. Emits `ArchitectPlan { behavioralChanges[], scenarioSketches[], grounding[] }` per existing `BuildArchitectPlanSchema:426`.
- **Editor** receives: Architect plan + the *full* per-zone schema from §3 + the catalog (typed form). Emits typed scenarios. Existing `BuildScenarioBatchSchema:553` is the target of the Δ — its `stimulusSpec`/`matcherSpec` opaque-string fields are replaced with the typed `stimulus` and `matchers` of §3.

### 4.4 Projector simplification

`EdogQaScenarioProjector` currently parses opaque JSON-string specs into typed `Scenario` records. Under the contract the Editor output is *already* typed, so projection becomes a straight copy with audit-field preservation. Net reduction: ~150 LOC.

### 4.5 Validator gate retention

All 5 gates remain active even though some become unreachable. **One new gate** added to absorb Finding 1 and Finding 10:

| Gate | Disposition under contract |
|---|---|
| Grounding | Active. Verifies cited evidence in Architect plan is real. **NEW sub-check**: active `slot-match` — `stimulus.slotId` must match the Architect sketch's recommended slot OR the Editor's `plan` field must explicitly justify the divergence (R2 active mitigation per §3-bis.3). |
| Schema-constraint | Mostly unreachable (schema already enforces); retained as audit assertion. |
| Topic | Active; verifies matcher topic.field is consistent with slot capture topic (covers Section 9.2 R1). |
| **Matcher-type consistency (new)** | Active; enforces the assertion ↔ `value` shape mapping in §3.1 (strict mode cannot express conditional constraints; Finding 1). |
| Confidence | Active; low-confidence emissions logged for telemetry (covers Section 9.2 R2 secondary mitigation). |
| Dedup | Active; cross-scenario duplicate detection. |

Sentinel mandate: do **not** delete unreachable gates. Telemetry signal of "lint never fires" is more valuable than the LOC savings.

### 4.6 Repair loop (T1e)

Existing loop in `EdogQaScenarioOrchestrator.cs:57-260`. **Partial-repair contract (Finding 5):** attempts 1 and 2 use a dedicated `PartialRepairSchema` that emits only the corrected scenarios alongside their original indices, eliminating the ambiguity over whether the model re-emits all N scenarios or just the failures.

**PartialRepairSchema** (used for repair-loop retries; structurally distinct from the full Editor schema):

```jsonc
{
  "type": "object",
  "additionalProperties": false,
  "required": ["plan", "correctedScenarios"],
  "properties": {
    "plan": { "type": "string",
              "description": "REQUIRED. Reason about WHY each prior emission failed before re-emitting." },
    "correctedScenarios": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["originalIndex", "scenario"],
        "properties": {
          "originalIndex": { "type": "integer" },
          "scenario":      { "$ref": "#/$defs/Scenario" }            // same Scenario $def as full Editor schema
        }
      }
    }
  }
}
```

Orchestrator splices: `original[originalIndex] = correctedScenario` for each entry. Splice logic + unit-test fixture (5-scenario batch, scenario[3] fails, repair returns `[{originalIndex:3, scenario:...}]`, assert merged 5-scenario result with scenarioId stability) is a Sentinel-required test.

**Attempt-3 escalation (Finding 14 / P3-bis):** on the third attempt — if attempts 1 and 2 both failed — the orchestrator switches to **single-scenario isolation mode**. For each persistent-failure index, issue a fresh LLM call carrying:
- the failed scenario's Architect plan excerpt only,
- the violating JSON-pointer + reason,
- the list of valid enum values,
- a `SingleScenarioSchema` (one scenario, no array).

This decouples the constrained slot choice from full-batch generation and recovers scenarios that would otherwise be quarantined.

Pattern-3 informative-retry message format (attempts 1 + 2):

```
ARCHITECT plan ID: {planId}
The following scenarios emitted in attempt {n} were rejected:
  - $.scenarios[2].stimulus.slotId: value "foo" is not in the enum [http.dag.runs.list, http.tables.list, …]
  - $.scenarios[5].matchers[1].topicField: value "http.response.dag.runs.invalid_field" is not in the enum [...]
  - $.scenarios[7].matchers[0]: assertion=inRange requires value.type="range" but received value.type="string" (matcher-type-consistency gate)

Re-emit ONLY corrections, using PartialRepairSchema. Set originalIndex to the source position.
Keep scenarioId values stable.
```

Max retries: 3 (attempts 1+2 = informative retries, attempt 3 = single-scenario isolation). After exhaustion, scenarios remain quarantined with reason `SCHEMA_REJECT_PERSISTENT` and counter ticks (per §7.3).

---

## 5. Workbench UI

### 5.1 Three-column layout

```
┌───────────────────────────────────────────────────────────────────────────────┐
│  Catalog-health strip   (counts per kind, fetch status, kindHashes)           │
├──────────────┬───────────────────────────┬────────────────────────────────────┤
│              │                           │                                    │
│ Scenario     │   Stimulus builder        │   Matcher builder (flat array)     │
│   list       │                           │                                    │
│ (selection,  │   • Zone + kind selector  │   • + Add matcher                   │
│  badges,     │   • Slot picker (5.5)     │   ┌────────────────────────────┐   │
│  search)     │   • Typed param form      │   │ Matcher #1                 │   │
│              │     rendered from slot    │   │  topic.field ▼             │   │
│              │     schema                │   │  assertion ▼ (7 options)   │   │
│              │   • Idempotency dot       │   │  value (typed input)       │   │
│              │                           │   └────────────────────────────┘   │
│              │                           │   ┌────────────────────────────┐   │
│              │                           │   │ Matcher #2 ...             │   │
│              │                           │   └────────────────────────────┘   │
├──────────────┴───────────────────────────┴────────────────────────────────────┤
│  Issues strip   (collapsible, count badge, click-to-jump)                     │
├───────────────────────────────────────────────────────────────────────────────┤
│  Last run strip (collapsible)                                                 │
│     • Captured values per topic                                               │
│     • Matcher result per matcher (expected vs. actual)                        │
│     • Re-run scenario button                                                  │
└───────────────────────────────────────────────────────────────────────────────┘
```

### 5.2 Slot-picker (Section 5.5)

Type-ahead combo. Each entry renders three lines:

```
http.dag.runs.list                          GET
/api/v1/dag/{dagId}/runs                    🟢 idempotent
List recent runs for a DAG                  5 captured fields
```

Searches across `slotId`, path/signature, summary, capture-field names, idempotency. Filter chips above the input when the zone supports multiple stimulus kinds.

Idempotency dot colors:
- 🟢 safe (no state change, no side effects)
- 🟡 idempotent (state change but repeatable)
- 🔴 destructive (state change, non-repeatable, ordering matters)

### 5.3 Matcher composer (Section 5.2 vocabulary)

7 assertion types. Right-column UI per assertion:

| Assertion | Right-column input control |
|---|---|
| `equals` / `notEquals` | Typed input matching the topic.field's declared type (string textbox, number input, datetime picker, etc.) |
| `exists` | No value control (boolean assertion only) |
| `inRange` | Two typed inputs: `min`, `max` |
| `containsAll` | Multi-add list of typed values |
| `oneOf` | Multi-add list of typed values (max 10 items per schema cap) |
| `length` | Op picker (`==` / `<` / `>` / `<=` / `>=`) + integer input |

### 5.4 Schema-violation feedback (Section 5.4)

Three layers, orthogonal:

1. **Inline markers** — red border + tooltip on the offending field (live as the user types).
2. **Issues strip** — collapsible "Issues (N)" header below matcher list; lists every violation with click-to-jump; doubles as the "what blocks save" indicator. Hidden when N=0.
3. **Toasts** — only for transient orchestrator events: "Repair loop succeeded, 2 scenarios fixed", "Repair exhausted, scenario quarantined", "Save complete". Never for persistent state.

### 5.5 Inline last-run results (Section 5.6)

Per scenario card in the left column, a `last-run` badge: `✓ / ✕ / — / stale`. Click to expand a "Last run" strip in the body of the workbench (sibling to the Issues strip).

Strip contents:
- Captured values per topic (JSON tree, collapsed by default per topic)
- Per matcher: expected (left) vs. actual (right), with diff highlighting on mismatch
- "Re-run this scenario" button
- For `stale`: large "Regenerate this scenario" button (per Section 6.4 mandate)

### 5.6 Workbench replaces existing in place (Section 5.7)

The existing F27 P9 Curator Workbench code is rewritten in place to host the three-column contract layout. Opaque-JSON authoring is removed entirely. No mode toggle. No legacy tab.

Pre-contract scenarios are quarantined on rollout (Section 6.3) and shown only via a "Show legacy quarantine (N)" filter chip, which lists them as read-only with a "Regenerate" action.

Sentinel non-negotiable: **if any PR introduces a code path that lets a user author or save a scenario with opaque `stimulusSpec` / `matcherSpec` JSON, that PR is blocked.**

---

## 6. Execution & catalog-hash verification

### 6.1 Per-slot stimulus + per-matcher-topic hashes

Each scenario carries (Section 6.1, Finding 8):

```jsonc
"catalogHashes": {
  "stimulusSlotHash": "sha256(...)",     // covers ONLY the specific slot referenced by stimulus.slotId
  "matcherTopicHashes": {                // one per topic actually referenced by this scenario's matchers
    "http.response.dag.runs":              "sha256(...)",
    "signalr.LiveTableHub.rowAdded":       "sha256(...)"
  },
  "catalogSnapshotId": "sha256(...)"     // diagnostic; ties to §2.1 snapshot envelope
}
```

Executor compares each value against the live catalog at run-start. Any single mismatch → verdict `stale`, soft reject, scenario not dispatched. **Per-slot granularity means unrelated sibling-slot changes do not stale this scenario** — keeping M5 (`< 15 %` stale/week) achievable in active zones.

The catalog `kindHash` (still present in the catalog envelope) is retained for diagnostics and dashboard summaries — not for staleness checks.

### 6.2 Dispatch endpoints (Section 6.2)

**Two endpoints** (Finding 5 — synchronous-only 5-min HTTP is operationally risky; only DAG needs the long wait, so DAG goes async while every other kind stays simple):

| Endpoint | Method | Purpose |
|---|---|---|
| `POST /devmode/qa/dispatch` | sync | HTTP/DI/SignalR/FileEvent/TimerTick — all ≤30 s. Returns when stimulus completes. |
| `POST /devmode/qa/dispatch/async` | async | DagTrigger only. Returns `202 {dispatchId}` immediately; EDOG polls. |
| `GET /devmode/qa/dispatch/{dispatchId}` | poll | DAG-run status. EDOG client polls every 5 s for up to 5 min, propagates user cancellation. |
| `GET /devmode/qa/capabilities` | meta | `{contractVersion, supportedKinds[], fltBuildSha, schemaCapVersion}` — used by EDOG for version-skew detection (§8.4 / Finding 12). |

**Security model (Finding 3 / R4 — every dispatch endpoint enforces ALL of):**

1. **Compile-time gating.** Controllers live in a `#if DEVMODE` block; the assembly compiled into Release builds does not contain the type. Registration follows ADR-005 (late DevMode registration via `EdogDevModeRegistrar`), NOT via `WorkloadEndpointSetup.AddAllControllersFromAssembly` — so Release-build auto-discovery cannot expose the route accidentally (cross-references Finding 11 / §8.3 G7).
2. **`X-EDOG-Control-Token` header required.** Same pattern as existing FLT control routes (`EdogLogServer.cs:418-520`). Token is a per-EDOG-session secret regenerated on EDOG startup; absence or mismatch → `401 Unauthorized` (no body, no helpful error text — security event logged).
3. **Localhost-only bind.** Kestrel listens for these routes only on `127.0.0.1` / `::1`. Remote requests are rejected at the bind layer, not the controller — defense in depth.
4. **Per-kind + per-slot allowlist.** Each request's `{kind, slotId}` pair is verified against the catalog snapshot the dispatch session was opened with. No reflection-by-string fallback. Slots not present in the catalog → `403 Forbidden` with `errorCode: "SLOT_NOT_IN_CATALOG"`.
5. **Per-kind concurrency caps.** Global semaphore per kind: `DI=8`, `DAG=2`, `SignalR=4`, `FileEvent=4`, `TimerTick=4`. Exceeded → `429 Too Many Requests`. Prevents one runaway QA run from starving the host.
6. **Request body size cap.** 64 KB. Larger bodies → `413 Payload Too Large`.
7. **Per-kind parameter validators.** Strongly-typed `params` deserialised against the catalog slot schema; type/range/required violations → `400 Bad Request` with `errorCode: "INVALID_PARAMS"`.
8. **Audit log with redaction.** Every dispatch logs `{dispatchId, kind, slotId, callerSessionId, durationMs, verdict}`. **Raw `params`, response body, captures, and matcher values are NEVER logged.** Sensitive identifiers (path params, query params, request headers) are hashed before logging.

**Request body** (discriminated union, sync endpoint):

```jsonc
{
  "stimulusKind": "DiInvocation" | "SignalRBroadcast" | "FileEvent" | "TimerTick",
  "slotId":       "...",
  "params":       { ...typed per slot... },
  "timeoutMs":    30000,                       // optional override; defaults from catalog
  "correlationId": "edog-run-{guid}/scenario-{scenarioId}/attempt-{n}"   // for observer disambiguation
}
```

**Sync response body:**

```jsonc
{
  "verdict":   "completed" | "timeout" | "error",
  "captures": {
    "topics": [
      { "topic": "http.response.dag.runs", "fields": { ... } }
    ]
  },
  "errorCode":   "INVALID_SLOT" | "DI_RESOLUTION_FAILED" | "TIMEOUT" | "FORBIDDEN" | "INVALID_PARAMS",
  "errorDetail": "...(truncated to 512 chars, no PII)..."
}
```

**Async DAG flow:**

```
EDOG  ──POST /devmode/qa/dispatch/async─►  FLT   (body: {kind:"DagTrigger", slotId, params, correlationId})
EDOG  ◄──202 {dispatchId, etag}──────────  FLT
EDOG  ──GET  /devmode/qa/dispatch/{dispatchId}──►  FLT   (poll every 5 s)
EDOG  ◄──200 {verdict:"running"}──────────  FLT
…
EDOG  ◄──200 {verdict:"completed", captures, errorCode?, errorDetail?}──  FLT
```

EDOG owns the 5-min budget client-side and threads a `CancellationToken` so user-initiated cancellation (e.g., user closes the workbench tab) propagates to a `DELETE /devmode/qa/dispatch/{dispatchId}` that cancels the underlying DAG run via `IQaDagRunInvoker.CancelAsync`.

**Per-kind behaviour table** (every row also threads the security model above):

| Kind | Endpoint | FLT-side seam | Synchronisation contract | Default timeout |
|---|---|---|---|---|
| `DiInvocation` | sync | `IQaDirectInvokeRegistry` (filtered by `[EdogDirectInvokeSeam]`) | Resolve via `IServiceProvider`, invoke target method, capture return value + side-effect log. Linked CT for cancellation. | 30 s |
| `SignalRBroadcast` | sync | **`IQaSignalRObserver`** (new FLT seam — Finding 4) wraps `HubLifetimeManager<T>` with an observer registration API. Dispatcher pre-registers observer with `correlationId`, fires via `IHubContext<T>`, harvests recorded payload from observer's in-process ring buffer, **disposes observer in `finally`**. | Returns when the observer has recorded what was broadcast (synchronous from the dispatcher's viewpoint). | 5 s |
| `DagTrigger` | **async** | **`IQaDagRunInvoker`** (new FLT seam — Finding 2) exposes `TriggerAsync(slotId, params, ct) → dispatchId` and `GetStatusAsync(dispatchId, ct) → {state, captures?}`. Underlying impl wraps the existing `LiveTableSchedulerRunController.RunDagAsync` reliable-operation queue and reads run-status via the existing scheduler status store. | EDOG polls; terminal states `Completed`/`Failed`/`Cancelled`. | 5 min (EDOG-side) |
| `FileEvent` | sync | **`IQaFileEventInjector`** (new FLT seam — Finding 4) — registered alongside the existing `IFileSystemFactory` DevMode wrapper; injects a synthetic event into the in-process event channel without touching the real file system. | Returns when the handler completes. | 30 s |
| `TimerTick` | sync | **`IQaTimerInjector`** (new FLT seam — Finding 4) — injects a synthetic tick into the timer topic the existing `TimerTickStimulusHandler` already subscribes to. | Returns when the handler completes. | 10 s |
| `HttpRequest` | — | **Not handled by these endpoints.** Executor sends real HTTP over the wire (auth via existing MWC token flow). | n/a | n/a |

**Observer disposal invariant:** every dispatch path wraps observer/seam registration in `try { register; invoke; harvest; } finally { dispose; }`. Correlation IDs are MANDATORY on every observer registration so concurrent dispatches in the same kind cannot cross-contaminate captures. Sentinel test: 4 concurrent SignalR dispatches must produce 4 distinct capture payloads with no cross-pollution.

### 6.3 Sync semantics, async-DAG semantics, cleanup (Section 6.2-bis)

Test-induced state (DAG-run rows, OneLake files, mutated DB rows) is **not** cleaned up. Operators accept residue. Cleanup mechanism is a deliberate follow-up ADR — its design needs more thought than this spec can absorb.

**Sync endpoint** (`POST /devmode/qa/dispatch`): does not return until the stimulus has finished executing, capped by per-kind timeout (max 30 s). On timeout the verdict is `inconclusive` (distinct from pass / fail / stale). The linked cancellation token is threaded into the underlying invoker so a client disconnect cancels the in-flight work.

**Async DAG flow** (`POST /devmode/qa/dispatch/async` + `GET /devmode/qa/dispatch/{id}`): the trigger endpoint queues the DAG run + registers a status observer keyed by `dispatchId`, then returns `202` immediately. The poll endpoint reads observer state. EDOG owns the 5-min wait; `DELETE /devmode/qa/dispatch/{id}` cancels via `IQaDagRunInvoker.CancelAsync`. Stale dispatch records are GC'd by FLT after 10 min idle.

Every dispatch path threads:
- A linked `CancellationToken` (caller → FLT controller → invoker → underlying operation)
- A unique `correlationId` per dispatch (used to disambiguate concurrent observers)
- `finally`-scoped observer/seam disposal

### 6.4 Stale verdict on hash mismatch (Section 6.4)

When the executor sees a hash mismatch (the scenario's `stimulusSlotHash` differs from the live slot's hash OR any of its `matcherTopicHashes` entries differs from the live topic hash):

- Scenario status → `stale`
- Verdict for this run → `stale` (not `failed`)
- Workbench shows the stale badge + "Regenerate this scenario" inline button
- "Regenerate" calls the orchestrator with a single-scenario scope, re-prompts the LLM with the current catalog, overwrites the scenario in place

Stale is recoverable. Stale is not a failure. The dashboard reports `N stale, N pass, N fail, N inconclusive` as distinct counters.

### 6.5 Pre-contract migration (Section 6.3)

On contract feature deploy, a one-time migration runs against the **actual scenario persistence layer**. Per Appendix A correction (Finding 13), `EdogQaRunStore` persists run-history JSON; scenarios themselves live in a separate store (`EdogQaScenarioStore` — already exists under F27 P9). The migration:

```
foreach scenario in EdogQaScenarioStore:
  if scenario.schemaVersion < "p10":
    scenario.status = "pre-contract-quarantined"
    persist
```

The workbench hides quarantined scenarios behind a filter chip. They show as read-only with a "Regenerate" action that re-prompts the LLM under the new contract.

No auto-projection. Migrated scenarios *must* be regenerated to enter the contract regime. This preserves Sentinel's invariant: "every scenario in the DB was authored under the contract."

### 6.6 Per-run fresh catalog (Section 6.5)

At run start (single scenario or batch):
1. Executor calls `EdogQaContractCatalog.BuildAsync(zone, devModeAuth)` for each unique zone in the run — returns a `CatalogSnapshot` envelope (§2.1).
2. Computes per-slot + per-topic hashes against the snapshot.
3. Compares against each scenario's `catalogHashes`.
4. Dispatches non-stale scenarios; marks stale ones.
5. Snapshot is held immutable for the run's duration; discarded on completion.
6. **Provider degradation**: if any required provider reports `failed` for a kind that the run needs, the run is refused with an operator-visible error pointing at the failing provider (Finding 6).

UI surfaces "Loading catalog…" → "Catalog ready: HTTP 47 slots, DI 12 slots, …" before run begins, and shows the snapshot's `fltBuildSha` + provider-status pill row in the catalog-health strip.

---

## 7. Linter disposition

### 7.1 LNT011 (new) — `format-string-literal`

**Severity:** Error (blocks the run).

**Detection:** Any matcher whose `value` field is a string containing one of:
- Date/time format tokens (`yyyy`, `MM`, `dd`, `HH`, `mm`, `ss`, `fff`, `K`, `zzz`)
- Numeric format specifiers (`{0:X8}`, `{0:N2}`, `{0:C}`, etc.)
- Regex metacharacters in suspicious clusters (`^[A-Z]+$`, `\d+`, `(.*)`, `?:`, `[abc]`, etc.)
- Common pattern literals (`*.parquet`, `**/*.csv`, etc.)

Under the contract this rule should fire essentially never. If it fires, the strict-mode + typed-matcher invariant has been bypassed somehow (LLM bug, projection regression, manual DB edit). Block the run, surface loudly.

### 7.2 Legacy rules retained at Error (defense-in-depth)

| Rule | Disposition |
|---|---|
| **LNT001** (hallucinated path) | Retained at Error. Should never fire under contract — slot-picker UI + typed schema make wrong paths impossible. Telemetry signal: zero fires = success. |
| **LNT003** (schema drift) | Retained at Error. Should never fire — typed matcher schema bound to slot's capture topic. |
| **LNT004** (undefined topic field) | Retained at Error. Should never fire — composite `topic.field` enum is the only source. |

Sentinel rationale: deletion of a working safety net to prove "it's not needed" is exactly the wrong move. The rules cost essentially nothing at runtime; the *telemetry that they never fire* is more valuable than the LOC savings.

### 7.3 Contract-health telemetry (logs only, no UI panel in v1)

Logger emits structured events on these triggers (all routed through `EdogQaTelemetry`):

| Event | Fields |
|---|---|
| `qa.contract.schema.reject` | `{ zoneId, attempt, role: "architect"|"editor", reasonCode, jsonPointer }` |
| `qa.contract.schema.reject_persistent` | `{ zoneId, scenarioId, attemptsExhausted: 3 }` |
| `qa.contract.repair.success` | `{ zoneId, attemptsTaken }` |
| `qa.contract.repair.escalation_attempt3` | `{ zoneId, scenarioId, jsonPointer, reasonCode }` |
| `qa.contract.lnt.fired` | `{ ruleId: "LNT001"|"LNT003"|"LNT004"|"LNT011", zoneId, scenarioId, detailHash }` |
| `qa.contract.hash.mismatch` | `{ zoneId, scenarioId, mismatchKind: "stimulusSlot"|"matcherTopic", expectedHash, actualHash }` |
| `qa.contract.dispatch.timeout` | `{ zoneId, scenarioId, stimulusKind, slotIdHash, timeoutMs }` |
| `qa.contract.dispatch.security_reject` | `{ reason: "token_missing"|"token_mismatch"|"slot_not_in_catalog"|"concurrency_cap"|"size_cap", callerSessionHash }` |
| `qa.contract.dispatch.concurrent_cap` | `{ kind, currentCount, cap }` |
| `qa.contract.catalog.overflow` | `{ zoneId, limitTripped, observedValue, phase: "assembler"|"generator" }` |
| `qa.contract.catalog.provider_degraded` | `{ zoneId, providerId, status: "degraded"|"empty"|"failed", reasonCode }` |
| `qa.contract.validator.gate_failed` | `{ zoneId, scenarioId, gate, reason }` |
| `qa.contract.architect.fallback` | `{ reason: "latency_timeout"|"unavailable", modelTried, latencyMs, phase }` |
| `qa.contract.schema.token_estimate` | `{ zoneId, schemaTokenEstimate, role: "editor"|"architect" }` |
| `qa.contract.scenario.outcome` | `{ zoneId, scenarioId, outcome: "pass"|"fail"|"stale"|"inconclusive"|"quarantined" }` |
| `qa.contract.feature_flag.snapshot` | `{ revision, enabled, disabledKinds, source: "config_reload"|"startup" }` |

**Redaction & sanitization rules (Finding 9 — mandatory across all events above):**

1. **NEVER log raw `params`**, request body, response headers, matcher `value` fields, LLM `plan` output, captured topic field values, or PR diff slices.
2. **Hash before logging** any of: full slot IDs (`slotIdHash = sha256(slotId)[:16]`), session identifiers (`callerSessionHash`), large LLM error detail blobs (`detailHash = sha256(detail)[:16]` plus log a reason-code that maps to an internal lookup table).
3. **Truncate `reason` / `errorDetail` to 512 characters.** Long messages → reason codes from a closed set (`SCHEMA_ENUM_MISMATCH`, `OPTIONAL_PARAM_MISSING_NULL_UNION`, etc.).
4. **Include for correlation**: `runId`, `dispatchId`, `catalogSnapshotId`, kind, sanitized-slot identifier (hash), and feature-flag `revision`.
5. **Sampling**: outcome events sampled at 100 % for `fail`/`stale`/`inconclusive`/`quarantined`, sampled at 10 % for `pass` once daily volume > 10 000. No sampling on `*.schema.reject*`, `*.security_reject`, `*.catalog.overflow`, `*.provider_degraded`, or `*.gate_failed`.
6. **High-cardinality safeguard**: `scenarioId` + `zoneId` may appear, but full paths/identifiers do not — the existing P9 telemetry envelope already enforces this for scenarioId; the new events MUST follow the same pattern.

An in-product Contract Health panel is deferred to a follow-up. Logs are the v1 surface; ops aggregates dashboards externally if desired.

---

## 8. Migration & sequencing

### 8.1 Rollout = big-bang (Section 8.1)

All 6 stimulus kinds ship and enable simultaneously. One PR train, one go-live event.

**Justification:** Per Hemant's directive ("at your best and precise"), the entire feature surface drops in one drop. Per-kind rollout adds operational complexity ("DI works but DAG doesn't yet — why?") that the per-kind emergency disable (8.2) addresses more cleanly *as a rollback mechanism* than as a staged-rollout mechanism.

### 8.2 Rollback = kill switch + per-kind emergency disable (Section 8.2)

**Configuration keys (`config/edog-config.json`):**

```jsonc
{
  "qa": {
    "contract": {
      "enabled": true,                          // single kill switch; default true
      "disabledKinds": [],                      // per-kind emergency override; default empty
      "fewShot": { "enabled": true },           // P7 — disable if token cost dominates
      "controlToken": "...session-secret..."    // §6.2 security
    }
  }
}
```

**Flag delivery — `IQaContractOptionsProvider` (Finding 10 / R-revision):**

The existing `EdogQaFeatureFlags` reads env vars once via `Lazy<T>` (no live reload). For P10 we introduce a new `IQaContractOptionsProvider` interface that:

1. **Atomic immutable snapshot.** Each config read produces a value-type `QaContractOptions { revision: long; enabled: bool; disabledKinds: ImmutableHashSet<string>; ... }`. Revisions monotonically increase.
2. **Snapshot capture at run start.** Every scenario generation, dispatch session, and run captures one revision at start and uses that snapshot for its full lifecycle. Mid-run config flips do NOT mutate in-flight catalog/schema/UI/executor state.
3. **Config-reload notification.** `IOptionsMonitor<QaContractOptions>` is wired to the FileSystemWatcher on `config/edog-config.json`. A flip applies to *new* runs within ~5 seconds (typical FS watcher latency) — not to in-flight runs.
4. **Mid-run disable behavior.** Flipping `disabledKinds` adds the kind to a "blocked for new scenarios" set. In-flight dispatches of that kind continue to terminal state; new scenario authoring of that kind is refused with operator-visible error; existing scenarios of that kind are marked `stale` only on the next run (not mid-run).
5. **Sentinel test.** `qa.contract.feature_flag.snapshot` telemetry event fires at each run-start with the captured revision; integration test asserts that two concurrent runs straddling a flag flip see consistent-per-run (but possibly distinct-across-runs) revisions.

**Effects:**

| State | Behaviour |
|---|---|
| `enabled: false` | Contract scenarios are unreadable in workbench, executor refuses to run, generation paused. Banner: "QA temporarily disabled." Total feature blackout. |
| `enabled: true, disabledKinds: []` | Default. All 6 kinds active. |
| `enabled: true, disabledKinds: ["DagTrigger"]` | DAG slots removed from catalog output **on next run only**; DAG branch dropped from Editor schema's `anyOf` root **on next generation**; existing DAG scenarios marked `stale` **at next run start, not mid-flight**; other 5 kinds continue. |

Flags are config-reload-watched per IOptionsMonitor; flip applies to NEW runs within ~5 seconds (in-flight runs honour the snapshot they captured at start). Emergency rollback path = sub-minute for the *next* run.

No dormant legacy opaque-JSON code path. Sentinel veto on dual-surface authoring (5.7) is honored absolutely. The legacy workbench code is *deleted*, not dormant.

### 8.3 Pre-merge quality gates (Section 8.3)

| Gate | What it proves | Implementation |
|---|---|---|
| **G1** | Every emitted schema passes Azure strict mode | Existing `scripts/smoke_test_strict_schema.py` + new test that runs `BuildScenarioBatchSchema` output (full generated object, post `$defs`/`anyOf`/partition factoring per §2.4) for every zone shape in a fixture set. Exit 0 = pass. **Includes Matcher value typed-shape coverage** (Finding 1) and **nullable-union pattern for every `required: false` catalog param** (Finding 2). |
| **G2** | All 6 catalog providers emit valid non-empty catalogs for representative zones | New unit test per provider; assert ≥1 slot per kind on fixture; assert hash is stable across runs; assert schema validates. **Snapshot envelope** (§2.1) populated and consistent. **Required-provider hard-fail** asserted (Finding 6 / R13). |
| **G3** | Each of the 6 stimulus kinds dispatches end-to-end against a **live CI-spun FLT** | **MANDATORY.** Recorded fixtures may *supplement* but never replace (Finding 11). CI spins an FLT instance with the DevMode controllers + 5 new seams (`IQaDagRunInvoker`, `IQaSignalRObserver`, `IQaFileEventInjector`, `IQaTimerInjector`, `IQaDirectInvokeRegistry`); EDOG test runner invokes every kind through `POST /devmode/qa/dispatch[/async]` and asserts captures. |
| **G4** | Re-running QA against PR 977882 produces zero LNT001/003/004/011 fires | Replay harness — provided PR diff + repo snapshot → full pipeline → assert lint output empty for those rules. Also replay on 2 additional recent PRs (Sentinel picks them). |
| **G5** | All pre-contract scenarios in a fixture DB transition to `pre-contract-quarantined` on deploy | Migration unit test against a seeded `EdogQaScenarioStore` (Finding 13 — actual scenario persistence, not the run-history store) with mixed shapes. |
| **G6** | Per-kind emergency disable affects **new runs only**, with in-flight runs honouring their captured revision | New integration test that flips `disabledKinds` mid-run; asserts mid-flight dispatches complete, new generation refuses the disabled kind, telemetry `feature_flag.snapshot` revisions are consistent. |
| **G7** | `/devmode/qa/dispatch*` is **absent** from Release-build FLT — both swagger AND actual route | Build pipeline check in `workload-fabriclivetable` asserts: (a) `WorkloadEndpointSetup` does NOT auto-discover the controllers (ADR-005 late DevMode registration only); (b) Release-build swagger does not list the routes; (c) **`GET/POST` against the routes on a Release build returns 404** (live test, not just swagger inspection — Finding 11). Hard-fails the release build if any of (a/b/c) fails. |
| **G8** | All telemetry counters from §7.3 fire under the relevant code path, and **none leak raw params/captures/LLM output** | Single test that exercises one path per counter and asserts the log line appears + a redaction assertion that no field exceeds the truncation cap and that hashed fields are present. |
| **G9** | Capability endpoint version-skew detection works | New test: spin two FLT versions (one with old `contractVersion`, one current); EDOG client correctly detects the mismatch and fails the run with `errorCode: "FLT_VERSION_MISMATCH"`. |

**Additional pre-merge requirements:**

- All 4 hivemind agents (Vex, Pixel, Sentinel, Sana) sign off in the PR review thread.
- Smoke test against a fresh FLT deploy in a sandbox capacity (not just local CI).
- ADR filed in `docs/adr/` covering the contract surface decision, plus a separate ADR covering the dispatch endpoint security model (X-EDOG-Control-Token + localhost + allowlist).
- Cross-repo dependency: FLT's `[EdogDirectInvokeSeam]` attribute + 5 new seam interfaces + 2 dispatch endpoints + capability endpoint + G7 pipeline check + contract-compatibility tests PR must merge **before** the EDOG PR. EDOG PR may not merge until the FLT main branch contains the dependency and its `contractVersion` matches what EDOG's `EdogQaContractCatalog` expects.

### 8.4 Cross-repo sequencing

**Phase 0 — FLT repo (`workload-fabriclivetable`)** — substantially expanded vs. rev-1 to absorb Findings 2/3/4/11/12:

1. Add `[EdogDirectInvokeSeam]` attribute definition.
2. Apply attribute to opt-in service classes (Sana + FLT team curate the initial set).
3. **NEW: Build 5 DevMode seam interfaces** behind `#if DEVMODE`:
   - `IQaDirectInvokeRegistry` — enumerates `[EdogDirectInvokeSeam]`-tagged services, exposes `Invoke(slotId, params, ct)`.
   - `IQaSignalRObserver` — wraps `HubLifetimeManager<T>` with `Register(correlationId, channelKey)` / `Harvest(correlationId)` / `Dispose(correlationId)`.
   - `IQaDagRunInvoker` — `TriggerAsync(slotId, params, ct) → dispatchId`, `GetStatusAsync(dispatchId, ct) → {state, captures?}`, `CancelAsync(dispatchId, ct)`. Wraps the existing `LiveTableSchedulerRunController.RunDagAsync` + run-status reader.
   - `IQaFileEventInjector` — `Inject(slotId, params, ct)` synthesises an event on the in-process channel of the existing `IFileSystemFactory` DevMode wrapper.
   - `IQaTimerInjector` — `Inject(slotId, params, ct)` injects a synthetic tick on the timer topic.
4. Add 2 dispatch controllers + capability controller under `Service/DevMode/Qa/`:
   - `QaDispatchController` — sync `POST /devmode/qa/dispatch`
   - `QaAsyncDispatchController` — async `POST /devmode/qa/dispatch/async` + `GET /devmode/qa/dispatch/{id}` + `DELETE /devmode/qa/dispatch/{id}`
   - `QaCapabilitiesController` — `GET /devmode/qa/capabilities`
5. **Security middleware** (`X-EDOG-Control-Token` validator + localhost-bind enforcement + per-kind concurrency-cap semaphore + 64KB body cap + redacted audit log writer).
6. **Registration via ADR-005 late DevMode path** (`EdogDevModeRegistrar`) — NOT via `WorkloadEndpointSetup.AddAllControllersFromAssembly` (Finding 11).
7. Add G7 build-time assertions: (a) static analyser ensures none of the new types are referenced from non-DEVMODE code, (b) Release-build swagger does not list the routes, (c) live-Release smoke test returns 404 on each route.
8. Add contract-compatibility tests: spin a stub EDOG client against the FLT PR build, assert dispatches succeed for every kind.
9. Merge to main. Tag for EDOG consumption (`flt/qa-contract-v1.0`).

**Phase 1 — EDOG repo (`edog-studio`)** (unchanged structurally, but consumes the new FLT contract):

1. Implement Section 2's `EdogQaContractCatalog` + 6 providers + `CatalogSnapshot` envelope.
2. Implement Section 3's schema generator with Value typed shapes + null-union + P1's `plan` description + R7/R8/R9.
3. Wire Section 4's pipeline deltas (Editor schema swap, Projector simplification, PartialRepairSchema, attempt-3 escalation, capped reachability formula, active grounding-slot-match check).
4. Implement Section 5's workbench (replace in place).
5. Implement Section 6's executor extension + dispatch client (sync + async-DAG poll + cancellation + capability-version check on every run).
6. Implement Section 7's telemetry + LNT011 + redaction rules.
7. Implement Section 8.2's `IQaContractOptionsProvider` revision-snapshot model.
8. Run G1–G9 + agent sign-off + sandbox smoke.
9. Merge to main. Big-bang go-live.

**Phase 2 — Post-deploy**
1. Operators flip per-zone "Regenerate" to migrate pre-contract scenarios.
2. Sentinel monitors telemetry against Section 9.1 metrics for 4 weeks.
3. If M1–M7 all met → success criteria reached; ship follow-ups (Contract Health panel, cleanup ADR, etc.).
4. If any metric missed → triggered rollback per Section 9.1's per-metric playbook.

**Estimated FLT-side LOC (Finding 11/13 corrections):** ~1 400 (5 seams + 3 controllers + security middleware + capability endpoint + G7 hardening + contract-compatibility tests). Was ~250 in rev-1; the expansion is the price of not cutting scope.

---

## 9. Success criteria & open risks

### 9.1 Success metrics (Section 9.1)

All measured from logs (per §7.3) over the first **4 weeks post-deploy**.

| # | Metric | Threshold | Violation playbook |
|---|---|---|---|
| **M1** | Sum of LNT001 + LNT003 + LNT004 + LNT011 fires | **0** | Rollback immediately (per-kind disable on the offending kind). Root-cause investigation. |
| **M2** | Schema-reject rate (Azure 400 from strict mode) | **< 8 %** of LLM emissions | Schema or prompt tuning; no rollback. |
| **M3** | Repair-loop persistent failure (`SCHEMA_REJECT_PERSISTENT`) | **< 3 %** of zones | Schema or catalog tuning; no rollback. |
| **M4** | `inconclusive` rate (dispatch timeouts) | **< 2 %** per stimulus kind | Tune per-kind timeouts; investigate FLT-side invoker perf; no rollback unless persistent. |
| **M5** | Stale-scenario rate | **< 15 %** per week | Catalog stability investigation; ops procedure tightening; no rollback. |
| **M6** | End-to-end scenario pass rate on representative PRs (sample of 10) | **No regression**, within ± **5 %** of pre-contract baseline | Rollback the whole feature. We shipped something that reduced QA value. |
| **M7** | Operator-reported workbench usability | Subjective; informal poll of 3 engineers | Frontend follow-up sprint; no rollback. |

Shipped successfully = M1–M7 all met at end of week 4.

### 9.2 Risk register (Section 9.2)

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| **R1** | Cross-field semantic mismatch the schema can't see (read-vs-mutation slot mismatch). | Medium | Slot catalog declares `mutates: true/false`; Validator topic gate refuses inconsistent scenarios. Catches most cases; few edges remain. |
| **R2** | Reasoning-model self-argument in hidden CoT. | Medium | **Primary mitigation: active Architect→Editor grounding-slot-match check** in the Validator (§3-bis.3 / §4.5). Editor must emit the Architect's recommended slot OR explicitly justify divergence in the `plan` field; soft-reject + repair loop on mismatch. **Secondary: low-confidence emissions logged for audit.** |
| **R3** | Structurally-identical slots with different semantics. | Low-Medium | Each slot's `purpose` text (from controller XML doc-comments) included in catalog, surfaced in slot-picker rich label, and **injected into the Editor system message via P6** (JSON Schema cannot attach `description` per enum value — Finding 13). The R2 grounding-slot-match check also catches a substantial subset of R3 failures. |
| **R4** | Dispatch endpoints = new attack surface in FLT. | High *if* exploited; **Low** likelihood with full security model | Full security stack per §6.2 (Finding 3): compile-time DevMode gating + ADR-005 late registration + `X-EDOG-Control-Token` + localhost-bind + per-kind+per-slot allowlist + per-kind concurrency caps + 64 KB body cap + per-kind param validators + redacted audit log. G7 asserts both swagger absence AND actual `404` on Release builds. |
| **R5** | Catalog-build-time strict-mode cap exception — a zone with >500 enum values or >100 props fails catalog assembly. | Medium | Per-zone partition at 30 anyOf branches. **Per-`topicField` enum char cap (≤7 000) explicitly checked** (Finding 7). **Caps re-asserted on the generated schema, not only the catalog** (post-`$defs`/`anyOf` factoring can change property count + depth). If still over cap, zone marked `schema-overflow` and excluded from contract authoring with operator-visible error pointing at the specific cap tripped. |
| **R6** | Big-bang blast radius — 6 kinds, ~4 100 LOC (post-expansion), single PR train. | High | G1–G9 + 4-agent sign-off + sandbox smoke + per-kind emergency disable. Acceptable given the bar set. |
| **R7** | One-time token cost on rollout for regenerating quarantined pre-contract scenarios. | Low | Documented in rollout runbook. Cost bounded by number of zones with existing scenarios. |
| **R8** | SignalR async-broadcast race — matcher checks before broadcast arrives. | Medium | Dispatch endpoint uses synchronous **`IQaSignalRObserver` seam** (Finding 4) that wraps `HubLifetimeManager<T>`: pre-register observer with `correlationId`, fire via `IHubContext<T>`, harvest from in-process ring buffer, dispose in `finally`. Matcher reads from in-process buffer, not the wire. Concurrent dispatches isolated by correlationId. |
| **R9** | `/responses` latency on gpt-5.4-pro for the Architect role. | **Medium** (upgraded from Low — Finding 12) | **Latency-triggered fallback** with explicit budget: 15 s first-token / 60 s total → re-issue against `gpt-5.4`. `reasoning_effort=medium` pinned to bound reasoning-token usage and cost. Existing availability fallback chain `ARCHITECT → PRO → default` runs first. Repair loop tolerates retries. |
| **R10** | Cross-repo coupling — EDOG PR depends on FLT PR. | Medium | Phase 0/1 sequencing enforced. **Capability endpoint `GET /devmode/qa/capabilities`** for version-skew detection. EDOG CI pins a tagged FLT artifact (`flt/qa-contract-v1.0`); EDOG tests skip/fail explicitly on `contractVersion` mismatch with `errorCode: "FLT_VERSION_MISMATCH"`. Contract-compatibility tests run in the FLT PR before EDOG PR opens. |
| **R11** | Frontend complexity drop — three-column workbench + inline last-run + Issues strip + slot picker + matcher composer in one PR. | Medium | Pixel splits the frontend into 3 component-tested chunks landing in sequence within the same PR train (left column → middle column → right column). Each chunk passes G-tests independently. |
| **R12** | Reasoning-trace privacy — `/responses` may include reasoning excerpts in audit logs. | Low | Audit logger redacts `/responses` body to keep only `output` field. Confirm in code review. Telemetry redaction rules from §7.3 apply universally — no raw params, no captures, no LLM `plan` field output ever logged in clear. |
| **R13** | Catalog provider partial-degradation — silent loss of slots if a provider is empty/failed. | **Medium** (new — Finding 6) | `CatalogSnapshot` envelope (§2.1) records per-provider status (`ok`/`degraded`/`empty`/`failed`). **Required providers** (HTTP/DI/TopicField for any zone that has slots of that kind) MUST be `ok` or the catalog assembler raises `CatalogAssemblyFailedException`. Non-required providers may degrade with a warning telemetry event. Operator-visible degradation indicators in the workbench's catalog-health strip. |

### 9.3 Pre-implementation expert consultation gate (Section 9.3)

**Status: COMPLETE.** Both expert consults ran 2026-05-20.

- **research agent (LLM/AI):** 2 Critical + 4 High + 6 Medium + 3 Low findings — see Appendix C.1.
- **rubber-duck agent (backend):** 1 Critical + 5 High + 7 Medium findings — see Appendix C.2.

**Donna's response: revised spec body** absorbs every Critical and High finding (28 in total). Phase 0 FLT-side LOC budget expanded from ~250 to ~1 400 to build the seams the spec previously assumed; total feature LOC from ~2 500 to ~4 100. No scope cut (per Hemant's directive 2026-05-20).

**Next: Final spec approval from Hemant. Then invoke `writing-plans` skill to produce the implementation plan. Implementation plan also reviewed by both expert agents (Sentinel's bar) before any code is written.**

---

## Appendix A — File-by-file change inventory

> **Reviewer note (Finding 13):** Several rev-1 entries described changes that conflicted with the actual current code shape. Rev-2 below reflects ground truth verified against `src/backend/DevMode/EdogQa*.cs` and the FLT repo. The breaking model-rename migrations are explicitly called out.

### EDOG repo

| File | Δ |
|---|---|
| `src/backend/DevMode/EdogQaLlmClient.cs` | Replace `BuildScenarioBatchSchema` (~line 553) opaque-string fields (`stimulusSpec` ~610, `matcherSpec` ~631) with typed `stimulus` + `matchers` per §3.1. Add `plan: string` with rich description (P1). Build `PartialRepairSchema` and `SingleScenarioSchema` for §4.6 repair loop. Wire P5 temperature anneal (0.2 → 0.4 → 0.6). Wire P6 slot-purpose system-message block per kind. Wire P7 few-shot exemplar (catalog-assembler-selected slot). Wire `reasoning_effort: medium` for Architect role calls. Wire latency-triggered fallback in capability probe. |
| `src/backend/DevMode/EdogQaContractCatalog.cs` | **New.** Catalog assembler + 6 source providers + `CatalogSnapshot` envelope (§2.1) + §2.4 cap assertions (assembler-side AND generator-side per Finding 7). Required-provider hard-fail. Null-union emission for `required: false` params (R8 / Finding 2). |
| `src/backend/DevMode/EdogQaDagScanner.cs` | **New.** Roslyn scan for `[DagDefinition]`-decorated DAG classes. |
| `src/backend/DevMode/EdogQaFileTimerScanner.cs` | **New.** Roslyn scan for FLT's `[EdogFileEventSeam]` / `[EdogTimerSeam]` attributes (Finding 4 — the prior plan referenced `IFileSystemWatcher`/`ITimerService` which don't exist as DI surfaces in FLT). |
| `src/backend/DevMode/EdogQaDiRegistryProvider.cs` | Extend with `[EdogDirectInvokeSeam]` attribute filter; consume FLT's new `IQaDirectInvokeRegistry` enumeration endpoint. Replace silent-on-empty behaviour with explicit `degraded`/`empty` status reporting (Finding 6). |
| `src/backend/DevMode/EdogQaOmniSharpProvider.cs` | Extend topic-field scan to include anonymous-type member name discovery for matcher topic.field catalog. |
| `src/backend/DevMode/EdogQaScenarioProjector.cs` | Simplify — Editor output now typed; remove opaque-string parsing (~150 LOC reduction). |
| `src/backend/DevMode/EdogQaScenarioValidator.cs` | Retain all 5 gates. **Add `MatcherTypeConsistencyGate`** (assertion ↔ value-shape per §3.1; Finding 1). **Extend grounding gate** with active `slot-match` sub-check (R2; Finding 10). Add `mutates`-consistency check in topic gate (R1). |
| `src/backend/DevMode/EdogQaScenarioOrchestrator.cs` | Update scenarios-per-zone formula (§4.2; Finding 4 — capped reachability term + coverage weighting). Update T1e repair loop with PartialRepairSchema splice logic (§4.6; Finding 5) + attempt-3 single-scenario escalation (P3-bis; Finding 14). Capture `IQaContractOptionsProvider` revision at run-start (§8.2; Finding 10). |
| `src/backend/DevMode/EdogQaScenarioLinter.cs` | Add LNT011 (format-string-literal). Retain LNT001/003/004 at Error. |
| `src/backend/DevMode/EdogQaExecutionEngine.cs` | Add catalog-hash comparison (per-slot + per-topic per §6.1; Finding 8) + `stale` verdict. Wire to `EdogQaStimulusDispatcher` for non-HTTP kinds. Add per-kind capture parsing. Add capability-version check at run-start. |
| `src/backend/DevMode/EdogQaStimulusDispatcher.cs` | **Substantial rewrite.** This file already exists under F27 P9; extend with: (a) `X-EDOG-Control-Token` header generation, (b) sync `POST /devmode/qa/dispatch` client for DI/SignalR/FileEvent/TimerTick, (c) async `POST /devmode/qa/dispatch/async` + `GET /devmode/qa/dispatch/{id}` poll client for DagTrigger with 5-min budget + linked cancellation, (d) per-kind timeout enforcement, (e) capture-buffer reading. |
| `src/backend/DevMode/EdogQaAssertionEngine.cs` | **Breaking change.** Existing engine supports `Exact/Contains/Regex/Range/Exists` (~5 types). Replace with the 7-type vocabulary (`equals`/`notEquals`/`exists`/`inRange`/`containsAll`/`oneOf`/`length`) per §5.2 against typed-value branches (`Value_string`/`Value_integer`/`Value_datetime`/`Value_range`/`Value_array`). Regex assertion is **removed** (no migration path — by design; format strings are exactly what LNT011 targets). |
| `src/backend/DevMode/EdogQaFeatureFlags.cs` | **Replaced by new `IQaContractOptionsProvider`** (Finding 10). Existing `Lazy<T>` env-var read pattern incompatible with mid-run consistency requirements. New provider exposes atomic immutable `QaContractOptions` snapshots with monotonic `revision`. `IOptionsMonitor<QaContractOptions>` wired to the config FileSystemWatcher. |
| `src/backend/DevMode/EdogQaRunStore.cs` | **(corrected per spec sanity-check 2026-05-20)** Scenarios are persisted as `QaScenarioRecord` items inside `QaRunRecord` entries within the JSON envelope; there is no separate scenario store. Migration traverses the envelope and marks each scenario where `schemaVersion < "p10"` → `status = "pre-contract-quarantined"` per §6.5. Surface `stale` / `inconclusive` verdict states. New `QaScenarioRecord.CatalogHashes` field (per-slot + per-topic). |
| `src/backend/DevMode/EdogQaModels.cs` | **Breaking model migrations** (Finding 13): rename `StimulusType.SignalrInvoke` → `SignalRBroadcast`, `StimulusType.DirectInvoke` → `DiInvocation`. Add `CatalogHashes` field (per-slot + per-topic) to `Scenario`. Add `Verdict.Stale`, `Verdict.Inconclusive`. Add `MatcherAssertion` 7-type enum. Add typed `MatcherValue` discriminated union. **All downstream consumers** (assertion engine, projector, validator, frontend serialization, storage) must update — this is not a small field addition. |
| `src/backend/DevMode/EdogQaTelemetry.cs` | Add the 15 contract-health event emitters from §7.3 with the redaction & sampling rules in §7.3 (Finding 9). |
| `src/backend/DevMode/EdogQaCapabilityProbe.cs` | Add latency-triggered fallback (Finding 12 / R9): 15 s first-token / 60 s total budget; emit `qa.contract.architect.fallback` on trip. Wire `reasoning_effort: medium` on `gpt-5.4-pro` calls. |
| `scripts/dev-server.py` | Add `/api/contract/catalog/{zoneId}` proxy + `/api/contract/capabilities` capability-endpoint proxy. |
| `src/frontend/js/qa-curation.js` + paired CSS | Rewrite in place to host the three-column workbench (§5). Slot-picker, matcher composer with typed value inputs (string/int/datetime/range/array per §3.1), Issues strip, Last-run strip. Verified path. |
| `src/frontend/js/qa-analysis.js` | Add catalog-health strip showing snapshot envelope (FLT build SHA + per-provider status). Wire to backend catalog fetch. |
| `config/edog-config.template.json` | Add `qa.contract.enabled`, `qa.contract.disabledKinds`, `qa.contract.fewShot.enabled`, `qa.contract.controlToken` defaults. |
| `data/framework-endpoints.json` | Extend if SignalR registry needs additions for the dispatch endpoint discovery. |

### FLT repo (`workload-fabriclivetable`) — cross-repo

| File / Area | Δ |
|---|---|
| `Service/.../Attributes/EdogDirectInvokeSeamAttribute.cs` | **New.** Marker attribute. |
| `Service/.../Attributes/EdogFileEventSeamAttribute.cs` | **New.** Marker attribute for file-event-triggered services. |
| `Service/.../Attributes/EdogTimerSeamAttribute.cs` | **New.** Marker attribute for timer-tick-triggered services. |
| Various service class files | Apply seam attributes to the opt-in subset (Sana + FLT team curate). |
| `Service/.../DevMode/Qa/IQaDirectInvokeRegistry.cs` (+impl) | **New seam** — enumerates `[EdogDirectInvokeSeam]` services; `Invoke(slotId, params, ct)`. |
| `Service/.../DevMode/Qa/IQaSignalRObserver.cs` (+impl) | **New seam** — wraps `HubLifetimeManager<T>` with observer registration keyed by `correlationId`. |
| `Service/.../DevMode/Qa/IQaDagRunInvoker.cs` (+impl) | **New seam** — `TriggerAsync` / `GetStatusAsync` / `CancelAsync`; wraps existing `LiveTableSchedulerRunController.RunDagAsync` + status reader. |
| `Service/.../DevMode/Qa/IQaFileEventInjector.cs` (+impl) | **New seam** — synthesises events on the in-process channel of the existing `IFileSystemFactory` DevMode wrapper. |
| `Service/.../DevMode/Qa/IQaTimerInjector.cs` (+impl) | **New seam** — synthesises timer ticks on the existing timer topic. |
| `Service/.../DevMode/Qa/QaDispatchController.cs` | **New.** Sync `POST /devmode/qa/dispatch`. Registered via **`EdogDevModeRegistrar` late DevMode path** — NOT via `WorkloadEndpointSetup.AddAllControllersFromAssembly` (Finding 11). |
| `Service/.../DevMode/Qa/QaAsyncDispatchController.cs` | **New.** Async `POST /devmode/qa/dispatch/async` + `GET /devmode/qa/dispatch/{id}` + `DELETE /devmode/qa/dispatch/{id}`. Same registration mechanism. |
| `Service/.../DevMode/Qa/QaCapabilitiesController.cs` | **New.** `GET /devmode/qa/capabilities` returning `{contractVersion, supportedKinds, fltBuildSha, schemaCapVersion}`. Same registration mechanism. |
| `Service/.../DevMode/Qa/QaSecurityMiddleware.cs` | **New.** `X-EDOG-Control-Token` validator + localhost-bind enforcement + per-kind concurrency-cap semaphore + 64 KB body cap + redacted audit log writer. |
| `Service/.../DevMode/EdogDevModeRegistrar.cs` | Extend with QA dispatch registration (new controllers + middleware + 5 seam interfaces). |
| Release pipeline | Add G7 multi-part hard-assertion (Finding 11): (a) static analyser confirms no Release-build reference to QA dispatch types, (b) Release swagger does not list QA dispatch routes, (c) live Release smoke test asserts 404 on each route. |
| Contract-compatibility test project | **New.** Spins a stub EDOG client against the FLT PR build; asserts dispatches succeed for every kind. Runs in FLT PR CI before EDOG PR opens. |

---

## Appendix B — Cross-repo FLT changes

See §8.4 Phase 0. The FLT PR is a hard prerequisite for EDOG PR merge. Sequence:

1. FLT PR opens with `[EdogDirectInvokeSeam]` + `QaDispatchController` + G7 pipeline check.
2. FLT team reviews + merges.
3. EDOG PR opens after FLT main contains the dependency.
4. EDOG PR's G2/G3 tests run against FLT main builds.

Estimated FLT-side LOC: ~250 (attribute + 5 invokers + DevMode wrapper + tests).

---

## Appendix C — Pre-implementation expert consultation

**Status: COMPLETE 2026-05-20.** Two parallel sub-agents reviewed the spec rev-1 against fresh code reads + 2025-2026 research. Combined findings: **3 Critical + 9 High + 13 Medium + 3 Low = 28**. Every Critical and High finding is absorbed into the spec body above (rev-2). Donna's response per finding follows.

**Resolution summary**

| Severity | Count | Disposition |
|---|---|---|
| Critical | 3 | All absorbed into spec body. |
| High | 9 | All absorbed into spec body. |
| Medium | 13 | Absorbed (code-time or implementation-detail). Documented in this appendix; the implementation plan must thread them through. |
| Low | 3 | Deferred to implementation polish; documented here for plan-writing visibility. |

### C.1 — research agent (LLM/AI expert) findings

**Reviewer model:** Claude Sonnet research agent with 2025-2026 web access (Tam et al. NeurIPS 2024, CRANE ICML 2025, Azure Structured Outputs docs).

**Citations the reviewer grounded against:**
- Tam et al. "Let Me Speak Freely?" arXiv:2408.02442 (NeurIPS 2024)
- Banerjee et al. "CRANE: Reasoning with constrained LLM generation" arXiv:2502.09061 (ICML 2025)
- Willard & Louf "Efficient Guided Generation for LLMs" arXiv:2307.09702
- Azure OpenAI Structured Outputs guide (Microsoft Learn)
- Azure OpenAI Responses API guide (Microsoft Learn)

| # | Severity | Finding | Donna's response | Section absorbed |
|---|---|---|---|---|
| **LLM-1** | Critical | Matcher `value` field is structurally incomplete for 3 of 7 assertion types (`inRange`, `containsAll`, `oneOf`). `Value_oneOfBranch` is referenced but never defined. Strict mode forbids `if/then/else`, so all shapes must be listed upfront. | **Accept fully.** Added `Value_range` + `Value_array` `$defs` with typed discriminators (R7). Replaced `Value_oneOfBranch` placeholder. Added `MatcherTypeConsistencyGate` to Validator that enforces the assertion ↔ value-shape mapping post-emission. | §3.1, §3.2 (R7), §4.5 |
| **LLM-2** | Critical | Optional catalog params (`required: false`) → strict mode 400-rejects (declared-but-not-required violates strict invariant). Spec showed `"limit": {required:false}` in §2.1 example without a null-union pattern. | **Accept fully.** R8 rule added — every `required: false` param emits as `["T","null"]` union, listed in `required[]`, LLM instructed to emit `null` for omitted. Assembler assertion `OPTIONAL_PARAM_MISSING_NULL_UNION` added. `min`/`max` numeric caveat documented (strict-mode rejects `minimum`/`maximum`; survives only via description + Validator gate). | §2.4, §3.1, §3.2 (R8) |
| **LLM-3** | High | `plan` field had no `description`. CRANE (ICML 2025) confirms reasoning-field-with-guidance is necessary — without it, the field degrades to "OK". Tam et al. measure ~10 % accuracy loss when JSON-mode collapses CoT. | **Accept.** Added multi-step `description` to `plan` field with 5 explicit reasoning steps (changed-symbols mapping, slotId-enum confirmation, topic.field mapping, slot-disambiguation justification, Architect-divergence statement). | §3.1, P1 |
| **LLM-4** | High | `reachableSlotCount` raw addend in scenarios-per-zone formula saturates the `clamp(…,3,10)` for any zone >7 slots → formula always returns 10 → diff-proportionality terms become computationally irrelevant. | **Accept.** Replaced raw addend with `min(2, floor(reachableSlotCount/8))` (reachability bonus capped at +2). Added coverage weighting: `effectiveReach = reachableSlotCount - count(scenarios already exercising a slot)`. Restores diff-proportionality. | §4.2 |
| **LLM-5** | High | Partial re-emit repair loop is silent on Option A (only failed scenarios) vs Option B (all N scenarios). Splice logic unspecified. | **Accept Option A with explicit schema.** Added `PartialRepairSchema = {plan, correctedScenarios:[{originalIndex, scenario}]}` for attempts 1+2. Splice contract: `original[originalIndex] = correctedScenario`. Sentinel unit test required. | §4.6 |
| **LLM-6** | High | R4 rationale (composite topic.field enum) framed as performance optimization. Actually a strict-mode **structural necessity** — alternatives need `if/then/else` (rejected) or burst the depth cap. | **Accept.** R4 rewritten to state structural necessity: (a) correlating topic→field requires `if/then/else`/`oneOf`, both rejected; (b) discriminated-anyOf alternative consumes the 5th nesting level inside Matcher and busts Azure's depth cap. Prevents wrong-path implementation choice. | §3.2 (R4) |
| **LLM-7** | Medium | Composite `topicField` enum char count not individually capped. Data-intensive zones (20 topics × 12 fields × 41 chars/value ≈ 9 840 chars) can exceed per-enum char cap before total-enum cap. | **Accept.** Added explicit per-`topicField` enum cap (≤7 000 chars). Matcher-side partitioning by topic prefix when exceeded (R5 extension). | §2.4, §3.2 (R5) |
| **LLM-8** | Medium | Schema token size competes with PR diff context. No budget analysis. 43-slot zone ≈ 10 K schema tokens; dense zone ≈ 20 K. | **Accept (instrumentation only).** Added `qa.contract.schema.token_estimate` telemetry event with rough estimation (chars ÷ 4). 128K context window is sufficient; no compression needed unless telemetry shows >30 K. | §7.3 |
| **LLM-9** | Medium | `temperature` was unspecified. Constrained decoding benefits from low temperature (concentrates probability on valid enum values). | **Accept.** Added P5 — temperature anneal `0.2 → 0.4 → 0.6` across repair-loop retries. Editor at 0.2 attempt-1. Encodes well-known best practice for constrained slot selection. | §3-bis.1 (P5), §3.4 |
| **LLM-10** | Medium | R2 (reasoning-model self-argument) mitigation was passive ("low-confidence emissions logged"). Architect→Editor handoff is the primary structural mitigation but wasn't framed as such. | **Accept.** Reframed R2 — primary mitigation is now an **active grounding-slot-match check** in the Validator: emitted `stimulus.slotId` must match Architect's recommended slot OR `plan` field must explicitly justify divergence. Soft-reject + repair on mismatch. | §3-bis.3, §4.5, §9.2 (R2) |
| **LLM-11** | Medium | `/responses` `reasoning_effort` unspecified for `gpt-5.4-pro`. Default is implementation-specific and may change. Causes non-deterministic latency + cost spikes. | **Accept.** Pinned `reasoning_effort: medium` on Architect calls. | §3.4 |
| **LLM-12** | Medium | R9 fallback trigger condition ("slow") undefined. The existing capability-availability fallback isn't a latency fallback. | **Accept.** Added explicit latency budget: 15 s first-token / 60 s total → re-issue against `gpt-5.4`. Emits `qa.contract.architect.fallback { reason: "latency_timeout" }`. R9 upgraded from Low to Medium. | §3.4, §9.2 (R9) |
| **LLM-13** | Low | Per-enum-value `purpose` text isn't representable in JSON Schema. R3 mitigation that "purpose surfaces in schema description" was wrong. | **Accept.** Added P6 — slot-purpose injected into the Editor system message, not the schema. Catalog assembler builds the per-kind purpose block from each slot's `purpose` field. | §3-bis.1 (P6), §3.2 (R9) |
| **LLM-14** | Low | Repair loop retries identical message on attempts 1/2/3. CRANE + Tam et al. show diminishing returns; attempt 3 should escalate. | **Accept.** Added P3-bis — attempt-3 single-scenario isolation mode. Per-failure isolated LLM call with just that scenario's plan excerpt + violating constraint + valid enum values. | §3-bis.1 (P3-bis), §4.6 |
| **LLM-15** | Low | Few-shot examples absent. Tam et al. + OpenAI cookbook show they help for complex nested schemas. | **Accept.** Added P7 — catalog assembler emits one canonical exemplar scenario (selected from zone's "simplest idempotent slot") into Editor system message. Disable-able via `qa.contract.fewShot.enabled`. | §3-bis.1 (P7) |

### C.2 — rubber-duck agent (backend expert) findings

**Reviewer model:** GPT-5.5 rubber-duck agent with read access to `src/backend/DevMode/EdogQa*.cs` and the FLT repo (`C:\Users\guptahemant\newrepo\workload-fabriclivetable`).

**Citations the reviewer grounded against:**
- `EdogLogServer.cs:418-520` (existing `X-EDOG-Control-Token` pattern)
- `TopicBuffer.cs:51-66, 73-77` (existing synchronous observer pattern in EDOG topic buffers)
- `LiveTableSchedulerRunController.cs:99-113, 210-219` (current 202-style DAG run queueing)
- `EdogDevModeRegistrar.cs:195-200` (existing `IFileSystemFactory` wrapper)
- `EdogQaStimulusDispatcher.cs:491-551` (existing `TimerTickStimulusHandler`)
- `EdogQaFeatureFlags.cs:15-40, 65-66` (existing `Lazy<T>` flag pattern, no live reload)
- `WorkloadEndpointSetup.cs:80-125` (FLT's `AddAllControllersFromAssembly` auto-discovery)
- `EdogQaDiRegistryProvider.cs:52-64` (silent-on-empty behaviour)

| # | Severity | Finding | Donna's response | Section absorbed |
|---|---|---|---|---|
| **BE-1** | Critical | Dispatch endpoint security under-specified. Existing EDOG control routes already require `X-EDOG-Control-Token`; the new endpoint is more dangerous with less protection. Compile-time/devmode-only registration, allowlist, concurrency caps, redacted audit log all missing. | **Accept fully.** Full security stack added: compile-time DevMode gating + ADR-005 late registration + `X-EDOG-Control-Token` + localhost-bind + per-kind+per-slot allowlist + per-kind concurrency caps (DI=8, DAG=2, SignalR=4, FileEvent=4, TimerTick=4) + 64 KB body cap + per-kind param validators + audit log with redaction (Finding 9). | §6.2, §9.2 (R4) |
| **BE-2** | High | SignalR "in-process observer before fire" not implementable as written. `IHubContext.SendCoreAsync` completes when message queued, not when delivered. EDOG `TopicBuffer.AddObserver` observes EDOG topic buffers, not SignalR transport. No FLT SignalR hub surface exists. | **Accept — build the seam.** Added `IQaSignalRObserver` FLT-side seam that wraps `HubLifetimeManager<T>` with `Register(correlationId, channelKey)` / `Harvest(correlationId)` / `Dispose(correlationId)`. Observer disposal mandatory in `finally`. Correlation IDs required to disambiguate concurrent dispatches. Phase 0 LOC budget expanded. | §6.2, §8.4, Appendix A |
| **BE-3** | High | DAG dispatch completion semantics not implementable from current FLT shape. `RunDagAsync` returns 202-style; no correlation ID, no status source, no cancellation contract. Spec said "wait 5 minutes for Completed/Failed" without defining how. | **Accept — build the seam.** Added `IQaDagRunInvoker.TriggerAsync(slotId, params, ct) → dispatchId` + `GetStatusAsync(dispatchId, ct) → {state, captures?}` + `CancelAsync(dispatchId, ct)`. Wraps existing `LiveTableSchedulerRunController.RunDagAsync` + reads status from the existing scheduler status store. Concurrency cap (DAG=2) prevents host starvation. | §6.2, §8.4, Appendix A |
| **BE-4** | High | `IFileSystemWatcher` / `ITimerService` don't exist as FLT DI surfaces. EDOG wraps `IFileSystemFactory`; current `TimerTickStimulusHandler` subscribes to a topic. Spec was designing against ghost infrastructure. | **Accept — build the seams against real abstractions.** Added `IQaFileEventInjector` (synthesises events on `IFileSystemFactory` DevMode wrapper's in-process channel) + `IQaTimerInjector` (synthesises ticks on the existing timer topic). Phase 0 catalog scanner targets new `[EdogFileEventSeam]` / `[EdogTimerSeam]` marker attributes. | §6.2, §8.4, Appendix A |
| **BE-5** | High | 5-min synchronous HTTP dispatch is operationally risky — proxy timeouts, client disconnects, Kestrel limits, cancellation leaks. Spec said `inconclusive` on timeout but didn't require cancellation propagation or `finally` cleanup. | **Accept — hybrid sync/async.** HTTP/DI/SignalR/FileEvent/TimerTick stay synchronous (all ≤30 s; well within proxy budgets). DAG switches to `POST /devmode/qa/dispatch/async` returning `202 {dispatchId}` + `GET /devmode/qa/dispatch/{id}` polling. EDOG owns the 5-min budget client-side with linked cancellation that propagates to `DELETE /devmode/qa/dispatch/{id}` → `IQaDagRunInvoker.CancelAsync`. All paths thread `finally`-scoped observer disposal. | §6.2, §6.3 |
| **BE-6** | Medium | Catalog assembly lacks a stable snapshot boundary. Providers can race; mixed-version sources produce hash that's deterministic but wrong. | **Accept.** Added `CatalogSnapshot` envelope (§2.1) — `snapshotId` + `fltBuildSha` + `edogRepoSha` + `schemaCapVersion` + per-provider status + `assembledAtUtc`. Snapshot is immutable for the run's duration; sole input to schema generation, hash comparison, dispatch authorization. Required providers hard-fail on empty/failed (Finding 6 / R13). | §2.1, §9.2 (R13) |
| **BE-7** | Medium | Strict-mode cap assertions belong after schema generation, not only in the assembler. `$defs`/`$ref`/partitioning can change property count + depth + per-enum char count. | **Accept.** §2.4 expanded — caps re-asserted on the generated schema object post-`$defs`/`anyOf`/partitioning. `CatalogSchemaCapacityException` carries `phase: "assembler"|"generator"` to disambiguate. | §2.4 |
| **BE-8** | Medium | Per-kind hash inflates stale rate. If HTTP has 47 slots and one unrelated endpoint changes, all 47 HTTP scenarios stale. M5 target (<15 %) becomes unrealistic in active zones. | **Accept.** Per-slot hash (`stimulusSlotHash`) now primary stale-check key. Per-kind hash retained as diagnostic only. | §2.3, §6.1, §6.4 |
| **BE-9** | Medium | Telemetry events risk leaking sensitive data + cardinality explosions. Spec's table didn't define redaction, truncation, hashing, sampling. | **Accept.** Added §7.3 redaction & sampling rules — never log raw params/bodies/headers/matcher values/LLM output; hash slot IDs + session identifiers; truncate to 512 chars; reason codes from closed set; sampling on `pass` outcomes only after >10K daily volume; never sample rejects/security events. | §7.3 |
| **BE-10** | Medium | Feature flag mechanics conflict with current `Lazy<T>` impl + mid-run flips can split catalog/schema/UI/executor state. | **Accept.** Replaced `EdogQaFeatureFlags` with `IQaContractOptionsProvider` exposing atomic immutable `QaContractOptions { revision, ... }`. Each run captures one revision at start. Mid-run flips affect new runs only; in-flight runs honour their captured revision. `IOptionsMonitor` wired to config FS watcher. | §8.2 |
| **BE-11** | High | G3 fixture-fallback is false confidence; G7 swagger-absence doesn't prove route absence (FLT's `AddAllControllersFromAssembly` auto-discovers any controller). | **Accept.** G3 mandatory live CI-spun FLT (fixtures supplement, never replace). Dispatch controllers registered via ADR-005 late DevMode path — NOT via `WorkloadEndpointSetup.AddAllControllersFromAssembly`. G7 now asserts (a) no Release-build reference to types, (b) Release swagger absence, (c) live Release-build 404 response. | §8.3 (G3, G7), §8.4 |
| **BE-12** | Medium | Cross-repo sequencing lacks compatibility bridge. EDOG tests behave undefined while FLT PR is in review; no version skew detection; broken FLT main breaks EDOG. | **Accept.** Added `GET /devmode/qa/capabilities` returning `{contractVersion, supportedKinds[], fltBuildSha, schemaCapVersion}`. EDOG CI pins a tagged FLT artifact (`flt/qa-contract-v1.0`). EDOG run start fails fast on mismatch with `errorCode: "FLT_VERSION_MISMATCH"`. Contract-compatibility tests in FLT PR before EDOG PR opens. New G9 gate. | §8.3 (G9), §8.4 |
| **BE-13** | Medium | Appendix A understated breaking migrations: existing model uses `StimulusType.SignalrInvoke` / `DirectInvoke` (spec renames to `SignalRBroadcast` / `DiInvocation`); existing matcher engine has `Exact/Contains/Regex/Range/Exists` (spec rewrites to 7-type vocabulary including removal of regex); `EdogQaRunStore` is run-history, not scenario persistence (migration target is `EdogQaScenarioStore`). | **Accept.** Appendix A rewritten with breaking-migration callouts. Each affected file flagged with "Breaking change" or "Breaking model migrations" with the full downstream-consumer ripple identified. Migration target corrected to `EdogQaScenarioStore`. | Appendix A |

### C.3 — Human escalation

**Not triggered.** Per §9.3 (rev-1), human escalation would have been warranted if the consults surfaced findings that required either scope cuts or design pivots Hemant hadn't already approved. The 28 findings are absorbable within the locked scope: 3 Critical + 9 High all addressed by building the right thing (5 new FLT seams + tightened security + hybrid sync/async dispatch + corrected schema shapes) rather than dropping any of the 6 stimulus kinds. LOC budget expanded ~2 500 → ~4 100; Hemant's directive ("we can't take scope cut", 2026-05-20) honoured.

### C.4 — Items retained for the implementation plan

The implementation plan (next step: `writing-plans` skill) must thread the following Medium / Low items into concrete task descriptions:

- BE-7 / LLM-7 → cap-assertion code lives in BOTH `EdogQaContractCatalog` (assembler-side) AND `EdogQaLlmClient.BuildScenarioBatchSchema` (generator-side). Two test fixtures.
- BE-9 → redaction rules need a `EdogQaTelemetryRedactor` helper class to centralize hashing + truncation + sampling. Unit-test the redactor independently.
- BE-10 → `IQaContractOptionsProvider` implementation strategy: `IOptionsMonitor<QaContractOptions>` + a `Lazy<ImmutableQaContractOptions>` snapshot field captured at `IQaContractRunScope.Start()`. Integration test required.
- BE-12 → `EdogQaContractCatalog` should fetch capabilities at first slot-provider call per run; cache for the run; emit `qa.contract.flt.capability_mismatch` on skew.
- LLM-9 / LLM-11 → `EdogQaCapabilityProbe` extension point for per-role temperature + reasoning_effort + latency-budget config.
- LLM-13 (P6) → catalog assembler emits the slot-purpose block; `EdogQaLlmClient` consumes via injection. Avoid the assembler knowing about LLM client internals.
- LLM-14 (P3-bis) → `EdogQaScenarioOrchestrator.RepairLoop.RunAttempt3Async()` needs a separate code path; do not inline in attempts 1+2 logic.
- LLM-15 (P7) → `qa.contract.fewShot.enabled` flag; default `true`; instrumentation on enable/disable.

---

## Appendix D — Glossary

| Term | Definition |
|---|---|
| **Contract** | The full structured constraint: per-zone schema + per-zone catalog + dispatch endpoint + executor verification. |
| **Catalog** | Per-zone data structure listing every slot (one per stimulus type) and every matcher topic.field reachable in the zone. Source of truth for what the LLM and human can author. |
| **Slot** | An invocable surface: HTTP endpoint, DI method, SignalR broadcast channel, DAG entry, file event source, timer. Identified by `slotId`. |
| **Slot ID** | Canonical dotted identifier for a slot (e.g., `http.dag.runs.list`). Stable across catalog rebuilds. |
| **Topic** | A capture channel emitted when a slot is invoked (e.g., `http.response.dag.runs`, `signalr.LiveTableHub.rowAdded`). |
| **Topic.field** | Composite enum used in matcher schema: `<topic>.<dotted field path>`. |
| **Stimulus** | The "do X" half of a scenario. Has a `kind` (one of 6), a `slotId`, and typed `params`. |
| **Matcher** | The "check Y" half of a scenario. Has a `topic.field`, an assertion (one of 7), and a typed value. |
| **Scenario** | A `{ stimulus, matchers[], catalogHashes }` triple. Persistent unit of QA. |
| **Zone** | An "impact zone" of changes from a PR — group of related symbols/files. From `EdogQaCodeAnalyzer`. |
| **kindHash** | sha256 over the slot list of one stimulus kind in a zone's catalog. |
| **stale** | Scenario verdict when its catalog hashes don't match the live catalog. Recoverable via regeneration. |
| **inconclusive** | Scenario verdict when dispatch times out. Distinct from pass/fail. |
| **schema-overflow** | Zone status when catalog assembly exceeds an Azure strict-mode cap. Zone refused; scenarios cannot be authored. |
| **DevMode** | EDOG's existing in-process interception infrastructure inside FLT. The contract's dispatch endpoint lives under this surface. Gated and absent in Release builds. |
| **`[EdogDirectInvokeSeam]`** | New opt-in marker attribute in FLT. Only DI services decorated with this attribute appear in the contract's DI catalog. |
