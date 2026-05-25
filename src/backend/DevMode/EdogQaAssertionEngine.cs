// <copyright file="EdogQaAssertionEngine.cs" company="Microsoft">
// Copyright (c) Microsoft Corporation. All rights reserved.
// </copyright>

#nullable disable
#pragma warning disable // DevMode-only file — suppress all warnings

namespace Microsoft.LiveTable.Service.DevMode
{
    using System;
    using System.Collections.Concurrent;
    using System.Collections.Generic;
    using System.Linq;
    using System.Text;
    using System.Text.Json;
    using System.Text.RegularExpressions;

    // ═════════════════════════════════════════════════════════════════
    // ExpectationState — mutable tracking for a single expectation
    // during streaming evaluation.
    // ═════════════════════════════════════════════════════════════════

    /// <summary>
    /// Tracks evaluation state of a single expectation during streaming.
    /// Thread-safe: all mutations go through <c>lock (_lock)</c>.
    /// </summary>
    public sealed class ExpectationState
    {
        private readonly object _lock = new();

        public ExpectationState(Expectation expectation)
        {
            Expectation = expectation;
        }

        /// <summary>The expectation being tracked.</summary>
        public Expectation Expectation { get; }

        /// <summary>Whether the expectation has reached a terminal state.</summary>
        public bool IsResolved { get; private set; }

        /// <summary>Terminal status (valid only when <see cref="IsResolved"/> is true).</summary>
        public ExpectationStatus Status { get; private set; }

        /// <summary>Number of events that satisfied the matcher.</summary>
        public int MatchCount { get; private set; }

        /// <summary>The first event that fully matched (or the violating event for absence).</summary>
        public TopicEvent MatchedEvent { get; private set; }

        /// <summary>All events that satisfied the matcher (for count/diagnostics).</summary>
        public List<TopicEvent> AllMatchedEvents { get; } = new();

        /// <summary>Best partial match for failure diagnostics.</summary>
        public TopicEvent ClosestPartialMatch { get; private set; }

        /// <summary>Confidence score of the closest partial match.</summary>
        public double ClosestPartialConfidence { get; private set; }

        /// <summary>Total candidate events seen on this expectation's topic.</summary>
        public int TotalCandidateEvents { get; private set; }

        /// <summary>Predicates that failed on the closest partial match.</summary>
        public string[] FailedPredicates { get; private set; }

        /// <summary>Human-readable failure reason, populated at finalization.</summary>
        public string FailureReason { get; set; }

        /// <summary>Increment the candidate counter (every event on topic).</summary>
        public void IncrementCandidates()
        {
            lock (_lock) { TotalCandidateEvents++; }
        }

        /// <summary>Record a matcher-satisfying event for count expectations.</summary>
        public void IncrementCount(TopicEvent evt)
        {
            lock (_lock)
            {
                MatchCount++;
                AllMatchedEvents.Add(evt);
            }
        }

        /// <summary>Record a partial match (close but not fully satisfied).</summary>
        public void RecordPartialMatch(TopicEvent evt, double confidence, string[] failedPreds)
        {
            lock (_lock)
            {
                if (ClosestPartialMatch == null || confidence > ClosestPartialConfidence)
                {
                    ClosestPartialMatch = evt;
                    ClosestPartialConfidence = confidence;
                    FailedPredicates = failedPreds;
                }
            }
        }

        /// <summary>Resolve the expectation to a terminal state.</summary>
        public void Resolve(ExpectationStatus status, TopicEvent matchedEvt = null)
        {
            lock (_lock)
            {
                if (IsResolved) return;
                Status = status;
                IsResolved = true;
                MatchedEvent = matchedEvt ?? MatchedEvent;
            }
        }

        /// <summary>Build an <see cref="ExpectationResult"/> for reporting.</summary>
        public ExpectationResult ToResult(DateTimeOffset t0)
        {
            lock (_lock)
            {
                return new ExpectationResult
                {
                    ExpectationId = Expectation.Id,
                    Description = Expectation.Description,
                    Status = IsResolved ? Status : ExpectationStatus.Unmatched,
                    MatchedEvent = MatchedEvent,
                    ClosestMiss = ClosestPartialMatch,
                    FailureReason = FailureReason,
                    MatchLatencyMs = MatchedEvent != null
                        ? (long)(MatchedEvent.Timestamp - t0).TotalMilliseconds
                        : 0
                };
            }
        }
    }

    // ═════════════════════════════════════════════════════════════════
    // FieldMatcher — atomic predicate evaluation
    // ═════════════════════════════════════════════════════════════════

    /// <summary>
    /// Evaluates field-level predicates (exact, contains, regex, range, exists)
    /// against a serialized <see cref="TopicEvent.Data"/> payload.
    /// All predicates within a <see cref="Matcher"/> use AND logic.
    /// </summary>
    public static class FieldMatcher
    {
        private static readonly JsonSerializerOptions CamelCase = new()
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase
        };

        /// <summary>
        /// Serialize <paramref name="data"/> to a <see cref="JsonElement"/> for field queries.
        /// Returns null if serialization fails.
        /// </summary>
        public static JsonElement? SerializeData(object data)
        {
            try
            {
                return JsonSerializer.SerializeToElement(data, CamelCase);
            }
            catch
            {
                return null;
            }
        }

        /// <summary>
        /// Evaluates all predicates in <paramref name="matcher"/> against a pre-serialized root.
        /// Returns true only if ALL specified predicates pass (AND logic).
        /// </summary>
        public static bool Satisfies(JsonElement root, LegacyMatcher matcher)
        {
            // Null matcher = vacuous — matches any event (topic-presence only)
            if (matcher == null) return true;

            if (matcher.Exact != null)
            {
                foreach (var (field, expected) in matcher.Exact)
                {
                    var resolved = ResolveField(root, field);
                    if (resolved == null) return false;
                    if (!ValueEquals(resolved.Value, expected)) return false;
                }
            }

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

            if (matcher.Regex != null)
            {
                foreach (var (field, pattern) in matcher.Regex)
                {
                    var resolved = ResolveField(root, field);
                    if (resolved == null) return false;
                    try
                    {
                        if (!System.Text.RegularExpressions.Regex.IsMatch(
                            resolved.Value.ToString() ?? "", pattern))
                            return false;
                    }
                    catch (RegexMatchTimeoutException) { return false; }
                    catch (ArgumentException) { return false; }
                }
            }

            if (matcher.Range != null)
            {
                foreach (var (field, bounds) in matcher.Range)
                {
                    var resolved = ResolveField(root, field);
                    if (resolved == null) return false;
                    if (!resolved.Value.TryGetDouble(out var numVal)) return false;
                    // P10 fix (P1-2): honour RangeBounds inclusivity flags.
                    if (bounds.Min.HasValue && (bounds.MinInclusive ? numVal < bounds.Min.Value : numVal <= bounds.Min.Value)) return false;
                    if (bounds.Max.HasValue && (bounds.MaxInclusive ? numVal > bounds.Max.Value : numVal >= bounds.Max.Value)) return false;
                }
            }

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

        /// <summary>
        /// Evaluates all predicates using pre-compiled regex patterns.
        /// </summary>
        public static bool SatisfiesWithCache(
            JsonElement root,
            LegacyMatcher matcher,
            IReadOnlyDictionary<string, Regex> regexCache)
        {
            // Null matcher = vacuous — matches any event (topic-presence only)
            if (matcher == null) return true;

            if (matcher.Exact != null)
            {
                foreach (var (field, expected) in matcher.Exact)
                {
                    var resolved = ResolveField(root, field);
                    if (resolved == null) return false;
                    if (!ValueEquals(resolved.Value, expected)) return false;
                }
            }

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

            if (matcher.Regex != null)
            {
                foreach (var (field, pattern) in matcher.Regex)
                {
                    var resolved = ResolveField(root, field);
                    if (resolved == null) return false;
                    try
                    {
                        if (regexCache.TryGetValue(pattern, out var compiled))
                        {
                            if (!compiled.IsMatch(resolved.Value.ToString() ?? ""))
                                return false;
                        }
                        else
                        {
                            if (!System.Text.RegularExpressions.Regex.IsMatch(
                                resolved.Value.ToString() ?? "", pattern))
                                return false;
                        }
                    }
                    catch (RegexMatchTimeoutException) { return false; }
                    catch (ArgumentException) { return false; }
                }
            }

            if (matcher.Range != null)
            {
                foreach (var (field, bounds) in matcher.Range)
                {
                    var resolved = ResolveField(root, field);
                    if (resolved == null) return false;
                    if (!resolved.Value.TryGetDouble(out var numVal)) return false;
                    // P10 fix (P1-2): honour RangeBounds inclusivity flags.
                    if (bounds.Min.HasValue && (bounds.MinInclusive ? numVal < bounds.Min.Value : numVal <= bounds.Min.Value)) return false;
                    if (bounds.Max.HasValue && (bounds.MaxInclusive ? numVal > bounds.Max.Value : numVal >= bounds.Max.Value)) return false;
                }
            }

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

        /// <summary>
        /// Resolve a dot-delimited field path against a JSON object tree.
        /// E.g. "responseHeaders.Retry-After" → root["responseHeaders"]["Retry-After"].
        /// </summary>
        public static JsonElement? ResolveField(JsonElement root, string fieldPath)
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

        /// <summary>
        /// Compare a <see cref="JsonElement"/> against an expected value.
        /// String comparison is case-sensitive; numeric comparison uses epsilon tolerance.
        /// </summary>
        public static bool ValueEquals(JsonElement element, object expected)
        {
            return element.ValueKind switch
            {
                JsonValueKind.String => element.GetString() == expected?.ToString(),
                JsonValueKind.Number => element.TryGetDouble(out var d)
                    && expected != null
                    && Math.Abs(d - Convert.ToDouble(expected)) < 0.0001,
                JsonValueKind.True => expected is bool b && b,
                JsonValueKind.False => expected is bool b2 && !b2,
                JsonValueKind.Null => expected == null,
                _ => element.ToString() == expected?.ToString()
            };
        }

        /// <summary>
        /// Identify which predicates in a matcher fail for a given event.
        /// Returns an array of human-readable predicate descriptions.
        /// </summary>
        public static string[] IdentifyFailedPredicates(JsonElement root, LegacyMatcher matcher)
        {
            if (matcher == null) return Array.Empty<string>();
            var failed = new List<string>();

            if (matcher.Exact != null)
            {
                foreach (var (field, expected) in matcher.Exact)
                {
                    var resolved = ResolveField(root, field);
                    if (resolved == null)
                        failed.Add($"exact({field}): field not found");
                    else if (!ValueEquals(resolved.Value, expected))
                        failed.Add($"exact({field}): expected '{expected}', got '{resolved.Value}'");
                }
            }

            if (matcher.Contains != null)
            {
                foreach (var (field, substring) in matcher.Contains)
                {
                    var resolved = ResolveField(root, field);
                    if (resolved == null)
                        failed.Add($"contains({field}): field not found");
                    else
                    {
                        var str = resolved.Value.ToString() ?? "";
                        if (!str.Contains(substring, StringComparison.OrdinalIgnoreCase))
                            failed.Add($"contains({field}): '{str}' does not contain '{substring}'");
                    }
                }
            }

            if (matcher.Regex != null)
            {
                foreach (var (field, pattern) in matcher.Regex)
                {
                    var resolved = ResolveField(root, field);
                    if (resolved == null)
                        failed.Add($"regex({field}): field not found");
                    else
                    {
                        try
                        {
                            if (!System.Text.RegularExpressions.Regex.IsMatch(
                                resolved.Value.ToString() ?? "", pattern))
                                failed.Add($"regex({field}): '{resolved.Value}' does not match /{pattern}/");
                        }
                        catch { failed.Add($"regex({field}): invalid pattern /{pattern}/"); }
                    }
                }
            }

            if (matcher.Range != null)
            {
                foreach (var (field, bounds) in matcher.Range)
                {
                    var resolved = ResolveField(root, field);
                    if (resolved == null)
                        failed.Add($"range({field}): field not found");
                    else if (!resolved.Value.TryGetDouble(out var num))
                        failed.Add($"range({field}): '{resolved.Value}' is not numeric");
                    else
                    {
                        if (bounds.Min.HasValue && (bounds.MinInclusive ? num < bounds.Min.Value : num <= bounds.Min.Value))
                            failed.Add($"range({field}): {num} {(bounds.MinInclusive ? "<" : "<=")} min {bounds.Min.Value}");
                        if (bounds.Max.HasValue && (bounds.MaxInclusive ? num > bounds.Max.Value : num >= bounds.Max.Value))
                            failed.Add($"range({field}): {num} {(bounds.MaxInclusive ? ">" : ">=")} max {bounds.Max.Value}");
                    }
                }
            }

            if (matcher.Exists != null)
            {
                foreach (var field in matcher.Exists)
                {
                    var resolved = ResolveField(root, field);
                    if (resolved == null || resolved.Value.ValueKind == JsonValueKind.Null)
                        failed.Add($"exists({field}): field is null or missing");
                }
            }

            return failed.ToArray();
        }
    }

    // ═════════════════════════════════════════════════════════════════
    // ConfidenceScorer — diagnostic confidence for partial matches
    // ═════════════════════════════════════════════════════════════════

    /// <summary>
    /// Computes a 0.0–1.0 confidence score for how closely an event matches
    /// an expectation. 1.0 = perfect match. Used for diagnostics, not verdict.
    /// </summary>
    public static class ConfidenceScorer
    {
        /// <summary>Score an event against an expectation's matcher.</summary>
        public static double Score(JsonElement root, LegacyMatcher matcher)
        {
            if (matcher == null) return 1.0;

            int totalPredicates = 0;
            double totalScore = 0.0;

            if (matcher.Exact != null)
            {
                foreach (var (field, expected) in matcher.Exact)
                {
                    totalPredicates++;
                    var resolved = FieldMatcher.ResolveField(root, field);
                    if (resolved == null) continue;
                    totalScore += FieldMatcher.ValueEquals(resolved.Value, expected) ? 1.0 : 0.0;
                }
            }

            if (matcher.Contains != null)
            {
                foreach (var (field, substring) in matcher.Contains)
                {
                    totalPredicates++;
                    var resolved = FieldMatcher.ResolveField(root, field);
                    if (resolved == null) continue;
                    var str = resolved.Value.ToString() ?? "";
                    if (str.Contains(substring, StringComparison.OrdinalIgnoreCase))
                        totalScore += 1.0;
                    else
                    {
                        int shared = substring.Count(c =>
                            str.Contains(c, StringComparison.OrdinalIgnoreCase));
                        totalScore += 0.9 * ((double)shared / Math.Max(1, substring.Length));
                    }
                }
            }

            if (matcher.Range != null)
            {
                foreach (var (field, bounds) in matcher.Range)
                {
                    totalPredicates++;
                    var resolved = FieldMatcher.ResolveField(root, field);
                    if (resolved == null || !resolved.Value.TryGetDouble(out var num))
                        continue;

                    bool inRange = (!bounds.Min.HasValue || (bounds.MinInclusive ? num >= bounds.Min.Value : num > bounds.Min.Value))
                        && (!bounds.Max.HasValue || (bounds.MaxInclusive ? num <= bounds.Max.Value : num < bounds.Max.Value));
                    if (inRange)
                    {
                        totalScore += 1.0;
                    }
                    else
                    {
                        double distance = 0;
                        if (bounds.Min.HasValue && num < bounds.Min.Value)
                            distance = bounds.Min.Value - num;
                        if (bounds.Max.HasValue && num > bounds.Max.Value)
                            distance = num - bounds.Max.Value;
                        double range = (bounds.Max ?? num) - (bounds.Min ?? num);
                        totalScore += range > 0
                            ? Math.Max(0, 0.9 * (1 - distance / range))
                            : 0.5;
                    }
                }
            }

            if (matcher.Regex != null)
            {
                foreach (var (field, _) in matcher.Regex)
                {
                    totalPredicates++;
                    var resolved = FieldMatcher.ResolveField(root, field);
                    if (resolved == null) continue;
                    // Regex: binary pass/fail for confidence
                    totalScore += 0.0;
                }
            }

            if (matcher.Exists != null)
            {
                foreach (var field in matcher.Exists)
                {
                    totalPredicates++;
                    var resolved = FieldMatcher.ResolveField(root, field);
                    totalScore += (resolved != null && resolved.Value.ValueKind != JsonValueKind.Null)
                        ? 1.0
                        : 0.0;
                }
            }

            return totalPredicates == 0 ? 0.0 : totalScore / totalPredicates;
        }
    }

    // ═════════════════════════════════════════════════════════════════
    // TimingAnalyzer — inter-event gap computation
    // ═════════════════════════════════════════════════════════════════

    /// <summary>
    /// Computes inter-event timing gaps between resolved expectations.
    /// </summary>
    public static class TimingAnalyzer
    {
        /// <summary>
        /// Computes the millisecond gap between two resolved expectations' matched events.
        /// Returns null if either expectation has no matched event.
        /// </summary>
        public static double? InterEventGapMs(ExpectationState first, ExpectationState second)
        {
            if (first?.MatchedEvent == null || second?.MatchedEvent == null) return null;
            return (second.MatchedEvent.Timestamp - first.MatchedEvent.Timestamp).TotalMilliseconds;
        }
    }

    // ═════════════════════════════════════════════════════════════════
    // FailureMessageGenerator — human-readable failure diagnostics
    // ═════════════════════════════════════════════════════════════════

    /// <summary>
    /// Generates actionable, human-readable explanations for failed expectations.
    /// Three parts: Expected, Observed, Suggestion.
    /// </summary>
    public static class FailureMessageGenerator
    {
        /// <summary>Generate a full failure message for a failed expectation.</summary>
        public static string Generate(ExpectationState state, DateTimeOffset t0)
        {
            var exp = state.Expectation;
            var sb = new StringBuilder();

            sb.Append($"Expected: {DescribeExpectation(exp)}");

            if (state.ClosestPartialMatch != null)
            {
                var elapsed = (state.ClosestPartialMatch.Timestamp - t0).TotalMilliseconds;
                sb.Append($"\nObserved (closest match at T+{elapsed:F0}ms): ");
                sb.Append(DescribeMatchedFields(state.ClosestPartialMatch, exp.Matcher));
                if (state.FailedPredicates != null && state.FailedPredicates.Length > 0)
                {
                    var display = state.FailedPredicates.Length <= 5
                        ? state.FailedPredicates
                        : state.FailedPredicates.Take(5)
                            .Append($"... and {state.FailedPredicates.Length - 5} more")
                            .ToArray();
                    sb.Append($"\nFailed predicates: {string.Join(", ", display)}");
                }
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

            sb.Append($"\nSuggestion: {GenerateSuggestion(state)}");
            return sb.ToString();
        }

        private static string DescribeExpectation(Expectation exp)
        {
            return exp.Type switch
            {
                ExpectationType.EventPresent =>
                    $"At least one event on '{exp.Topic}' matching {DescribeMatcher(exp.Matcher)}",
                ExpectationType.EventAbsent =>
                    $"No events on '{exp.Topic}' matching {DescribeMatcher(exp.Matcher)}",
                ExpectationType.EventCount =>
                    $"{FormatCount(exp.Count)} events on '{exp.Topic}' matching {DescribeMatcher(exp.Matcher)}",
                ExpectationType.Timing =>
                    $"Event on '{exp.Topic}' within {exp.TimeWindow?.WithinMs}ms of stimulus",
                ExpectationType.EventOrder =>
                    $"Event on '{exp.Topic}' after expectation '{exp.Order?.After}'",
                ExpectationType.FieldMatch =>
                    $"Event on '{exp.Topic}' matching {DescribeMatcher(exp.Matcher)}",
                _ => exp.Description ?? $"{exp.Type} on '{exp.Topic}'"
            };
        }

        /// <summary>Describe a matcher in human-readable form.</summary>
        public static string DescribeMatcher(LegacyMatcher m)
        {
            if (m == null) return "(vacuous — no assertions)";
            var parts = new List<string>();

            if (m.Exact != null)
                foreach (var (k, v) in m.Exact)
                    parts.Add($"{k}={v}");
            if (m.Contains != null)
                foreach (var (k, v) in m.Contains)
                    parts.Add($"{k} contains '{v}'");
            if (m.Regex != null)
                foreach (var (k, v) in m.Regex)
                    parts.Add($"{k} matches /{v}/");
            if (m.Range != null)
                foreach (var (k, r) in m.Range)
                {
                    var lo = r.Min.HasValue ? r.Min.Value.ToString("G") : "-Inf";
                    var hi = r.Max.HasValue ? r.Max.Value.ToString("G") : "+Inf";
                    parts.Add($"{k} in [{lo}..{hi}]");
                }
            if (m.Exists != null)
                foreach (var f in m.Exists)
                    parts.Add($"{f} exists");

            return parts.Count > 0 ? string.Join(" AND ", parts) : "(vacuous — no assertions)";
        }

        private static string DescribeMatchedFields(TopicEvent evt, LegacyMatcher matcher)
        {
            if (matcher == null || evt?.Data == null) return "(no data)";
            var root = FieldMatcher.SerializeData(evt.Data);
            if (root == null) return "(unserializable)";

            var parts = new List<string>();
            var fields = new HashSet<string>();
            if (matcher.Exact != null) foreach (var k in matcher.Exact.Keys) fields.Add(k);
            if (matcher.Contains != null) foreach (var k in matcher.Contains.Keys) fields.Add(k);
            if (matcher.Range != null) foreach (var k in matcher.Range.Keys) fields.Add(k);

            foreach (var field in fields.Take(5))
            {
                var resolved = FieldMatcher.ResolveField(root.Value, field);
                parts.Add(resolved != null ? $"{field}={resolved.Value}" : $"{field}=(missing)");
            }

            return parts.Count > 0 ? string.Join(", ", parts) : "(vacuous — no assertions)";
        }

        private static string FormatCount(CountSpec c)
        {
            if (c == null) return "some";
            if (c.Exact.HasValue) return $"exactly {c.Exact.Value}";
            if (c.Min.HasValue && c.Max.HasValue) return $"{c.Min.Value}..{c.Max.Value}";
            if (c.Min.HasValue) return $"at least {c.Min.Value}";
            if (c.Max.HasValue) return $"at most {c.Max.Value}";
            return "some";
        }

        private static string GenerateSuggestion(ExpectationState state)
        {
            var exp = state.Expectation;

            if (state.TotalCandidateEvents == 0)
                return $"No events on topic '{exp.Topic}'. " +
                       "Verify the interceptor is active and the stimulus triggered the expected code path.";

            if (state.ClosestPartialMatch != null && state.FailedPredicates?.Length == 1)
                return $"Close match found — only '{state.FailedPredicates[0]}' didn't match. " +
                       "Check if the expected value has changed in the code under test.";

            if (exp.Type == ExpectationType.EventCount)
                return $"Got {state.MatchCount} instead of {FormatCount(exp.Count)}. " +
                       "Check loop/retry configuration values.";

            if (exp.Type == ExpectationType.EventAbsent)
                return "An event that should NOT have appeared was observed. " +
                       "Review error handling or guard conditions.";

            return "Review the captured event stream in the Timeline view for unexpected behavior patterns.";
        }
    }

    // ═════════════════════════════════════════════════════════════════
    // EdogQaAssertionEngine — streaming evaluation engine
    // ═════════════════════════════════════════════════════════════════

    /// <summary>
    /// Streaming assertion engine for F27 QA Testing. Evaluates <see cref="TopicEvent"/>
    /// instances against a scenario's <see cref="Expectation"/> array as events arrive.
    ///
    /// <para>
    /// Performance contract: &lt; 1ms per event evaluation.
    /// Thread safety: all public methods are safe for concurrent callers.
    /// </para>
    ///
    /// <para>Usage:</para>
    /// <code>
    /// var engine = new EdogQaAssertionEngine(scenario, stimulusTimestamp);
    /// // Feed events as they arrive from TopicBuffer.ReadLiveAsync()
    /// foreach (var evt in events)
    ///     engine.EvaluateEvent(evt);
    /// // Finalize and get results
    /// var results = engine.GetResults();
    /// </code>
    /// </summary>
    public sealed class EdogQaAssertionEngine
    {
        private readonly Scenario _scenario;
        private readonly DateTimeOffset _t0;
        private readonly ConcurrentDictionary<string, ExpectationState> _states;
        private readonly Dictionary<string, List<ExpectationState>> _byTopic;
        private readonly Dictionary<string, Regex> _regexCache;
        private readonly ConcurrentDictionary<string, HashSet<long>> _seenSequenceIds;
        private readonly Action<string, string, bool> _onExpectationMatched;

        private readonly object _evalLock = new();
        private int _totalEventsEvaluated;

        /// <summary>
        /// Initialize the assertion engine for a single scenario execution.
        /// </summary>
        /// <param name="scenario">The scenario whose expectations are evaluated.</param>
        /// <param name="stimulusTimestamp">T0 — the moment the stimulus was dispatched.</param>
        /// <param name="onExpectationMatched">
        /// Optional callback invoked when an expectation resolves: (scenarioId, expectationId, passed).
        /// </param>
        public EdogQaAssertionEngine(
            Scenario scenario,
            DateTimeOffset stimulusTimestamp,
            Action<string, string, bool> onExpectationMatched = null)
        {
            _scenario = scenario ?? throw new ArgumentNullException(nameof(scenario));
            _t0 = stimulusTimestamp;
            _onExpectationMatched = onExpectationMatched;

            _states = new ConcurrentDictionary<string, ExpectationState>();
            _byTopic = new Dictionary<string, List<ExpectationState>>();
            _regexCache = new Dictionary<string, Regex>();
            _seenSequenceIds = new ConcurrentDictionary<string, HashSet<long>>();

            foreach (var exp in scenario.Expectations ?? new List<Expectation>())
            {
                var state = new ExpectationState(exp);
                _states[exp.Id] = state;

                if (!_byTopic.TryGetValue(exp.Topic, out var list))
                {
                    list = new List<ExpectationState>();
                    _byTopic[exp.Topic] = list;
                }
                list.Add(state);

                // Pre-compile regex patterns
                if (exp.Matcher?.Regex != null)
                {
                    foreach (var (_, pattern) in exp.Matcher.Regex)
                    {
                        if (!_regexCache.ContainsKey(pattern))
                        {
                            try
                            {
                                _regexCache[pattern] = new Regex(pattern,
                                    RegexOptions.Compiled | RegexOptions.Singleline,
                                    TimeSpan.FromMilliseconds(100));
                            }
                            catch (ArgumentException)
                            {
                                // Invalid pattern — will fail at match time gracefully
                            }
                        }
                    }
                }
            }
        }

        /// <summary>
        /// Validate the ordering graph for circular dependencies.
        /// Call before starting evaluation. Returns true if valid, false if cycles detected.
        /// </summary>
        public bool ValidateOrderGraph()
        {
            var graph = new Dictionary<string, List<string>>();
            foreach (var exp in _scenario.Expectations)
            {
                graph[exp.Id] = new List<string>();
                if (exp.Order?.After != null)
                    graph[exp.Id].Add(exp.Order.After);
            }

            // Topological sort via DFS — detect cycles
            var visited = new HashSet<string>();
            var inStack = new HashSet<string>();

            bool Dfs(string node)
            {
                if (inStack.Contains(node)) return false; // Cycle
                if (visited.Contains(node)) return true;
                inStack.Add(node);
                visited.Add(node);
                if (graph.TryGetValue(node, out var deps))
                {
                    foreach (var dep in deps)
                    {
                        if (graph.ContainsKey(dep) && !Dfs(dep)) return false;
                    }
                }
                inStack.Remove(node);
                return true;
            }

            foreach (var node in graph.Keys)
            {
                if (!Dfs(node)) return false;
            }
            return true;
        }

        /// <summary>
        /// Evaluate a single <see cref="TopicEvent"/> against all pending expectations.
        /// Call this as events arrive from <c>TopicBuffer.ReadLiveAsync()</c>.
        /// Thread-safe: multiple topic consumers may call concurrently.
        /// </summary>
        /// <param name="evt">The event to evaluate.</param>
        public void EvaluateEvent(TopicEvent evt)
        {
            if (evt == null) return;

            // T0 filter — exclude pre-stimulus events
            if (evt.Timestamp < _t0) return;

            // Deduplication by SequenceId per topic
            if (IsDuplicate(evt)) return;

            // O(1) topic lookup — skip if no expectations for this topic
            if (!_byTopic.TryGetValue(evt.Topic, out var states)) return;

            // Check if any expectations for this topic are still pending
            bool anyPending = false;
            foreach (var s in states)
            {
                if (!s.IsResolved) { anyPending = true; break; }
            }
            if (!anyPending) return;

            // Serialize once per event (the expensive operation)
            var root = FieldMatcher.SerializeData(evt.Data);
            if (root == null) return;

            System.Threading.Interlocked.Increment(ref _totalEventsEvaluated);

            // Evaluate all pending expectations for this topic
            foreach (var state in states)
            {
                if (state.IsResolved) continue;
                state.IncrementCandidates();
                EvaluateAgainst(root.Value, evt, state);
            }
        }

        /// <summary>
        /// Finalize all expectations and return per-expectation results.
        /// Call after the observation window closes (timeout or all-positive-matched + grace).
        /// </summary>
        /// <returns>List of per-expectation results for the scenario result.</returns>
        public List<ExpectationResult> GetResults()
        {
            FinalizeCountAssertions();
            FinalizeAbsenceAssertions();
            FinalizeUnresolved();
            GenerateFailureReasons();

            return _states.Values
                .Select(s => s.ToResult(_t0))
                .ToList();
        }

        /// <summary>
        /// Return all expectation states that have not yet resolved.
        /// </summary>
        public List<ExpectationState> GetPendingExpectations()
        {
            return _states.Values.Where(s => !s.IsResolved).ToList();
        }

        /// <summary>
        /// Returns true when every expectation has reached a terminal state.
        /// </summary>
        public bool IsAllResolved()
        {
            foreach (var s in _states.Values)
            {
                if (!s.IsResolved) return false;
            }
            return true;
        }

        /// <summary>
        /// Returns true when all positive (non-absence) expectations are satisfied.
        /// Used for short-circuit: once all positives pass, start the absence grace period.
        /// </summary>
        public bool AllPositiveExpectationsSatisfied()
        {
            foreach (var s in _states.Values)
            {
                if (s.Expectation.Type == ExpectationType.EventAbsent) continue;
                // Count expectations resolve at finalization, not during streaming
                if (s.Expectation.Type == ExpectationType.EventCount) continue;
                if (!s.IsResolved) return false;
            }
            return true;
        }

        /// <summary>
        /// Compute the final <see cref="AssertionVerdict"/> for this scenario.
        /// Calls <see cref="GetResults"/> internally.
        /// </summary>
        public AssertionVerdict ComputeVerdict()
        {
            var results = GetResults();
            bool allPassed = results.All(r =>
                r.Status == ExpectationStatus.Passed || r.Status == ExpectationStatus.Inconclusive);
            bool onlyTimingFailures = results
                .Where(r => r.Status == ExpectationStatus.Failed)
                .All(r => r.FailureReason?.StartsWith("TimeWindow") == true);

            return new AssertionVerdict
            {
                Passed = allPassed,
                OnlyTimingFailures = onlyTimingFailures,
                TotalDurationMs = (long)(DateTimeOffset.UtcNow - _t0).TotalMilliseconds,
                TotalEventsEvaluated = _totalEventsEvaluated,
                ExpectationResults = results
            };
        }

        /// <summary>Total number of events evaluated by this engine instance.</summary>
        public int TotalEventsEvaluated => _totalEventsEvaluated;

        // ─── Private evaluation logic ────────────────────────────────

        private void EvaluateAgainst(JsonElement root, TopicEvent evt, ExpectationState state)
        {
            var exp = state.Expectation;
            bool matches = FieldMatcher.SatisfiesWithCache(root, exp.Matcher, _regexCache);

            switch (exp.Type)
            {
                case ExpectationType.EventPresent:
                case ExpectationType.FieldMatch:
                    if (matches && TimeWindowSatisfied(evt, exp) && OrderSatisfied(exp, evt))
                    {
                        // Vacuous (null matcher) → Inconclusive (topic-presence only, no real assertion)
                        var status = exp.Matcher == null
                            ? ExpectationStatus.Inconclusive
                            : ExpectationStatus.Passed;
                        state.Resolve(status, evt);
                        _onExpectationMatched?.Invoke(_scenario.Id, exp.Id, status == ExpectationStatus.Passed);
                    }
                    else if (matches)
                    {
                        // Partial match — field predicates passed but timing/order failed
                        var failedPreds = new List<string>();
                        if (!TimeWindowSatisfied(evt, exp))
                            failedPreds.Add($"TimeWindow: event at T+{(evt.Timestamp - _t0).TotalMilliseconds:F0}ms");
                        if (!OrderSatisfied(exp, evt))
                            failedPreds.Add($"Order: predecessor '{exp.Order?.After}' not yet resolved");
                        state.RecordPartialMatch(evt, 0.8, failedPreds.ToArray());
                    }
                    else
                    {
                        // Not a match — compute confidence for diagnostics
                        double confidence = ConfidenceScorer.Score(root, exp.Matcher);
                        if (confidence > 0.3)
                        {
                            var failedPreds = FieldMatcher.IdentifyFailedPredicates(root, exp.Matcher);
                            state.RecordPartialMatch(evt, confidence, failedPreds);
                        }
                    }
                    break;

                case ExpectationType.EventOrder:
                    if (matches && OrderSatisfied(exp, evt) && TimeWindowSatisfied(evt, exp))
                    {
                        state.Resolve(ExpectationStatus.Passed, evt);
                        _onExpectationMatched?.Invoke(_scenario.Id, exp.Id, true);
                    }
                    break;

                case ExpectationType.EventCount:
                    if (matches && TimeWindowSatisfied(evt, exp))
                    {
                        state.IncrementCount(evt);
                    }
                    break;

                case ExpectationType.EventAbsent:
                    if (matches && TimeWindowSatisfied(evt, exp))
                    {
                        // Immediate failure — the forbidden event appeared
                        state.IncrementCount(evt);
                        state.Resolve(ExpectationStatus.Failed, evt);
                        _onExpectationMatched?.Invoke(_scenario.Id, exp.Id, false);
                    }
                    break;

                case ExpectationType.Timing:
                    if (matches)
                    {
                        if (TimeWindowSatisfied(evt, exp))
                        {
                            state.Resolve(ExpectationStatus.Passed, evt);
                            _onExpectationMatched?.Invoke(_scenario.Id, exp.Id, true);
                        }
                        else
                        {
                            var failedPreds = new[] {
                                $"TimeWindow: event at T+{(evt.Timestamp - _t0).TotalMilliseconds:F0}ms, " +
                                $"expected within {exp.TimeWindow?.WithinMs}ms after {exp.TimeWindow?.AfterMs}ms"
                            };
                            state.RecordPartialMatch(evt, 0.7, failedPreds);
                        }
                    }
                    break;
            }
        }

        private bool TimeWindowSatisfied(TopicEvent evt, Expectation exp)
        {
            if (exp.TimeWindow == null) return true;
            var elapsed = (evt.Timestamp - _t0).TotalMilliseconds;
            if (exp.TimeWindow.WithinMs.HasValue && elapsed > exp.TimeWindow.WithinMs.Value)
                return false;
            if (exp.TimeWindow.AfterMs.HasValue && elapsed < exp.TimeWindow.AfterMs.Value)
                return false;
            return true;
        }

        private bool OrderSatisfied(Expectation exp, TopicEvent candidateEvent)
        {
            if (exp.Order?.After == null) return true;
            if (!_states.TryGetValue(exp.Order.After, out var predecessor)) return false;
            if (!predecessor.IsResolved) return false;
            // Timestamp validation: candidate must be after predecessor's match
            if (predecessor.MatchedEvent != null
                && candidateEvent.Timestamp < predecessor.MatchedEvent.Timestamp)
                return false;
            return true;
        }

        private bool IsDuplicate(TopicEvent evt)
        {
            var seen = _seenSequenceIds.GetOrAdd(evt.Topic, _ => new HashSet<long>());
            lock (seen)
            {
                return !seen.Add(evt.SequenceId);
            }
        }

        // ─── Finalization ────────────────────────────────────────────

        private void FinalizeCountAssertions()
        {
            foreach (var state in _states.Values)
            {
                if (state.IsResolved) continue;
                if (state.Expectation.Type != ExpectationType.EventCount) continue;

                var c = state.Expectation.Count;
                if (c == null)
                {
                    // No count spec — treat as min:1
                    state.Resolve(state.MatchCount >= 1
                        ? ExpectationStatus.Passed
                        : ExpectationStatus.Failed);
                    continue;
                }

                bool passed;
                if (c.Exact.HasValue)
                    passed = state.MatchCount == c.Exact.Value;
                else
                    passed = (!c.Min.HasValue || state.MatchCount >= c.Min.Value)
                          && (!c.Max.HasValue || state.MatchCount <= c.Max.Value);

                state.Resolve(passed ? ExpectationStatus.Passed : ExpectationStatus.Failed);
                _onExpectationMatched?.Invoke(_scenario.Id, state.Expectation.Id, passed);
            }
        }

        private void FinalizeAbsenceAssertions()
        {
            foreach (var state in _states.Values)
            {
                if (state.IsResolved) continue;
                if (state.Expectation.Type != ExpectationType.EventAbsent) continue;

                // Still unresolved = no matching event ever arrived = PASS
                state.Resolve(ExpectationStatus.Passed);
                _onExpectationMatched?.Invoke(_scenario.Id, state.Expectation.Id, true);
            }
        }

        private void FinalizeUnresolved()
        {
            foreach (var state in _states.Values)
            {
                if (state.IsResolved) continue;
                state.Resolve(ExpectationStatus.Failed);
                _onExpectationMatched?.Invoke(_scenario.Id, state.Expectation.Id, false);
            }
        }

        private void GenerateFailureReasons()
        {
            foreach (var state in _states.Values)
            {
                if (state.Status == ExpectationStatus.Passed) continue;
                state.FailureReason = FailureMessageGenerator.Generate(state, _t0);
            }
        }

        internal IReadOnlyList<ExpectationResult> EvaluateContractMatchers(
            IReadOnlyList<Matcher> matchers,
            IReadOnlyList<TopicEvent> capturedEvents)
        {
            if (matchers == null || matchers.Count == 0)
            {
                return Array.Empty<ExpectationResult>();
            }

            capturedEvents ??= Array.Empty<TopicEvent>();
            var results = new List<ExpectationResult>(matchers.Count);

            for (var i = 0; i < matchers.Count; i++)
            {
                var matcher = matchers[i];
                var matcherId = $"matcher-{i + 1}";
                if (matcher == null)
                {
                    results.Add(new ExpectationResult
                    {
                        ExpectationId = matcherId,
                        Description = "Null matcher",
                        Status = ExpectationStatus.Failed,
                        FailureReason = "Matcher entry is null.",
                    });
                    continue;
                }

                var topic = ExtractMatcherTopic(matcher.TopicField);
                var candidates = capturedEvents
                    .Where(evt => string.Equals(evt?.Topic, topic, StringComparison.Ordinal))
                    .ToList();
                var matchedEvent = candidates.FirstOrDefault(evt => EvaluateMatcher(matcher, evt));

                results.Add(new ExpectationResult
                {
                    ExpectationId = matcherId,
                    Description = DescribeContractMatcher(matcher),
                    Status = matchedEvent != null ? ExpectationStatus.Passed : ExpectationStatus.Failed,
                    MatchedEvent = matchedEvent,
                    ClosestMiss = matchedEvent == null ? candidates.FirstOrDefault() : null,
                    MatchLatencyMs = matchedEvent != null
                        ? (long)(matchedEvent.Timestamp - _t0).TotalMilliseconds
                        : 0,
                    FailureReason = matchedEvent != null
                        ? null
                        : BuildContractMatcherFailureReason(matcher, candidates.Count),
                });
            }

            return results;
        }

        private static bool EvaluateMatcher(Matcher matcher, TopicEvent evt)
        {
            if (matcher == null || evt == null)
            {
                return false;
            }

            if (!string.Equals(evt.Topic, ExtractMatcherTopic(matcher.TopicField), StringComparison.Ordinal))
            {
                return false;
            }

            return matcher.Assertion switch
            {
                MatcherAssertion.Equals => EvaluateEquals(matcher, evt),
                MatcherAssertion.NotEquals => EvaluateNotEquals(matcher, evt),
                MatcherAssertion.Exists => EvaluateExists(matcher, evt),
                MatcherAssertion.InRange => EvaluateInRange(matcher, evt),
                MatcherAssertion.ContainsAll => EvaluateContainsAll(matcher, evt),
                MatcherAssertion.OneOf => EvaluateOneOf(matcher, evt),
                MatcherAssertion.Length => EvaluateLength(matcher, evt),
                _ => false,
            };
        }

        private static bool EvaluateEquals(Matcher matcher, TopicEvent evt)
        {
            return TryResolveContractField(evt, matcher.TopicField, out var actual)
                && matcher.Value is ScalarMatcherValue scalar
                && FieldMatcher.ValueEquals(actual, scalar.Value);
        }

        private static bool EvaluateNotEquals(Matcher matcher, TopicEvent evt)
        {
            return TryResolveContractField(evt, matcher.TopicField, out var actual)
                && matcher.Value is ScalarMatcherValue scalar
                && !FieldMatcher.ValueEquals(actual, scalar.Value);
        }

        private static bool EvaluateExists(Matcher matcher, TopicEvent evt)
        {
            var exists = TryResolveContractField(evt, matcher.TopicField, out var actual)
                && actual.ValueKind != JsonValueKind.Null;

            if (matcher.Value is BooleanMatcherValue expected)
            {
                return expected.Expected ? exists : !exists;
            }

            return exists;
        }

        private static bool EvaluateInRange(Matcher matcher, TopicEvent evt)
        {
            if (!TryResolveContractField(evt, matcher.TopicField, out var actual)
                || matcher.Value is not RangeMatcherValue range
                || !actual.TryGetDouble(out var numeric))
            {
                return false;
            }

            var lowerOk = !range.Min.HasValue
                || (range.MinInclusive ? numeric >= range.Min.Value : numeric > range.Min.Value);
            var upperOk = !range.Max.HasValue
                || (range.MaxInclusive ? numeric <= range.Max.Value : numeric < range.Max.Value);
            return lowerOk && upperOk;
        }

        private static bool EvaluateContainsAll(Matcher matcher, TopicEvent evt)
        {
            if (!TryResolveContractField(evt, matcher.TopicField, out var actual)
                || actual.ValueKind != JsonValueKind.Array
                || matcher.Value is not ArrayMatcherValue expected)
            {
                return false;
            }

            var actualItems = actual.EnumerateArray().ToList();
            return expected.Items.All(item => actualItems.Any(candidate => FieldMatcher.ValueEquals(candidate, item)));
        }

        private static bool EvaluateOneOf(Matcher matcher, TopicEvent evt)
        {
            return TryResolveContractField(evt, matcher.TopicField, out var actual)
                && matcher.Value is ArrayMatcherValue allowed
                && allowed.Items.Any(item => FieldMatcher.ValueEquals(actual, item));
        }

        private static bool EvaluateLength(Matcher matcher, TopicEvent evt)
        {
            if (!TryResolveContractField(evt, matcher.TopicField, out var actual)
                || matcher.Value is not LengthMatcherValue length)
            {
                return false;
            }

            int? actualLength = actual.ValueKind switch
            {
                JsonValueKind.String => actual.GetString()?.Length,
                JsonValueKind.Array => actual.GetArrayLength(),
                _ => null,
            };

            if (!actualLength.HasValue)
            {
                return false;
            }

            return (!length.Min.HasValue || actualLength.Value >= length.Min.Value)
                && (!length.Max.HasValue || actualLength.Value <= length.Max.Value);
        }

        private static bool TryResolveContractField(TopicEvent evt, string topicField, out JsonElement value)
        {
            value = default;
            if (evt?.Data == null)
            {
                return false;
            }

            var root = FieldMatcher.SerializeData(evt.Data);
            if (root == null)
            {
                return false;
            }

            var fieldPath = ExtractMatcherFieldPath(topicField);
            if (string.IsNullOrWhiteSpace(fieldPath))
            {
                value = root.Value;
                return true;
            }

            var resolved = FieldMatcher.ResolveField(root.Value, fieldPath);
            if (resolved == null)
            {
                return false;
            }

            value = resolved.Value;
            return true;
        }

        private static string ExtractMatcherTopic(string topicField)
        {
            if (string.IsNullOrWhiteSpace(topicField))
            {
                return string.Empty;
            }

            var separator = topicField.IndexOf('.');
            return separator > 0 ? topicField.Substring(0, separator) : topicField;
        }

        private static string ExtractMatcherFieldPath(string topicField)
        {
            if (string.IsNullOrWhiteSpace(topicField))
            {
                return string.Empty;
            }

            var separator = topicField.IndexOf('.');
            return separator >= 0 && separator + 1 < topicField.Length
                ? topicField.Substring(separator + 1)
                : string.Empty;
        }

        private static string DescribeContractMatcher(Matcher matcher)
        {
            if (matcher == null)
            {
                return "contract matcher";
            }

            return $"{matcher.TopicField} {matcher.Assertion}";
        }

        private static string BuildContractMatcherFailureReason(Matcher matcher, int candidateCount)
        {
            var topic = ExtractMatcherTopic(matcher?.TopicField);
            if (candidateCount == 0)
            {
                return $"No captured events were observed on topic '{topic}' for matcher '{DescribeContractMatcher(matcher)}'.";
            }

            return $"{candidateCount} captured events were checked on topic '{topic}', but none satisfied matcher '{DescribeContractMatcher(matcher)}'.";
        }
    }

    // ═════════════════════════════════════════════════════════════════
    // AssertionVerdict — output of ComputeVerdict()
    // ═════════════════════════════════════════════════════════════════

    /// <summary>
    /// Final verdict produced by <see cref="EdogQaAssertionEngine.ComputeVerdict"/>.
    /// Wraps per-expectation results with aggregate pass/fail and timing metadata.
    /// Distinct from the <see cref="ScenarioVerdict"/> enum used in <see cref="ScenarioResult"/>.
    /// </summary>
    public sealed class AssertionVerdict
    {
        /// <summary>True if all expectations passed.</summary>
        public bool Passed { get; set; }

        /// <summary>True if only timing-related expectations failed (eligible for auto-retry with 2x timeout).</summary>
        public bool OnlyTimingFailures { get; set; }

        /// <summary>Total milliseconds from T0 to verdict.</summary>
        public long TotalDurationMs { get; set; }

        /// <summary>Total events evaluated across all topics.</summary>
        public int TotalEventsEvaluated { get; set; }

        /// <summary>Per-expectation results.</summary>
        public List<ExpectationResult> ExpectationResults { get; set; } = new();
    }
}
