// <copyright file="EdogQaResultAggregator.cs" company="Microsoft">
// Copyright (c) Microsoft Corporation. All rights reserved.
// </copyright>

#nullable disable
#pragma warning disable // DevMode-only file — suppress all warnings

namespace Microsoft.LiveTable.Service.DevMode
{
    using System;
    using System.Collections.Generic;
    using System.IO;
    using System.Linq;
    using System.Text;
    using System.Text.Json;
    using System.Xml;

    // ──────────────────────────────────────────────
    // QA Run Context
    // ──────────────────────────────────────────────

    /// <summary>
    /// Context for a QA run, built during PR analysis phase.
    /// Carries PR metadata and unobservable paths from C02 (Roslyn analyzer).
    /// </summary>
    public sealed class QaRunContext
    {
        /// <summary>Pull request ID.</summary>
        public int PrId { get; set; }

        /// <summary>Pull request title.</summary>
        public string PrTitle { get; set; }

        /// <summary>Pull request URL.</summary>
        public string PrUrl { get; set; }

        /// <summary>Code paths that cannot be verified by EDOG interceptors.</summary>
        public List<string> UnobservablePaths { get; set; } = new();
    }

    // ──────────────────────────────────────────────
    // Result Aggregator
    // ──────────────────────────────────────────────

    /// <summary>
    /// Collects per-scenario results into an aggregated <see cref="RunResult"/>
    /// with overall verdict, timing summary, and export capabilities.
    /// Thread-safe for concurrent scenario completion callbacks.
    /// </summary>
    public sealed class EdogQaResultAggregator
    {
        private readonly object _lock = new();
        private readonly List<ScenarioResult> _results = new();
        private readonly string _runId;
        private readonly QaRunContext _context;

        /// <summary>
        /// Initializes a new aggregator for a single QA run.
        /// </summary>
        /// <param name="runId">Run identifier, e.g. "run-20250615-143022".</param>
        /// <param name="context">PR and analysis context for this run.</param>
        public EdogQaResultAggregator(string runId, QaRunContext context)
        {
            _runId = runId ?? throw new ArgumentNullException(nameof(runId));
            _context = context ?? throw new ArgumentNullException(nameof(context));
        }

        /// <summary>
        /// Adds a completed scenario result. Thread-safe.
        /// </summary>
        /// <param name="result">The completed scenario result.</param>
        public void AddScenarioResult(ScenarioResult result)
        {
            if (result == null) throw new ArgumentNullException(nameof(result));
            lock (_lock)
            {
                _results.Add(result);
            }
        }

        /// <summary>
        /// Computes the aggregated <see cref="RunResult"/> from all collected scenario results.
        /// </summary>
        /// <returns>The fully aggregated run result with verdict, timing, and performance data.</returns>
        public RunResult GetRunResult()
        {
            List<ScenarioResult> snapshot;
            lock (_lock)
            {
                snapshot = _results.ToList();
            }

            var summary = BuildSummary(snapshot);
            var slowest = snapshot.OrderByDescending(r => r.DurationMs).FirstOrDefault();

            var startedAt = snapshot.Count > 0
                ? snapshot.Min(r => r.StartedAt)
                : DateTimeOffset.UtcNow;
            var completedAt = snapshot.Count > 0
                ? snapshot.Max(r => r.CompletedAt)
                : DateTimeOffset.UtcNow;
            var wallClockMs = (long)(completedAt - startedAt).TotalMilliseconds;

            return new RunResult
            {
                RunId = _runId,
                PrId = _context.PrId,
                PrTitle = _context.PrTitle,
                PrUrl = _context.PrUrl,
                StartedAt = startedAt,
                CompletedAt = completedAt,
                TotalDurationMs = wallClockMs,
                Summary = summary,
                Scenarios = snapshot,
                UnobservablePaths = _context.UnobservablePaths ?? new List<string>(),
                Performance = new PerformanceReport
                {
                    SlowestScenarioMs = slowest?.DurationMs ?? 0,
                    SlowestScenarioId = slowest?.ScenarioId,
                    AverageScenarioMs = snapshot.Count > 0
                        ? (long)snapshot.Average(r => r.DurationMs)
                        : 0,
                    TotalExecutionMs = snapshot.Sum(r => r.DurationMs),
                    OverheadMs = Math.Max(0, wallClockMs - snapshot.Sum(r => r.DurationMs))
                }
            };
        }

        // ──────────────────────────────────────────
        // PR Comment Formatting
        // ──────────────────────────────────────────

        /// <summary>
        /// Formats the run result as an ADO-compatible PR comment in markdown.
        /// Uses &lt;details&gt; for collapsible failure sections.
        /// Truncates to ~130KB if the comment exceeds ADO's ~150KB limit.
        /// </summary>
        /// <returns>Markdown string suitable for posting as a PR comment.</returns>
        public string FormatPrComment()
        {
            var result = GetRunResult();
            var sb = new StringBuilder();

            AppendHeader(sb, result);
            AppendSummaryTable(sb, result);
            AppendFailureDetails(sb, result);
            AppendUnobservablePaths(sb, result);
            AppendPerformance(sb, result);
            AppendFooter(sb, result);

            // ADO PR comments have a ~150KB limit — truncate at 130KB
            if (sb.Length > 130_000)
            {
                return TruncateComment(sb, result);
            }

            return sb.ToString();
        }

        // ──────────────────────────────────────────
        // JUnit XML Export
        // ──────────────────────────────────────────

        /// <summary>
        /// Exports the run result as JUnit XML for CI pipeline integration.
        /// Each scenario becomes a &lt;testcase&gt;; failures and timeouts produce
        /// &lt;failure&gt; and &lt;error&gt; elements respectively.
        /// </summary>
        /// <returns>JUnit XML string.</returns>
        public string ExportJunitXml()
        {
            var result = GetRunResult();

            var settings = new XmlWriterSettings
            {
                Indent = true,
                Encoding = Encoding.UTF8,
                OmitXmlDeclaration = false
            };

            using var stream = new MemoryStream();
            using (var writer = XmlWriter.Create(stream, settings))
            {
                writer.WriteStartDocument();

                // <testsuites>
                writer.WriteStartElement("testsuites");
                writer.WriteAttributeString("name", "EDOG QA Testing");
                writer.WriteAttributeString("tests", result.Summary.Total.ToString());
                writer.WriteAttributeString("failures", result.Summary.Failed.ToString());
                writer.WriteAttributeString("errors",
                    (result.Summary.Crashed + result.Summary.TimedOut).ToString());
                writer.WriteAttributeString("time",
                    (result.TotalDurationMs / 1000.0).ToString("F3"));

                // <testsuite>
                writer.WriteStartElement("testsuite");
                writer.WriteAttributeString("name",
                    $"PR #{result.PrId}: {result.PrTitle}");
                writer.WriteAttributeString("tests", result.Summary.Total.ToString());
                writer.WriteAttributeString("failures", result.Summary.Failed.ToString());
                writer.WriteAttributeString("errors",
                    (result.Summary.Crashed + result.Summary.TimedOut).ToString());
                writer.WriteAttributeString("time",
                    (result.TotalDurationMs / 1000.0).ToString("F3"));
                writer.WriteAttributeString("timestamp",
                    result.StartedAt.ToString("o"));

                foreach (var scenario in result.Scenarios)
                {
                    WriteTestCase(writer, scenario);
                }

                writer.WriteEndElement(); // </testsuite>
                writer.WriteEndElement(); // </testsuites>
                writer.WriteEndDocument();
            }

            return Encoding.UTF8.GetString(stream.ToArray());
        }

        // ──────────────────────────────────────────
        // JSON Export
        // ──────────────────────────────────────────

        /// <summary>
        /// Exports the run result as JSON for programmatic consumption.
        /// CapturedEvents are excluded from the aggregate to avoid memory pressure;
        /// full evidence is stored separately per scenario.
        /// </summary>
        /// <returns>JSON string of the run result.</returns>
        public string ExportJson()
        {
            var result = GetRunResult();

            // Strip CapturedEvents from the aggregate to keep size manageable
            var exportScenarios = result.Scenarios.Select(s => new
            {
                s.ScenarioId,
                s.Title,
                s.Category,
                Verdict = s.Verdict.ToString(),
                s.DurationMs,
                s.StartedAt,
                s.CompletedAt,
                s.EventsCaptured,
                s.ErrorMessage,
                Expectations = s.Expectations.Select(e => new
                {
                    e.ExpectationId,
                    e.Description,
                    Status = e.Status.ToString(),
                    e.FailureReason,
                    e.MatchLatencyMs
                })
            });

            var export = new
            {
                result.RunId,
                result.PrId,
                result.PrTitle,
                result.PrUrl,
                result.StartedAt,
                result.CompletedAt,
                result.TotalDurationMs,
                Summary = new
                {
                    result.Summary.Total,
                    result.Summary.Passed,
                    result.Summary.Failed,
                    result.Summary.TimedOut,
                    result.Summary.Partial,
                    result.Summary.Crashed,
                    result.Summary.Skipped,
                    result.Summary.OverallPass
                },
                Scenarios = exportScenarios,
                result.UnobservablePaths,
                Performance = new
                {
                    result.Performance.SlowestScenarioMs,
                    result.Performance.SlowestScenarioId,
                    result.Performance.AverageScenarioMs,
                    result.Performance.TotalExecutionMs,
                    result.Performance.OverheadMs
                }
            };

            return JsonSerializer.Serialize(export, new JsonSerializerOptions
            {
                WriteIndented = true,
                PropertyNamingPolicy = JsonNamingPolicy.CamelCase
            });
        }

        // ──────────────────────────────────────────
        // Verdict Logic
        // ──────────────────────────────────────────

        /// <summary>
        /// Determines the overall pass/fail verdict.
        /// 100% strict: ANY failure, crash, timeout, or partial blocks the PR.
        /// Zero scenarios is also a failure.
        /// </summary>
        internal static bool ComputeOverallPass(List<ScenarioResult> results)
        {
            if (results == null || results.Count == 0) return false;
            return results.All(r => r.Verdict == ScenarioVerdict.Passed);
        }

        // ──────────────────────────────────────────
        // Display Ordering (S12)
        // ──────────────────────────────────────────

        /// <summary>
        /// Sorts scenario results for display: crashes first, then failures,
        /// timeouts, partials, passes last. Within each group, fastest first.
        /// </summary>
        internal static List<ScenarioResult> SortForDisplay(List<ScenarioResult> results)
        {
            return results
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
                .ThenBy(r => r.DurationMs)
                .ToList();
        }

        /// <summary>
        /// Builds the summary line, e.g. "10/12 PASSED ● 1 FAILED ● 1 TIMED OUT".
        /// </summary>
        internal static string BuildSummaryLine(RunSummary summary)
        {
            var parts = new List<string> { $"{summary.Passed}/{summary.Total} PASSED" };
            if (summary.Failed > 0)   parts.Add($"{summary.Failed} FAILED");
            if (summary.TimedOut > 0) parts.Add($"{summary.TimedOut} TIMED OUT");
            if (summary.Crashed > 0)  parts.Add($"{summary.Crashed} CRASHED");
            if (summary.Partial > 0)  parts.Add($"{summary.Partial} PARTIAL");
            if (summary.Skipped > 0)  parts.Add($"{summary.Skipped} SKIPPED");
            return string.Join(" ● ", parts);
        }

        // ══════════════════════════════════════════
        // Private Helpers
        // ══════════════════════════════════════════

        private static RunSummary BuildSummary(List<ScenarioResult> results)
        {
            var summary = new RunSummary
            {
                Total = results.Count,
                Passed = results.Count(r => r.Verdict == ScenarioVerdict.Passed),
                Failed = results.Count(r => r.Verdict == ScenarioVerdict.Failed),
                TimedOut = results.Count(r => r.Verdict == ScenarioVerdict.TimedOut),
                Partial = results.Count(r => r.Verdict == ScenarioVerdict.Partial),
                Crashed = results.Count(r => r.Verdict == ScenarioVerdict.Crashed),
                Skipped = results.Count(r => r.Verdict == ScenarioVerdict.Skipped)
            };
            return summary;
        }

        // ── PR Comment Sections ─────────────────

        private static void AppendHeader(StringBuilder sb, RunResult result)
        {
            sb.AppendLine("## ◆ EDOG QA Testing Results");
            sb.AppendLine();
            sb.AppendLine($"**PR:** #{result.PrId} — {EscapeMarkdown(result.PrTitle)}");

            var duration = FormatDuration(result.TotalDurationMs);
            sb.AppendLine($"**Run:** {result.StartedAt:yyyy-MM-dd HH:mm} UTC "
                        + $"| Duration: {duration} | Run ID: `{result.RunId}`");
            sb.AppendLine();
        }

        private static void AppendSummaryTable(StringBuilder sb, RunResult result)
        {
            var summaryLine = BuildSummaryLine(result.Summary);
            sb.AppendLine($"### Summary: {summaryLine}");
            sb.AppendLine();

            var sorted = SortForDisplay(result.Scenarios);

            sb.AppendLine("| # | Scenario | Category | Result | Duration |");
            sb.AppendLine("|---|----------|----------|--------|----------|");

            for (int i = 0; i < sorted.Count; i++)
            {
                var s = sorted[i];
                var badge = VerdictBadge(s.Verdict);
                var durationStr = FormatDuration(s.DurationMs);
                sb.AppendLine($"| {i + 1} "
                            + $"| {EscapeMarkdown(s.Title)} "
                            + $"| {EscapeMarkdown(s.Category)} "
                            + $"| {badge} "
                            + $"| {durationStr} |");
            }

            sb.AppendLine();
        }

        private static void AppendFailureDetails(StringBuilder sb, RunResult result)
        {
            var failures = result.Scenarios
                .Where(s => s.Verdict != ScenarioVerdict.Passed
                         && s.Verdict != ScenarioVerdict.Skipped)
                .OrderBy(s => s.Verdict switch
                {
                    ScenarioVerdict.Crashed  => 0,
                    ScenarioVerdict.Failed   => 1,
                    ScenarioVerdict.TimedOut  => 2,
                    ScenarioVerdict.Partial   => 3,
                    _                        => 4
                })
                .ToList();

            if (failures.Count == 0) return;

            foreach (var scenario in failures)
            {
                var badge = VerdictBadge(scenario.Verdict);
                sb.AppendLine("<details>");
                sb.AppendLine($"<summary>{badge} — {EscapeMarkdown(scenario.ScenarioId)}: "
                            + $"{EscapeMarkdown(scenario.Title)}</summary>");
                sb.AppendLine();

                if (scenario.Verdict == ScenarioVerdict.TimedOut)
                {
                    AppendTimeoutDetails(sb, scenario);
                }
                else if (scenario.Verdict == ScenarioVerdict.Crashed)
                {
                    sb.AppendLine("**Crash details:**");
                    sb.AppendLine($"- Phase: `{scenario.FailedAtPhase}`");
                    if (!string.IsNullOrEmpty(scenario.ErrorMessage))
                        sb.AppendLine($"- Error: {EscapeMarkdown(scenario.ErrorMessage)}");
                    sb.AppendLine();
                }
                else
                {
                    AppendExpectationDetails(sb, scenario);
                }

                sb.AppendLine($"**Evidence:** {scenario.EventsCaptured} events captured "
                            + $"| [View Full Trace](http://localhost:5555/#/qa/"
                            + $"{result.RunId}/{scenario.ScenarioId})");
                sb.AppendLine("</details>");
                sb.AppendLine();
            }
        }

        private static void AppendExpectationDetails(StringBuilder sb, ScenarioResult scenario)
        {
            sb.AppendLine("**What failed:**");
            foreach (var exp in scenario.Expectations)
            {
                var icon = exp.Status == ExpectationStatus.Passed ? "●" : "✕";
                sb.AppendLine($"- {icon} {exp.ExpectationId}: {EscapeMarkdown(exp.Description)}");
                if (exp.Status == ExpectationStatus.Failed)
                {
                    if (!string.IsNullOrEmpty(exp.FailureReason))
                        sb.AppendLine($"  - **Observed:** {EscapeMarkdown(exp.FailureReason)}");
                    if (exp.ClosestMiss != null)
                        sb.AppendLine($"  - **Closest match:** `{SerializeClosestMiss(exp.ClosestMiss)}`");
                }
            }
            sb.AppendLine();
        }

        private static void AppendTimeoutDetails(StringBuilder sb, ScenarioResult scenario)
        {
            var matched = scenario.Expectations.Count(e => e.Status == ExpectationStatus.Passed);
            var total = scenario.Expectations.Count;
            sb.AppendLine($"**What happened:** Scenario exceeded timeout. "
                        + $"{matched}/{total} expectations matched before timeout.");

            foreach (var exp in scenario.Expectations)
            {
                var icon = exp.Status == ExpectationStatus.Passed ? "● PASS" : "● UNMATCHED";
                sb.AppendLine($"- {exp.ExpectationId}: {icon} — {EscapeMarkdown(exp.Description)}");
            }
            sb.AppendLine();

            if (!string.IsNullOrEmpty(scenario.ErrorMessage))
            {
                sb.AppendLine($"**Suggestion:** {EscapeMarkdown(scenario.ErrorMessage)}");
                sb.AppendLine();
            }
        }

        private static void AppendUnobservablePaths(StringBuilder sb, RunResult result)
        {
            if (result.UnobservablePaths == null || result.UnobservablePaths.Count == 0)
                return;

            sb.AppendLine("### Unobservable Paths");
            sb.AppendLine();
            sb.AppendLine("The following code touched by this PR cannot be verified by EDOG interceptors:");
            foreach (var path in result.UnobservablePaths)
            {
                sb.AppendLine($"- `{EscapeMarkdown(path)}`");
            }
            sb.AppendLine();
        }

        private static void AppendPerformance(StringBuilder sb, RunResult result)
        {
            sb.AppendLine("### Performance");
            sb.AppendLine();
            sb.AppendLine("| Metric | Value |");
            sb.AppendLine("|--------|-------|");

            var perf = result.Performance;
            sb.AppendLine($"| Slowest scenario | "
                        + $"{EscapeMarkdown(perf.SlowestScenarioId ?? "N/A")} "
                        + $"({FormatDuration(perf.SlowestScenarioMs)}) |");
            sb.AppendLine($"| Average scenario | {FormatDuration(perf.AverageScenarioMs)} |");
            sb.AppendLine($"| Total execution | {FormatDuration(perf.TotalExecutionMs)} |");
            sb.AppendLine($"| Overhead (setup/teardown) | {FormatDuration(perf.OverheadMs)} |");
            sb.AppendLine();
        }

        private static void AppendFooter(StringBuilder sb, RunResult result)
        {
            sb.AppendLine("---");
            sb.AppendLine($"*Generated by EDOG Studio F27 | Run ID: `{result.RunId}` "
                        + $"| [View Full Results](http://localhost:5555/#/qa/{result.RunId})*");
        }

        private static string TruncateComment(StringBuilder sb, RunResult result)
        {
            // Keep header + summary table, truncate failure details
            var truncated = new StringBuilder();
            AppendHeader(truncated, result);
            AppendSummaryTable(truncated, result);

            var failures = result.Scenarios
                .Where(s => s.Verdict != ScenarioVerdict.Passed
                         && s.Verdict != ScenarioVerdict.Skipped)
                .Take(5)
                .ToList();

            truncated.AppendLine($"> Showing top 5 of {result.Summary.Failed + result.Summary.TimedOut + result.Summary.Crashed} "
                              + $"non-passing scenarios. "
                              + $"[View Full Results](http://localhost:5555/#/qa/{result.RunId})");
            truncated.AppendLine();

            AppendUnobservablePaths(truncated, result);
            AppendPerformance(truncated, result);
            AppendFooter(truncated, result);

            return truncated.ToString();
        }

        // ── JUnit XML Helpers ───────────────────

        private static void WriteTestCase(XmlWriter writer, ScenarioResult scenario)
        {
            writer.WriteStartElement("testcase");
            writer.WriteAttributeString("name", scenario.Title ?? scenario.ScenarioId);
            writer.WriteAttributeString("classname",
                $"edog.qa.{scenario.Category ?? "unknown"}");
            writer.WriteAttributeString("time",
                (scenario.DurationMs / 1000.0).ToString("F3"));

            switch (scenario.Verdict)
            {
                case ScenarioVerdict.Failed:
                case ScenarioVerdict.Partial:
                    WriteFailureElement(writer, scenario);
                    break;

                case ScenarioVerdict.TimedOut:
                case ScenarioVerdict.Crashed:
                    WriteErrorElement(writer, scenario);
                    break;

                case ScenarioVerdict.Skipped:
                    writer.WriteStartElement("skipped");
                    writer.WriteAttributeString("message",
                        scenario.ErrorMessage ?? "Scenario skipped");
                    writer.WriteEndElement();
                    break;
            }

            writer.WriteEndElement(); // </testcase>
        }

        private static void WriteFailureElement(XmlWriter writer, ScenarioResult scenario)
        {
            var failedExps = scenario.Expectations
                .Where(e => e.Status == ExpectationStatus.Failed)
                .ToList();

            var message = failedExps.Count > 0
                ? failedExps[0].FailureReason ?? "Expectation not met"
                : "Expectation not met";

            writer.WriteStartElement("failure");
            writer.WriteAttributeString("message", Truncate(message, 2000));
            writer.WriteAttributeString("type", "ExpectationFailed");

            // Body: all failed expectations concatenated
            var body = new StringBuilder();
            foreach (var exp in failedExps)
            {
                body.AppendLine($"{exp.ExpectationId}: {exp.Description}");
                if (!string.IsNullOrEmpty(exp.FailureReason))
                    body.AppendLine($"  Observed: {exp.FailureReason}");
                if (exp.ClosestMiss != null)
                    body.AppendLine($"  Closest match: {SerializeClosestMiss(exp.ClosestMiss)}");
                body.AppendLine();
            }
            writer.WriteString(Truncate(body.ToString(), 2000));
            writer.WriteEndElement(); // </failure>
        }

        private static void WriteErrorElement(XmlWriter writer, ScenarioResult scenario)
        {
            var errorType = $"Scenario{scenario.Verdict}";
            var message = scenario.ErrorMessage
                       ?? $"Scenario {scenario.Verdict.ToString().ToLowerInvariant()} "
                        + $"after {scenario.DurationMs}ms";

            writer.WriteStartElement("error");
            writer.WriteAttributeString("message", Truncate(message, 2000));
            writer.WriteAttributeString("type", errorType);

            // For timeouts, report matched/pending expectations
            if (scenario.Verdict == ScenarioVerdict.TimedOut && scenario.Expectations.Count > 0)
            {
                var body = new StringBuilder();
                var matched = scenario.Expectations.Count(e => e.Status == ExpectationStatus.Passed);
                body.AppendLine($"{matched}/{scenario.Expectations.Count} expectations matched before timeout.");

                var pending = scenario.Expectations
                    .Where(e => e.Status != ExpectationStatus.Passed)
                    .ToList();
                if (pending.Count > 0)
                {
                    body.Append("Pending: ");
                    body.AppendLine(string.Join(", ",
                        pending.Select(e => $"{e.ExpectationId} ({e.Description})")));
                }
                writer.WriteString(Truncate(body.ToString(), 2000));
            }

            writer.WriteEndElement(); // </error>
        }

        // ── Formatting Utilities ────────────────

        private static string VerdictBadge(ScenarioVerdict verdict) => verdict switch
        {
            ScenarioVerdict.Passed   => "● PASS",
            ScenarioVerdict.Failed   => "● FAIL",
            ScenarioVerdict.TimedOut  => "● TIMEOUT",
            ScenarioVerdict.Partial   => "● PARTIAL",
            ScenarioVerdict.Crashed   => "● CRASH",
            ScenarioVerdict.Skipped   => "● SKIP",
            _                         => "● UNKNOWN"
        };

        private static string FormatDuration(long ms)
        {
            if (ms < 1000) return $"{ms}ms";
            if (ms < 60_000) return $"{ms / 1000.0:F1}s";
            var minutes = ms / 60_000;
            var seconds = (ms % 60_000) / 1000;
            return $"{minutes}m {seconds}s";
        }

        /// <summary>
        /// Escapes pipe characters and backtick sequences in markdown text
        /// to prevent table and code rendering issues.
        /// </summary>
        private static string EscapeMarkdown(string text)
        {
            if (string.IsNullOrEmpty(text)) return text ?? string.Empty;
            return text
                .Replace("|", "\\|")
                .Replace("<", "&lt;")
                .Replace(">", "&gt;");
        }

        private static string SerializeClosestMiss(TopicEvent ev)
        {
            if (ev == null) return "null";
            try
            {
                var summary = new { ev.Topic, ev.Timestamp, ev.Data };
                return JsonSerializer.Serialize(summary,
                    new JsonSerializerOptions { WriteIndented = false });
            }
            catch
            {
                return $"[Topic={ev.Topic}, Timestamp={ev.Timestamp}]";
            }
        }

        private static string Truncate(string text, int maxLength)
        {
            if (string.IsNullOrEmpty(text) || text.Length <= maxLength) return text ?? string.Empty;
            return text.Substring(0, maxLength - 3) + "...";
        }
    }
}
