# C04: Assertion Engine

> **Component:** C04 — Assertion Engine
> **Feature:** F27 — QA Testing: AI-Driven Scenario Generation & Execution
> **Priority:** P1
> **File:** `src/backend/DevMode/EdogQaAssertionEngine.cs` (new)
> **Author:** Sana (architecture agent)
> **Status:** SPEC

---

## 0. Preamble

The Assertion Engine is the verdict machinery of F27. It takes a stream of `TopicEvent` instances captured during scenario execution and evaluates them against the scenario's `Expectation[]` array. It answers one question: **did the system behave as specified?**

This is not a post-hoc log grep. The engine operates in **streaming mode** — as each `TopicEvent` arrives from `TopicBuffer.ReadLiveAsync()`, every pending expectation is re-evaluated. Expectations turn green in the UI the instant they match. When all positive expectations are satisfied (or the timeout expires), the engine produces a final `ScenarioVerdict`.

### 0.1 Conventions (verified from source)

| Convention | Evidence |
|---|---|
| `#nullable disable` | All DevMode `.cs` files (`TopicEvent.cs:5`, `EdogTopicRouter.cs:5`) |
| `#pragma warning disable` | Same files — DevMode-only blanket suppression |
| Namespace `Microsoft.LiveTable.Service.DevMode` | `TopicEvent.cs:8`, `EdogTopicRouter.cs:8` |
| `TopicEvent` envelope: `{ SequenceId, Timestamp, Topic, Data }` | `TopicEvent.cs:17-30` |
| `TopicBuffer` ring buffer with live `Channel<TopicEvent>` | `TopicBuffer.cs:20-74` |
| `EdogTopicRouter.Publish(topic, object)` wraps Data in envelope | `EdogTopicRouter.cs:77-86` |
| Event payloads are anonymous objects (no `GetField()` method exists) | `EdogHttpPipelineHandler.cs:67-78`, `EdogCacheInterceptor.cs:46-56` |
| Serialization: `System.Text.Json` with `JsonNamingPolicy.CamelCase` | `EdogLogServer.cs:37` |

### 0.2 Critical Design Constraint: No `GetField()` on TopicEvent

The spec's pseudocode (§6.2) references `evt.GetField(field)`, but `TopicEvent.Data` is `object` — typically an anonymous type or a typed model like `LogEntry`. There is no `GetField()` method. The assertion engine must use **reflection or JSON serialization** to extract fields:

```csharp
// Strategy: serialize Data to JsonElement, then query by path
static JsonElement? ResolveField(object data, string fieldPath)
{
    var json = JsonSerializer.SerializeToElement(data, _camelCaseOptions);
    foreach (var segment in fieldPath.Split('.'))
    {
        if (json.ValueKind != JsonValueKind.Object) return null;
        if (!json.TryGetProperty(segment, out var child)) return null;
        json = child;
    }
    return json;
}
```

This is the only viable approach given that interceptor payloads are heterogeneous anonymous objects (`EdogHttpPipelineHandler.cs:67-78`) and typed models (`LogEntry` in `EdogLogModels.cs:16-46`). JSON serialization normalizes both into a queryable tree.

### 0.3 TopicEvent Data Shapes (Verified)

The engine matches against these actual payload shapes:

| Topic | Shape (from source) | Source |
|---|---|---|
| `http` | `{ method, url, statusCode, durationMs, requestHeaders, responseHeaders, responseBodyPreview, httpClientName, correlationId }` | `EdogHttpPipelineHandler.cs:67-78` |
| `retry` | `{ endpoint, statusCode, retryAttempt, totalAttempts, waitDurationMs, strategyName, reason, isThrottle, retryAfterMs, iterationId }` | `EdogRetryInterceptor.cs:186-200` |
| `cache` | `{ cacheName, operation, key, hitOrMiss, valueSizeBytes, ttlSeconds, durationMs, evictionReason }` | `EdogCacheInterceptor.cs:46-56` |
| `log` | `LogEntry { Timestamp, Level, Message, Component, RootActivityId, EventId, CustomData, IterationId, CodeMarkerName }` | `EdogLogModels.cs:16-46` |
| `telemetry` | `TelemetryEvent { Timestamp, ActivityName, ActivityStatus, DurationMs, ResultCode, CorrelationId, Attributes, UserId }` | `EdogLogModels.cs:51-60` |
| `flag` | `{ flagName, result, evaluationContext }` | Spec §4.2 example (line ~608) |
| `fileop` | `{ operation, path, contentSizeBytes, ... }` | Spec §4.2 example (line ~494) |

---

## 1. Field-Level Matchers

### 1.1 Name + ID + One-Liner

**SCN-C04-01: Field Matchers** — Evaluate `exact`, `contains`, `regex`, `range`, and `exists` predicates against individual fields in a `TopicEvent.Data` payload.

### 1.2 Detailed Description

Field matchers are the atomic units of the assertion engine. Every expectation's `matcher` object contains one or more field-level predicates grouped by type: `exact` (strict equality), `contains` (substring), `regex` (pattern match), `range` (numeric bounds), and `exists` (non-null check). All predicates within a single matcher are combined with AND logic — every specified predicate must pass for the event to satisfy the matcher. Field names use dot-notation for nested access (see SCN-C04-02). The engine serializes `TopicEvent.Data` to `System.Text.Json.JsonElement` once per event, then resolves each field path against the resulting JSON tree.

### 1.3 Technical Mechanism

```csharp
public static class FieldMatcher
{
    private static readonly JsonSerializerOptions CamelCase = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase
    };

    /// <summary>
    /// Evaluates all predicates in a Matcher against a TopicEvent's Data payload.
    /// Returns true only if ALL specified predicates pass (AND logic).
    /// </summary>
    public static bool Satisfies(TopicEvent evt, Matcher matcher)
    {
        // Serialize once, query many
        JsonElement root;
        try
        {
            root = JsonSerializer.SerializeToElement(evt.Data, CamelCase);
        }
        catch
        {
            return false; // Unserializable payload — cannot match
        }

        // exact: field value equals expected (string comparison after ToString)
        if (matcher.Exact != null)
        {
            foreach (var (field, expected) in matcher.Exact)
            {
                var resolved = ResolveField(root, field);
                if (resolved == null) return false;
                if (!ValueEquals(resolved.Value, expected)) return false;
            }
        }

        // contains: field value contains substring
        if (matcher.Contains != null)
        {
            foreach (var (field, substring) in matcher.Contains)
            {
                var resolved = ResolveField(root, field);
                if (resolved == null) return false;
                var str = resolved.Value.ToString();
                if (str == null || !str.Contains(substring, StringComparison.OrdinalIgnoreCase))
                    return false;
            }
        }

        // regex: field value matches pattern
        if (matcher.Regex != null)
        {
            foreach (var (field, pattern) in matcher.Regex)
            {
                var resolved = ResolveField(root, field);
                if (resolved == null) return false;
                if (!System.Text.RegularExpressions.Regex.IsMatch(
                    resolved.Value.ToString() ?? "", pattern))
                    return false;
            }
        }

        // range: numeric field within bounds
        if (matcher.Range != null)
        {
            foreach (var (field, bounds) in matcher.Range)
            {
                var resolved = ResolveField(root, field);
                if (resolved == null) return false;
                if (!resolved.Value.TryGetDouble(out var numVal)) return false;
                if (bounds.Min.HasValue && numVal < bounds.Min.Value) return false;
                if (bounds.Max.HasValue && numVal > bounds.Max.Value) return false;
            }
        }

        // exists: field is present and non-null
        if (matcher.Exists != null)
        {
            foreach (var field in matcher.Exists)
            {
                var resolved = ResolveField(root, field);
                if (resolved == null || resolved.Value.ValueKind == JsonValueKind.Null)
                    return false;
            }
        }

        return true;
    }

    private static JsonElement? ResolveField(JsonElement root, string fieldPath)
    {
        var current = root;
        foreach (var segment in fieldPath.Split('.'))
        {
            if (current.ValueKind != JsonValueKind.Object) return null;
            if (!current.TryGetProperty(segment, out var child)) return null;
            current = child;
        }
        return current;
    }

    private static bool ValueEquals(JsonElement element, object expected)
    {
        return element.ValueKind switch
        {
            JsonValueKind.String => element.GetString() == expected?.ToString(),
            JsonValueKind.Number => element.TryGetDouble(out var d)
                && Math.Abs(d - Convert.ToDouble(expected)) < 0.0001,
            JsonValueKind.True => expected is bool b && b,
            JsonValueKind.False => expected is bool b2 && !b2,
            JsonValueKind.Null => expected == null,
            _ => element.ToString() == expected?.ToString()
        };
    }
}
```

### 1.4 Source Code Path

- `TopicEvent.Data` (the matched target): `src/backend/DevMode/TopicEvent.cs:29`
- HTTP event payload shape: `src/backend/DevMode/EdogHttpPipelineHandler.cs:67-78`
- Cache event payload shape: `src/backend/DevMode/EdogCacheInterceptor.cs:46-56`
- Retry event payload shape: `src/backend/DevMode/EdogRetryInterceptor.cs:186-200`
- LogEntry typed model: `src/backend/DevMode/EdogLogModels.cs:16-46`
- Matcher schema definition: `docs/specs/features/F27-qa-testing/spec.md` §4.1 (lines 424-459)

### 1.5 Edge Cases

| Case | Behavior |
|---|---|
| Field path resolves to `null` | Predicate FAILS (except for `exists` which explicitly checks this) |
| `TopicEvent.Data` is not serializable | Event is skipped (returns `false`), logged to debug output |
| Numeric field contains string (e.g., `"200"` vs `200`) | `TryGetDouble` handles JSON numbers; string values fail range checks |
| Regex with invalid pattern | `Regex.IsMatch` throws → catch and return false, emit diagnostic |
| Empty matcher (no predicates) | Returns `true` — matches ANY event on the specified topic |
| `contains` with empty string | Always matches (substring check on empty string returns true) |
| Case sensitivity | `exact` is case-sensitive; `contains` is case-insensitive; `regex` follows pattern flags |

### 1.6 Interactions

| Component | Interaction |
|---|---|
| C01 (Code Understanding Engine) | Generates matchers — must produce field names matching actual interceptor payload shapes |
| C02 (Scenario Generator) | Embeds matchers in `Expectation.matcher` objects |
| C03 (Execution Engine) | Feeds captured `TopicEvent` stream to the assertion engine |
| C05 (Results UI) | Displays per-field match/mismatch detail for failed expectations |

### 1.7 Revert/Undo Mechanism

Field matchers are pure functions — no state mutation. No revert needed. If matcher logic changes, re-evaluate the same captured event buffer with updated matchers (replay from `RecordingSession`).

### 1.8 Priority

**P0** — every other assertion type depends on field matchers as the primitive building block.

---

## 2. Nested Field Matchers

### 2.1 Name + ID + One-Liner

**SCN-C04-02: Nested Matchers** — Resolve dot-delimited field paths (e.g., `responseHeaders.Retry-After`) against arbitrarily nested JSON objects in event payloads.

### 2.2 Detailed Description

Interceptor payloads contain nested structures. HTTP events include `requestHeaders` and `responseHeaders` (objects), `LogEntry` has `CustomData` (dictionary), and future return-value captures may contain deeply nested result objects. The matcher must support dot-notation paths like `responseHeaders.Content-Type` or `returnValue.status.code`. The `ResolveField` function in SCN-C04-01 already implements this — split on `.`, walk `JsonElement.TryGetProperty` at each level. Array indexing (e.g., `items.0.name`) is a P2 extension; V1 supports object nesting only.

### 2.3 Technical Mechanism

```csharp
// Already shown in SCN-C04-01 ResolveField. Key behavior:
// "responseHeaders.Retry-After" → root["responseHeaders"]["Retry-After"]
// "returnValue.result.status"   → root["returnValue"]["result"]["status"]

// JSON property names are camelCase due to JsonNamingPolicy.CamelCase.
// Matcher field paths must use camelCase:
//   CORRECT: "statusCode"        (matches EdogHttpPipelineHandler.cs:71)
//   WRONG:   "StatusCode"        (won't match — CamelCase policy lowercased it)

// For LogEntry (typed model), CamelCase policy transforms:
//   LogEntry.RootActivityId  →  "rootActivityId"
//   LogEntry.CustomData      →  "customData"
```

### 2.4 Source Code Path

- HTTP `responseHeaders` (nested object): `src/backend/DevMode/EdogHttpPipelineHandler.cs:74`
- LogEntry `CustomData` (Dictionary): `src/backend/DevMode/EdogLogModels.cs:41`
- TelemetryEvent `Attributes` (Dictionary): `src/backend/DevMode/EdogLogModels.cs:60`
- JSON serialization policy: `src/backend/DevMode/EdogLogServer.cs:37`

### 2.5 Edge Cases

| Case | Behavior |
|---|---|
| Path segment doesn't exist | `TryGetProperty` returns false → `null` → predicate fails |
| Path traverses a non-object (e.g., `statusCode.nested` where `statusCode` is a number) | `ValueKind != Object` check → `null` → fails |
| Dictionary keys with dots (e.g., `customData` key = `"some.key"`) | Ambiguous — V1 treats `.` as separator always. Document as limitation. |
| Property names with special characters (e.g., `Retry-After`) | Works — `TryGetProperty` handles hyphenated names |
| Array at intermediate level | V1 does not support array indexing — path resolution returns null |

### 2.6 Interactions

| Component | Interaction |
|---|---|
| C02 (Scenario Generator) | Must produce field paths using camelCase, matching `JsonNamingPolicy.CamelCase` output |
| C01 (Code Understanding) | Roslyn analysis of interceptor `Publish()` call sites reveals actual field names |

### 2.7 Revert/Undo Mechanism

None needed — pure function. No state.

### 2.8 Priority

**P0** — required for matching against HTTP headers, log custom data, and return values.

---

## 3. Streaming Evaluation

### 3.1 Name + ID + One-Liner

**SCN-C04-03: Streaming Evaluation** — Evaluate expectations incrementally as `TopicEvent` instances arrive from `TopicBuffer.ReadLiveAsync()`, updating match state in real-time.

### 3.2 Detailed Description

The assertion engine does not wait for the scenario to complete before evaluating. It subscribes to relevant `TopicBuffer` live channels (one per topic referenced by any expectation) and evaluates every arriving event against all pending (unmatched) expectations. When an expectation matches, the engine immediately emits an `ExpectationMatched` signal to the frontend via SignalR, causing the expectation row in the execution monitor to turn green. This provides real-time progress feedback. The engine also maintains a `PendingExpectationSet` — when all positive expectations are satisfied and the absence grace period expires, execution can short-circuit without waiting for the full timeout.

### 3.3 Technical Mechanism

```csharp
public sealed class StreamingEvaluator : IDisposable
{
    private readonly Scenario _scenario;
    private readonly DateTimeOffset _t0;            // stimulus timestamp
    private readonly CancellationTokenSource _cts;
    private readonly Dictionary<string, ExpectationState> _states;
    private readonly Action<string, string, bool> _onMatch; // scenarioId, expId, passed

    public StreamingEvaluator(
        Scenario scenario,
        DateTimeOffset stimulusTimestamp,
        Action<string, string, bool> onExpectationMatched)
    {
        _scenario = scenario;
        _t0 = stimulusTimestamp;
        _cts = new CancellationTokenSource();
        _onMatch = onExpectationMatched;
        _states = new Dictionary<string, ExpectationState>();

        foreach (var exp in scenario.Expectations)
            _states[exp.Id] = new ExpectationState(exp);
    }

    /// <summary>
    /// Main evaluation loop. Call once after stimulus. Returns when:
    /// (a) all positive expectations matched + absence grace period elapsed, or
    /// (b) timeout expires.
    /// </summary>
    public async Task<ScenarioVerdict> EvaluateAsync(TimeSpan timeout)
    {
        using var timeoutCts = new CancellationTokenSource(timeout);
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(
            _cts.Token, timeoutCts.Token);

        // Subscribe to each topic referenced by expectations
        var topics = _scenario.Expectations
            .Select(e => e.Topic)
            .Distinct()
            .ToList();

        var tasks = topics.Select(t => ConsumeTopicAsync(t, linked.Token));

        try
        {
            await Task.WhenAll(tasks);
        }
        catch (OperationCanceledException)
        {
            // Expected: timeout or all-matched short-circuit
        }

        return ProduceVerdict();
    }

    private async Task ConsumeTopicAsync(string topic, CancellationToken ct)
    {
        var buffer = EdogTopicRouter.GetBuffer(topic);
        if (buffer == null) return;

        await foreach (var evt in buffer.ReadLiveAsync(ct))
        {
            // Skip events from before stimulus
            if (evt.Timestamp < _t0) continue;

            EvaluateEvent(evt);

            // Short-circuit: all positive expectations matched?
            if (AllPositiveExpectationsSatisfied())
            {
                // Wait grace period for absence assertions (2 seconds)
                await Task.Delay(2000, ct);
                _cts.Cancel(); // Signal all consumers to stop
            }
        }
    }

    private void EvaluateEvent(TopicEvent evt)
    {
        foreach (var (expId, state) in _states)
        {
            if (state.IsResolved) continue;
            if (state.Expectation.Topic != evt.Topic) continue;

            bool matches = FieldMatcher.Satisfies(evt, state.Expectation.Matcher);

            if (state.Expectation.Type == "event_present" ||
                state.Expectation.Type == "field_match")
            {
                if (matches && TimeWindowSatisfied(evt, state.Expectation)
                            && OrderSatisfied(state.Expectation))
                {
                    state.Resolve(ExpectationResult.Passed, evt);
                    _onMatch(_scenario.Id, expId, true);
                }
                else if (matches)
                {
                    state.RecordPartialMatch(evt); // Close but timing/order wrong
                }
            }
            else if (state.Expectation.Type == "event_count")
            {
                if (matches) state.IncrementCount(evt);
            }
            // event_absent and timing evaluated at finalization
        }
    }

    private bool TimeWindowSatisfied(TopicEvent evt, Expectation exp)
    {
        if (exp.TimeWindow == null) return true;
        var elapsed = evt.Timestamp - _t0;
        if (exp.TimeWindow.WithinMs.HasValue
            && elapsed.TotalMilliseconds > exp.TimeWindow.WithinMs.Value)
            return false;
        if (exp.TimeWindow.AfterMs.HasValue
            && elapsed.TotalMilliseconds < exp.TimeWindow.AfterMs.Value)
            return false;
        return true;
    }

    private bool OrderSatisfied(Expectation exp)
    {
        if (exp.Order?.After == null) return true;
        // The referenced expectation must already be resolved
        return _states.TryGetValue(exp.Order.After, out var dep) && dep.IsResolved;
    }

    private bool AllPositiveExpectationsSatisfied()
    {
        return _states.Values
            .Where(s => s.Expectation.Type != "event_absent")
            .All(s => s.IsResolved);
    }

    private ScenarioVerdict ProduceVerdict()
    {
        // Finalize count assertions
        foreach (var state in _states.Values.Where(s =>
            s.Expectation.Type == "event_count" && !s.IsResolved))
        {
            var c = state.Expectation.Count;
            bool passed = (c.Exact.HasValue && state.MatchCount == c.Exact.Value)
                || (!c.Exact.HasValue
                    && (!c.Min.HasValue || state.MatchCount >= c.Min.Value)
                    && (!c.Max.HasValue || state.MatchCount <= c.Max.Value));
            state.Resolve(passed ? ExpectationResult.Passed : ExpectationResult.Failed);
        }

        // Finalize absence assertions
        foreach (var state in _states.Values.Where(s =>
            s.Expectation.Type == "event_absent" && !s.IsResolved))
        {
            // No matching events found = PASS for absence
            state.Resolve(state.MatchCount == 0
                ? ExpectationResult.Passed
                : ExpectationResult.Failed);
        }

        // Mark any still-unresolved as failed (timeout)
        foreach (var state in _states.Values.Where(s => !s.IsResolved))
            state.Resolve(ExpectationResult.Failed);

        bool allPassed = _states.Values.All(s => s.Result == ExpectationResult.Passed);
        return new ScenarioVerdict
        {
            ScenarioId = _scenario.Id,
            Passed = allPassed,
            ExpectationResults = _states.ToDictionary(
                kvp => kvp.Key,
                kvp => kvp.Value.ToResultDetail())
        };
    }

    public void Dispose() => _cts?.Dispose();
}
```

### 3.4 Source Code Path

- `TopicBuffer.ReadLiveAsync()` (live event stream): `src/backend/DevMode/TopicBuffer.cs:70-73`
- `EdogPlaygroundHub.SubscribeToTopic()` (existing streaming pattern): `src/backend/DevMode/EdogPlaygroundHub.cs:62-106`
- `EdogTopicRouter.GetBuffer()`: `src/backend/DevMode/EdogTopicRouter.cs:60-65`
- Execution flow (CAPTURE step): `docs/specs/features/F27-qa-testing/spec.md` §5.1 (line ~654)
- SignalR `ExpectationMatched` event: `docs/specs/features/F27-qa-testing/spec.md` §8.4 (line ~1024)

### 3.5 Edge Cases

| Case | Behavior |
|---|---|
| Event arrives during serialization (race) | `TopicBuffer` uses `Channel<TopicEvent>` — thread-safe by design (`TopicBuffer.cs:34-35`) |
| 50,000+ events in a single scenario | Spec limit (`spec.md` §8.6 line ~1047). Engine skips events for already-resolved expectations to bound CPU. |
| All expectations match before timeout | Short-circuit after 2s absence grace period (spec §6.4 line ~827) |
| Zero expectations (empty array) | Schema requires `minItems: 1` (spec line ~279). Engine rejects. |
| Multiple topics subscribed simultaneously | One `Task.Run` per topic, all feeding `EvaluateEvent` — requires thread-safe `_states` access (use `lock` or `ConcurrentDictionary`) |

### 3.6 Interactions

| Component | Interaction |
|---|---|
| C03 (Execution Engine) | Creates `StreamingEvaluator`, provides `_t0`, receives `ScenarioVerdict` |
| C05 (Results UI) | Receives `ExpectationMatched` callbacks in real-time via SignalR |
| C06 (Recording Session) | Provides the scoped `TopicBuffer` snapshot start positions (spec §5.3 line ~685) |
| `EdogTopicRouter` | Source of `TopicBuffer` instances for subscription |

### 3.7 Revert/Undo Mechanism

`StreamingEvaluator` is disposable. On cancel/timeout, `_cts.Cancel()` propagates to all topic consumers. The evaluator can be re-run against the same recording session buffer (replay). No persistent state to revert.

### 3.8 Priority

**P0** — core evaluation loop. Without streaming evaluation, the engine has no real-time UX and must wait for full timeout on every scenario.

---

## 4. Temporal Ordering Assertions

### 4.1 Name + ID + One-Liner

**SCN-C04-04: Temporal Ordering** — Verify that matching events occurred in a specified sequence using the `order.after` constraint between expectations.

### 4.2 Detailed Description

Some scenarios require events in a specific order: "DI resolution before HTTP call before SQL query" or "retry attempt 1 before retry attempt 2." The spec models this with `order.after` on each expectation, referencing the ID of a predecessor expectation. The assertion engine enforces ordering by only allowing an expectation with `order.after: "exp-N"` to match AFTER `exp-N` has already been resolved. This is implemented in `OrderSatisfied()` (SCN-C04-03). Ordering is a DAG — circular dependencies are detected at scenario load time. Ordering is about wall-clock sequence (verified via `TopicEvent.Timestamp`), not just logical dependency.

### 4.3 Technical Mechanism

```csharp
// Order validation occurs in two places:

// 1. At scenario load time: detect circular dependencies
public static bool ValidateOrderGraph(Expectation[] expectations)
{
    var graph = new Dictionary<string, List<string>>();
    foreach (var exp in expectations)
    {
        graph[exp.Id] = new List<string>();
        if (exp.Order?.After != null)
            graph[exp.Id].Add(exp.Order.After);
    }
    // Topological sort — if cycle detected, return false
    return TopologicalSort(graph) != null;
}

// 2. At match time: predecessor must be resolved
private bool OrderSatisfied(Expectation exp)
{
    if (exp.Order?.After == null) return true;
    if (!_states.TryGetValue(exp.Order.After, out var predecessor))
        return false; // Referenced expectation doesn't exist
    if (!predecessor.IsResolved) return false;
    return true;
}

// 3. Timestamp validation: matched event must be after predecessor's matched event
private bool OrderTimestampValid(Expectation exp, TopicEvent candidateEvent)
{
    if (exp.Order?.After == null) return true;
    if (!_states.TryGetValue(exp.Order.After, out var pred)) return false;
    if (pred.MatchedEvent == null) return false;
    return candidateEvent.Timestamp >= pred.MatchedEvent.Timestamp;
}
```

**Example scenario (from spec §4.2):**
```json
{
  "expectations": [
    { "id": "exp-1", "type": "event_count", "topic": "retry", "count": { "min": 2 } },
    { "id": "exp-2", "type": "event_present", "topic": "retry",
      "order": { "after": "exp-1" },
      "matcher": { "range": { "waitDurationMs": { "min": 900 } } }
    },
    { "id": "exp-3", "type": "event_present", "topic": "http",
      "matcher": { "exact": { "statusCode": 201 } },
      "description": "Final request succeeds after retries"
    }
  ]
}
```

### 4.4 Source Code Path

- Order constraint schema: `docs/specs/features/F27-qa-testing/spec.md` §4.1 (lines 412-416)
- Example with ordering: `docs/specs/features/F27-qa-testing/spec.md` §4.2 (lines 556-559)
- `TopicEvent.Timestamp` (ordering basis): `src/backend/DevMode/TopicEvent.cs:23`
- `TopicEvent.SequenceId` (monotonic per topic): `src/backend/DevMode/TopicEvent.cs:20`

### 4.5 Edge Cases

| Case | Behavior |
|---|---|
| Circular dependency (`exp-1.after: exp-2`, `exp-2.after: exp-1`) | Detected at load time by `ValidateOrderGraph()`. Scenario rejected with diagnostic. |
| `order.after` references non-existent expectation ID | Predecessor check fails → expectation can never match → scenario times out. Emit warning. |
| Same-timestamp events | `TopicEvent.SequenceId` (monotonic per topic, `TopicBuffer.cs:41`) breaks ties within a topic. Cross-topic same-timestamp events: order is indeterminate — document as limitation. |
| Predecessor is an absence assertion | Absence is resolved at finalization. Any expectation with `order.after` pointing to an absence expectation will fail (absence is never "resolved" during streaming). Warn at load time. |

### 4.6 Interactions

| Component | Interaction |
|---|---|
| C02 (Scenario Generator) | Produces `order.after` references. Must ensure referenced IDs exist within same scenario. |
| C05 (Results UI) | Displays sequence diagram of matched events showing temporal order |

### 4.7 Revert/Undo Mechanism

None — ordering is a stateless check during evaluation.

### 4.8 Priority

**P1** — important for multi-step scenarios but many scenarios work without explicit ordering.

---

## 5. Absence Assertions

### 5.1 Name + ID + One-Liner

**SCN-C04-05: Absence Detection** — Verify that specific events did NOT occur during the observation window, using timeout-based confirmation.

### 5.2 Detailed Description

Absence assertions (`event_absent` type) verify negative conditions: "no error log appeared," "no cache writes when flag is off," "no retries on success path." These are inherently timeout-dependent — you can only conclude something didn't happen after waiting long enough. The engine evaluates absence assertions LAST, after all positive expectations are satisfied plus a 2-second grace period (spec §6.4). During streaming, every arriving event is still checked against absence matchers to track potential violations. If a matching event arrives, the absence assertion is immediately marked FAILED without waiting.

### 5.3 Technical Mechanism

```csharp
// In StreamingEvaluator.EvaluateEvent():
if (state.Expectation.Type == "event_absent")
{
    if (matches)
    {
        // Immediate failure — the thing that shouldn't happen DID happen
        state.Resolve(ExpectationResult.Failed, evt);
        _onMatch(_scenario.Id, expId, false);
    }
    // If no match, don't resolve yet — wait for finalization
}

// In ProduceVerdict() (after timeout or all-positive-matched + grace):
foreach (var state in _states.Values.Where(s =>
    s.Expectation.Type == "event_absent" && !s.IsResolved))
{
    // Still unresolved = no matching event ever arrived = PASS
    state.Resolve(ExpectationResult.Passed);
}
```

**Example (from spec §4.2 line 574-580):**
```json
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
```

### 5.4 Source Code Path

- Absence evaluation rule (grace period): `docs/specs/features/F27-qa-testing/spec.md` §6.4 (lines 824-827)
- Example absence expectation: `docs/specs/features/F27-qa-testing/spec.md` §4.2 (lines 574-580)
- Flag-off absence example: `docs/specs/features/F27-qa-testing/spec.md` §4.2 (lines 615-621)

### 5.5 Edge Cases

| Case | Behavior |
|---|---|
| Absence expectation with `timeWindow.withinMs` | Only check events within that window. Events outside the window don't count as violations. |
| Late-arriving events (after grace period) | Not checked. 2s grace period is the contract. Document that async operations completing >2s after last positive match may produce false passes. |
| All expectations are absence (no positive) | Engine waits full scenario `timeout`, then evaluates. No short-circuit possible. |
| Absence on a topic with high volume (e.g., `log`) | Every log event evaluated against the absence matcher. Performance mitigated by topic filtering (only `log` topic events checked). |
| Matcher matches events from BEFORE `_t0` | Pre-stimulus events excluded by `evt.Timestamp < _t0` guard in `ConsumeTopicAsync`. |

### 5.6 Interactions

| Component | Interaction |
|---|---|
| C03 (Execution Engine) | Must maintain recording session open for the full grace period after positive expectations match |
| C05 (Results UI) | Absence pass: shows "No matching events (waited Nms)". Absence fail: shows the violating event. |
| F24 (Chaos Engineering) | Absence + chaos = "inject fault, verify NO permanent error" pattern (spec §4.2 lines 519-586) |

### 5.7 Revert/Undo Mechanism

None — absence evaluation is read-only over the captured event buffer.

### 5.8 Priority

**P0** — critical for error-path scenarios where "no permanent failure" is the success condition.

---

## 6. Return Value Capture

### 6.1 Name + ID + One-Liner

**SCN-C04-06: Return Value Capture** — Extend the interceptor infrastructure to capture method return values in `TopicEvent.Data`, enabling correctness assertions beyond structural occurrence.

### 6.2 Detailed Description

Current interceptors capture invocation facts (method called, arguments, duration, errors) but NOT what the method returned (viability analysis §3, lines 189-199). For full correctness verification, the assertion engine needs to match against return values: "GetStatus() returned 'Completed'", "WriteFileAsync returned true." This requires extending interceptor payloads to include `returnValue` and `returnType` fields. The extension is minimal — interceptors already wrap method calls; capturing the return value before forwarding it is a small addition to the existing pattern. This does NOT require changes to `TopicEvent` itself (the envelope is unchanged); only the anonymous-object payload grows by two fields.

### 6.3 Technical Mechanism

```csharp
// Pattern: extend existing interceptor anonymous-object payload
// Example: EdogHttpPipelineHandler.cs (already captures response)
// The http interceptor effectively captures "return value" as statusCode + body.
// For other interceptors (e.g., cache, DI), add returnValue:

// BEFORE (EdogCacheInterceptor.cs:46-56):
var eventData = new
{
    cacheName, operation, key, hitOrMiss, durationMs, valueSizeBytes, ttlSeconds,
    evictionReason,
};

// AFTER (with return value capture):
var eventData = new
{
    cacheName, operation, key, hitOrMiss, durationMs, valueSizeBytes, ttlSeconds,
    evictionReason,
    returnValue = SerializeSafe(result),  // NEW
    returnType = result?.GetType().Name,  // NEW
};

// Safe serialization: return values may be large or circular
static object SerializeSafe(object value)
{
    if (value == null) return null;
    try
    {
        // Attempt JSON serialization to validate. Truncate large values.
        var json = JsonSerializer.Serialize(value, _camelCaseOptions);
        if (json.Length > 4096)
            return new { _truncated = true, _preview = json[..4096], _type = value.GetType().Name };
        return value;
    }
    catch
    {
        // Non-serializable: capture type and ToString()
        return new { _type = value.GetType().Name, _toString = value.ToString()?[..Math.Min(256, value.ToString().Length)] };
    }
}
```

**Assertion engine usage:**
```json
{
  "id": "exp-5",
  "type": "field_match",
  "topic": "cache",
  "matcher": {
    "exact": { "operation": "Get", "returnValue.status": "Completed" },
    "exists": ["returnValue"]
  },
  "description": "Cache Get returned an object with status=Completed"
}
```

### 6.4 Source Code Path

- Viability analysis (return value gap): `docs/specs/features/F27-qa-testing/research/viability-analysis.md` §3 (lines 189-199)
- Extended InterceptorEvent model (proposed): `docs/specs/features/F27-qa-testing/research/viability-analysis.md` (lines 201-220)
- Cache interceptor (extension target): `src/backend/DevMode/EdogCacheInterceptor.cs:46-56`
- HTTP interceptor (already captures response body): `src/backend/DevMode/EdogHttpPipelineHandler.cs:67-78`
- Retry interceptor: `src/backend/DevMode/EdogRetryInterceptor.cs:186-200`
- Existing wrapping pattern (DelegatingHandler): `src/backend/DevMode/EdogTokenInterceptor.cs:24`

### 6.5 Edge Cases

| Case | Behavior |
|---|---|
| Return value is `null` | `returnValue: null` in payload. Matcher `exists: ["returnValue"]` fails. |
| Return value is non-serializable (circular refs) | `SerializeSafe` catches and returns `{ _type, _toString }` fallback |
| Return value > 4KB | Truncated with `_truncated: true` marker and 4KB preview |
| Void method (no return) | No `returnValue` field emitted. Matchers referencing it will fail `exists` check. |
| Task<T> return | Capture the unwrapped `T`, not the `Task` itself |
| IAsyncEnumerable return | P2 — not supported in V1. Document as limitation. |
| Performance: serialization overhead | `SerializeSafe` only called when return value capture is opted-in per interceptor (not blanket) |

### 6.6 Interactions

| Component | Interaction |
|---|---|
| All interceptors | Each interceptor opts-in to return value capture independently |
| C01 (Code Understanding) | Roslyn resolves return types to determine which interceptors need return capture |
| C02 (Scenario Generator) | Generates `field_match` expectations referencing `returnValue.*` paths |
| C05 (Results UI) | Displays return value in event detail panel |

### 6.7 Revert/Undo Mechanism

Return value capture is additive — new fields on existing anonymous objects. Removing the fields is backward-compatible (matchers for `returnValue` simply fail `exists` check, which is the correct behavior when capture is disabled). No schema migration needed.

### 6.8 Priority

**P1** — enables correctness verification but V1 can ship with structural + value assertions only.

---

## 7. Count Assertions

### 7.1 Name + ID + One-Liner

**SCN-C04-07: Count Assertions** — Verify that exactly N, at least N, or at most N matching events occurred during the observation window.

### 7.2 Detailed Description

Count assertions (`event_count` type) verify cardinality: "exactly 3 retry events," "at least 1 HTTP 200 response," "at most 5 cache misses." The engine accumulates matching events during streaming and evaluates the final count at verdict time. The count spec supports three modes: `exact` (must equal), `min` (must be at least), `max` (must be at most). `min` and `max` can combine (range). During streaming, count expectations are never resolved early — they accumulate matches until the observation window closes.

### 7.3 Technical Mechanism

```csharp
public sealed class ExpectationState
{
    public Expectation Expectation { get; }
    public ExpectationResult Result { get; private set; }
    public bool IsResolved { get; private set; }
    public int MatchCount { get; private set; }
    public TopicEvent MatchedEvent { get; private set; }
    public List<TopicEvent> AllMatchedEvents { get; } = new();
    public TopicEvent ClosestPartialMatch { get; private set; }

    public void IncrementCount(TopicEvent evt)
    {
        MatchCount++;
        AllMatchedEvents.Add(evt);
    }

    public void Resolve(ExpectationResult result, TopicEvent matchedEvt = null)
    {
        Result = result;
        IsResolved = true;
        MatchedEvent = matchedEvt;
    }

    public void RecordPartialMatch(TopicEvent evt)
    {
        ClosestPartialMatch ??= evt; // Keep first partial match for diagnostics
    }
}

// Count evaluation at finalization (ProduceVerdict):
var c = state.Expectation.Count;
bool passed;
if (c.Exact.HasValue)
    passed = state.MatchCount == c.Exact.Value;
else
    passed = (!c.Min.HasValue || state.MatchCount >= c.Min.Value)
          && (!c.Max.HasValue || state.MatchCount <= c.Max.Value);
```

**Example (from spec §4.2 lines 541-549):**
```json
{
  "id": "exp-1",
  "type": "event_count",
  "topic": "retry",
  "matcher": { "exact": { "statusCode": 429, "isThrottle": true } },
  "count": { "min": 2, "max": 3 },
  "description": "At least 2 retry attempts logged for 429 throttle"
}
```

### 7.4 Source Code Path

- Count schema: `docs/specs/features/F27-qa-testing/spec.md` §4.1 (lines 404-410)
- Example count expectation: `docs/specs/features/F27-qa-testing/spec.md` §4.2 (lines 541-549)
- Matching logic pseudocode: `docs/specs/features/F27-qa-testing/spec.md` §6.1 (lines 766-768)

### 7.5 Edge Cases

| Case | Behavior |
|---|---|
| `count: { exact: 0 }` | Equivalent to `event_absent`. Passes if no matches. Warn: prefer explicit `event_absent` type. |
| Neither `exact`, `min`, nor `max` specified | Schema validation should reject. If reached: treat as `min: 1` (at least one). |
| `min` > `max` | Invalid. Detect at load time, reject scenario with diagnostic. |
| Very high count (e.g., `exact: 1000`) | Functional but slow — every event evaluated. Performance bounded by topic volume cap (50K events per recording). |
| Duplicate events (same SequenceId) | Should not happen (`TopicBuffer.NextSequenceId()` is `Interlocked.Increment`, `TopicBuffer.cs:41`). If it does, count both. |

### 7.6 Interactions

| Component | Interaction |
|---|---|
| C02 (Scenario Generator) | LLM reads retry config (`maxRetries=3`) to generate count expectations |
| C05 (Results UI) | Displays "matched N events (expected min:2 max:3)" with event list |

### 7.7 Revert/Undo Mechanism

None — count is a running tally during evaluation. Replay from recording session for re-evaluation.

### 7.8 Priority

**P0** — essential for retry and throughput verification scenarios.

---

## 8. Timing Assertions

### 8.1 Name + ID + One-Liner

**SCN-C04-08: Timing Assertions** — Verify event latency, inter-event gaps, and total scenario duration against configurable time bounds.

### 8.2 Detailed Description

Timing assertions verify performance characteristics: "HTTP response within 5000ms," "retry backoff wait between 900-5000ms," "total scenario completes in <20s." The engine supports three timing dimensions: (1) **absolute** — event timestamp relative to stimulus T0 (`timeWindow.withinMs`, `timeWindow.afterMs`), (2) **event-internal** — the `durationMs` field within an event payload (matched via `range` in the field matcher), and (3) **inter-event** — gap between two events (computed from matched events' timestamps). Timing assertions are subject to clock granularity (`DateTimeOffset.UtcNow` precision ~15ms on Windows). The spec offers automatic retry with 2x timeout when ONLY timing expectations fail (§6.6 line ~845).

### 8.3 Technical Mechanism

```csharp
// Dimension 1: Time window (event vs stimulus T0)
// Already implemented in StreamingEvaluator.TimeWindowSatisfied()
// See SCN-C04-03 section 3.3

// Dimension 2: Event-internal duration (via field matcher range)
// Example: verify retry backoff duration is within bounds
{
  "matcher": {
    "range": { "waitDurationMs": { "min": 900, "max": 5000 } }
  }
}
// This is handled by FieldMatcher.Satisfies() range predicate (SCN-C04-01)

// Dimension 3: Inter-event gap (P1 extension)
// Computed at finalization from matched events of ordered expectations:
public static class TimingAnalyzer
{
    /// <summary>
    /// Computes gap between two resolved expectations' matched events.
    /// Used for "time between retry attempt 1 and retry attempt 2."
    /// </summary>
    public static double? InterEventGapMs(ExpectationState first, ExpectationState second)
    {
        if (first.MatchedEvent == null || second.MatchedEvent == null) return null;
        return (second.MatchedEvent.Timestamp - first.MatchedEvent.Timestamp)
            .TotalMilliseconds;
    }
}

// Timing retry logic (spec §6.6):
if (verdict.OnlyTimingFailures())
{
    // Offer retry with 2x timeout
    var retryVerdict = await evaluator.EvaluateAsync(timeout * 2);
    return retryVerdict;
}
```

### 8.4 Source Code Path

- Time window schema: `docs/specs/features/F27-qa-testing/spec.md` §4.1 (lines 398-402)
- Time window evaluation: `docs/specs/features/F27-qa-testing/spec.md` §6.3 (lines 814-821)
- Timing retry on failure: `docs/specs/features/F27-qa-testing/spec.md` §6.6 (line ~845)
- `TopicEvent.Timestamp` precision: `src/backend/DevMode/TopicEvent.cs:23` (DateTimeOffset)
- `EdogTopicRouter.Publish` timestamp assignment: `src/backend/DevMode/EdogTopicRouter.cs:83`

### 8.5 Edge Cases

| Case | Behavior |
|---|---|
| Windows timer resolution (~15ms) | Tight timing bounds (< 50ms) are unreliable. Warn in diagnostics if `withinMs < 50`. |
| GC pauses during capture | Can introduce spurious timing failures. The 2x retry mechanism (spec §6.6) mitigates. |
| `afterMs` > scenario timeout | Event can never arrive in time. Detect at load time, warn. |
| `withinMs: 0` | Only matches events at exact stimulus timestamp. Effectively impossible. Warn. |
| Clock skew between topics | All timestamps from `DateTimeOffset.UtcNow` in same process — no skew (single machine). |

### 8.6 Interactions

| Component | Interaction |
|---|---|
| C03 (Execution Engine) | Provides `_t0` (stimulus timestamp) as the timing reference |
| C05 (Results UI) | Displays timeline visualization with time windows overlaid |
| C02 (Scenario Generator) | LLM reads timeout config values from code to generate timing bounds |

### 8.7 Revert/Undo Mechanism

None — timing is derived from immutable timestamps on captured events.

### 8.8 Priority

**P1** — important for performance validation, but most scenarios can function without explicit timing bounds.

---

## 9. Composite Expectations (AND/OR Logic)

### 9.1 Name + ID + One-Liner

**SCN-C04-09: Composite Expectations** — Support AND/OR combinators between matchers within a single expectation.

### 9.2 Detailed Description

The V1 matcher uses implicit AND logic — all predicates in a matcher must pass. But some scenarios need OR: "event has statusCode 200 OR statusCode 201" or "message contains 'success' OR message contains 'completed'." V1 handles this by allowing multiple expectations for the same topic (each is an independent OR branch). True intra-matcher OR logic is a V2 extension. For AND across expectations, the spec's scoring rule (§6.5 lines 832-837) already enforces it: ALL expectations must pass. Composite logic in V1 is expressed through expectation composition, not a new matcher primitive.

### 9.3 Technical Mechanism

```csharp
// V1 approach: OR via multiple expectations
// "statusCode is 200 OR 201" expressed as:
[
  { "id": "exp-success-200", "type": "event_present", "topic": "http",
    "matcher": { "exact": { "statusCode": 200 } } },
  { "id": "exp-success-201", "type": "event_present", "topic": "http",
    "matcher": { "exact": { "statusCode": 201 } } }
]
// Problem: both must pass (AND), not either (OR).

// Solution for V1: introduce a grouping wrapper
public sealed class ExpectationGroup
{
    public string GroupId { get; set; }
    public string Logic { get; set; } // "and" (default) | "or" | "at_least_n"
    public int? AtLeastN { get; set; } // for "at_least_n" mode
    public string[] ExpectationIds { get; set; }
}

// Verdict evaluation with groups:
private bool EvaluateGroups()
{
    foreach (var group in _scenario.ExpectationGroups ?? Array.Empty<ExpectationGroup>())
    {
        var memberStates = group.ExpectationIds
            .Select(id => _states[id])
            .ToList();

        bool groupPassed = group.Logic switch
        {
            "or" => memberStates.Any(s => s.Result == ExpectationResult.Passed),
            "at_least_n" => memberStates.Count(s => s.Result == ExpectationResult.Passed)
                >= (group.AtLeastN ?? 1),
            _ => memberStates.All(s => s.Result == ExpectationResult.Passed), // "and"
        };

        if (!groupPassed) return false;
    }
    return true;
}
```

### 9.4 Source Code Path

- Scoring rule (AND logic): `docs/specs/features/F27-qa-testing/spec.md` §6.5 (lines 832-837)
- Expectation schema: `docs/specs/features/F27-qa-testing/spec.md` §4.1 (lines 378-422)

### 9.5 Edge Cases

| Case | Behavior |
|---|---|
| Ungrouped expectations | Default AND — all must pass (V1 default, spec §6.5) |
| OR group where both match | Group passes. Both matched events recorded for evidence. |
| Empty group (`ExpectationIds: []`) | Passes vacuously. Warn at load time. |
| Expectation in multiple groups | Allowed. Each group evaluates independently. |
| OR group with absence expectation | Semantically odd ("either no error OR no timeout"). Allowed but flagged. |

### 9.6 Interactions

| Component | Interaction |
|---|---|
| C02 (Scenario Generator) | Generates groups when LLM detects alternative success paths |
| C05 (Results UI) | Groups displayed as collapsible sections. OR groups show which branch matched. |

### 9.7 Revert/Undo Mechanism

None — groups are metadata over existing expectations.

### 9.8 Priority

**P2** — V1 can use multiple expectations to approximate OR. Groups add clarity but aren't blocking.

---

## 10. Partial Match Handling & Verdict Logic

### 10.1 Name + ID + One-Liner

**SCN-C04-10: Partial Match & Verdict** — Determine scenario outcome when some expectations pass and others fail, producing actionable diagnostics.

### 10.2 Detailed Description

The spec mandates binary verdicts: "No partial credit. A scenario either passes completely or fails" (§6.5 line ~837). But the assertion engine must still track partial progress for diagnostics: "3 of 5 expectations met — here's what failed and why." For each failed expectation, the engine records: (a) what WAS observed on that topic, (b) the closest partial match (event that matched some but not all predicates), (c) which specific predicate failed. This powers the "expected vs observed" diff view in the Results UI. The `ScenarioVerdict` object contains per-expectation results with evidence.

### 10.3 Technical Mechanism

```csharp
public sealed class ExpectationResultDetail
{
    public string ExpectationId { get; set; }
    public ExpectationResult Result { get; set; } // Passed | Failed
    public TopicEvent MatchedEvent { get; set; }  // null if failed
    public double MatchLatencyMs { get; set; }    // ms after T0

    // Diagnostic fields (populated on failure):
    public string FailureReason { get; set; }
    public TopicEvent ClosestPartialMatch { get; set; }
    public string[] FailedPredicates { get; set; }
    public int TotalCandidateEvents { get; set; } // events on this topic
}

public sealed class ScenarioVerdict
{
    public string ScenarioId { get; set; }
    public bool Passed { get; set; }
    public Dictionary<string, ExpectationResultDetail> ExpectationResults { get; set; }
    public double TotalDurationMs { get; set; }
    public int TotalEventsEvaluated { get; set; }

    /// <summary>True if only timing expectations failed (eligible for auto-retry).</summary>
    public bool OnlyTimingFailures()
    {
        var failed = ExpectationResults.Values
            .Where(r => r.Result == ExpectationResult.Failed);
        return failed.All(f =>
            f.FailureReason?.StartsWith("TimeWindow") == true);
    }
}

// Failure reason generation:
private string GenerateFailureReason(ExpectationState state)
{
    var exp = state.Expectation;
    if (state.MatchCount == 0 && exp.Type != "event_absent")
        return $"No events matched on topic '{exp.Topic}'. " +
               $"{state.TotalCandidateEvents} events observed, none satisfied matcher.";

    if (state.ClosestPartialMatch != null)
    {
        var failedPreds = IdentifyFailedPredicates(state.ClosestPartialMatch, exp.Matcher);
        return $"Closest match on topic '{exp.Topic}' failed predicates: " +
               string.Join(", ", failedPreds);
    }

    if (exp.Type == "event_count")
        return $"Expected count {FormatCount(exp.Count)} but got {state.MatchCount}.";

    return "Expectation not satisfied within timeout.";
}
```

### 10.4 Source Code Path

- Scoring rule (no partial credit): `docs/specs/features/F27-qa-testing/spec.md` §6.5 (lines 832-837)
- Result data model (per-expectation): `docs/specs/features/F27-qa-testing/spec.md` §7.1 (lines 870-910)
- Failed expectation display format: `docs/specs/features/F27-qa-testing/spec.md` §7.2 (lines 933-936)
- Closest match example: `docs/specs/features/F27-qa-testing/spec.md` §7.1 (lines 901-906)

### 10.5 Edge Cases

| Case | Behavior |
|---|---|
| 0 of N expectations pass | Scenario fails. All failure reasons populated. |
| N-1 of N pass | Scenario fails. The one failed expectation gets detailed diagnostics. |
| All pass except timing | `OnlyTimingFailures()` returns true. Engine offers 2x timeout retry (spec §6.6). |
| Closest partial match is from wrong time window | Still reported as closest match, with `FailedPredicates: ["timeWindow.withinMs"]`. |
| No events at all on expected topic | `FailureReason: "No events observed on topic '{topic}'. Is the interceptor active?"` |

### 10.6 Interactions

| Component | Interaction |
|---|---|
| C05 (Results UI) | Renders per-expectation pass/fail badges, failure reasons, closest match diff view |
| C06 (ADO Reporter) | Formats failure reasons into PR comment markdown (spec §7.2) |
| C02 (Scenario Generator, learning loop) | Failed predicate patterns feed back to improve future generation (spec §7.4) |

### 10.7 Revert/Undo Mechanism

Verdicts are immutable once produced. Re-evaluation requires replaying from the recording session.

### 10.8 Priority

**P0** — without good diagnostics, every failure is opaque and users can't act on results.

---

## 11. Confidence Scoring

### 11.1 Name + ID + One-Liner

**SCN-C04-11: Confidence Scoring** — Assign a confidence score (0.0-1.0) to each expectation result indicating match quality.

### 11.2 Detailed Description

While verdicts are binary (pass/fail), the engine also computes a confidence score for diagnostic and learning purposes. An exact match on all predicates with no ambiguity scores 1.0. A match where some predicates are "close" (e.g., string 95% similar, number within 10% of bound) scores proportionally lower. Confidence is metadata — it does NOT affect the pass/fail verdict. It helps the learning loop (spec §7.4) distinguish "barely failed" from "completely wrong" expectations, and helps users prioritize which failed expectations to investigate first.

### 11.3 Technical Mechanism

```csharp
public static class ConfidenceScorer
{
    /// <summary>
    /// Computes a 0.0-1.0 confidence score for how closely an event matches
    /// an expectation. 1.0 = perfect match. Used for diagnostics, not verdict.
    /// </summary>
    public static double Score(TopicEvent evt, Expectation exp)
    {
        var matcher = exp.Matcher;
        if (matcher == null) return 1.0;

        int totalPredicates = 0;
        double totalScore = 0.0;

        JsonElement root;
        try { root = JsonSerializer.SerializeToElement(evt.Data, _camelCaseOptions); }
        catch { return 0.0; }

        // Score each predicate type
        if (matcher.Exact != null)
        {
            foreach (var (field, expected) in matcher.Exact)
            {
                totalPredicates++;
                var resolved = ResolveField(root, field);
                if (resolved == null) { totalScore += 0.0; continue; }
                totalScore += ValueEquals(resolved.Value, expected) ? 1.0 : 0.0;
            }
        }

        if (matcher.Contains != null)
        {
            foreach (var (field, substring) in matcher.Contains)
            {
                totalPredicates++;
                var resolved = ResolveField(root, field);
                if (resolved == null) { totalScore += 0.0; continue; }
                var str = resolved.Value.ToString() ?? "";
                totalScore += str.Contains(substring, StringComparison.OrdinalIgnoreCase)
                    ? 1.0
                    : FuzzyContainsScore(str, substring);
            }
        }

        if (matcher.Range != null)
        {
            foreach (var (field, bounds) in matcher.Range)
            {
                totalPredicates++;
                var resolved = ResolveField(root, field);
                if (resolved == null || !resolved.Value.TryGetDouble(out var num))
                { totalScore += 0.0; continue; }

                bool inRange = (!bounds.Min.HasValue || num >= bounds.Min.Value)
                    && (!bounds.Max.HasValue || num <= bounds.Max.Value);
                totalScore += inRange ? 1.0 : ProximityScore(num, bounds);
            }
        }

        return totalPredicates == 0 ? 1.0 : totalScore / totalPredicates;
    }

    private static double FuzzyContainsScore(string haystack, string needle)
    {
        // Levenshtein-based: how close is the best substring match?
        // Returns 0.0-0.9 (never 1.0 for non-exact)
        // Simple heuristic: shared character ratio
        int shared = needle.Count(c => haystack.Contains(c, StringComparison.OrdinalIgnoreCase));
        return 0.9 * ((double)shared / needle.Length);
    }

    private static double ProximityScore(double actual, RangeBounds bounds)
    {
        // How close to the valid range? 0.0 = far, 0.9 = almost in range
        double distance = 0;
        if (bounds.Min.HasValue && actual < bounds.Min.Value)
            distance = bounds.Min.Value - actual;
        if (bounds.Max.HasValue && actual > bounds.Max.Value)
            distance = actual - bounds.Max.Value;
        double range = (bounds.Max ?? actual) - (bounds.Min ?? actual);
        if (range <= 0) return 0.5;
        return Math.Max(0, 0.9 * (1 - distance / range));
    }
}
```

### 11.4 Source Code Path

- Scenario metadata confidence field: `docs/specs/features/F27-qa-testing/spec.md` §4.1 (line ~296)
- Learning loop (uses confidence for feedback): `docs/specs/features/F27-qa-testing/spec.md` §7.4 (lines 952-959)
- False positive mitigation context: `docs/specs/features/F27-qa-testing/spec.md` §6.6 (lines 839-845)

### 11.5 Edge Cases

| Case | Behavior |
|---|---|
| Perfect match | Score = 1.0 |
| No predicates match | Score = 0.0 |
| Empty matcher | Score = 1.0 (vacuously true) |
| Single predicate fails out of 5 | Score = 0.8 |
| Numeric value is NaN/Infinity | Treated as 0.0 for that predicate |

### 11.6 Interactions

| Component | Interaction |
|---|---|
| C05 (Results UI) | Displays confidence as a subtle indicator on failed expectations |
| C02 (Scenario Generator, learning loop) | High-confidence failures = genuine regression. Low-confidence = flaky expectation. |

### 11.7 Revert/Undo Mechanism

None — confidence is a derived metric. Recalculate by re-scoring.

### 11.8 Priority

**P2** — diagnostic enhancement. V1 ships with binary pass/fail. Confidence scoring improves UX but isn't blocking.

---

## 12. Human-Readable Failure Messages

### 12.1 Name + ID + One-Liner

**SCN-C04-12: Failure Messages** — Generate actionable, human-readable explanations for every failed expectation including what was expected, what was observed, and a suggested investigation path.

### 12.2 Detailed Description

When an expectation fails, the user needs to understand WHY without digging through raw event JSON. The assertion engine produces structured failure messages with three parts: (1) **Expected** — what the expectation required, in plain English derived from the matcher predicates, (2) **Observed** — what actually appeared on the topic (closest match or "nothing"), and (3) **Suggestion** — context-aware hint for investigation (e.g., "Check if the interceptor for topic 'retry' is active" or "The response was HTTP 500 instead of 201 — check error handling"). These messages appear in the Results UI and in ADO PR comments (spec §7.2 lines 933-936).

### 12.3 Technical Mechanism

```csharp
public static class FailureMessageGenerator
{
    public static string Generate(ExpectationState state, DateTimeOffset t0)
    {
        var exp = state.Expectation;
        var sb = new StringBuilder();

        // Part 1: What was expected
        sb.Append($"Expected: {DescribeExpectation(exp)}");

        // Part 2: What was observed
        if (state.ClosestPartialMatch != null)
        {
            sb.Append($"\nObserved: {DescribeEvent(state.ClosestPartialMatch)}");
            sb.Append($"\nFailed predicates: {string.Join(", ", state.FailedPredicates)}");
        }
        else if (state.TotalCandidateEvents > 0)
        {
            sb.Append($"\nObserved: {state.TotalCandidateEvents} events on topic " +
                       $"'{exp.Topic}', but none matched the matcher.");
        }
        else
        {
            sb.Append($"\nObserved: No events on topic '{exp.Topic}'.");
        }

        // Part 3: Suggestion
        sb.Append($"\nSuggestion: {GenerateSuggestion(state)}");

        return sb.ToString();
    }

    private static string DescribeExpectation(Expectation exp)
    {
        return exp.Type switch
        {
            "event_present" => $"At least one event on '{exp.Topic}' matching " +
                               DescribeMatcher(exp.Matcher),
            "event_absent" => $"No events on '{exp.Topic}' matching " +
                              DescribeMatcher(exp.Matcher),
            "event_count" => $"{FormatCount(exp.Count)} events on '{exp.Topic}' matching " +
                             DescribeMatcher(exp.Matcher),
            "timing" => $"Event on '{exp.Topic}' within {exp.TimeWindow?.WithinMs}ms of stimulus",
            _ => exp.Description ?? $"{exp.Type} on '{exp.Topic}'"
        };
    }

    private static string DescribeMatcher(Matcher m)
    {
        var parts = new List<string>();
        if (m?.Exact != null)
            foreach (var (k, v) in m.Exact)
                parts.Add($"{k}={v}");
        if (m?.Contains != null)
            foreach (var (k, v) in m.Contains)
                parts.Add($"{k} contains '{v}'");
        if (m?.Regex != null)
            foreach (var (k, v) in m.Regex)
                parts.Add($"{k} matches /{v}/");
        if (m?.Range != null)
            foreach (var (k, r) in m.Range)
                parts.Add($"{k} in [{r.Min ?? double.NegativeInfinity}..{r.Max ?? double.PositiveInfinity}]");
        return parts.Count > 0 ? string.Join(" AND ", parts) : "(any event)";
    }

    private static string GenerateSuggestion(ExpectationState state)
    {
        if (state.TotalCandidateEvents == 0)
            return $"No events on topic '{state.Expectation.Topic}'. " +
                   "Verify the interceptor is active and the stimulus triggered the expected code path.";

        if (state.ClosestPartialMatch != null && state.FailedPredicates?.Length == 1)
            return $"Close match found — only '{state.FailedPredicates[0]}' didn't match. " +
                   "Check if the expected value has changed in the code under test.";

        if (state.Expectation.Type == "event_count")
            return $"Got {state.MatchCount} instead of {FormatCount(state.Expectation.Count)}. " +
                   "Check loop/retry configuration values.";

        return "Review the captured event stream in the Timeline view for unexpected behavior patterns.";
    }
}
```

### 12.4 Source Code Path

- PR comment failure format: `docs/specs/features/F27-qa-testing/spec.md` §7.2 (lines 933-936)
- Result data model (reason field): `docs/specs/features/F27-qa-testing/spec.md` §7.1 (lines 900-906)
- Expectation description field: `docs/specs/features/F27-qa-testing/spec.md` §4.1 (lines 418-421)

### 12.5 Edge Cases

| Case | Behavior |
|---|---|
| Matcher has many predicates (verbose message) | Truncate at 5 predicates, append "... and N more" |
| Closest match event has large payload | Show only the fields referenced by the matcher, not entire event |
| `event_absent` failed | "Event matching X was NOT expected but was observed at T+Nms" |
| Multiple events could be closest match | Keep the one with highest confidence score (SCN-C04-11) |

### 12.6 Interactions

| Component | Interaction |
|---|---|
| C05 (Results UI) | Renders failure messages in expectation detail panel and diff view |
| C06 (ADO Reporter) | Embeds failure messages in PR comment markdown |
| C02 (Scenario Generator) | The `description` field on each expectation seeds the "Expected" part |

### 12.7 Revert/Undo Mechanism

None — messages are generated from verdict data. Regenerate by re-evaluating.

### 12.8 Priority

**P0** — without readable messages, failures are opaque and users cannot act on results.

---

## 13. Performance: Real-Time Matching

### 13.1 Name + ID + One-Liner

**SCN-C04-13: Performance** — Evaluate each arriving event against all pending expectations in < 1ms to support high-volume event streams without backpressure.

### 13.2 Detailed Description

The assertion engine sits in the hot path: every `TopicEvent` published during scenario execution flows through `EvaluateEvent()`. With 16 topic buffers and potentially thousands of events per second (e.g., log topic during DAG execution), the engine must be fast. The < 1ms target means: serialize `TopicEvent.Data` to `JsonElement` once, evaluate all pending expectations for that topic in a single pass. Key optimizations: (a) **topic pre-filtering** — skip expectations for other topics (O(1) lookup), (b) **resolved-skip** — skip already-matched expectations, (c) **lazy serialization** — only serialize Data if there are pending expectations for this topic, (d) **compiled regex cache** — pre-compile regex patterns at scenario load time.

### 13.3 Technical Mechanism

```csharp
public sealed class PerformanceOptimizedEvaluator
{
    // Pre-index expectations by topic for O(1) lookup
    private readonly Dictionary<string, List<ExpectationState>> _byTopic;

    // Pre-compiled regex cache (compiled once at scenario load)
    private readonly Dictionary<string, Regex> _regexCache;

    public PerformanceOptimizedEvaluator(Scenario scenario)
    {
        _byTopic = scenario.Expectations
            .GroupBy(e => e.Topic)
            .ToDictionary(
                g => g.Key,
                g => g.Select(e => new ExpectationState(e)).ToList());

        _regexCache = new Dictionary<string, Regex>();
        foreach (var exp in scenario.Expectations)
        {
            if (exp.Matcher?.Regex == null) continue;
            foreach (var (_, pattern) in exp.Matcher.Regex)
            {
                if (!_regexCache.ContainsKey(pattern))
                    _regexCache[pattern] = new Regex(pattern,
                        RegexOptions.Compiled | RegexOptions.Singleline);
            }
        }
    }

    public void EvaluateEvent(TopicEvent evt)
    {
        // O(1) topic lookup — skip entire event if no expectations for this topic
        if (!_byTopic.TryGetValue(evt.Topic, out var states)) return;

        // Skip if all expectations for this topic are resolved
        bool anyPending = false;
        foreach (var s in states)
        {
            if (!s.IsResolved) { anyPending = true; break; }
        }
        if (!anyPending) return;

        // Serialize ONCE per event (the expensive operation)
        JsonElement root;
        try { root = JsonSerializer.SerializeToElement(evt.Data, _camelCaseOptions); }
        catch { return; }

        // Evaluate all pending expectations for this topic
        foreach (var state in states)
        {
            if (state.IsResolved) continue;
            EvaluateAgainst(root, evt, state);
        }
    }
}

// Performance budget per event:
// - Topic lookup:        ~10ns (Dictionary TryGetValue)
// - Pending check:       ~50ns (iterate max ~10 expectations)
// - JSON serialize:      ~200-500μs (depending on payload size)
// - Matcher evaluation:  ~50-200μs per expectation (field lookups + string ops)
// - Total per event:     ~300-800μs (well under 1ms target)
//
// Critical: JSON serialization is the bottleneck.
// Future optimization: cache JsonElement per TopicEvent (memoize on SequenceId).
```

### 13.4 Source Code Path

- Performance limits: `docs/specs/features/F27-qa-testing/spec.md` §8.6 (lines 1040-1050)
- Max events per recording: 50,000 (spec line ~1047)
- `TopicBuffer` channel (backpressure model): `src/backend/DevMode/TopicBuffer.cs:34-35` (unbounded)
- Regex compilation pattern: `src/backend/DevMode/EdogRetryInterceptor.cs:39-57` (existing `RegexOptions.Compiled` usage)

### 13.5 Edge Cases

| Case | Behavior |
|---|---|
| Burst of 1000+ events/sec (DAG execution) | Topic pre-filtering ensures only events for subscribed topics are serialized. Most events skipped in O(1). |
| Single scenario with 50 expectations | All 50 evaluated per matching event. At ~200μs each = 10ms. Exceeds target. Mitigation: partition by topic. |
| Very large `Data` payload (>100KB) | JSON serialization takes >1ms. Mitigation: `SerializeSafe` truncation (SCN-C04-06). |
| Regex catastrophic backtracking | Pre-compiled with `RegexOptions.Compiled`. Add `Regex.MatchTimeout = 100ms` safety valve. |
| Recording session hits 50K event limit | Stop capturing. Outstanding expectations evaluated against what's captured. |

### 13.6 Interactions

| Component | Interaction |
|---|---|
| `TopicBuffer` | Backpressure: if evaluation is slow, `Channel<TopicEvent>` buffer grows (unbounded, `TopicBuffer.cs:34`). No event loss. |
| C03 (Execution Engine) | Must not block FLT's main thread. Evaluation runs on background tasks. |
| `EdogTopicRouter` | Engine reads from buffers, never writes. No interference with normal interceptor flow. |

### 13.7 Revert/Undo Mechanism

N/A — performance is an implementation characteristic, not a state mutation.

### 13.8 Priority

**P1** — critical for real-time UX but the engine works correctly even if slower (just delayed UI updates).

---

## 14. Edge Case: Duplicate, Out-of-Order, and Cross-Scenario Events

### 14.1 Name + ID + One-Liner

**SCN-C04-14: Event Isolation** — Handle duplicate events, out-of-order arrivals, and events bleeding from other scenarios or background FLT activity.

### 14.2 Detailed Description

The assertion engine must be robust against messy real-world event streams. Three categories: (1) **Duplicates** — `TopicBuffer.NextSequenceId()` uses `Interlocked.Increment` (`TopicBuffer.cs:41`), guaranteeing unique monotonic IDs within a topic. True duplicates should not occur, but the engine deduplicates by `SequenceId` as a safety net. (2) **Out-of-order** — events from different topics have independent sequence counters and may interleave arbitrarily. The engine evaluates each event independently; ordering is validated only for expectations with `order.after` constraints and uses `TopicEvent.Timestamp`, not arrival order. (3) **Cross-scenario bleed** — background FLT activity (scheduled tasks, keep-alive pings, periodic token refresh) generates events that are NOT part of the scenario under test. The engine's T0 timestamp filter (`evt.Timestamp < _t0` guard) and topic scoping mitigate this. Correlation ID scoping (spec §6.6 line ~842) provides further isolation.

### 14.3 Technical Mechanism

```csharp
// Deduplication: track seen SequenceIds per topic
private readonly Dictionary<string, HashSet<long>> _seenSequenceIds = new();

private bool IsDuplicate(TopicEvent evt)
{
    if (!_seenSequenceIds.TryGetValue(evt.Topic, out var seen))
    {
        seen = new HashSet<long>();
        _seenSequenceIds[evt.Topic] = seen;
    }
    return !seen.Add(evt.SequenceId); // Returns false if already present
}

// T0 filtering (pre-stimulus events excluded):
if (evt.Timestamp < _t0) continue;

// Correlation ID scoping (optional, per-expectation):
if (exp.CorrelationId != null)
{
    var evtCorrelation = ResolveField(root, "correlationId");
    if (evtCorrelation?.GetString() != exp.CorrelationId) continue;
}

// Background noise examples to filter:
// - Token refresh events every 30min (token topic)
// - Keep-alive pings (http topic, internal URLs)
// - Periodic telemetry flush (telemetry topic)
// All excluded by T0 timestamp filter + matcher specificity
```

### 14.4 Source Code Path

- `TopicBuffer.NextSequenceId()` (monotonic guarantee): `src/backend/DevMode/TopicBuffer.cs:41`
- Correlation ID scoping: `docs/specs/features/F27-qa-testing/spec.md` §6.6 (line ~842)
- Background noise filtering: `docs/specs/features/F27-qa-testing/spec.md` §6.6 (lines 839-845)
- Scoped recording: `docs/specs/features/F27-qa-testing/spec.md` §5.3 (lines 685-701)

### 14.5 Edge Cases

| Case | Behavior |
|---|---|
| Token refresh event during scenario | Excluded by T0 filter (refresh is periodic, started before scenario) unless refresh was triggered BY the scenario. Matcher specificity (exact URL match) provides secondary filter. |
| Two scenarios run back-to-back, events from first leak into second | 500ms cooldown between scenarios (spec §5.4 line ~706). T0 of second scenario excludes first scenario's events. |
| FLT background DAG running during test | Events from background DAG appear on `dag`, `http`, `spark` topics. T0 filtering helps but isn't perfect if the background DAG event timestamps overlap. Correlation ID scoping is the robust solution. |
| SequenceId rollover (long max) | `long.MaxValue` = 9.2 × 10^18. At 1M events/sec, rollover in ~292K years. Not a concern. |

### 14.6 Interactions

| Component | Interaction |
|---|---|
| C03 (Execution Engine) | Provides T0 timestamp and optional correlation ID from stimulus response |
| C06 (Recording Session) | Provides snapshot position to define the "before T0" boundary |
| `TopicBuffer` | Guarantees monotonic `SequenceId` within each topic |

### 14.7 Revert/Undo Mechanism

None — deduplication and filtering are stateless guards on the evaluation path.

### 14.8 Priority

**P0** — without proper isolation, every scenario picks up noise and produces false positives.

---

## 15. Data Models Summary

### 15.1 Types Introduced by C04

```csharp
// All types in namespace Microsoft.LiveTable.Service.DevMode

// ─── Matcher (deserialized from scenario JSON) ───
public sealed class Matcher
{
    public Dictionary<string, object> Exact { get; set; }
    public Dictionary<string, string> Contains { get; set; }
    public Dictionary<string, string> Regex { get; set; }
    public Dictionary<string, RangeBounds> Range { get; set; }
    public List<string> Exists { get; set; }
}

public sealed class RangeBounds
{
    public double? Min { get; set; }
    public double? Max { get; set; }
}

// ─── Evaluation state ───
public enum ExpectationResult { Pending, Passed, Failed }

public sealed class ExpectationState { /* See SCN-C04-07 §7.3 */ }
public sealed class ExpectationResultDetail { /* See SCN-C04-10 §10.3 */ }
public sealed class ScenarioVerdict { /* See SCN-C04-10 §10.3 */ }

// ─── Optional V1 extension ───
public sealed class ExpectationGroup { /* See SCN-C04-09 §9.3 */ }

// ─── Static utilities ───
public static class FieldMatcher { /* See SCN-C04-01 §1.3 */ }
public static class ConfidenceScorer { /* See SCN-C04-11 §11.3 */ }
public static class FailureMessageGenerator { /* See SCN-C04-12 §12.3 */ }
public static class TimingAnalyzer { /* See SCN-C04-08 §8.3 */ }

// ─── Main evaluator ───
public sealed class StreamingEvaluator : IDisposable { /* See SCN-C04-03 §3.3 */ }
```

### 15.2 Wire Format (SignalR → Frontend)

The `ScenarioVerdict` and per-expectation `ExpectationResultDetail` objects are serialized to JSON via `System.Text.Json` with `CamelCase` policy and sent to the frontend through `EdogPlaygroundHub` SignalR events:

- `ExpectationMatched(scenarioId, expectationId, passed)` — real-time, per-match
- `ScenarioCompleted(scenarioId, ScenarioVerdict)` — final, per-scenario

---

## 16. Priority Summary

| Scenario | ID | Priority | Rationale |
|---|---|---|---|
| Field-Level Matchers | SCN-C04-01 | **P0** | Every assertion depends on field matching |
| Nested Field Matchers | SCN-C04-02 | **P0** | Required for HTTP headers, nested payloads |
| Streaming Evaluation | SCN-C04-03 | **P0** | Core evaluation loop, real-time UX |
| Temporal Ordering | SCN-C04-04 | **P1** | Multi-step scenarios |
| Absence Assertions | SCN-C04-05 | **P0** | Error-path verification |
| Return Value Capture | SCN-C04-06 | **P1** | Correctness verification (interceptor extension) |
| Count Assertions | SCN-C04-07 | **P0** | Retry and throughput validation |
| Timing Assertions | SCN-C04-08 | **P1** | Performance validation |
| Composite Expectations | SCN-C04-09 | **P2** | OR logic (workaround exists) |
| Partial Match & Verdict | SCN-C04-10 | **P0** | Actionable diagnostics |
| Confidence Scoring | SCN-C04-11 | **P2** | Learning loop enhancement |
| Failure Messages | SCN-C04-12 | **P0** | User-facing failure explanation |
| Performance | SCN-C04-13 | **P1** | Real-time matching at scale |
| Event Isolation | SCN-C04-14 | **P0** | False positive prevention |

**P0 (must ship):** 8 scenarios — field matchers, nested matchers, streaming eval, absence, count, partial match, failure messages, event isolation.
**P1 (should ship):** 4 scenarios — ordering, return value capture, timing, performance.
**P2 (nice to have):** 2 scenarios — composite expectations, confidence scoring.
