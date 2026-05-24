# QA Scenario Quality — Three Bug Fixes

**Date:** 2026-05-25
**Author:** Sana (architecture) + Sentinel (quality)
**Scope:** F27 QA Testing — LLM pipeline scenario quality bugs

---

## Problem Statement

The QA feature generates test scenarios from PR diffs using a 3-step LLM pipeline (Analyst → Architect → Editor). Three systemic bugs cause scenarios to either produce false positives, hallucinate non-existent fields, or miss SignalR coverage entirely.

These were identified during the May 21-24 debugging session (30+ bugs found, most fixed). These three remain.

---

## Bug 1 — Vacuous Matcher False Positives

### Symptom

Scenarios report `PASSED` when no real assertion was evaluated. During the May 24 run, 11 "passed" scenarios were actually false positives — the empty matcher matched the first random log event.

### Root Cause Chain

```
LLM generates typed matchers with unsupported assertions (ContainsAll, OneOf, Length, NotEquals)
  → BuildLegacyMatcherFromTyped deliberately omits them (P10 fix P1-1, line 886-896)
  → all predicates omitted → returns LegacyMatcher with all-null fields
  → Projector attaches empty matcher to expectation (no gate, line 475-481)
  → AssertionEngine.Satisfies(event, emptyMatcher) → all predicate blocks skipped → return true (line 234)
  → false positive: scenario "passes" having asserted nothing
```

### Existing Mitigation (Partial)

Commit `f387f76` added a check in `EdogQaExecutionEngine.cs:507-522`: when ALL legacy expectations have empty matchers AND contract matchers exist, legacy expectations are skipped entirely.

### Remaining Gaps

1. When SOME expectations have empty matchers but not all, false positives still occur.
2. `EventAbsent` + vacuous matcher sees no matches → finalizes as `Passed` (finding nothing is "correct" for absence).
3. `EventCount exact: 0` + vacuous matcher can also pass.

### Fix — Defensive (3 layers)

**Layer 1 — Projector: detect and mark empty legacy matchers**

In `EdogQaScenarioProjector.cs`, after `BuildLegacyMatcherFromTyped` returns, check if the resulting matcher is vacuous (all fields null). If so:
- Set `Matcher = null` on the expectation
- Set a new flag `VacuousLegacy = true` on the `Expectation` model

```
File: src/backend/DevMode/EdogQaScenarioProjector.cs
Location: lines 470-485 (typed matcher path)
Change: after line 475 (var legacyMatcher = BuildLegacyMatcherFromTyped(...)):
  - Add IsVacuous(legacyMatcher) helper that checks all 5 fields null
  - If vacuous, set matcher to null and VacuousLegacy = true
```

**Layer 2 — AssertionEngine: null/empty matcher returns false, not true**

```
File: src/backend/DevMode/EdogQaAssertionEngine.cs
Changes:
  - Satisfies(root, null) → return false (line 170)
  - SatisfiesWithCache(root, null, ...) → return false (line 243)
  - Score(root, null) → return 0.0 (line 547: totalPredicates == 0 ? 0.0)
  - DescribeMatcher(null) → "(vacuous — no assertions)" instead of "(any event)"
```

**Layer 3 — ExecutionEngine: short-circuit VacuousLegacy BEFORE evaluation**

Do NOT rely on matcher evaluation semantics for vacuous expectations. Short-circuit the VacuousLegacy flag before normal evaluation, regardless of expectation type (EventPresent, EventAbsent, EventCount, etc.):

```
File: src/backend/DevMode/EdogQaExecutionEngine.cs
Change: Before calling ComputeVerdict(), iterate expectations and for any
  with VacuousLegacy=true:
  - If contract matchers exist → set Status = Inconclusive, reason = "empty legacy matcher — contract matchers are the assertion surface"
  - If no contract matchers exist → set Status = Failed, reason = "empty legacy matcher — no assertions to evaluate"
  Remove the expectation from the assertion engine's evaluation set so it can't produce false positives.
```

### Verdict Aggregation Rules (new)

Current verdict logic treats any `Status != Passed` as failure. With `Inconclusive`, define explicit rules:

| Scenario | Verdict |
|----------|---------|
| All passed (contract + legacy) | `Passed` |
| Any contract matcher failed | `Failed` or `Partial` |
| No failures, at least one Inconclusive | `Inconclusive` |
| Mix of pass + inconclusive + no failures | `Inconclusive` |

Update `EdogQaExecutionEngine.cs` verdict determination (line 541+) and `EdogQaResultAggregator` consumers that render non-pass as fail.

### Model Change

```
File: src/backend/DevMode/EdogQaModels.cs
Add: bool VacuousLegacy on Expectation class (default false)
Add: ExpectationStatus.Inconclusive enum value (if not present)
```

### Impact on Existing Tests

The `test_qa_broadcast_projection.py` and `test_qa_e2e.py` tests that rely on legacy matcher behavior will need assertion updates where they currently expect `true` for empty matchers. The Score path change (`0 predicates → 0.0` instead of `1.0`) may affect scoring tests in `test_qa_eval_score.py`.

---

## Bug 2 — Hallucinated Topic Fields Leak Through Validation

### Symptom

LLM invents fields like `token.oboAcquired`, `http.authMode`, `retry.transient` that don't exist on the actual interceptor events. Scenarios pass validation because the validator only checks the topic ROOT (`token` is valid) but never the field suffix (`oboAcquired` is hallucinated).

### Root Cause

1. **JSON Schema gap:** `topicField` in `BuildMatcherSchema()` (line 1348) is `{ "type": "string" }` — no enum constraint. The LLM can output any string.
2. **Validator gap:** `ValidateTypedMatchers()` (line 838) extracts the topic prefix via `ExtractMatcherTopic()` and checks it against `topicSet`, but never validates the field suffix.
3. **Vocabulary mismatch:** `data/topic-vocabulary.json` defines `telemetry.*` fields that aren't in the TOPIC FIELD SCHEMA prompt block, and the prompt block defines topics (`spark`, `fileop`, `catalog`, `dag`, etc.) with no field definitions at all.

### Fix — Two layers + canonical source

**Layer 0 — Single canonical topic-field registry**

Current state has three fragmented sources: prompt TOPIC FIELD SCHEMA block, JSON schema (no constraint), and `data/topic-vocabulary.json`. All three can drift. Consolidate to a single canonical source:

```
File: src/backend/DevMode/EdogQaLlmClient.cs
Add: private static readonly Dictionary<string, string[]> TopicFieldRegistry = new()
{
    ["http"] = new[] { "method", "url", "statusCode", "durationMs", "requestHeaders", ... },
    ["token"] = new[] { "tokenType", "scheme", "audience", "expiryUtc", ... },
    ["retry"] = new[] { "endpoint", "statusCode", "retryAttempt", ... },
    ...all topics from the expectation enum...
};
```

This registry generates:
- The JSON schema `topicField` enum (Layer 1)
- The prompt TOPIC FIELD SCHEMA block (replace hardcoded lines 2733-2740)
- The validator HashSet (Layer 2)
- Future: lint tests

**Layer 1 — JSON Schema: enum constraint on topicField**

Build the `topicField` enum dynamically from `TopicFieldRegistry`:

```
File: src/backend/DevMode/EdogQaLlmClient.cs
Location: BuildMatcherSchema() line 1348
Change: replace { "type": "string" } with:
  { "type": "string", "enum": TopicFieldRegistry.SelectMany(kv => kv.Value.Select(f => $"{kv.Key}.{f}")).ToArray() }
```

This is a hard constraint — the LLM cannot output values outside the enum.

**Layer 2 — Validator: field-level validation (tiered)**

```
File: src/backend/DevMode/EdogQaScenarioValidator.cs
Location: ValidateTypedMatchers() line 836-867
Change: after the existing topic-root check, add field-level check:
  - Build validFields HashSet from TopicFieldRegistry
  - If matcher.TopicField not in validFields:
    - If topic has a declared complete field list → quarantine (hallucinated field on well-modeled topic)
    - If topic has no field list yet → advisory warning (graceful degradation for under-modeled topics)
```

Split behavior by scenario source:
- **Generated scenarios** (from current pipeline): strict enum blocks invalid fields at generation time — the validator path is backup defense
- **Legacy/manual scenarios**: validator advisory/quarantine policy applies

**Extend TOPIC FIELD SCHEMA coverage:**

Currently the prompt only covers `http`, `token`, `retry`, `log`, `flag`, `di`, `perf`, `cache`. The expectation topic enum also includes `spark`, `fileop`, `catalog`, `dag`, `flt-ops`, `nexus`, `capacity`, `telemetry`. Add minimal field lists for these topics in the registry so the schema covers the full enum. Topics with unknown field shapes get a `_placeholder` field and are marked incomplete in the registry.

**Sync `data/topic-vocabulary.json`:**

Update to match the canonical registry. The vocabulary file becomes supplemental metadata (known value sets per field) rather than the source of truth for field names.

### Impact on Existing Tests

`test_qa_prompt_shape.py` tests that check prompt content will need updates for the expanded TOPIC FIELD SCHEMA. `test_qa_contract_models.py` tests for matcher schema shape will need the new enum. Validator tests will need cases for field-level warnings.

---

## Bug 5 — SignalR Catalog Slots Always Empty

### Symptom

The QA pipeline never generates SignalR-related scenarios because the catalog has zero SignalR slots. The diagnostic log shows "framework-endpoints.json not found — SignalR slots will be empty".

### Root Cause (Three-layered)

**Problem 1 — Path resolution:** `EdogQaCodeAnalyzer.cs:1585-1607` tries three paths, all fail at FLT runtime because the working directory is the FLT bin directory, not edog-studio.

**Problem 2 — Missing data:** `data/framework-endpoints.json` has ZERO SignalR hub entries. It only contains 2 swagger framework endpoints (`swagger.json` and Swagger UI). The `$schema` comment mentions `MapHub` but no hub entries were ever added.

**Problem 3 — Parser shape mismatch:** Even if hubs were present, `SignalRSlotProvider` expects a `"hubs"` array with objects containing `name` + `methods`. The file uses an `"endpoints"` array with a different shape (`id`, `name`, `method`, `urlTemplate`, etc.).

### Fix (Three parts)

**Part 1 — Add SignalR hub entries to framework-endpoints.json**

The FLT workload has at least one relevant SignalR hub: `EdogPlaygroundHub` mapped at `/hub/playground` (line 235 of `EdogLogServer.cs`). Add a `"hubs"` section to the file with the hub name and its Qa-prefixed methods.

```
File: data/framework-endpoints.json
Change: add "hubs" array alongside existing "endpoints":
{
  "hubs": [
    {
      "name": "EdogPlaygroundHub",
      "route": "/hub/playground",
      "methods": [
        "EdogIdentify", "QaAnalyzePr", "QaSubmitCuratedScenarios",
        "QaExecuteRun", "QaCancelRun", "QaGetRunHistory",
        ...all public hub methods
      ]
    }
  ]
}
```

**Part 2 — Fix path resolution + deploy copy**

```
File: src/backend/DevMode/EdogQaCodeAnalyzer.cs
Location: lines 1585-1608
Change: add candidate path:
  Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "DevMode", "framework-endpoints.json")
  (same pattern as edog-config.json resolution)
```

```
File: edog.py
Location: deploy flow (where edog-config.json is already copied)
Change: also copy data/framework-endpoints.json to the DevMode output directory
  - Copy AFTER build (not just before) to survive bin directory recreation
  - Log source path, destination, and file size
```

**Part 3 — Update parser to handle both shapes**

The `SignalRSlotProvider` already handles `"hubs"` arrays correctly. No parser change needed — the new `"hubs"` section in the file will be parsed by the existing code path (line 185-189). The `"endpoints"` array is a separate concern (HTTP endpoints, not SignalR hubs).

### Alternative considered

Embedding the JSON as a C# resource string was rejected — the file is updated as new SignalR hubs are discovered, and file-based loading allows hot-updating without rebuild.

### Impact on Existing Tests

`test_framework_endpoints_loader.py` and `test_framework_endpoints_lint.py` should continue to pass (they test the JSON shape — adding `"hubs"` is additive). Add a new test that `SignalRSlotProvider.FromFrameworkEndpoints()` with the real file returns slot count > 0.

---

## Files Changed (Summary)

| File | Bug | Change |
|------|-----|--------|
| `EdogQaAssertionEngine.cs` | 1 | null/empty → false, Score 0.0, describe "(vacuous)" |
| `EdogQaScenarioProjector.cs` | 1 | IsVacuous gate after BuildLegacyMatcherFromTyped |
| `EdogQaExecutionEngine.cs` | 1 | per-expectation Inconclusive for vacuous |
| `EdogQaModels.cs` | 1 | VacuousLegacy flag, Inconclusive status |
| `EdogQaLlmClient.cs` | 2 | topicField enum in schema, extended TOPIC FIELD SCHEMA |
| `EdogQaScenarioValidator.cs` | 2 | field-level advisory warning |
| `data/topic-vocabulary.json` | 2 | sync with canonical field list |
| `EdogQaCodeAnalyzer.cs` | 5 | DevMode path candidate for framework-endpoints.json |
| `edog.py` | 5 | copy framework-endpoints.json during deploy |

## Fix Ordering

Recommended execution order based on dependencies:

1. **Bug 5 first** — restore SignalR catalog slots so prompt/catalog tests reflect reality
2. **Bug 2 second** — lock topic fields after catalog/vocabulary shape is settled
3. **Bug 1 last** — assertion semantics are mostly independent, but final verdict behavior should be tested with contract matchers generated under the corrected schema

## Testing Strategy

- **Bug 1:** Update existing assertion engine tests for null → false behavior. Add test for vacuous legacy + contract matcher scenario (should be Inconclusive, not Passed). Add test for EventAbsent + vacuous (should be Inconclusive, not Passed). Update scoring tests for `totalPredicates == 0 → 0.0`. Verify verdict aggregation with mixed pass/inconclusive results.
- **Bug 2:** Add test that topicField enum is present in matcher schema (schema shape test). Add validator test for known-root/unknown-field (quarantine for well-modeled topics, advisory for under-modeled). Verify TOPIC FIELD SCHEMA prompt block covers all expectation topic enum values. Verify `TopicFieldRegistry` is the single source of truth.
- **Bug 5:** Add test that `SignalRSlotProvider.FromFrameworkEndpoints()` with real file returns slot count > 0. Add test that `framework-endpoints.json` is in deploy file manifest. Verify hub entries have correct shape.
- **Integration:** Add one end-to-end regression test: typed contract matcher using unsupported legacy assertion (OneOf), legacy projection becomes vacuous, contract matcher uses valid topic field, SignalR slot present in catalog. Assert: not passed via legacy fallback, SignalR slots non-empty.
- **Regression:** Run full `pytest tests/test_qa_*.py` suite after all changes.
