# F27 P10 — Executable Stimulus & Expectation Contract

> **Status:** Design approved by Hemant 2026-05-20. **Pending pre-implementation expert consultation gate** (Section 9.3) before invoking writing-plans.
> **Date:** 2026-05-20
> **Authors:** Donna (synthesis) + Sana (architecture lead) + Vex (impl C# / Python) + Pixel (frontend) + Sentinel (quality gates)
> **Driver:** PR 977882 surfaced hallucinated HTTP paths (`/api/v1/insights/summary`) and format-string matcher values (`yyyy-MM-dd`) that survived F27 P9's strict-mode schema. Root cause: `stimulusSpec` and `matcherSpec` declared as `{type: "string"}` — opaque JSON-encoded strings the LLM hallucinates inside, with zero schema enforcement on the content.
> **Scope:** Replace opaque stimulus / matcher strings with typed per-zone contracts, all 6 stimulus kinds, end to end. Workbench UI rebuild. Executor extension for non-HTTP stimuli via a single DevMode dispatch endpoint in FLT. Big-bang rollout with per-kind emergency disable.

---

## Locked decisions (one-line per section)

| § | Decision |
|---|---|
| **1** | Replace opaque `stimulusSpec`/`matcherSpec` strings with typed contract bound to a per-zone catalog; covers all 6 stimulus kinds. |
| **2** | Per-zone catalog assembled from 6 source providers (runtime swagger, DI registry filtered by `[EdogDirectInvokeSeam]`, framework-endpoints.json, DAG scanner, file/timer scanner, topic-field Roslyn scan). |
| **3** | Per-zone JSON schema uses Azure strict-mode-compatible primitives only: `anyOf` per slot with literal `slotId` discriminator first, composite `topic.field` enum, `$defs`/`$ref` factoring, zone partition at >30 anyOf branches. |
| **3-bis** | Strict-mode compensation: R1–R6 schema authoring rules + build-time caps (≤100 props / ≤5 depth / ≤14K name chars / ≤450 enum / ≤7K single-enum / ≤30 anyOf branches) + P1–P4 prompt-layer patterns (early `plan` field, double-encoded soft constraints, informative retries, JSON-mode prelude). |
| **4** | Architect → Editor → Projector → Validator → Orchestrator pipeline (mostly already shipped under P9); Projector simplifies post-tightening; Validator retains all 5 gates as defense-in-depth; scenarios-per-zone formula: `clamp(3 + lines/40 + symbols/3 + slots + depthBonus, 3, 10)`. |
| **5.1** | Workbench layout: three-column workbench (left = scenario list, middle = stimulus builder, right = matcher builder). |
| **5.2** | Matcher assertion vocabulary: 7 types — `equals`, `notEquals`, `exists`, `inRange`, `containsAll`, `oneOf`, `length`. Identical for LLM and human authoring. No regex / format-string surface. |
| **5.3** | Matchers per scenario: flat array, cap 6 enforced via system-prompt rule + Validator post-emission gate (strict mode rejects `maxItems`, so the cap cannot be a schema-level constraint). |
| **5.4** | Schema-violation feedback: inline markers + collapsible "Issues (N)" strip + transient toasts for orchestrator events. |
| **5.5** | Slot-picker: type-ahead combo with rich labels (slotId + path/signature + summary + capture-field names + idempotency dot). |
| **5.6** | Inline last-run result panels per scenario card; existing results view retained for cross-scenario analytics. |
| **5.7** | Replace existing workbench in place. No opaque-JSON authoring path remains. |
| **6.1** | Catalog hash granularity: per-stimulus-kind hash + per-referenced-matcher-catalog hashes. |
| **6.2** | Stimulus delivery: single FLT DevMode endpoint `POST /devmode/qa/dispatch` with discriminated payload; HTTP stays on real network. |
| **6.2-bis** | No cleanup mechanism. Dispatch endpoint is synchronous; per-kind timeout (DAG=5min, FileEvent=30s, DI=30s, SignalR=5s, TimerTick=10s); on timeout scenario verdict = `inconclusive`. |
| **6.3** | Pre-contract scenario migration: quarantine all and force regeneration. |
| **6.4** | Catalog-hash mismatch handling: soft reject + `stale` verdict state + one-click regenerate. |
| **6.5** | Catalog freshness: fresh fetch per run; single snapshot for the whole run. |
| **7.1** | LNT011 (format-string-literal) severity = **Error**. |
| **7.2** | LNT001 / LNT003 / LNT004 retained at **Error** as defense-in-depth. |
| **7.3** | Contract-health telemetry surface: logs only; in-product panel deferred to follow-up. |
| **8.1** | Rollout = big-bang. All 6 kinds shipped + enabled together. |
| **8.2** | Rollback = kill switch (`qa.contract.enabled`) + per-kind emergency disable (`qa.contract.disabledKinds`); default all-on. |
| **8.3** | Pre-merge bar: 8 named gates G1–G8 + 4-agent sign-off + sandbox smoke + ADR file + cross-repo FLT-first sequencing + CI-spun live FLT for G3 (recorded-fixture fallback only if CI infeasible). |
| **9.1** | 7 success metrics M1–M7 measured over first 4 weeks; M6 at ±5%. |
| **9.2** | 12-risk register (R1–R12) accepted with stated mitigations. |
| **9.3** | Subagent expert consults (research agent for LLM/AI, rubber-duck for backend) in parallel post-spec-write; escalate to human review if substantial findings; consult findings + responses included as Appendix C. |

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
| `DiInvocation` | DI registry, filtered by `[EdogDirectInvokeSeam]` opt-in attribute | `POST /devmode/qa/dispatch` |
| `SignalRBroadcast` | `data/framework-endpoints.json` (existing FLT registry) | `POST /devmode/qa/dispatch` |
| `DagTrigger` | New DAG scanner over FLT DAG definitions | `POST /devmode/qa/dispatch` (waits for run completion) |
| `FileEvent` | New file/timer scanner over `IFileSystemWatcher` registrations | `POST /devmode/qa/dispatch` |
| `TimerTick` | New file/timer scanner over `ITimerService` registrations | `POST /devmode/qa/dispatch` |

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
  "perKind": {
    "HttpRequest": {
      "kindHash": "sha256(...)",
      "slots": [
        {
          "slotId": "http.dag.runs.list",
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
      "http.response.dag.runs": { "fields": { "status": "integer", "items[].runId": "string", "items[].state": "string", "items[].startedAt": "datetime" } },
      "signalr.LiveTableHub.rowAdded": { "fields": { "tableId": "string", "rowId": "string", "ts": "datetime" } }
      // ...
    }
  }
}
```

### 2.2 Source providers (six)

| Provider | Source | Code location |
|---|---|---|
| `HttpSlotProvider` | `swagger_runtime.fetch_runtime_swagger` (MWC-token-authed `/swagger/v1/swagger.json` from FLT) | `scripts/swagger_runtime.py` (existing) |
| `DiSlotProvider` | FLT `/devmode/di-registry` filtered by `[EdogDirectInvokeSeam]` attribute (cross-repo dependency — see Appendix B) | `EdogQaDiRegistryProvider.cs` (extend) |
| `SignalRSlotProvider` | `data/framework-endpoints.json` (existing hand-curated registry) | `scripts/flt_catalog.py` (extend) |
| `DagSlotProvider` | New Roslyn scan over FLT DAG definitions (`*Dag.cs` files with `[DagDefinition]` attribute) | `EdogQaDagScanner.cs` (new) |
| `FileTimerSlotProvider` | New Roslyn scan over `IFileSystemWatcher` / `ITimerService` registrations in DI setup | `EdogQaFileTimerScanner.cs` (new) |
| `TopicFieldProvider` | Existing OmniSharp/Roslyn scan over anonymous-type expressions in topic-router code paths (extends `EdogQaOmniSharpProvider`) | `EdogQaOmniSharpProvider.cs` (extend) |

All providers run inside the existing `EdogQaContractCatalog` assembler (new file). The assembler is invoked once per zone at orchestrator init time. Errors from any provider yield an *operator-visible* zone-degradation flag rather than a silent fallback.

### 2.3 Catalog hash strategy

Per Section 6.1: each scenario carries a `catalogHashes` object covering the catalogs it references:

```jsonc
{
  "stimulusKindHash": "sha256(catalog.perKind.HttpRequest.slots)",
  "matcherTopicHashes": {                  // only the topics this scenario's matchers reference
    "http.response.dag.runs": "sha256(...)",
    "signalr.LiveTableHub.rowAdded": "sha256(...)"
  }
}
```

Executor compares against the freshly-assembled catalog at run start (Section 6.5). Any mismatch on either field → scenario verdict = `stale` (Section 6.4).

### 2.4 Catalog build-time invariants (Section 3-bis caps)

The assembler **must** assert before emitting a schema for a zone:

- Total object properties ≤ **100** (Azure strict cap = 100)
- Maximum nesting depth ≤ **5** (Azure strict cap = 5)
- Total string-name characters ≤ **14 000** (Azure strict cap = 15 000; we leave 1 000 slack)
- Total enum values across schema ≤ **450** (Azure strict cap = 500; 50 slack)
- Per-single-enum ≤ **7 000 chars** (Azure strict cap = 7 500; 500 slack)
- Per-`anyOf` branch count ≤ **30** (we partition the zone if exceeded)

Violation throws `CatalogSchemaCapacityException(zoneId, limitTripped, observedValue)`. Orchestrator catches, marks zone `schema-overflow`, logs `catalog.schema.overflow` telemetry, and refuses to author contract scenarios for that zone with an operator-visible error pointing at the specific cap tripped. No silent degradation.

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
    "plan":      { "type": "string" },                       // P1 — early reasoning channel
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
    "Params_http_dag_runs_list": { ... typed per slot from catalog ... },
    "Matcher":      { "type": "object", "required": ["topicField","assertion","value"],
                      "properties": { "topicField": {"type":"string","enum":["http.response.dag.runs.status","http.response.dag.runs.items[].runId", ...]},  // composite enum
                                      "assertion":  {"type":"string","enum":["equals","notEquals","exists","inRange","containsAll","oneOf","length"]},
                                      "value":      {"anyOf": [{"$ref":"#/$defs/Value_string"}, {"$ref":"#/$defs/Value_integer"}, {"$ref":"#/$defs/Value_datetime"}, {"$ref":"#/$defs/Value_oneOfBranch"}]} } }
    // ...
  }
}
```

### 3.2 Authoring rules (R1–R6 from Section 3-bis)

| Rule | Statement |
|---|---|
| **R1** | Every union uses `anyOf` with a **literal discriminator field first** (e.g., `"kind": {"const": "HttpRequest"}` ranked first in `properties`). FSM prefix coalescence is faster + more accurate than nested anyOf. |
| **R2** | Every bare `const` carries a sibling `type` declaration (empirically required by Azure strict mode despite docs being ambiguous). |
| **R3** | Aggressive `$defs` / `$ref` factoring. No duplicated typed value shapes. |
| **R4** | Topic.field uses **dotted composite enum** (`"http.response.dag.runs.status"`), not nested `topic` + `field` anyOf. |
| **R5** | Partition the zone schema if any `anyOf` exceeds **30 branches**. Partitioning splits the schema into multiple Editor requests, each with a slice of slots; results merged. |
| **R6** | Soft constraints (e.g., "use a realistic value, not a placeholder") encoded in the schema's `description` fields, where the model reads them; *also* repeated in the system-message rule list (R6 = double-encoding). |

### 3.3 Strict-mode rejected primitives (empirically confirmed)

Do **not** use any of: `oneOf`, `allOf`, `not`, `if`/`then`/`else`, `minItems`, `maxItems`, `uniqueItems`, `minContains`, `maxContains`, `contains`, `pattern`, `format`, `minLength`, `maxLength`, `minimum`, `maximum`, `multipleOf`. Bare `const` without sibling `type` rejected.

Verified by `scripts/smoke_test_strict_schema.py` (chat-completions) and `scripts/smoke_test_strict_schema_pro.py` (responses). Both pass; both are retained as regression tests against future schema changes.

### 3.4 Wire protocol per model

| Model | Endpoint | Format envelope | API version |
|---|---|---|---|
| `gpt-5.4` | `/chat/completions` | `response_format: {type: "json_schema", json_schema: {...}}` | `2025-04-01-preview` |
| `gpt-5.4-pro` | `/responses` | `text.format: {type: "json_schema", ...}` (flat, no nested `json_schema`) | `v1` or `preview` |

Capability probe (`EdogQaCapabilityProbe.cs:36-255`) selects the right wire shape per role; existing fallback chain `ARCHITECT → PRO → default` applies.

---

## 3-bis. Strict-mode compensation patterns

The schema constraints in §3 cover *structural* validity. The patterns below close the gap on *semantic* validity that strict mode alone won't enforce.

### 3-bis.1 Prompt-layer patterns (P1–P4)

| Pattern | Implementation |
|---|---|
| **P1 — Early `plan` field** | Editor schema declares `plan: string` as the **first** property of the root. Model emits its reasoning into the field before generating scenarios — providing a reasoning channel that strict mode cannot deny, and giving us a window into model intent for audit. |
| **P2 — Double-encoded soft constraints** | Each soft rule (e.g., "use realistic identifiers, not `id-1`") appears both in the schema's `description` field *and* in the system message's rule list. Models attend to both surfaces. |
| **P3 — Informative retries** | On strict-schema violation, the repair-loop user message includes the specific JSON-pointer path + violation reason: `"Rule violated at $.scenarios[2].stimulus.slotId — value 'foo' is not in the enum [...]. Re-emit only the affected scenarios."`. Not a blind "try again." Implemented in `EdogQaScenarioOrchestrator` T1e repair loop. |
| **P4 — JSON-mode prelude** | System message contains the literal word "JSON" (Azure requirement when `response_format.type=json_schema`). Plus an explicit phrase: *"Emit only JSON conforming to the provided schema. Do not include explanatory prose."* |

### 3-bis.2 Build-time guards

As §2.4. Catalog assembler enforces 6 numeric caps before emitting the schema.

### 3-bis.3 Three honest residuals (Section 9.2 R1/R2/R3)

The schema layer cannot catch:

1. **Cross-field semantic mismatch** (R1): scenario picks a GET slot but matcher asserts on a row mutation. Mitigated by `mutates: bool` flag on each slot, enforced post-projection by the Validator's existing topic-consistency gate.
2. **Reasoning-model self-argument** (R2): model "convinces itself" inside hidden CoT to emit a structurally-valid but contextually-wrong slot. No fix at the schema or LLM layer. Surfaced via execution-failure rate telemetry; routinely reviewed by Sentinel.
3. **Structurally-identical slots, different semantics** (R3): two HTTP endpoints with identical typed shapes but different roles. Mitigated by including the slot's XML doc-comment as `purpose` text in the catalog, surfaced in the slot-picker UI rich label and in the schema's `description`.

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
scenariosPerZone = clamp(3 + floor(linesChanged/40) + floor(symbolsTouched/3) + reachableSlotCount + depthBonus,
                          MIN=3, MAX=10)
```

Where:
- `linesChanged` = diff lines in the zone
- `symbolsTouched` = distinct API/DI/topic symbols modified
- `reachableSlotCount` = total slots across all 6 kinds in this zone's catalog
- `depthBonus` = `2` if the zone touches multiple stimulus kinds, else `0`

Budget gate at the orchestrator: `min(formulaResult, tokenBudget × 0.9 ÷ avgTokensPerScenario)`.

### 4.3 Architect / Editor handoff

- **Architect** receives: PR diff slice for this zone, the assembled catalog (read-only summary form), and prior-test excerpts. Emits `ArchitectPlan { behavioralChanges[], scenarioSketches[], grounding[] }` per existing `BuildArchitectPlanSchema:426`.
- **Editor** receives: Architect plan + the *full* per-zone schema from §3 + the catalog (typed form). Emits typed scenarios. Existing `BuildScenarioBatchSchema:553` is the target of the Δ — its `stimulusSpec`/`matcherSpec` opaque-string fields are replaced with the typed `stimulus` and `matchers` of §3.

### 4.4 Projector simplification

`EdogQaScenarioProjector` currently parses opaque JSON-string specs into typed `Scenario` records. Under the contract the Editor output is *already* typed, so projection becomes a straight copy with audit-field preservation. Net reduction: ~150 LOC.

### 4.5 Validator gate retention

All 5 gates remain active even though some become unreachable:

| Gate | Disposition under contract |
|---|---|
| Grounding | Active; verifies cited evidence in Architect plan is real. |
| Schema-constraint | Mostly unreachable (schema already enforces); retained as audit assertion. |
| Topic | Active; verifies matcher topic.field is consistent with slot capture topic (covers Section 9.2 R1). |
| Confidence | Active; low-confidence emissions logged for telemetry (covers Section 9.2 R2). |
| Dedup | Active; cross-scenario duplicate detection. |

Sentinel mandate: do **not** delete unreachable gates. Telemetry signal of "lint never fires" is more valuable than the LOC savings.

### 4.6 Repair loop (T1e)

Existing loop in `EdogQaScenarioOrchestrator.cs:57-260`. Pattern-3 informative-retry message format:

```
ARCHITECT plan ID: {planId}
The following scenarios emitted in attempt {n} were rejected by strict schema:
  - $.scenarios[2].stimulus.slotId: value "foo" is not in the enum [http.dag.runs.list, http.tables.list, …]
  - $.scenarios[5].matchers[1].topicField: value "http.response.dag.runs.invalid_field" is not in the enum [...]

Re-emit ONLY scenarios with indices [2, 5] from attempt {n}, corrected.
Keep scenarioId values stable. Do not regenerate other scenarios.
```

Max retries: 3. After exhaustion, scenarios remain quarantined with reason `SCHEMA_REJECT_PERSISTENT` and counter ticks (per §7.3).

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

### 6.1 Per-kind + per-matcher-topic hashes

Each scenario carries (Section 6.1):

```jsonc
"catalogHashes": {
  "stimulusKindHash": "sha256(...)",     // covers catalog.perKind[scenario.stimulus.kind].slots
  "matcherTopicHashes": {                // one per topic actually referenced by this scenario's matchers
    "http.response.dag.runs":              "sha256(...)",
    "signalr.LiveTableHub.rowAdded":       "sha256(...)"
  }
}
```

Executor compares each value against the live catalog at run-start. Any single mismatch → verdict `stale`, soft reject, scenario not dispatched.

### 6.2 Dispatch endpoint (Section 6.2)

**Single new FLT endpoint:** `POST /devmode/qa/dispatch`

**Request body** (discriminated union):

```jsonc
{
  "stimulusKind": "DiInvocation" | "SignalRBroadcast" | "DagTrigger" | "FileEvent" | "TimerTick",
  "slotId":       "...",
  "params":       { ...typed per slot... },
  "timeoutMs":    30000                  // optional override; defaults from catalog
}
```

**Response body:**

```jsonc
{
  "verdict":   "completed" | "timeout" | "error",
  "captures": {
    "topics": [
      { "topic": "http.response.dag.runs", "fields": { ... } }
    ]
  },
  "errorCode":   "INVALID_SLOT" | "DI_RESOLUTION_FAILED" | "DAG_FAILED" | "TIMEOUT" | ...,
  "errorDetail": "..."
}
```

**Behaviour:**

| Kind | Invocation | Synchronous-completion semantics |
|---|---|---|
| `DiInvocation` | Resolve `slotId` via `IServiceProvider`, invoke target method with `params`, capture return value + side-effect log. | Returns when the DI method returns. Default timeout 30s. |
| `SignalRBroadcast` | Pre-fire: hook an in-process observer onto the target hub channel. Fire: send broadcast via `IHubContext<T>`. Post-fire: harvest the observer's recorded payload from the in-process buffer. | Returns when the observer has recorded what was broadcast (synchronous from the dispatcher's viewpoint, even though wire-side delivery to remote subscribers is fire-and-forget). Default timeout 5s. |
| `DagTrigger` | Trigger DAG run via FLT's DAG runtime hook with `params`. Wait for run status to reach `Completed` or `Failed`. | Returns when DAG run terminates. Default timeout 5 minutes. |
| `FileEvent` | Fire synthetic event via mocked `IFileSystemWatcher` channel; FLT's handler runs in-process. | Returns when the handler completes. Default timeout 30s. |
| `TimerTick` | Fire synthetic tick via mocked `ITimerService`; FLT's handler runs in-process. | Returns when the handler completes. Default timeout 10s. |
| `HttpRequest` | **Not handled by this endpoint.** Executor sends real HTTP over the wire. | n/a |

### 6.3 No cleanup, synchronous completion (Section 6.2-bis)

Test-induced state (DAG-run rows, OneLake files, mutated DB rows) is **not** cleaned up. Operators accept residue. Cleanup mechanism is a deliberate follow-up ADR — its design needs more thought than this spec can absorb.

The dispatch endpoint *is* synchronous: it does not return until the stimulus has finished executing. This ensures matchers can assert on actual outcomes, not race against in-flight async work. On timeout the verdict is `inconclusive` (distinct from pass / fail / stale).

### 6.4 Stale verdict on hash mismatch (Section 6.4)

When the executor sees a hash mismatch (either `stimulusKindHash` or any `matcherTopicHashes` entry):

- Scenario status → `stale`
- Verdict for this run → `stale` (not `failed`)
- Workbench shows the stale badge + "Regenerate this scenario" inline button
- "Regenerate" calls the orchestrator with a single-scenario scope, re-prompts the LLM with the current catalog, overwrites the scenario in place

Stale is recoverable. Stale is not a failure. The dashboard reports `N stale, N pass, N fail, N inconclusive` as distinct counters.

### 6.5 Pre-contract migration (Section 6.3)

On contract feature deploy, a one-time migration runs:

```sql
UPDATE scenarios SET status = 'pre-contract-quarantined' WHERE schema_version < 'p10';
```

The workbench hides quarantined scenarios behind a filter chip. They show as read-only with a "Regenerate" action that re-prompts the LLM under the new contract.

No auto-projection. Migrated scenarios *must* be regenerated to enter the contract regime. This preserves Sentinel's invariant: "every scenario in the DB was authored under the contract."

### 6.6 Per-run fresh catalog (Section 6.5)

At run start (single scenario or batch):
1. Executor calls `EdogQaContractCatalog.BuildAsync(zone, devModeAuth)` for each unique zone in the run.
2. Computes per-kind + per-topic hashes.
3. Compares against each scenario's hashes.
4. Dispatches non-stale scenarios; marks stale ones.
5. Catalog is cached for the run's duration; discarded on completion.

UI surfaces "Loading catalog…" → "Catalog ready: HTTP 47 slots, DI 12 slots, …" before run begins.

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
| `qa.contract.lnt.fired` | `{ ruleId: "LNT001"|"LNT003"|"LNT004"|"LNT011", zoneId, scenarioId, detail }` |
| `qa.contract.hash.mismatch` | `{ zoneId, scenarioId, mismatchKind: "stimulusKind"|"matcherTopic", expectedHash, actualHash }` |
| `qa.contract.dispatch.timeout` | `{ zoneId, scenarioId, stimulusKind, slotId, timeoutMs }` |
| `qa.contract.catalog.overflow` | `{ zoneId, limitTripped, observedValue }` |
| `qa.contract.validator.gate_failed` | `{ zoneId, scenarioId, gate, reason }` |
| `qa.contract.scenario.outcome` | `{ zoneId, scenarioId, outcome: "pass"|"fail"|"stale"|"inconclusive"|"quarantined" }` |

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
      "disabledKinds": []                       // per-kind emergency override; default empty
    }
  }
}
```

**Effects:**

| State | Behaviour |
|---|---|
| `enabled: false` | Contract scenarios are unreadable in workbench, executor refuses to run, generation paused. Banner: "QA temporarily disabled." Total feature blackout. |
| `enabled: true, disabledKinds: []` | Default. All 6 kinds active. |
| `enabled: true, disabledKinds: ["DagTrigger"]` | DAG slots removed from catalog output; DAG branch dropped from Editor schema's `anyOf` root; existing DAG scenarios marked `stale`; other 5 kinds continue. |

Flags are config-reload-watched. Flip applies within ~5 seconds with no restart. Emergency rollback path is sub-minute.

No dormant legacy opaque-JSON code path. Sentinel veto on dual-surface authoring (5.7) is honored absolutely. The legacy workbench code is *deleted*, not dormant.

### 8.3 Pre-merge quality gates (Section 8.3)

| Gate | What it proves | Implementation |
|---|---|---|
| **G1** | Every emitted schema passes Azure strict mode | Existing `scripts/smoke_test_strict_schema.py` + new test that runs against `BuildScenarioBatchSchema` output for every zone shape in a fixture set. Exit 0 = pass. |
| **G2** | All 6 catalog providers emit valid non-empty catalogs for representative zones | New unit test per provider; assert ≥1 slot per kind on fixture; assert hash is stable across runs; assert schema validates. |
| **G3** | Each of the 6 stimulus kinds dispatches end-to-end against a live FLT | **CI-spun live FLT** (preferred). Falls back to recorded fixture only if live CI infrastructure proves infeasible during implementation. Vex's call. |
| **G4** | Re-running QA against PR 977882 produces zero LNT001/003/004/011 fires | Replay harness — provided PR diff + repo snapshot → full pipeline → assert lint output empty for those rules. Also replay on 2 additional recent PRs (Sentinel picks them). |
| **G5** | All pre-contract scenarios in a fixture DB transition to `pre-contract-quarantined` on deploy | Migration unit test against a seeded DB with mixed shapes. |
| **G6** | Per-kind emergency disable removes the kind from UI, schema, and executor with other kinds still working | New integration test that toggles `disabledKinds` mid-run; assert UI + schema + executor all consistent. |
| **G7** | `/devmode/qa/dispatch` is **absent** from Release-build FLT swagger | Build pipeline check in `workload-fabriclivetable`. Hard-fails the release build if the route is present. |
| **G8** | All telemetry counters from §7.3 fire under the relevant code path | Single test that exercises one path per counter and asserts the log line appears. |

**Additional pre-merge requirements:**

- All 4 hivemind agents (Vex, Pixel, Sentinel, Sana) sign off in the PR review thread.
- Smoke test against a fresh FLT deploy in a sandbox capacity (not just local CI).
- ADR filed in `docs/adr/` covering the contract surface decision.
- Cross-repo dependency: FLT's `[EdogDirectInvokeSeam]` attribute + `/devmode/qa/dispatch` endpoint PR must merge **before** the EDOG PR. EDOG PR may not merge until the FLT main branch contains the dependency.

### 8.4 Cross-repo sequencing

**Phase 0 — FLT repo (`workload-fabriclivetable`)**
1. Add `[EdogDirectInvokeSeam]` attribute definition.
2. Apply attribute to opt-in service classes (Sana + FLT team curate the initial set).
3. Add `POST /devmode/qa/dispatch` endpoint behind the existing DevMode gate.
4. Add G7 build-time assertion.
5. Merge to main. Tag for EDOG consumption.

**Phase 1 — EDOG repo (`edog-studio`)**
1. Implement Section 2's `EdogQaContractCatalog` + 6 providers.
2. Implement Section 3's schema generator.
3. Wire Section 4's pipeline deltas (Editor schema swap, Projector simplification).
4. Implement Section 5's workbench (replace in place).
5. Implement Section 6's executor extension + dispatch client.
6. Implement Section 7's telemetry + LNT011.
7. Implement Section 8.2's config gates.
8. Run G1–G8 + agent sign-off + sandbox smoke.
9. Merge to main. Big-bang go-live.

**Phase 2 — Post-deploy**
1. Operators flip per-zone "Regenerate" to migrate pre-contract scenarios.
2. Sentinel monitors telemetry against Section 9.1 metrics for 4 weeks.
3. If M1–M7 all met → success criteria reached; ship follow-ups (Contract Health panel, cleanup ADR, etc.).
4. If any metric missed → triggered rollback per Section 9.1's per-metric playbook.

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
| **R2** | Reasoning-model self-argument in hidden CoT. | Medium | Validator confidence + grounding gates active; low-confidence emissions logged for review. No fix at LLM layer. |
| **R3** | Structurally-identical slots with different semantics. | Low-Medium | Each slot's `purpose` text (from controller XML doc-comments) included in catalog, surfaced in slot-picker rich label + schema `description`. Execution-failure rate telemetry surfaces the wrong-slot pattern. |
| **R4** | Dispatch endpoint = new attack surface in FLT. DevMode-only, but if DevMode auth is bypassed an attacker invokes arbitrary DI services. | High *if* exploited; Low likelihood | G7 build-time assertion ensures absence from Release builds. Dispatch handler logs every invocation with caller identity + slot + params. Operator alert on calls outside DevMode sessions. |
| **R5** | Catalog-build-time strict-mode cap exception — a zone with >500 enum values or >100 props fails catalog assembly. | Medium | Per-zone partition at 30 anyOf branches. If still over cap, zone marked `schema-overflow` and excluded from contract authoring with operator-visible error pointing at the specific cap tripped. |
| **R6** | Big-bang blast radius — 6 kinds, ~2500 LOC, single PR train. | High | G1–G8 + 4-agent sign-off + sandbox smoke + per-kind emergency disable. Acceptable given the bar set. |
| **R7** | One-time token cost on rollout for regenerating quarantined pre-contract scenarios. | Low | Documented in rollout runbook. Cost bounded by number of zones with existing scenarios. |
| **R8** | SignalR async-broadcast race — matcher checks before broadcast arrives. | Medium | Dispatch endpoint uses synchronous "broadcast then immediately observe via in-process subscriber" pattern; matcher reads from in-process buffer, not the wire. |
| **R9** | `/responses` latency on gpt-5.4-pro for the Architect role. | Low | Existing capability probe falls back to `gpt-5.4` when `gpt-5.4-pro` is unavailable/slow. Repair loop tolerates retries. |
| **R10** | Cross-repo coupling — EDOG PR depends on FLT PR. | Medium | Phase 0/1 sequencing enforced. EDOG PR gated on FLT main containing the dependency. |
| **R11** | Frontend complexity drop — three-column workbench + inline last-run + Issues strip + slot picker + matcher composer in one PR. | Medium | Pixel splits the frontend into 3 component-tested chunks landing in sequence within the same PR train (left column → middle column → right column). Each chunk passes G-tests independently. |
| **R12** | Reasoning-trace privacy — `/responses` may include reasoning excerpts in audit logs. | Low | Audit logger redacts `/responses` body to keep only `output` field. Confirm in code review. |

### 9.3 Pre-implementation expert consultation gate (Section 9.3)

Before invoking writing-plans:

1. **Spec written** (this document).
2. **Spec self-review** by Donna.
3. **User reviews this spec.**
4. **Parallel expert consults:**
   - **`research` agent** (LLM/AI expert): schema authoring (anyOf-per-slot, composite topic.field enum, $defs factoring, strict-mode compensation §3-bis), prompt strategy, repair loop, model fallback chain, R1/R2/R3/R9 mitigations. Cites current literature on structured outputs + JSON-schema-with-LLMs + reasoning-model behaviour.
   - **`rubber-duck` agent** (backend expert): dispatch endpoint architecture, in-process invokers per kind, DevMode gating + G7 production absence guarantee, catalog assembler design, cross-repo FLT coupling, executor synchronicity + timeouts, R4/R5/R8/R10 mitigations.
5. **Findings + Donna's responses** appended to this spec as **Appendix C**.
6. **Escalate to human review** (Option γ) only if the subagents surface substantial findings.
7. **Final spec approval** from Hemant.
8. **Invoke writing-plans skill** to produce the implementation plan.
9. **Implementation plan also reviewed** by both expert agents (Sentinel's bar).
10. **Implementation begins.**

---

## Appendix A — File-by-file change inventory

### EDOG repo

| File | Δ |
|---|---|
| `src/backend/DevMode/EdogQaLlmClient.cs` | Replace lines 610 (`stimulusSpec: string`) + 631 (`matcherSpec: string`) with typed `stimulus` + `matchers` per §3. Add `plan: string` to root schema (P1). Add informative-retry payload formatter for repair loop (P3). |
| `src/backend/DevMode/EdogQaContractCatalog.cs` | **New.** Catalog assembler + 6 source providers + §2.4 cap assertions. |
| `src/backend/DevMode/EdogQaDagScanner.cs` | **New.** Roslyn scan for `[DagDefinition]`-decorated DAG classes. |
| `src/backend/DevMode/EdogQaFileTimerScanner.cs` | **New.** Roslyn scan for `IFileSystemWatcher` / `ITimerService` registrations. |
| `src/backend/DevMode/EdogQaDiRegistryProvider.cs` | Extend with `[EdogDirectInvokeSeam]` attribute filter. |
| `src/backend/DevMode/EdogQaOmniSharpProvider.cs` | Extend topic-field scan to include anonymous-type member name discovery for matcher topic.field catalog. |
| `src/backend/DevMode/EdogQaScenarioProjector.cs` | Simplify — Editor output now typed; remove opaque-string parsing (~150 LOC reduction). |
| `src/backend/DevMode/EdogQaScenarioValidator.cs` | Retain all 5 gates. Add `mutates`-consistency check in topic gate (R1). |
| `src/backend/DevMode/EdogQaScenarioOrchestrator.cs` | Add scenarios-per-zone formula (§4.2). Update T1e repair loop with P3 informative retries. Add config gate for `qa.contract.disabledKinds`. |
| `src/backend/DevMode/EdogQaScenarioLinter.cs` | Add LNT011 (format-string-literal). Retain LNT001/003/004 at Error. |
| `src/backend/DevMode/EdogQaExecutionEngine.cs` | Add catalog-hash comparison + `stale` verdict. Wire to `EdogQaStimulusDispatcher` for non-HTTP kinds. Add per-kind capture parsing. |
| `src/backend/DevMode/EdogQaStimulusDispatcher.cs` | Extend with dispatch-endpoint client for all 5 non-HTTP kinds. Per-kind timeout enforcement. Capture-buffer reading for SignalRBroadcast. |
| `src/backend/DevMode/EdogQaAssertionEngine.cs` | Wire 7-type matcher vocabulary (`equals`/`notEquals`/`exists`/`inRange`/`containsAll`/`oneOf`/`length`) per §5.2 typed-value branches. |
| `src/backend/DevMode/EdogQaFeatureFlags.cs` | Add `qa.contract.enabled` + `qa.contract.disabledKinds` flag definitions and config-reload watcher per §8.2. |
| `src/backend/DevMode/EdogQaRunStore.cs` | Add migration that marks pre-contract scenarios `pre-contract-quarantined` per §6.3. Surface `stale` / `inconclusive` verdict states for persistence + retrieval. |
| `src/backend/DevMode/EdogQaModels.cs` | Add `CatalogHashes` field to `Scenario`. Add `Verdict.Stale`. Add `Verdict.Inconclusive`. |
| `src/backend/DevMode/EdogQaTelemetry.cs` | Add the 9 contract-health event emitters from §7.3. |
| `scripts/dev-server.py` | Add `/api/contract/catalog/{zoneId}` proxy if needed (existing swagger / DI registry proxies likely suffice). |
| `src/frontend/js/qa-curation.js` + paired CSS | Rewrite in place to host the three-column workbench (§5). Slot-picker, matcher composer, Issues strip, Last-run strip. |
| `src/frontend/js/qa-analysis.js` | Add catalog-health strip; wire to backend catalog fetch. |
| `config/edog-config.template.json` | Add `qa.contract.enabled` + `qa.contract.disabledKinds` defaults. |
| `data/framework-endpoints.json` | Extend if SignalR registry needs additions for the dispatch endpoint. |

### FLT repo (`workload-fabriclivetable`) — cross-repo

| File | Δ |
|---|---|
| `Service/.../Attributes/EdogDirectInvokeSeamAttribute.cs` | **New.** Marker attribute. |
| Various service class files | Apply `[EdogDirectInvokeSeam]` to the opt-in subset (Sana + FLT team curate). |
| `Service/.../DevMode/QaDispatchController.cs` | **New.** `POST /devmode/qa/dispatch` endpoint. DevMode-gated. Discriminated handler with 5 invokers. |
| Release pipeline | Add G7 hard-assertion that `/devmode/qa/dispatch` is absent from Release swagger. |

---

## Appendix B — Cross-repo FLT changes

See §8.4 Phase 0. The FLT PR is a hard prerequisite for EDOG PR merge. Sequence:

1. FLT PR opens with `[EdogDirectInvokeSeam]` + `QaDispatchController` + G7 pipeline check.
2. FLT team reviews + merges.
3. EDOG PR opens after FLT main contains the dependency.
4. EDOG PR's G2/G3 tests run against FLT main builds.

Estimated FLT-side LOC: ~250 (attribute + 5 invokers + DevMode wrapper + tests).

---

## Appendix C — Pre-implementation expert consultation gate

**Status:** Pending. Will be populated after §9.3 expert consults complete.

**Section to add per agent:**

```
### C.1 — research agent (LLM/AI expert) findings

[Date]
[Findings, organized by spec section]
[Donna's response to each finding]
[Resulting spec amendments]

### C.2 — rubber-duck agent (backend expert) findings

[Date]
[Findings, organized by spec section]
[Donna's response to each finding]
[Resulting spec amendments]

### C.3 — Human escalation (if triggered)

[Names, date, findings, resolutions]
```

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
