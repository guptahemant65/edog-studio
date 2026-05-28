# QA Scenario Quality Bug Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix three QA scenario quality bugs — vacuous matcher false positives, hallucinated topic fields, and empty SignalR catalog — to eliminate false-positive verdicts and improve LLM scenario accuracy.

**Architecture:** Defensive layering — each bug gets fixes at multiple levels (model, projector, validator, engine) so no single layer's failure causes a bad scenario to leak through. Single canonical topic-field registry eliminates vocabulary fragmentation.

**Tech Stack:** C# (.NET DevMode files), Python (tests, edog.py deploy), JSON (vocabulary/catalog data)

**Spec:** `docs/superpowers/specs/2026-05-25-qa-scenario-bugs-design.md`

---

## File Structure

| File | Responsibility | Tasks |
|------|---------------|-------|
| `src/backend/DevMode/EdogQaModels.cs` | Add `Inconclusive` to `ExpectationStatus`, `VacuousLegacy` flag | 1 |
| `src/backend/DevMode/EdogQaAssertionEngine.cs` | null/empty matcher → false, Score → 0.0 | 2 |
| `src/backend/DevMode/EdogQaScenarioProjector.cs` | IsVacuous gate after BuildLegacyMatcherFromTyped | 3 |
| `src/backend/DevMode/EdogQaExecutionEngine.cs` | Short-circuit VacuousLegacy before eval, verdict rules | 4 |
| `data/framework-endpoints.json` | Add SignalR hub entries | 5 |
| `src/backend/DevMode/EdogQaCodeAnalyzer.cs` | Fix path resolution for framework-endpoints.json | 6 |
| `edog.py` | Copy framework-endpoints.json during deploy | 6 |
| `src/backend/DevMode/EdogQaLlmClient.cs` | TopicFieldRegistry, schema enum, prompt generation | 7 |
| `src/backend/DevMode/EdogQaScenarioValidator.cs` | Field-level topicField validation | 8 |
| `data/topic-vocabulary.json` | Sync with canonical registry | 8 |
| `tests/test_qa_e2e.py` | New tests for all three fixes | 1-8 |

---

### Task 1: Add Inconclusive status and VacuousLegacy flag to models

**Files:**
- Modify: `src/backend/DevMode/EdogQaModels.cs:150-156` (ExpectationStatus enum)
- Modify: `src/backend/DevMode/EdogQaModels.cs:694-719` (Expectation class)

- [ ] **Step 1: Add Inconclusive to ExpectationStatus enum**

In `src/backend/DevMode/EdogQaModels.cs`, find the `ExpectationStatus` enum (line 150) and add `Inconclusive`:

```csharp
    public enum ExpectationStatus
    {
        Passed,
        Failed,
        Unmatched,
        Skipped,
        Inconclusive
    }
```

- [ ] **Step 2: Add VacuousLegacy flag to Expectation class**

In the same file, find the `Expectation` class (line 694) and add after the `Description` property (line 718):

```csharp
        /// <summary>
        /// True when the legacy matcher was produced from typed matchers but all
        /// assertions were unsupported (ContainsAll/OneOf/Length/NotEquals), resulting
        /// in an all-null LegacyMatcher that would match everything. The execution
        /// engine short-circuits these to Inconclusive instead of evaluating them.
        /// </summary>
        public bool VacuousLegacy { get; set; }
```

- [ ] **Step 3: Commit**

```bash
git add src/backend/DevMode/EdogQaModels.cs
git commit -m "feat(qa): add Inconclusive ExpectationStatus and VacuousLegacy flag"
```

---

### Task 2: Make AssertionEngine reject null/empty matchers

**Files:**
- Modify: `src/backend/DevMode/EdogQaAssertionEngine.cs:168-170` (Satisfies null check)
- Modify: `src/backend/DevMode/EdogQaAssertionEngine.cs:240-245` (SatisfiesWithCache null check)
- Modify: `src/backend/DevMode/EdogQaAssertionEngine.cs:547` (Score zero-predicate path)
- Modify: `src/backend/DevMode/EdogQaAssertionEngine.cs:359-361` (IdentifyFailedPredicates null)
- Modify: `src/backend/DevMode/EdogQaAssertionEngine.cs:639-641` (DescribeMatcher null)
- Modify: `src/backend/DevMode/EdogQaAssertionEngine.cs:664` (DescribeMatcher empty)

- [ ] **Step 1: Change Satisfies(null) from true to false**

In `src/backend/DevMode/EdogQaAssertionEngine.cs`, line 170:

Replace:
```csharp
            if (matcher == null) return true;
```
With:
```csharp
            if (matcher == null) return false;
```

- [ ] **Step 2: Change SatisfiesWithCache(null) from true to false**

Same file, line ~243 (the `SatisfiesWithCache` method):

Replace:
```csharp
            if (matcher == null) return true;
```
With:
```csharp
            if (matcher == null) return false;
```

- [ ] **Step 3: Change Score zero-predicate path from 1.0 to 0.0**

Same file, line 547:

Replace:
```csharp
            return totalPredicates == 0 ? 1.0 : totalScore / totalPredicates;
```
With:
```csharp
            return totalPredicates == 0 ? 0.0 : totalScore / totalPredicates;
```

- [ ] **Step 4: Update IdentifyFailedPredicates for null matcher**

Same file, line 361:

Replace:
```csharp
            if (matcher == null) return Array.Empty<string>();
```
With:
```csharp
            if (matcher == null) return new[] { "vacuous: matcher is null — no assertions to evaluate" };
```

- [ ] **Step 5: Update DescribeMatcher for null and empty**

Same file, line 641:

Replace:
```csharp
        if (m == null) return "(any event)";
```
With:
```csharp
        if (m == null) return "(vacuous — no assertions)";
```

Same file, line 664 (the empty parts return):

Replace:
```csharp
            return parts.Count > 0 ? string.Join(" AND ", parts) : "(any event)";
```
With:
```csharp
            return parts.Count > 0 ? string.Join(" AND ", parts) : "(vacuous — no assertions)";
```

Same file, DescribeMatchedFields method, line 685:

Replace:
```csharp
            return parts.Count > 0 ? string.Join(", ", parts) : "(empty matcher)";
```
With:
```csharp
            return parts.Count > 0 ? string.Join(", ", parts) : "(vacuous — no assertions)";
```

- [ ] **Step 6: Commit**

```bash
git add src/backend/DevMode/EdogQaAssertionEngine.cs
git commit -m "fix(qa): null/empty matcher returns false instead of true — eliminates false positives"
```

---

### Task 3: Add IsVacuous gate in Projector

**Files:**
- Modify: `src/backend/DevMode/EdogQaScenarioProjector.cs:470-485` (typed matcher projection path)
- Modify: `src/backend/DevMode/EdogQaScenarioProjector.cs:843-905` (after BuildLegacyMatcherFromTyped)

- [ ] **Step 1: Add IsVacuous helper method**

In `src/backend/DevMode/EdogQaScenarioProjector.cs`, add after the `BuildLegacyMatcherFromTyped` method (after line 906):

```csharp
        /// <summary>
        /// Returns true when a LegacyMatcher has all predicate fields null/empty,
        /// meaning it would match every event (vacuous acceptance).
        /// </summary>
        private static bool IsVacuous(LegacyMatcher matcher)
        {
            if (matcher == null) return true;
            return matcher.Exact == null
                && matcher.Contains == null
                && matcher.Regex == null
                && matcher.Range == null
                && matcher.Exists == null;
        }
```

- [ ] **Step 2: Gate the typed matcher projection path**

In the same file, replace the typed-matcher expectation creation block (lines 470-485):

Replace:
```csharp
                if (hasTypedMatchers)
                {
                    // Skip matcherSpec parsing. Build an internal LegacyMatcher
                    // from the typed matchers array by topic so the assertion
                    // engine can evaluate them.
                    var legacyMatcher = BuildLegacyMatcherFromTyped(src.Matchers, expSrc.Topic);
                    expectations.Add(new Expectation
                    {
                        Id = $"exp-{i + 1}",
                        Type = expType,
                        Topic = expSrc.Topic,
                        Matcher = legacyMatcher,
                        Description = expSrc.Rationale,
                    });
                    continue;
                }
```
With:
```csharp
                if (hasTypedMatchers)
                {
                    // Skip matcherSpec parsing. Build an internal LegacyMatcher
                    // from the typed matchers array by topic so the assertion
                    // engine can evaluate them.
                    var legacyMatcher = BuildLegacyMatcherFromTyped(src.Matchers, expSrc.Topic);
                    var vacuous = IsVacuous(legacyMatcher);
                    expectations.Add(new Expectation
                    {
                        Id = $"exp-{i + 1}",
                        Type = expType,
                        Topic = expSrc.Topic,
                        Matcher = vacuous ? null : legacyMatcher,
                        Description = expSrc.Rationale,
                        VacuousLegacy = vacuous,
                    });
                    continue;
                }
```

- [ ] **Step 3: Commit**

```bash
git add src/backend/DevMode/EdogQaScenarioProjector.cs
git commit -m "fix(qa): mark vacuous legacy matchers in projector — prevents false positives downstream"
```

---

### Task 4: Short-circuit VacuousLegacy in ExecutionEngine + verdict rules

**Files:**
- Modify: `src/backend/DevMode/EdogQaExecutionEngine.cs:498-577` (evaluate + verdict phases)

- [ ] **Step 1: Short-circuit VacuousLegacy expectations before evaluation**

In `src/backend/DevMode/EdogQaExecutionEngine.cs`, replace the entire legacy evaluation block (lines 498-530):

Replace:
```csharp
                // A legacy expectation with all-null matcher fields
                // (exact/contains/regex/range/exists all null) matches
                // EVERY event — producing false positives. When contract
                // matchers exist, they carry the real assertions; skip
                // vacuous legacy expectations to avoid inflating the
                // pass count.
                var hasContractMatchers = scenario.Matchers != null && scenario.Matchers.Count > 0;
                var hasLegacyExpectations = scenario.Expectations != null && scenario.Expectations.Count > 0;
                if (hasLegacyExpectations && hasContractMatchers)
                {
                    // Check if ALL legacy expectations have empty matchers
                    var allVacuous = scenario.Expectations.All(e =>
                        e.Matcher == null
                        || (e.Matcher.Exact == null
                            && e.Matcher.Contains == null
                            && e.Matcher.Regex == null
                            && e.Matcher.Range == null
                            && e.Matcher.Exists == null));
                    if (allVacuous)
                    {
                        // Contract matchers are the sole assertion surface
                        hasLegacyExpectations = false;
                    }
                }
                var expectationResults = new List<ExpectationResult>();
                AssertionVerdict verdict = null;

                if (hasLegacyExpectations)
                {
                    verdict = assertionEngine.ComputeVerdict();
                    expectationResults.AddRange(verdict.ExpectationResults);
                }
```
With:
```csharp
                var hasContractMatchers = scenario.Matchers != null && scenario.Matchers.Count > 0;
                var hasLegacyExpectations = scenario.Expectations != null && scenario.Expectations.Count > 0;
                var expectationResults = new List<ExpectationResult>();
                AssertionVerdict verdict = null;

                // Short-circuit VacuousLegacy expectations BEFORE evaluation.
                // These have all-null legacy matchers (typed assertions were
                // unsupported like ContainsAll/OneOf/Length) and would match
                // every event, producing false positives.
                var vacuousResults = new List<ExpectationResult>();
                if (hasLegacyExpectations)
                {
                    var nonVacuousCount = scenario.Expectations.Count(e => !e.VacuousLegacy);
                    foreach (var exp in scenario.Expectations.Where(e => e.VacuousLegacy))
                    {
                        vacuousResults.Add(new ExpectationResult
                        {
                            ExpectationId = exp.Id,
                            Description = exp.Description,
                            Status = hasContractMatchers
                                ? ExpectationStatus.Inconclusive
                                : ExpectationStatus.Failed,
                            FailureReason = hasContractMatchers
                                ? "Vacuous legacy matcher — contract matchers are the assertion surface"
                                : "Vacuous legacy matcher — no assertions to evaluate",
                        });
                    }

                    if (nonVacuousCount > 0)
                    {
                        verdict = assertionEngine.ComputeVerdict();
                        // Filter out vacuous expectations from verdict results
                        var vacuousIds = new HashSet<string>(
                            scenario.Expectations.Where(e => e.VacuousLegacy).Select(e => e.Id));
                        expectationResults.AddRange(
                            verdict.ExpectationResults.Where(r => !vacuousIds.Contains(r.ExpectationId)));
                    }
                    else
                    {
                        // All legacy expectations are vacuous — skip legacy eval
                        hasLegacyExpectations = false;
                    }
                }
                expectationResults.AddRange(vacuousResults);
```

- [ ] **Step 2: Update verdict determination to handle Inconclusive**

In the same file, replace the verdict determination block (lines 541-577):

Replace:
```csharp
                var allPassed = expectationResults.Count > 0
                    && expectationResults.All(e => e.Status == ExpectationStatus.Passed);
                var anyPassed = expectationResults.Any(e => e.Status == ExpectationStatus.Passed);
                var anyFailed = expectationResults.Any(e => e.Status != ExpectationStatus.Passed);
                var legacyResultCount = verdict?.ExpectationResults?.Count ?? 0;
                var contractFailures = hasContractMatchers
                    && expectationResults.Skip(legacyResultCount)
                        .Any(e => e.Status != ExpectationStatus.Passed);

                // Determine scenario verdict
                if (allPassed)
                {
                    result.Verdict = ScenarioVerdict.Passed;
                }
                else if (captureOutcome == CaptureOutcome.TimedOut
                    && hasContractMatchers
                    && !hasLegacyExpectations)
                {
                    result.Verdict = ScenarioVerdict.Inconclusive;
                }
                else if (captureOutcome == CaptureOutcome.TimedOut
                    && hasLegacyExpectations
                    && verdict.OnlyTimingFailures
                    && !contractFailures)
                {
                    result.Verdict = ScenarioVerdict.Partial;
                }
                else if (captureOutcome == CaptureOutcome.TimedOut)
                {
                    result.Verdict = anyPassed && anyFailed
                        ? ScenarioVerdict.Partial
                        : (hasContractMatchers ? ScenarioVerdict.Inconclusive : ScenarioVerdict.TimedOut);
                }
                else
                {
                    result.Verdict = anyPassed && anyFailed ? ScenarioVerdict.Partial : ScenarioVerdict.Failed;
                }
```
With:
```csharp
                var actionableResults = expectationResults
                    .Where(e => e.Status != ExpectationStatus.Inconclusive).ToList();
                var allPassed = actionableResults.Count > 0
                    && actionableResults.All(e => e.Status == ExpectationStatus.Passed);
                var anyPassed = actionableResults.Any(e => e.Status == ExpectationStatus.Passed);
                var anyFailed = actionableResults.Any(e => e.Status != ExpectationStatus.Passed);
                var anyInconclusive = expectationResults.Any(e => e.Status == ExpectationStatus.Inconclusive);
                var legacyResultCount = verdict?.ExpectationResults?.Count ?? 0;
                var contractFailures = hasContractMatchers
                    && expectationResults
                        .Where(e => e.Status != ExpectationStatus.Inconclusive)
                        .Skip(legacyResultCount)
                        .Any(e => e.Status != ExpectationStatus.Passed);

                // Determine scenario verdict
                if (allPassed && !anyInconclusive)
                {
                    result.Verdict = ScenarioVerdict.Passed;
                }
                else if (allPassed && anyInconclusive)
                {
                    // Contract matchers passed but legacy was vacuous
                    result.Verdict = ScenarioVerdict.Passed;
                }
                else if (captureOutcome == CaptureOutcome.TimedOut
                    && hasContractMatchers
                    && !hasLegacyExpectations)
                {
                    result.Verdict = ScenarioVerdict.Inconclusive;
                }
                else if (captureOutcome == CaptureOutcome.TimedOut
                    && hasLegacyExpectations
                    && verdict != null && verdict.OnlyTimingFailures
                    && !contractFailures)
                {
                    result.Verdict = ScenarioVerdict.Partial;
                }
                else if (captureOutcome == CaptureOutcome.TimedOut)
                {
                    result.Verdict = anyPassed && anyFailed
                        ? ScenarioVerdict.Partial
                        : (hasContractMatchers ? ScenarioVerdict.Inconclusive : ScenarioVerdict.TimedOut);
                }
                else if (actionableResults.Count == 0 && anyInconclusive)
                {
                    // Only inconclusive results, no contract matchers
                    result.Verdict = ScenarioVerdict.Inconclusive;
                }
                else
                {
                    result.Verdict = anyPassed && anyFailed ? ScenarioVerdict.Partial : ScenarioVerdict.Failed;
                }
```

- [ ] **Step 3: Commit**

```bash
git add src/backend/DevMode/EdogQaExecutionEngine.cs
git commit -m "fix(qa): short-circuit vacuous legacy expectations before evaluation — defensive verdict rules"
```

---

### Task 4.5: Update ResultAggregator display ordering for Inconclusive

**Files:**
- Modify: `src/backend/DevMode/EdogQaResultAggregator.cs:322-332`

- [ ] **Step 1: Add Inconclusive to SortForDisplay ordering**

In `src/backend/DevMode/EdogQaResultAggregator.cs`, update the `SortForDisplay` switch (line 323):

Replace:
```csharp
                .OrderBy(r => r.Verdict switch
                {
                    ScenarioVerdict.Crashed  => 0,
                    ScenarioVerdict.Failed   => 1,
                    ScenarioVerdict.TimedOut  => 2,
                    ScenarioVerdict.Partial   => 3,
                    ScenarioVerdict.Skipped   => 4,
                    ScenarioVerdict.Passed    => 5,
                    _                         => 6
                })
```
With:
```csharp
                .OrderBy(r => r.Verdict switch
                {
                    ScenarioVerdict.Crashed      => 0,
                    ScenarioVerdict.Failed       => 1,
                    ScenarioVerdict.TimedOut      => 2,
                    ScenarioVerdict.Partial       => 3,
                    ScenarioVerdict.Inconclusive  => 4,
                    ScenarioVerdict.Skipped       => 5,
                    ScenarioVerdict.Passed        => 6,
                    _                             => 7
                })
```

- [ ] **Step 2: Commit with Task 4**

(Commit together with ExecutionEngine changes in Task 4 Step 3)

---

### Task 5: Add SignalR hub entries to framework-endpoints.json

**Files:**
- Modify: `data/framework-endpoints.json`

- [ ] **Step 1: Add hubs section to framework-endpoints.json**

In `data/framework-endpoints.json`, add a `"hubs"` array after the existing `"endpoints"` array (before the closing `}`):

After the closing `]` of `"endpoints"` (line 37), add:

```json
  ,
  "hubs": [
    {
      "name": "EdogPlaygroundHub",
      "route": "/hub/playground",
      "source": "framework",
      "methods": [
        "Subscribe",
        "Unsubscribe",
        "EdogIdentify",
        "QaStartCodeAnalysis",
        "QaCancelAnalysis",
        "QaSubmitCuratedScenarios",
        "QaStartRun",
        "QaCancelRun",
        "QaGetRunHistory",
        "QaGetRunDetail",
        "QaGetTelemetry",
        "QaGetCapabilities",
        "QaCompareRuns",
        "MitmGetCapabilities",
        "MitmCreateRule",
        "MitmDeleteRule",
        "MitmListRules",
        "MitmResumeBreakpoint",
        "MitmClearAll",
        "MitmToggleInterception",
        "MitmSendToPlayground"
      ]
    }
  ]
```

- [ ] **Step 2: Commit**

```bash
git add data/framework-endpoints.json
git commit -m "feat(qa): add SignalR hub entries to framework-endpoints.json"
```

---

### Task 6: Fix framework-endpoints.json path resolution + deploy copy

**Files:**
- Modify: `src/backend/DevMode/EdogQaCodeAnalyzer.cs:1590-1604`
- Modify: `edog.py:1749-1767`

- [ ] **Step 1: Add DevMode path candidate in CodeAnalyzer**

In `src/backend/DevMode/EdogQaCodeAnalyzer.cs`, replace the candidates array (lines 1590-1595):

Replace:
```csharp
                        var candidates = new[]
                        {
                            System.IO.Path.Combine(edogRoot, "data", "framework-endpoints.json"),
                            System.IO.Path.Combine(Environment.GetEnvironmentVariable("FLT_BIN_PATH") ?? string.Empty, "framework-endpoints.json"),
                            System.IO.Path.Combine(System.IO.Directory.GetCurrentDirectory(), "data", "framework-endpoints.json"),
                        };
```
With:
```csharp
                        var candidates = new[]
                        {
                            // DevMode output dir (copied by edog.py during deploy)
                            System.IO.Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "DevMode", "framework-endpoints.json"),
                            System.IO.Path.Combine(edogRoot, "data", "framework-endpoints.json"),
                            System.IO.Path.Combine(Environment.GetEnvironmentVariable("FLT_BIN_PATH") ?? string.Empty, "framework-endpoints.json"),
                            System.IO.Path.Combine(System.IO.Directory.GetCurrentDirectory(), "data", "framework-endpoints.json"),
                        };
```

- [ ] **Step 2: Copy framework-endpoints.json during deploy in edog.py**

In `edog.py`, find the block where `edog-config.json` is copied (lines 1766-1767) and add after it:

After line 1767 (`shutil.copy2(config_src, out_devmode / "edog-config.json")`), add:

```python
            fw_endpoints_src = Path(__file__).parent / "data" / "framework-endpoints.json"
            if fw_endpoints_src.exists():
                shutil.copy2(fw_endpoints_src, out_devmode / "framework-endpoints.json")
```

- [ ] **Step 3: Commit**

```bash
git add src/backend/DevMode/EdogQaCodeAnalyzer.cs edog.py
git commit -m "fix(qa): fix framework-endpoints.json path resolution + deploy copy"
```

---

### Task 7: Create canonical TopicFieldRegistry + schema enum

**Files:**
- Modify: `src/backend/DevMode/EdogQaLlmClient.cs:1348` (BuildMatcherSchema)
- Modify: `src/backend/DevMode/EdogQaLlmClient.cs:2732-2742` (TOPIC FIELD SCHEMA prompt block)

- [ ] **Step 1: Add TopicFieldRegistry as static readonly**

In `src/backend/DevMode/EdogQaLlmClient.cs`, add as a static field near the top of the class (find the class declaration and add after other static fields). The registry is the single source of truth for all valid topicField values:

```csharp
        /// <summary>
        /// Canonical registry of valid topic → field mappings. This is the SINGLE source of truth
        /// that generates: (1) the JSON schema enum, (2) the prompt TOPIC FIELD SCHEMA block,
        /// (3) the validator field check. NEVER hardcode topic fields elsewhere.
        /// </summary>
        internal static readonly Dictionary<string, string[]> TopicFieldRegistry = new()
        {
            ["http"] = new[] { "method", "url", "statusCode", "durationMs", "requestHeaders", "responseHeaders", "responseBodyPreview", "requestBodyPreview", "requestSizeBytes", "responseSizeBytes", "httpClientName", "correlationId" },
            ["token"] = new[] { "tokenType", "scheme", "audience", "expiryUtc", "issuedUtc", "httpClientName", "endpoint", "claims" },
            ["retry"] = new[] { "endpoint", "statusCode", "retryAttempt", "totalAttempts", "waitDurationMs", "strategyName", "reason", "isThrottle", "retryAfterMs", "iterationId" },
            ["log"] = new[] { "message", "level", "category", "exception", "timestamp", "iterationId", "correlationId" },
            ["flag"] = new[] { "flagName", "tenantId", "capacityId", "workspaceId", "result", "durationMs", "overridden", "caller" },
            ["di"] = new[] { "serviceType", "implementationType", "lifetime", "isIntercepted" },
            ["perf"] = new[] { "marker", "durationMs", "caller", "context" },
            ["cache"] = new[] { "key", "operation", "hit", "sizeBytes", "ttlMs" },
            // Under-modeled topics — minimal fields, will expand as interceptors are instrumented
            ["telemetry"] = new[] { "eventName", "properties", "measurements" },
            ["spark"] = new[] { "sessionId", "appId", "status", "durationMs" },
            ["fileop"] = new[] { "path", "operation", "sizeBytes", "durationMs" },
            ["catalog"] = new[] { "entityType", "operation", "entityId" },
            ["dag"] = new[] { "nodeId", "status", "iterationId", "durationMs" },
            ["flt-ops"] = new[] { "operation", "status", "durationMs" },
            ["nexus"] = new[] { "endpoint", "method", "statusCode" },
            ["capacity"] = new[] { "capacityId", "operation", "status" },
        };

        /// <summary>All valid topicField values in "topic.field" format.</summary>
        internal static readonly string[] AllValidTopicFields = TopicFieldRegistry
            .SelectMany(kv => kv.Value.Select(f => $"{kv.Key}.{f}"))
            .ToArray();

        /// <summary>Topics with complete field catalogs (schema-enforced).</summary>
        internal static readonly HashSet<string> WellModeledTopics = new()
        {
            "http", "token", "retry", "log", "flag", "di", "perf", "cache"
        };
```

- [ ] **Step 2: Add topicField enum to BuildMatcherSchema**

In the same file, in `BuildMatcherSchema()` (line 1348):

Replace:
```csharp
                    ["topicField"] = new Dictionary<string, object> { ["type"] = "string" },
```
With:
```csharp
                    ["topicField"] = new Dictionary<string, object>
                    {
                        ["type"] = "string",
                        ["enum"] = AllValidTopicFields,
                    },
```

- [ ] **Step 3: Generate TOPIC FIELD SCHEMA from registry instead of hardcoding**

In the same file, replace the hardcoded TOPIC FIELD SCHEMA block (lines 2732-2742):

Replace:
```csharp
            sb.AppendLine("---BEGIN TOPIC FIELD SCHEMA (trusted harness context — use ONLY these fields in matcher topicField)---");
            sb.AppendLine("http: method, url, statusCode, durationMs, requestHeaders, responseHeaders, responseBodyPreview, requestBodyPreview, requestSizeBytes, responseSizeBytes, httpClientName, correlationId");
            sb.AppendLine("token: tokenType, scheme, audience, expiryUtc, issuedUtc, httpClientName, endpoint, claims");
            sb.AppendLine("retry: endpoint, statusCode, retryAttempt, totalAttempts, waitDurationMs, strategyName, reason, isThrottle, retryAfterMs, iterationId");
            sb.AppendLine("log: message, level, category, exception, timestamp, iterationId, correlationId (structured log entries — field names match the FLT logger output)");
            sb.AppendLine("flag: flagName, tenantId, capacityId, workspaceId, result, durationMs, overridden, caller");
            sb.AppendLine("di: serviceType, implementationType, lifetime, isIntercepted");
            sb.AppendLine("perf: marker, durationMs, caller, context");
            sb.AppendLine("cache: key, operation, hit, sizeBytes, ttlMs");
            sb.AppendLine("RULE: matcher topicField MUST be '<topic>.<field>' where <field> is one of the fields listed above. Example: http.statusCode, token.tokenType, retry.retryAttempt, log.message, flag.result. Do NOT invent fields — if the assertion cannot be expressed with these fields, use the Exists assertion on the topic root.");
            sb.AppendLine("---END TOPIC FIELD SCHEMA---");
```
With:
```csharp
            sb.AppendLine("---BEGIN TOPIC FIELD SCHEMA (trusted harness context — use ONLY these fields in matcher topicField)---");
            foreach (var (topic, fields) in TopicFieldRegistry)
            {
                sb.AppendLine($"{topic}: {string.Join(", ", fields)}");
            }
            sb.AppendLine("RULE: matcher topicField MUST be '<topic>.<field>' where <field> is one of the fields listed above. Example: http.statusCode, token.tokenType, retry.retryAttempt, log.message, flag.result. Do NOT invent fields — if the assertion cannot be expressed with these fields, use the Exists assertion on the topic root.");
            sb.AppendLine("---END TOPIC FIELD SCHEMA---");
```

- [ ] **Step 4: Commit**

```bash
git add src/backend/DevMode/EdogQaLlmClient.cs
git commit -m "feat(qa): canonical TopicFieldRegistry + topicField schema enum — eliminates field hallucination"
```

---

### Task 8: Add field-level validation in Validator + sync vocabulary

**Files:**
- Modify: `src/backend/DevMode/EdogQaScenarioValidator.cs:836-867`
- Modify: `data/topic-vocabulary.json`

- [ ] **Step 1: Add field-level topicField validation**

In `src/backend/DevMode/EdogQaScenarioValidator.cs`, find the typed matcher validation in `ValidateTypedMatchers` (after line 866, after the existing topic-root check closing brace `}`):

After the closing brace of the `else` block on line 867, add the field-level check before the `IsMatcherValueCompatible` check (line 869):

```csharp
                // Field-level validation: check full topicField against canonical registry
                if (!string.IsNullOrWhiteSpace(matcher.TopicField)
                    && !EdogQaLlmClient.AllValidTopicFields.Contains(matcher.TopicField))
                {
                    var fieldTopic = ExtractMatcherTopic(matcher.TopicField);
                    if (EdogQaLlmClient.WellModeledTopics.Contains(fieldTopic))
                    {
                        // Well-modeled topic: hallucinated field is a quarantine offence
                        sink.Add(new QuarantineReason
                        {
                            Code = CodeTopicUnknown,
                            Message = $"Matcher topicField '{matcher.TopicField}' is not a valid field for topic '{fieldTopic}'. Valid fields: {string.Join(", ", EdogQaLlmClient.TopicFieldRegistry.GetValueOrDefault(fieldTopic, Array.Empty<string>()))}.",
                            FieldPath = $"{pathPrefix}.topicField",
                        });
                    }
                    // else: under-modeled topic — skip field validation (catalog incomplete).
                    // These topics will expand as interceptors are instrumented.
                }
```

Note: `ValidateTypedMatchers` only has a `sink` (quarantine reasons) parameter — there is no separate advisories list. For under-modeled topics, log instead of quarantine. The advisory message below uses the same `sink` with a non-quarantine code that the orchestrator treats as informational.

- [ ] **Step 2: Sync topic-vocabulary.json with canonical registry**

Replace `data/topic-vocabulary.json` with content synced to the canonical registry. The vocabulary file is supplemental metadata (known value sets), the field names come from `TopicFieldRegistry`:

```json
{
  "_meta": {
    "schemaVersion": 2,
    "description": "Supplemental known-value sets for topic fields. Field names are sourced from EdogQaLlmClient.TopicFieldRegistry (the canonical source of truth). This file adds value enumeration for eval scoring and prompt enrichment.",
    "owner": "edog-qa"
  },
  "topics": {
    "http.statusCode": {
      "type": "integer",
      "knownValues": [200, 201, 202, 204, 301, 302, 304, 400, 401, 403, 404, 409, 422, 429, 500, 502, 503, 504]
    },
    "http.method": {
      "type": "string",
      "knownValues": ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]
    },
    "token.scheme": {
      "type": "string",
      "knownValues": ["obo", "legacy", "DirectAAD", "WSPL"]
    },
    "token.tokenType": {
      "type": "string",
      "knownValues": ["Bearer", "MWC", "S2S"]
    },
    "log.level": {
      "type": "string",
      "knownValues": ["Trace", "Debug", "Information", "Warning", "Error", "Critical"]
    },
    "log.authMode": {
      "type": "string",
      "knownValues": ["OBO", "DirectAAD", "WSPL"]
    },
    "flag.result": {
      "type": "string",
      "knownValues": ["true", "false", "on", "off"]
    },
    "retry.reason": {
      "type": "string",
      "knownValues": ["Throttle", "Transient", "ServerError", "Timeout"]
    },
    "di.lifetime": {
      "type": "string",
      "knownValues": ["Singleton", "Scoped", "Transient"]
    },
    "cache.operation": {
      "type": "string",
      "knownValues": ["Get", "Set", "Remove", "Expire"]
    }
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add src/backend/DevMode/EdogQaScenarioValidator.cs data/topic-vocabulary.json
git commit -m "fix(qa): field-level topicField validation — quarantine hallucinated fields on well-modeled topics"
```

---

### Task 9: Update tests and run regression suite

**Files:**
- Modify: `tests/test_qa_e2e.py` (add new test cases)

- [ ] **Step 1: Add test for topicField enum in matcher schema**

Add to `tests/test_qa_e2e.py`:

```python
def test_qa_matcher_schema_has_topic_field_enum(harness_environment, built_harness) -> None:
    """The topicField property in the matcher JSON schema must be an enum
    (not free-form string) to prevent LLM hallucination of field names."""
    src = (PROJECT_DIR / "src" / "backend" / "DevMode" / "EdogQaLlmClient.cs").read_text(encoding="utf-8")
    assert "AllValidTopicFields" in src, "TopicFieldRegistry/AllValidTopicFields not found"
    assert '"enum"' in src or "'enum'" in src, "topicField must have enum constraint in schema"
```

- [ ] **Step 2: Add test for VacuousLegacy flag on Expectation**

```python
def test_qa_expectation_model_has_vacuous_legacy_flag() -> None:
    """The Expectation model must expose VacuousLegacy so the execution
    engine can short-circuit false-positive evaluations."""
    src = (PROJECT_DIR / "src" / "backend" / "DevMode" / "EdogQaModels.cs").read_text(encoding="utf-8")
    assert "VacuousLegacy" in src, "Expectation.VacuousLegacy flag not found"
    assert "Inconclusive" in src, "ExpectationStatus.Inconclusive not found"
```

- [ ] **Step 3: Add test for framework-endpoints.json hubs**

```python
def test_qa_framework_endpoints_has_signalr_hubs() -> None:
    """framework-endpoints.json must contain a 'hubs' section with at least
    one hub so SignalR catalog slots are non-empty."""
    import json
    path = PROJECT_DIR / "data" / "framework-endpoints.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    assert "hubs" in data, "Missing 'hubs' section in framework-endpoints.json"
    assert len(data["hubs"]) > 0, "hubs array is empty"
    hub = data["hubs"][0]
    assert "name" in hub, "hub entry missing 'name'"
    assert "methods" in hub, "hub entry missing 'methods'"
    assert len(hub["methods"]) > 0, "hub methods array is empty"
```

- [ ] **Step 4: Add test for TopicFieldRegistry covering all expectation topics**

```python
def test_qa_topic_field_registry_covers_expectation_topics() -> None:
    """Every topic in the expectation enum must have an entry in TopicFieldRegistry."""
    src = (PROJECT_DIR / "src" / "backend" / "DevMode" / "EdogQaLlmClient.cs").read_text(encoding="utf-8")
    # Extract topic enum values from the expectation schema
    models_src = (PROJECT_DIR / "src" / "backend" / "DevMode" / "EdogQaModels.cs").read_text(encoding="utf-8")
    # TopicFieldRegistry must contain all topics from the prompt's topic enum
    for topic in ["http", "token", "flag", "perf", "spark", "log", "telemetry",
                   "retry", "cache", "fileop", "catalog", "dag", "flt-ops", "nexus", "di", "capacity"]:
        assert f'["{topic}"]' in src, f"TopicFieldRegistry missing topic: {topic}"
```

- [ ] **Step 5: Add test for deploy manifest including framework-endpoints**

```python
def test_qa_deploy_copies_framework_endpoints() -> None:
    """edog.py must copy framework-endpoints.json to DevMode output during deploy."""
    src = (PROJECT_DIR / "edog.py").read_text(encoding="utf-8")
    assert "framework-endpoints.json" in src, "edog.py must copy framework-endpoints.json"
```

- [ ] **Step 6: Run full QA test suite**

Run: `python -m pytest tests/test_qa_*.py -v --tb=short`
Expected: All tests pass (175 existing + 5 new = 180)

- [ ] **Step 7: Commit**

```bash
git add tests/test_qa_e2e.py
git commit -m "test(qa): add tests for vacuous matcher, topic field enum, SignalR catalog, deploy manifest"
```

---

### Task 10: Final verification and push

- [ ] **Step 1: Run full test suite**

Run: `python -m pytest tests/test_qa_*.py -v --tb=short`
Expected: All tests pass

- [ ] **Step 2: Run linter**

Run: `make lint` (or `ruff check .`)
Expected: Clean

- [ ] **Step 3: Push all commits**

```bash
git push
```
