# C05: Results & Reporting — Component Deep Spec

> **Author:** Sana (Architecture & FLT Internals)
> **Date:** 2025-07-10
> **Status:** P1 — Deep Design
> **Parent:** F27 QA Testing (`docs/specs/features/F27-qa-testing/spec.md`)
> **Depends on:** C01 (PR Diff Acquisition), C02 (Code Understanding Engine), C03 (Scenario Generation), C04 (Execution Engine)
> **Depended on by:** C06 (Frontend UI — results-view.js)

---

## Overview

Results & Reporting is everything AFTER the assertion engine evaluates expectations. It owns the data model that every upstream component writes into and every downstream consumer reads from: the frontend results panel, the PR comment thread, the CI gate verdict, the history store, and the regression detector. If C04 (Execution Engine) is the muscle, C05 is the nerve system that makes outcomes legible.

**Scope boundary:** C05 does NOT evaluate expectations (that's C04's `AssertionEngine`). C05 receives typed `ScenarioResult` objects and handles aggregation, formatting, persistence, transport, regression analysis, and export.

---

## S01: Result Data Model

**ID:** `C05-S01`
**One-liner:** Typed data model for individual scenario outcomes and aggregate run results.

### Detailed Description

Every scenario execution produces a `ScenarioResult` with a deterministic verdict: `passed`, `failed`, `partial`, `timed_out`, or `crashed`. Each expectation within the scenario carries its own status plus the matched (or closest-miss) evidence event. The `RunResult` aggregates all scenario results into a single object with summary counts, timing data, and the overall verdict. This model is the canonical contract consumed by every downstream system — frontend rendering (C06), PR comment formatting (S03), persistence (S06), regression detection (S07), and CI export (S08).

### Technical Mechanism

```csharp
// src/backend/DevMode/QaResultModels.cs (NEW — to be created)

public enum ScenarioVerdict { Passed, Failed, Partial, TimedOut, Crashed }
public enum ExpectationStatus { Passed, Failed, Unmatched, Skipped }

public sealed class ExpectationResult
{
    public string ExpectationId { get; set; }       // "exp-1", "exp-2", etc.
    public string Description { get; set; }         // Human-readable summary
    public ExpectationStatus Status { get; set; }
    public TopicEvent MatchedEvent { get; set; }    // null if Unmatched
    public TopicEvent ClosestMiss { get; set; }     // best-effort near-match for failures
    public string FailureReason { get; set; }       // "Expected HTTP 201, observed HTTP 500"
    public long MatchLatencyMs { get; set; }        // time from stimulus to match
}

public sealed class ScenarioResult
{
    public string ScenarioId { get; set; }          // "scn-write-file-correct-path"
    public string Title { get; set; }
    public string Category { get; set; }            // "happy_path", "error_path", etc.
    public ScenarioVerdict Verdict { get; set; }
    public long DurationMs { get; set; }
    public DateTimeOffset StartedAt { get; set; }
    public DateTimeOffset CompletedAt { get; set; }
    public List<ExpectationResult> Expectations { get; set; }
    public List<TopicEvent> CapturedEvents { get; set; }  // full evidence trail
    public string ErrorMessage { get; set; }        // non-null only for Crashed
    public int EventsCaptured { get; set; }         // count for summary display
}

public sealed class RunResult
{
    public string RunId { get; set; }               // "run-20250615-143022"
    public int PrId { get; set; }
    public string PrTitle { get; set; }
    public string PrUrl { get; set; }
    public DateTimeOffset StartedAt { get; set; }
    public DateTimeOffset CompletedAt { get; set; }
    public long TotalDurationMs { get; set; }
    public RunSummary Summary { get; set; }
    public List<ScenarioResult> Scenarios { get; set; }
    public List<string> UnobservablePaths { get; set; }  // code paths we can't test
    public PerformanceReport Performance { get; set; }
}

public sealed class RunSummary
{
    public int Total { get; set; }
    public int Passed { get; set; }
    public int Failed { get; set; }
    public int TimedOut { get; set; }
    public int Partial { get; set; }
    public int Crashed { get; set; }
    public int Skipped { get; set; }
    public bool OverallPass => Failed == 0 && Crashed == 0;
}

public sealed class PerformanceReport
{
    public long SlowestScenarioMs { get; set; }
    public string SlowestScenarioId { get; set; }
    public long AverageScenarioMs { get; set; }
    public long TotalExecutionMs { get; set; }       // sum of all scenario durations
    public long OverheadMs { get; set; }              // total - execution (setup/teardown)
}
```

### Source Code Path

- **New file:** `src/backend/DevMode/QaResultModels.cs` (to be created)
- **Consumed by:** `EdogPlaygroundHub.cs` (`src/backend/DevMode/EdogPlaygroundHub.cs`) via `ScenarioCompleted` and `RunCompleted` SignalR events (spec §8.4)
- **Builds on:** `TopicEvent` (`src/backend/DevMode/TopicEvent.cs:17-30`) — the `MatchedEvent` and `ClosestMiss` fields hold the same envelope type used across all interceptors

### Edge Cases

- **Crashed scenario with no expectations evaluated:** `Verdict = Crashed`, all expectations `Status = Skipped`, `ErrorMessage` populated. Frontend must handle zero-length expectation results.
- **Scenario with 0 captured events:** Possible if FLT is unresponsive. `Verdict = TimedOut`, `CapturedEvents` empty, `EventsCaptured = 0`. PR comment must not render an empty evidence section.
- **Very large evidence trail:** A single scenario may capture 50,000 events (spec §8.6 limit). `CapturedEvents` in `ScenarioResult` holds ALL of them for the trace explorer, but `RunResult` JSON serialization must use lazy serialization or separate the evidence file to avoid memory pressure.

### Interactions

| Component | Interaction |
|-----------|-------------|
| **C04 (Execution Engine)** | Produces `ScenarioResult` after each scenario execution. C05 receives via in-process callback. |
| **C06 (Frontend)** | Consumes `ScenarioResult` in real-time via SignalR `ScenarioCompleted` event, and `RunResult` via `RunCompleted`. |
| **S03 (PR Comment)** | Formats `RunResult` into markdown. |
| **S06 (History)** | Persists `RunResult` to `~/.edog/qa/results/{runId}.json`. |

### Revert/Undo

Data model is a type definition — no runtime state to revert. If the model schema changes, existing persisted `RunResult` files must be version-tagged (see S06) and migrated.

### Priority: **P0** — Every other scenario in C05 depends on this model.

---

## S02: Aggregation Logic

**ID:** `C05-S02`
**One-liner:** Reduce N scenario results into one `RunResult` with an overall pass/fail verdict.

### Detailed Description

After the execution engine (C04) completes all scenarios (or the run is cancelled), the aggregator collects all `ScenarioResult` objects, computes summary counts, calculates timing stats, and determines the overall verdict. The spec (§11, Decision #2) mandates **100% strict** — ANY failure blocks the PR. However, `Partial` and `TimedOut` are treated as failures for gate purposes but displayed distinctly in the UI. The aggregator also computes the `PerformanceReport` section and attaches the `UnobservablePaths` list from the code understanding engine (C02).

### Technical Mechanism

```csharp
// Inside ResultStore (src/backend/DevMode/QaResultStore.cs — NEW)

public RunResult Aggregate(string runId, QaRunContext context, List<ScenarioResult> results)
{
    var summary = new RunSummary
    {
        Total = results.Count,
        Passed = results.Count(r => r.Verdict == ScenarioVerdict.Passed),
        Failed = results.Count(r => r.Verdict == ScenarioVerdict.Failed),
        TimedOut = results.Count(r => r.Verdict == ScenarioVerdict.TimedOut),
        Partial = results.Count(r => r.Verdict == ScenarioVerdict.Partial),
        Crashed = results.Count(r => r.Verdict == ScenarioVerdict.Crashed),
        Skipped = results.Count(r => r.Verdict == ScenarioVerdict.Passed && r.Expectations.Count == 0)
    };

    var slowest = results.OrderByDescending(r => r.DurationMs).FirstOrDefault();

    return new RunResult
    {
        RunId = runId,
        PrId = context.PrId,
        PrTitle = context.PrTitle,
        PrUrl = context.PrUrl,
        StartedAt = results.Min(r => r.StartedAt),
        CompletedAt = results.Max(r => r.CompletedAt),
        TotalDurationMs = (long)(results.Max(r => r.CompletedAt) - results.Min(r => r.StartedAt))
                          .TotalMilliseconds,
        Summary = summary,
        Scenarios = results,
        UnobservablePaths = context.UnobservablePaths,
        Performance = new PerformanceReport
        {
            SlowestScenarioMs = slowest?.DurationMs ?? 0,
            SlowestScenarioId = slowest?.ScenarioId,
            AverageScenarioMs = results.Count > 0
                ? (long)results.Average(r => r.DurationMs) : 0,
            TotalExecutionMs = results.Sum(r => r.DurationMs),
            OverheadMs = (long)(results.Max(r => r.CompletedAt) - results.Min(r => r.StartedAt))
                         .TotalMilliseconds - results.Sum(r => r.DurationMs)
        }
    };
}
```

**Verdict rules (ordered):**

| Condition | `OverallPass` |
|-----------|---------------|
| Any `Crashed` | `false` |
| Any `Failed` | `false` |
| Any `TimedOut` | `false` |
| Any `Partial` only | `false` — partial is a failure for gate purposes |
| All `Passed` | `true` |
| Zero scenarios | `false` — empty runs are not a pass |

### Source Code Path

- **New file:** `src/backend/DevMode/QaResultStore.cs` — `Aggregate()` method
- **Inputs from:** `ExecutionEngine` in `EdogQaEngine` (spec §8.1: `ExecutionEngine → AssertionEngine → ResultStore`)
- **Context from:** `QaRunContext` built during PR analysis phase, carries `UnobservablePaths` from C02 (Roslyn analyzer)

### Edge Cases

- **Run cancelled mid-flight:** Scenarios not yet started get `Verdict = Skipped`. Already-running scenario gets force-completed as `TimedOut` (C04 handles this). Aggregator includes all results — the partial run still gets a verdict.
- **All scenarios skipped:** `OverallPass = false`. Zero execution is not a positive signal.
- **Single scenario run:** Valid. Aggregation produces a `RunResult` with `Total = 1`.
- **Overflow:** 50 scenarios (spec max) with 50,000 events each = 2.5M events. `RunResult.Scenarios[].CapturedEvents` must NOT be serialized into the aggregate JSON — only counts. Full evidence stored separately per scenario.

### Interactions

| Component | Interaction |
|-----------|-------------|
| **C04 (Execution Engine)** | Provides the `List<ScenarioResult>` input |
| **C02 (Code Understanding)** | Provides `UnobservablePaths` via `QaRunContext` |
| **S03 (PR Comment)** | Consumes `RunResult` for formatting |
| **S06 (History)** | Consumes `RunResult` for persistence |

### Revert/Undo

Aggregation is a pure function — no state to revert. Re-running produces a new `RunResult` with a new `runId`.

### Priority: **P0** — Required for every downstream consumer.

---

## S03: PR Comment Formatting

**ID:** `C05-S03`
**One-liner:** Transform `RunResult` into scannable, actionable markdown for ADO and GitHub PR comments.

### Detailed Description

The formatter takes a `RunResult` and produces a markdown string suitable for posting as a PR comment. The format must be (a) scannable at a glance — pass/fail verdict + counts visible in the first line, (b) expandable for failure details — reviewers need expected-vs-observed without leaving the PR, (c) actionable — every failure includes a suggestion or next step, (d) linkable — deep links back to EDOG Studio for trace exploration. Both ADO and GitHub markdown rendering are supported (they differ in collapsible section syntax).

### Technical Mechanism

**ADO format** (uses `<details>` for collapsible sections — supported in ADO PR comments):

```markdown
## ◆ EDOG QA Testing Results

**PR:** #12345 — Fix WriteFileAsync retry logic
**Run:** 2025-06-15 14:30 UTC | Duration: 2m 23s | Run ID: `run-20250615-143022`

### Summary: 10/12 PASSED ● 1 FAILED ● 1 TIMED OUT

| # | Scenario | Category | Result | Duration |
|---|----------|----------|--------|----------|
| 1 | WriteFileAsync writes to correct OneLake path | happy_path | ● PASS | 8.4s |
| 2 | OneLake 429 triggers exponential backoff retry | error_path | ● FAIL | 30.0s |
| 3 | Concurrent writes serialize correctly | edge_case | ● PASS | 12.1s |
| 4 | WriteFileAsync completes within SLA | performance | ● PASS | 5.2s |
| ... | ... | ... | ... | ... |
| 12 | Large file write with network partition | error_path | ● TIMEOUT | 60.0s |

<details>
<summary>● FAIL — scn-retry-on-429-throttle: OneLake 429 triggers exponential backoff retry</summary>

**What failed:**
- exp-3: Expected HTTP 201 to `dfs.fabric.microsoft.com` after retries
- **Expected:** `statusCode == 201` on topic `http` matching `url contains "dfs.fabric.microsoft.com"`
- **Observed:** HTTP 500 (closest match: `{statusCode: 500, url: "https://dfs.fabric.microsoft.com/..."}`)
- **Suggestion:** Check if retry count exceeds `MaxRetryAttempts` config value. The retry interceptor recorded 3 attempts but the 429→retry→success chain did not complete.

**Evidence:** 47 events captured | [View Full Trace](http://localhost:5555/#/qa/run-20250615-143022/scn-retry-on-429-throttle)
</details>

<details>
<summary>● TIMEOUT — scn-large-file-network-partition: Large file write with network partition (60.0s)</summary>

**What happened:** Scenario exceeded 60s timeout. 3/5 expectations matched before timeout.
- exp-1: ● PASS — Chaos rule injected network partition
- exp-2: ● PASS — Write operation initiated
- exp-3: ● PASS — Retry attempts observed (3x)
- exp-4: ● UNMATCHED — Expected write completion event never arrived
- exp-5: ● UNMATCHED — Expected cache invalidation after write

**Suggestion:** Increase timeout or check if `OneLakeWriter.WriteFileAsync` blocks indefinitely under network partition. Consider adding a circuit breaker.

**Evidence:** 312 events captured | [View Full Trace](http://localhost:5555/#/qa/run-20250615-143022/scn-large-file-network-partition)
</details>

### Unobservable Paths

The following code touched by this PR cannot be verified by EDOG interceptors:
- `SparkSessionManager.CreateSession()` — uses 1P HTTP client (not intercepted)
- `NotebookApi.ExecuteCell()` — external Notebook API call

### Performance

| Metric | Value |
|--------|-------|
| Slowest scenario | scn-large-file-network-partition (60.0s) |
| Average scenario | 11.8s |
| Total execution | 2m 21s |
| Overhead (setup/teardown) | 2s |

---
*Generated by EDOG Studio F27 | Run ID: `run-20250615-143022` | [View Full Results](http://localhost:5555/#/qa/run-20250615-143022)*
```

**GitHub format** — identical structure, but uses GitHub-flavored markdown checkbox syntax for expectation lists and native `> [!NOTE]` / `> [!WARNING]` callout blocks for unobservable paths.

```csharp
// src/backend/DevMode/QaAdoReporter.cs (NEW — to be created)

public sealed class QaPrCommentFormatter
{
    public enum PrPlatform { AzureDevOps, GitHub }

    public string Format(RunResult result, PrPlatform platform)
    {
        var sb = new StringBuilder();
        AppendHeader(sb, result);
        AppendSummaryTable(sb, result);
        AppendFailureDetails(sb, result, platform);
        AppendUnobservablePaths(sb, result, platform);
        AppendPerformance(sb, result);
        AppendFooter(sb, result);
        return sb.ToString();
    }

    private void AppendFailureDetails(StringBuilder sb, RunResult result, PrPlatform platform)
    {
        var failures = result.Scenarios
            .Where(s => s.Verdict != ScenarioVerdict.Passed)
            .OrderBy(s => s.Verdict) // Failed first, then TimedOut, then Partial
            .ToList();

        foreach (var scenario in failures)
        {
            if (platform == PrPlatform.AzureDevOps)
                sb.AppendLine($"<details>");
            else
                sb.AppendLine($"<details>");  // GitHub also supports <details>

            sb.AppendLine($"<summary>● {VerdictBadge(scenario.Verdict)} — {scenario.ScenarioId}: "
                        + $"{scenario.Title}</summary>");
            sb.AppendLine();

            foreach (var exp in scenario.Expectations)
            {
                var icon = exp.Status == ExpectationStatus.Passed ? "●" : "✕";
                sb.AppendLine($"- {icon} {exp.ExpectationId}: {exp.Description}");
                if (exp.Status == ExpectationStatus.Failed && exp.FailureReason != null)
                    sb.AppendLine($"  - **Observed:** {exp.FailureReason}");
                if (exp.ClosestMiss != null)
                    sb.AppendLine($"  - **Closest match:** `{SerializeClosestMiss(exp.ClosestMiss)}`");
            }

            sb.AppendLine($"\n**Evidence:** {scenario.EventsCaptured} events captured "
                        + $"| [View Full Trace](http://localhost:5555/#/qa/{result.RunId}/{scenario.ScenarioId})");
            sb.AppendLine("</details>");
            sb.AppendLine();
        }
    }
}
```

### Source Code Path

- **New file:** `src/backend/DevMode/QaAdoReporter.cs` — `QaPrCommentFormatter` class
- **ADO API call:** `POST https://dev.azure.com/{org}/{project}/_apis/git/repositories/{repo}/pullRequests/{id}/threads` (spec §9.3, line 1087)
- **Authentication:** Reuses existing PAT from `~/.edog/config.json` (spec §9.3, line 1091)

### Edge Cases

- **Markdown injection:** Scenario titles and failure reasons may contain user-influenced strings (from code comments, variable names). All interpolated text must be escaped — pipe characters (`|`) in table cells, backtick sequences, HTML tags. Use `EscapeMarkdown()` utility.
- **ADO comment size limit:** ADO PR comments have a ~150KB limit. With 50 scenarios and verbose failure details, the comment could exceed this. If `sb.Length > 130_000`, truncate failure details to top-5 most critical and append "... N more failures — [View Full Results](link)".
- **Localhost links:** The `View Full Results` link points to `localhost:5555`. This only works if the reviewer is running EDOG locally. For CI-posted comments, this link is useless. Future: hosted results viewer (out of C05 scope, note in comment).
- **No failures:** When all pass, omit the Failures section entirely. The comment should be short and celebratory: "All 12 scenarios passed."

### Interactions

| Component | Interaction |
|-----------|-------------|
| **S02 (Aggregation)** | Provides `RunResult` as input |
| **S04 (ADO API)** | Posts the formatted string to the PR |
| **C06 (Frontend)** | Shares the same `RunResult` but renders its own HTML — NOT the markdown |

### Revert/Undo

PR comments can be deleted via ADO API. The `AdoReporter` stores the `threadId` of the posted comment in the `RunResult` metadata so a subsequent run can update-in-place rather than creating a new comment.

### Priority: **P0** — Core deliverable for the PR workflow.

---

## S04: ADO API Integration

**ID:** `C05-S04`
**One-liner:** Post formatted results to ADO PR threads and update PR status.

### Detailed Description

The ADO reporter makes two API calls per run: (1) POST a PR comment thread with the formatted markdown, and (2) POST a PR status check that appears in the PR's merge policy evaluation. The status check enables future CI gate integration (spec §9.4) — even when posted manually, the PR shows "EDOG QA: Passed" or "EDOG QA: Failed" in the status checks section. Authentication uses the existing PAT infrastructure (`~/.edog/config.json`). The reporter supports idempotent re-posting: if a comment for this `runId` already exists, it updates the existing thread instead of creating a duplicate.

### Technical Mechanism

```csharp
// src/backend/DevMode/QaAdoReporter.cs — API integration methods

public sealed class QaAdoReporter
{
    private readonly HttpClient _httpClient;
    private readonly string _orgUrl;   // "https://dev.azure.com/powerbi"
    private readonly string _project;  // "MWC"
    private readonly string _repoId;   // GUID
    private readonly string _pat;      // from ~/.edog/config.json

    // Post or update PR comment
    public async Task<int> PostResultsAsync(int prId, string markdown, string runId)
    {
        // 1. Check if a thread with this runId already exists (idempotent update)
        var existingThreadId = await FindExistingThread(prId, runId);

        if (existingThreadId.HasValue)
        {
            // Update existing comment
            await UpdateThreadComment(prId, existingThreadId.Value, markdown);
            return existingThreadId.Value;
        }

        // 2. Create new thread
        var payload = new {
            comments = new[] {
                new { parentCommentId = 0, content = markdown, commentType = "text" }
            },
            status = "active",
            properties = new {
                edogRunId = new { type = "System.String", value = runId }
            }
        };

        var response = await _httpClient.PostAsJsonAsync(
            $"{_orgUrl}/{_project}/_apis/git/repositories/{_repoId}" +
            $"/pullRequests/{prId}/threads?api-version=7.1",
            payload);

        var thread = await response.Content.ReadFromJsonAsync<AdoThread>();
        return thread.Id;
    }

    // Post PR status check
    public async Task PostStatusAsync(int prId, RunResult result)
    {
        var status = new {
            state = result.Summary.OverallPass ? "succeeded" : "failed",
            description = $"EDOG QA: {result.Summary.Passed}/{result.Summary.Total} passed",
            context = new { name = "edog-qa", genre = "edog-studio" },
            targetUrl = $"http://localhost:5555/#/qa/{result.RunId}"
        };

        await _httpClient.PostAsJsonAsync(
            $"{_orgUrl}/{_project}/_apis/git/repositories/{_repoId}" +
            $"/pullRequests/{prId}/statuses?api-version=7.1",
            status);
    }
}
```

### Source Code Path

- **New file:** `src/backend/DevMode/QaAdoReporter.cs`
- **API endpoints:** Spec §9.3 (`spec.md:1081-1091`)
- **Auth config:** `~/.edog/config.json` — same PAT used by `PrDiffFetcher` (C01)
- **Hub trigger:** `PostToPr(string runId)` on `EdogPlaygroundHub` (`src/backend/DevMode/EdogPlaygroundHub.cs`) — spec §8.4, line 1017

### Edge Cases

- **PAT expired or insufficient scope:** ADO returns 401/403. Reporter must catch, log the specific permission error, and surface a clear message to the frontend: "PAT needs `Code (Read)` + `Pull Request Threads (Read & Write)` scope."
- **PR merged/closed:** ADO still allows comment posting on closed PRs. No special handling needed.
- **Rate limiting:** ADO API rate limits are generous (200 req/min per PAT). Single run posts 2 requests. No throttling needed.
- **Network failure:** Retry once after 2s delay. If still fails, store the formatted markdown locally (`~/.edog/qa/results/{runId}-pending-post.md`) and offer a "Retry Post" button in the frontend.
- **GitHub target:** If the repo is on GitHub (not ADO), use GitHub REST API (`POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews` for status, `POST /repos/{owner}/{repo}/issues/{issue_number}/comments` for comments). Platform detection from the PR URL.

### Interactions

| Component | Interaction |
|-----------|-------------|
| **S03 (Formatter)** | Provides the markdown string |
| **C01 (PR Diff)** | Shares the same PAT and org/project/repo configuration |
| **C06 (Frontend)** | Triggers `PostToPr` via SignalR; receives success/failure callback |

### Revert/Undo

Store the `threadId` returned by ADO. Provide a `DeleteResultComment(runId)` method that calls `DELETE .../threads/{threadId}`. The frontend can offer "Remove PR Comment" if the user wants to retract posted results.

### Priority: **P0** — Core PR workflow integration.

---

## S05: Failure Diagnostics

**ID:** `C05-S05`
**One-liner:** For each failed expectation, explain WHAT failed, WHY, and WHAT TO DO.

### Detailed Description

Raw "expectation not matched" is not actionable. The diagnostics engine enriches every failure with three layers: (1) **What** — the expected pattern vs what was actually observed (expected-vs-actual diff), (2) **Why** — causal analysis using the captured event trail (e.g., "retry loop exhausted because the chaos rule injected a permanent 500, not a transient 429"), (3) **What to do** — a concrete suggestion (e.g., "check MaxRetryAttempts config" or "the timeout of 30s may be too short for this code path"). For `TimedOut` scenarios, diagnostics report how many expectations matched before timeout and which ones were still pending.

### Technical Mechanism

```csharp
// src/backend/DevMode/QaFailureDiagnostics.cs (NEW)

public sealed class QaFailureDiagnostics
{
    public void Enrich(ScenarioResult result)
    {
        if (result.Verdict == ScenarioVerdict.Passed) return;

        foreach (var exp in result.Expectations.Where(e => e.Status != ExpectationStatus.Passed))
        {
            // 1. Find closest-miss event
            exp.ClosestMiss = FindClosestMatch(exp, result.CapturedEvents);

            // 2. Build failure reason with expected vs observed
            exp.FailureReason = BuildFailureReason(exp, result);

            // 3. Generate actionable suggestion (LLM-assisted or rule-based)
            // Rule-based first; LLM fallback for complex failures
        }
    }

    private TopicEvent FindClosestMatch(ExpectationResult exp, List<TopicEvent> events)
    {
        // Score each captured event against the expectation's matcher:
        //   - Topic matches: +50 points
        //   - Each matching field: +10 points
        //   - Partial string match on field value: +5 points
        // Return the event with the highest score (above a minimum threshold of 50)
        // This surfaces "you expected HTTP 201 but got HTTP 500 to the same URL"
    }

    private string BuildFailureReason(ExpectationResult exp, ScenarioResult scenario)
    {
        if (exp.ClosestMiss != null)
        {
            // Diff the expected fields against the closest-miss fields
            return $"Expected {ExpectedSummary(exp)} but observed {ObservedSummary(exp.ClosestMiss)}";
        }

        if (scenario.Verdict == ScenarioVerdict.TimedOut)
        {
            return $"No matching event within {scenario.DurationMs}ms timeout. "
                 + $"{scenario.EventsCaptured} events captured but none matched.";
        }

        return "No event matched. The expected behavior may not have been triggered.";
    }
}
```

### Source Code Path

- **New file:** `src/backend/DevMode/QaFailureDiagnostics.cs`
- **Called by:** `ResultStore.Aggregate()` — enrichment happens before persistence and before PR comment formatting
- **Reads:** `TopicEvent.Data` (object payload) from `src/backend/DevMode/TopicEvent.cs:29` — the diagnostic engine needs to inspect field-level data within the generic `object Data` property

### Edge Cases

- **No captured events at all:** FLT was unresponsive. Diagnostic: "Zero events captured. Verify FLT is running and EDOG interceptors are registered."
- **Multiple close matches:** If two events score equally, report both in the diagnostic. The reviewer picks which is relevant.
- **Sensitive data in events:** Event payloads may contain tokens, tenant IDs, or file paths. Diagnostics included in PR comments must redact known-sensitive fields (token values, connection strings). Use the same redaction logic as the existing `EdogTokenInterceptor`.
- **Suggestion quality:** Rule-based suggestions cover common patterns (wrong status code, missing retry, timeout). For novel failures, the suggestion is generic: "Review the full event trace in EDOG Studio."

### Interactions

| Component | Interaction |
|-----------|-------------|
| **C04 (Execution Engine)** | Provides the raw `ScenarioResult` with `CapturedEvents` |
| **S01 (Data Model)** | Enriches `ExpectationResult.ClosestMiss` and `FailureReason` fields |
| **S03 (PR Comment)** | Renders the enriched diagnostic text in the failure details section |
| **C06 (Frontend)** | Renders the same diagnostic data in the "Diff View: expected vs observed" panel |

### Revert/Undo

Diagnostics are computed fields — re-running the enrichment recomputes them. No persisted state to revert.

### Priority: **P0** — Failures without diagnostics are noise, not signal.

---

## S06: Run History Persistence

**ID:** `C05-S06`
**One-liner:** Store run results locally with versioned schema, 30-day retention, indexed for query.

### Detailed Description

Every completed run (including cancelled or crashed runs) is persisted to `~/.edog/qa/results/{runId}.json`. The history store supports queries by PR ID (show all runs for this PR), by date range, and by verdict (show all failures). Results are stored with a schema version tag so future format changes can migrate old data. Full evidence trails (captured events) are stored in a separate sidecar file (`{runId}-evidence.jsonl`) to keep the main result file scannable. Retention is 30 days (spec §8.5), enforced by a cleanup sweep on each new run.

### Technical Mechanism

```csharp
// src/backend/DevMode/QaResultStore.cs — persistence methods

public sealed class QaResultStore
{
    private static readonly string ResultsDir =
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                     ".edog", "qa", "results");

    private const int SchemaVersion = 1;
    private const int RetentionDays = 30;

    public async Task PersistAsync(RunResult result)
    {
        Directory.CreateDirectory(ResultsDir);

        // 1. Write main result (without full evidence)
        var summary = CloneWithoutEvidence(result);
        summary.SchemaVersion = SchemaVersion;
        var mainPath = Path.Combine(ResultsDir, $"{result.RunId}.json");
        await File.WriteAllTextAsync(mainPath,
            JsonSerializer.Serialize(summary, _jsonOptions));

        // 2. Write evidence sidecar (JSONL — one event per line, streamable)
        var evidencePath = Path.Combine(ResultsDir, $"{result.RunId}-evidence.jsonl");
        using var writer = new StreamWriter(evidencePath);
        foreach (var scenario in result.Scenarios)
        {
            foreach (var evt in scenario.CapturedEvents)
            {
                await writer.WriteLineAsync(JsonSerializer.Serialize(new {
                    scenarioId = scenario.ScenarioId,
                    evt.SequenceId,
                    evt.Timestamp,
                    evt.Topic,
                    evt.Data
                }, _jsonOptions));
            }
        }

        // 3. Cleanup old results
        CleanupOlderThan(TimeSpan.FromDays(RetentionDays));
    }

    public List<RunResultSummary> ListRuns(int? prId = null, int limit = 50)
    {
        // Read all .json files in ResultsDir (excluding -evidence.jsonl)
        // Filter by prId if specified
        // Return sorted by StartedAt descending
        // Only deserialize header fields (runId, prId, summary, startedAt) for speed
    }

    public RunResult LoadRun(string runId)
    {
        var path = Path.Combine(ResultsDir, $"{runId}.json");
        return JsonSerializer.Deserialize<RunResult>(File.ReadAllText(path), _jsonOptions);
    }

    private void CleanupOlderThan(TimeSpan maxAge)
    {
        var cutoff = DateTimeOffset.UtcNow - maxAge;
        foreach (var file in Directory.GetFiles(ResultsDir, "run-*.json"))
        {
            // Parse date from filename: run-YYYYMMDD-HHMMSS.json
            if (TryParseDateFromRunId(Path.GetFileNameWithoutExtension(file), out var date)
                && date < cutoff)
            {
                File.Delete(file);
                // Also delete evidence sidecar
                var evidence = Path.ChangeExtension(file, null) + "-evidence.jsonl";
                if (File.Exists(evidence)) File.Delete(evidence);
            }
        }
    }
}
```

**Storage layout:**

```
~/.edog/qa/results/
├── run-20250615-143022.json              # Main result (summary + scenario verdicts, no events)
├── run-20250615-143022-evidence.jsonl    # Full evidence trail (one event per line)
├── run-20250614-091500.json
├── run-20250614-091500-evidence.jsonl
└── ...
```

### Source Code Path

- **New file:** `src/backend/DevMode/QaResultStore.cs`
- **Storage location:** `~/.edog/qa/results/{runId}.json` (spec §8.5, line 1034)
- **Retention:** 30 days (spec §8.5)
- **Loaded by:** Frontend via `QaGetResults` SignalR RPC (P0 research §2.2, line 1002)

### Edge Cases

- **Disk full:** `PersistAsync` catches `IOException`, logs warning, and surfaces "Results not saved — disk full" to frontend. Run still succeeds in-memory.
- **Concurrent writes:** Each run has a unique `runId` (timestamped). No collision possible unless two runs start in the same second — the `runId` generator appends a random suffix if collision detected.
- **Evidence file for 50K events:** At ~200 bytes/line average, 50K events = ~10MB JSONL. For 50 scenarios = ~500MB worst case. Mitigate by storing only non-pass scenario evidence (passed scenarios don't need trace exploration).
- **Schema migration:** On load, check `SchemaVersion`. If older than current, run migration function. Version 1 → 2 migration registered at compile time. Unknown versions logged as warning but still loaded (best-effort).

### Interactions

| Component | Interaction |
|-----------|-------------|
| **S02 (Aggregation)** | Provides `RunResult` to persist |
| **S07 (Regression Detection)** | Reads historical runs via `ListRuns(prId)` |
| **S13 (Re-run Comparison)** | Loads two `RunResult` objects for diff |
| **C06 (Frontend)** | Displays run history list from `ListRuns()` |

### Revert/Undo

Delete both `{runId}.json` and `{runId}-evidence.jsonl`. The `qa:clear` command palette command (spec Appendix C) calls `ResultStore.DeleteRun(runId)`.

### Priority: **P0** — No history means no regression detection, no re-run comparison, no persistence across restarts.

---

## S07: Regression Detection

**ID:** `C05-S07`
**One-liner:** Detect when the same expectation fails across multiple runs — signal a real bug, not flakiness.

### Detailed Description

A single failure might be flaky. The same expectation failing across 3+ runs on related PRs is a regression. The regression detector scans historical results (S06) for patterns: (a) same expectation ID failing in multiple runs, (b) same code area (impact zone) producing failures across PRs, (c) a previously-passing expectation that now fails (behavioral regression). Regressions are surfaced prominently in both the frontend results view and the PR comment, with a label like "REGRESSION: This expectation has failed in 3 of the last 5 runs touching this area."

### Technical Mechanism

```csharp
// src/backend/DevMode/QaRegressionDetector.cs (NEW)

public sealed class QaRegressionDetector
{
    private readonly QaResultStore _store;

    public List<RegressionSignal> Detect(RunResult currentRun)
    {
        var signals = new List<RegressionSignal>();

        // 1. Load recent runs (last 30 days, same repo)
        var history = _store.ListRuns(limit: 100);

        // 2. For each failed expectation in current run,
        //    check if the same pattern has failed before
        foreach (var scenario in currentRun.Scenarios
            .Where(s => s.Verdict != ScenarioVerdict.Passed))
        {
            foreach (var exp in scenario.Expectations
                .Where(e => e.Status == ExpectationStatus.Failed))
            {
                var matchKey = BuildMatchKey(scenario, exp);
                    // Key: "{topic}:{matcher_fields_hash}" — identifies the semantic expectation
                    // independent of scenario ID (which changes per PR)

                var priorFailures = FindPriorFailures(history, matchKey);
                if (priorFailures.Count >= 2) // current + 2 prior = 3 total
                {
                    signals.Add(new RegressionSignal
                    {
                        Type = RegressionType.RepeatedFailure,
                        ExpectationKey = matchKey,
                        FailCount = priorFailures.Count + 1,
                        RunWindow = priorFailures.Count + 1,
                        AffectedRuns = priorFailures.Select(r => r.RunId).ToList(),
                        Summary = $"This expectation has failed in {priorFailures.Count + 1} "
                                + $"of the last {history.Count} runs"
                    });
                }
            }
        }

        // 3. Detect newly-failing expectations
        //    (expectations that passed in the last run but fail now)
        var lastRun = history.FirstOrDefault();
        if (lastRun != null)
        {
            var previouslyPassed = LoadPassedExpectationKeys(lastRun);
            var nowFailed = GetFailedExpectationKeys(currentRun);
            var newFailures = nowFailed.Intersect(previouslyPassed).ToList();
            foreach (var key in newFailures)
            {
                signals.Add(new RegressionSignal
                {
                    Type = RegressionType.NewFailure,
                    ExpectationKey = key,
                    Summary = "NEW: This expectation passed in the previous run but fails now"
                });
            }
        }

        return signals;
    }
}

public enum RegressionType { RepeatedFailure, NewFailure, AreaDegradation }

public sealed class RegressionSignal
{
    public RegressionType Type { get; set; }
    public string ExpectationKey { get; set; }
    public int FailCount { get; set; }
    public int RunWindow { get; set; }
    public List<string> AffectedRuns { get; set; }
    public string Summary { get; set; }
}
```

### Source Code Path

- **New file:** `src/backend/DevMode/QaRegressionDetector.cs`
- **Data source:** `QaResultStore.ListRuns()` and `QaResultStore.LoadRun()` from `src/backend/DevMode/QaResultStore.cs`
- **Invoked by:** `ResultStore.Aggregate()` — regression signals are attached to the `RunResult` before PR comment formatting

### Edge Cases

- **First-ever run:** No history. Regression detection returns empty. All failures are "new" by definition — no regression label applied.
- **Flaky vs regression:** Spec §10.5 (line 1150) defines flakiness: "passes sometimes, fails sometimes" over 3 runs. Regression = fails consistently. The detector marks flaky expectations separately (`FlakySignal`), not as regressions.
- **Scenario ID changes between runs:** Scenario IDs are PR-specific (e.g., `scn-write-file-correct-path` for PR #100 and `scn-write-file-renamed-path` for PR #101). Regression detection uses `BuildMatchKey()` based on the expectation's topic + matcher fields, NOT the scenario ID, to detect cross-PR regressions.
- **Large history:** 100 runs, 50 scenarios each = 5,000 scenario results to scan. `ListRuns()` loads only summaries (not evidence). Performance budget: <500ms for regression detection.

### Interactions

| Component | Interaction |
|-----------|-------------|
| **S06 (History)** | Reads historical run results |
| **S03 (PR Comment)** | Regression signals appear as labels in the failure details section |
| **C06 (Frontend)** | Regression signals highlighted with a distinct visual indicator |
| **C02 (Code Understanding)** | `AreaDegradation` regression uses impact zones from Roslyn analysis |

### Revert/Undo

Regression signals are computed on-the-fly — no persistent state. Clearing history (S06) resets the regression baseline.

### Priority: **P1** — High value but requires history data to be useful. Not needed for day-one single-run workflow.

---

## S08: Export to CI Systems (JUnit XML)

**ID:** `C05-S08`
**One-liner:** Export `RunResult` as JUnit XML for pipeline integration and test result dashboards.

### Detailed Description

CI pipelines (Azure Pipelines, GitHub Actions) understand JUnit XML natively. The export converts each scenario into a `<testcase>` element and each failed expectation into a `<failure>` element. This enables: (a) test result tab in the ADO pipeline run, (b) test analytics (trend charts, flaky test detection), (c) third-party dashboard integration (Datadog, Grafana). The export is triggered manually ("Export as JUnit XML") or automatically when F27 runs in CI mode (spec §9.4).

### Technical Mechanism

```xml
<!-- Example JUnit XML output for the run -->
<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="EDOG QA Testing" tests="12" failures="1" errors="1" time="143.0">
  <testsuite name="PR #12345: Fix WriteFileAsync retry logic"
             tests="12" failures="1" errors="1" time="143.0"
             timestamp="2025-06-15T14:30:22Z">

    <testcase name="WriteFileAsync writes to correct OneLake path"
              classname="edog.qa.happy_path" time="8.432">
    </testcase>

    <testcase name="OneLake 429 triggers exponential backoff retry"
              classname="edog.qa.error_path" time="30.0">
      <failure message="exp-3: Expected HTTP 201 but observed HTTP 500"
               type="ExpectationFailed">
Expected: statusCode == 201 on topic 'http' matching url contains 'dfs.fabric.microsoft.com'
Observed: {statusCode: 500, url: "https://dfs.fabric.microsoft.com/..."}
Suggestion: Check if retry count exceeds MaxRetryAttempts config value
      </failure>
    </testcase>

    <testcase name="Large file write with network partition"
              classname="edog.qa.error_path" time="60.0">
      <error message="Scenario timed out after 60000ms"
             type="ScenarioTimedOut">
3/5 expectations matched before timeout.
Pending: exp-4 (write completion), exp-5 (cache invalidation)
      </error>
    </testcase>

  </testsuite>
</testsuites>
```

```csharp
// src/backend/DevMode/QaJUnitExporter.cs (NEW)

public sealed class QaJUnitExporter
{
    public string Export(RunResult result)
    {
        var doc = new XDocument(
            new XElement("testsuites",
                new XAttribute("name", "EDOG QA Testing"),
                new XAttribute("tests", result.Summary.Total),
                new XAttribute("failures", result.Summary.Failed),
                new XAttribute("errors", result.Summary.Crashed + result.Summary.TimedOut),
                new XAttribute("time", result.TotalDurationMs / 1000.0),
                new XElement("testsuite",
                    new XAttribute("name", $"PR #{result.PrId}: {result.PrTitle}"),
                    new XAttribute("tests", result.Summary.Total),
                    new XAttribute("timestamp", result.StartedAt.ToString("o")),
                    result.Scenarios.Select(ScenarioToTestCase)
                )
            )
        );

        return doc.ToString();
    }

    private XElement ScenarioToTestCase(ScenarioResult scenario)
    {
        var tc = new XElement("testcase",
            new XAttribute("name", scenario.Title),
            new XAttribute("classname", $"edog.qa.{scenario.Category}"),
            new XAttribute("time", scenario.DurationMs / 1000.0));

        switch (scenario.Verdict)
        {
            case ScenarioVerdict.Failed:
                var failedExp = scenario.Expectations
                    .First(e => e.Status == ExpectationStatus.Failed);
                tc.Add(new XElement("failure",
                    new XAttribute("message", failedExp.FailureReason ?? "Expectation not met"),
                    new XAttribute("type", "ExpectationFailed"),
                    BuildFailureBody(scenario)));
                break;

            case ScenarioVerdict.TimedOut:
            case ScenarioVerdict.Crashed:
                tc.Add(new XElement("error",
                    new XAttribute("message", scenario.ErrorMessage ?? $"Scenario {scenario.Verdict}"),
                    new XAttribute("type", $"Scenario{scenario.Verdict}")));
                break;
        }

        return tc;
    }
}
```

### Source Code Path

- **New file:** `src/backend/DevMode/QaJUnitExporter.cs`
- **Output path:** `~/.edog/qa/results/{runId}-junit.xml`
- **Pipeline consumption:** `PublishTestResults@2` ADO task reads JUnit XML (spec §9.4, line 1104-1112)

### Edge Cases

- **Special characters in scenario titles:** XML entities must be escaped (`&`, `<`, `>`, `"`, `'`). `XDocument` handles this natively.
- **Very long failure messages:** JUnit XML has no formal size limit, but some CI dashboards truncate at 4KB per failure body. Keep failure details under 2KB; link to full trace for more.
- **Scenario with multiple failed expectations:** JUnit allows one `<failure>` per `<testcase>`. Concatenate all failed expectations into a single failure body, separated by newlines.

### Interactions

| Component | Interaction |
|-----------|-------------|
| **S02 (Aggregation)** | Provides `RunResult` as input |
| **S05 (Diagnostics)** | Failure body text includes diagnostic suggestions |
| **C06 (Frontend)** | "Export JUnit XML" button triggers this exporter |

### Revert/Undo

File-based — delete the XML file. No side effects.

### Priority: **P1** — Required for CI integration (spec Phase 2, §9.4) but not for day-one manual workflow.

---

## S09: Real-Time Progress Reporting

**ID:** `C05-S09`
**One-liner:** Stream scenario-by-scenario progress to the frontend via SignalR as execution unfolds.

### Detailed Description

During a run, the frontend needs to show "Scenario 3/12 — 2 passed, 1 failed" updating in real-time. The execution engine (C04) fires SignalR events as each scenario progresses through its lifecycle. C05 defines the event contracts and ensures the frontend receives a coherent, ordered stream that survives reconnections. The events mirror the SignalR protocol defined in spec §8.4 (`EdogPlaygroundHub`).

### Technical Mechanism

```csharp
// SignalR events emitted by the execution engine, defined in C05's contracts

// 1. Run started
await Clients.All.SendAsync("QaRunStarted", new {
    runId,
    totalScenarios = scenarios.Count,
    startedAt = DateTimeOffset.UtcNow
});

// 2. Per-scenario progress (fired by C04, uses C05 event shapes)
await Clients.All.SendAsync("QaScenarioStarted", new {
    runId,
    scenarioId,
    scenarioIndex,     // 1-based: "scenario 3 of 12"
    totalScenarios,
    title
});

// 3. Per-expectation match (real-time, as events arrive)
await Clients.All.SendAsync("QaExpectationMatched", new {
    runId,
    scenarioId,
    expectationId,
    passed,            // bool
    matchedEvent,      // TopicEvent or null
    failureReason      // string or null
});

// 4. Scenario complete
await Clients.All.SendAsync("QaScenarioCompleted", new {
    runId,
    scenarioId,
    verdict,           // "passed", "failed", "timed_out", "crashed"
    durationMs,
    passedCount,       // expectations passed
    failedCount,       // expectations failed
    totalExpectations
});

// 5. Run complete
await Clients.All.SendAsync("QaRunCompleted", new {
    runId,
    summary,           // RunSummary object
    totalDurationMs,
    regressionSignals  // List<RegressionSignal>
});
```

**Frontend state machine:**

```
IDLE → RUN_STARTED → [SCENARIO_STARTED → EXPECTATION_MATCHED* → SCENARIO_COMPLETED]+ → RUN_COMPLETED → IDLE
```

### Source Code Path

- **Events defined on:** `EdogPlaygroundHub` (`src/backend/DevMode/EdogPlaygroundHub.cs`) — new methods per spec §8.4, lines 1019-1026
- **Frontend handler:** `main.js:handleWebSocketMessage()` (`src/frontend/js/main.js:552`) — extended with `qa*` event type routing
- **Frontend state:** New `QaRunState` class in `state.js` (pattern follows `LogViewerState` at `src/frontend/js/state.js:125`)

### Edge Cases

- **SignalR disconnect during run:** Execution continues on the backend. On reconnect, the frontend calls `QaGetRunState(runId)` to get the current snapshot (which scenarios are done, which is in-progress) and resumes from that point. Pattern matches F24's reconnection with snapshot rehydration (P0 research §2.2).
- **Event ordering:** SignalR MessagePack over WebSocket is ordered per-connection. No out-of-order risk within a single client.
- **Backend crash during run:** All events lost. On EDOG restart, the run is marked as `Crashed` from the last persisted checkpoint. See C04's crash recovery (spec §5.5).

### Interactions

| Component | Interaction |
|-----------|-------------|
| **C04 (Execution Engine)** | Fires the events at each lifecycle transition |
| **C06 (Frontend)** | Consumes events to update progress bar, scenario status list, live event stream |
| **S01 (Data Model)** | Event payloads use the same types as the final `ScenarioResult` |

### Revert/Undo

Events are fire-and-forget. No state to revert. The frontend can "reset" by navigating away from the QA panel.

### Priority: **P0** — Users must see execution progress. Without it, the run appears frozen.

---

## S10: Diff-Aware Reporting

**ID:** `C05-S10`
**One-liner:** Label expectations that are NEW, REMOVED, or CHANGED compared to the last run on this PR.

### Detailed Description

When a developer re-runs F27 after updating their PR, the results should highlight what changed: "3 new expectations added (from new code in commit abc123)", "1 expectation removed (code deleted)", "2 expectations modified (matcher updated due to refactor)". This is computed by diffing the current run's expectation set against the previous run for the same PR. The diff uses the same `BuildMatchKey()` from regression detection (S07) to identify semantic equivalence across runs.

### Technical Mechanism

```csharp
// src/backend/DevMode/QaDiffReporter.cs (NEW)

public sealed class QaDiffReporter
{
    public RunDiff ComputeDiff(RunResult current, RunResult previous)
    {
        var currentKeys = ExtractExpectationKeys(current);
        var previousKeys = ExtractExpectationKeys(previous);

        return new RunDiff
        {
            NewExpectations = currentKeys.Except(previousKeys)
                .Select(k => new DiffItem { Key = k, Label = "NEW" }).ToList(),
            RemovedExpectations = previousKeys.Except(currentKeys)
                .Select(k => new DiffItem { Key = k, Label = "REMOVED" }).ToList(),
            ChangedVerdicts = FindVerdictChanges(current, previous),
            PreviousRunId = previous.RunId
        };
    }

    private List<VerdictChange> FindVerdictChanges(RunResult current, RunResult previous)
    {
        // Find expectations present in both runs where the verdict flipped
        // e.g., was PASS → now FAIL = regression
        //        was FAIL → now PASS = fixed
    }
}

public sealed class RunDiff
{
    public List<DiffItem> NewExpectations { get; set; }
    public List<DiffItem> RemovedExpectations { get; set; }
    public List<VerdictChange> ChangedVerdicts { get; set; }
    public string PreviousRunId { get; set; }
}

public sealed class VerdictChange
{
    public string ExpectationKey { get; set; }
    public ScenarioVerdict PreviousVerdict { get; set; }
    public ScenarioVerdict CurrentVerdict { get; set; }
    public string Label { get; set; }  // "FIXED", "REGRESSED", "NOW FLAKY"
}
```

### Source Code Path

- **New file:** `src/backend/DevMode/QaDiffReporter.cs`
- **Data source:** `QaResultStore.ListRuns(prId)` to find the previous run (S06)
- **Output consumed by:** S03 (PR comment adds "NEW" / "FIXED" labels) and C06 (frontend badges)

### Edge Cases

- **First run on this PR:** No previous run to diff against. `RunDiff` is null. All expectations implicitly "new."
- **PR has 10 previous runs:** Use only the most recent previous run for diff. Older runs are available in history but not compared here.
- **Scenario restructured:** If the AI generates completely different scenarios after a large code change, all expectations appear "NEW" and all old ones "REMOVED." This is correct behavior — the diff is accurate even if not particularly insightful.

### Interactions

| Component | Interaction |
|-----------|-------------|
| **S06 (History)** | Loads the previous run for this PR |
| **S07 (Regression)** | Shares `BuildMatchKey()` logic for semantic key generation |
| **S03 (PR Comment)** | Adds diff labels ("NEW", "FIXED") to the comment |
| **C06 (Frontend)** | Displays diff badges next to each expectation |

### Revert/Undo

Pure computation — no state. Re-running recomputes.

### Priority: **P1** — Valuable for iterative development but not required for single-run workflow.

---

## S11: Performance Report Section

**ID:** `C05-S11`
**One-liner:** Include timing data and slowest-scenario breakdown in every run report.

### Detailed Description

Every `RunResult` includes a `PerformanceReport` (defined in S01) with: slowest scenario (ID + duration), average scenario duration, total execution time, and overhead (setup/teardown time). This section appears in both the PR comment (S03) and the frontend results view (C06). For `performance` category scenarios specifically, the report also includes per-operation timing data extracted from `perf` topic events (using `EdogPerfMarkerCallback` at `src/backend/DevMode/EdogPerfMarkerCallback.cs:68`).

### Technical Mechanism

```csharp
// Computed during aggregation (S02), stored in RunResult.Performance

public PerformanceReport BuildPerformanceReport(List<ScenarioResult> results)
{
    var sorted = results.OrderByDescending(r => r.DurationMs).ToList();

    var report = new PerformanceReport
    {
        SlowestScenarioMs = sorted.First().DurationMs,
        SlowestScenarioId = sorted.First().ScenarioId,
        AverageScenarioMs = (long)results.Average(r => r.DurationMs),
        TotalExecutionMs = results.Sum(r => r.DurationMs),
        OverheadMs = /* total wall clock - sum of scenario durations */
    };

    // For performance-category scenarios, extract perf topic timing
    foreach (var scenario in results.Where(s => s.Category == "performance"))
    {
        var perfEvents = scenario.CapturedEvents
            .Where(e => e.Topic == "perf")
            .Select(e => DeserializePerfEvent(e.Data))
            .OrderByDescending(p => p.DurationMs)
            .ToList();

        report.OperationTimings.Add(new OperationTiming
        {
            ScenarioId = scenario.ScenarioId,
            SlowestOperation = perfEvents.FirstOrDefault()?.OperationName,
            SlowestOperationMs = perfEvents.FirstOrDefault()?.DurationMs ?? 0,
            Operations = perfEvents
        });
    }

    return report;
}
```

### Source Code Path

- **Computed in:** `QaResultStore.Aggregate()` — `src/backend/DevMode/QaResultStore.cs`
- **Perf event source:** `EdogPerfMarkerCallback.cs:68` publishes to `perf` topic with fields: `operationName`, `durationMs`, `result`, `correlationId`, `dimensions` (spec Appendix A)
- **Rendered in:** S03 (PR comment "Performance" table) and C06 (frontend performance section)

### Edge Cases

- **Zero scenarios:** No performance data. `PerformanceReport` fields all zero. Omit the section from PR comment.
- **All scenarios timed out:** `SlowestScenarioMs` = timeout value (60s). `AverageScenarioMs` = timeout value. The performance section is misleading — add a note: "All scenarios hit timeout — performance data unreliable."
- **No perf-category scenarios:** `OperationTimings` is empty. The basic timing section (slowest, average, total) is still shown.

### Interactions

| Component | Interaction |
|-----------|-------------|
| **S02 (Aggregation)** | Computes the `PerformanceReport` during aggregation |
| **S03 (PR Comment)** | Renders the Performance table in the markdown comment |
| **C06 (Frontend)** | Renders timing charts and slowest-scenario highlights |

### Revert/Undo

Computed data — no state.

### Priority: **P2** — Nice to have. Basic timing (slowest, average) is P0 as part of S02. The detailed operation-level breakdown is P2.

---

## S12: Partial Results Handling

**ID:** `C05-S12`
**One-liner:** When some scenarios pass and others fail/timeout, produce a coherent overall verdict with clear accounting.

### Detailed Description

A run with 10 passed, 1 failed, and 1 timed-out must not silently ignore the failures or present an ambiguous result. The partial results handler ensures: (a) the overall verdict is `FAILED` (100% strict, spec §11 Decision #2), (b) the summary line clearly states "10/12 PASSED ● 1 FAILED ● 1 TIMED OUT" (not just "83% pass rate"), (c) passed scenarios are still shown (with green indicators) to give credit for what works, (d) the PR comment lists failures first, then timeouts, then successes (scannable priority order).

### Technical Mechanism

The verdict logic is in S02 (Aggregation). S12's role is the **presentation ordering and accounting** for mixed results:

```csharp
// Sorting order for PR comment and frontend display
public static List<ScenarioResult> SortForDisplay(List<ScenarioResult> results)
{
    return results
        .OrderBy(r => r.Verdict switch
        {
            ScenarioVerdict.Crashed  => 0,  // Crashes first — most severe
            ScenarioVerdict.Failed   => 1,  // Failures second
            ScenarioVerdict.TimedOut => 2,  // Timeouts third
            ScenarioVerdict.Partial  => 3,  // Partial results fourth
            ScenarioVerdict.Passed   => 4,  // Passes last — least interesting
            _ => 5
        })
        .ThenBy(r => r.DurationMs)          // Within each group, fastest first
        .ToList();
}

// Summary line generation
public static string BuildSummaryLine(RunSummary summary)
{
    var parts = new List<string>();
    parts.Add($"{summary.Passed}/{summary.Total} PASSED");
    if (summary.Failed > 0)   parts.Add($"{summary.Failed} FAILED");
    if (summary.TimedOut > 0) parts.Add($"{summary.TimedOut} TIMED OUT");
    if (summary.Crashed > 0)  parts.Add($"{summary.Crashed} CRASHED");
    if (summary.Partial > 0)  parts.Add($"{summary.Partial} PARTIAL");
    return string.Join(" ● ", parts);
}
```

### Source Code Path

- **In:** `src/backend/DevMode/QaAdoReporter.cs` — display ordering logic within the formatter
- **Summary line used by:** S03 (PR comment header) and C06 (frontend header bar)

### Edge Cases

- **ALL scenarios passed:** Summary: "12/12 PASSED". No failures section. Short, celebratory comment.
- **ALL scenarios failed:** Summary: "0/12 PASSED ● 12 FAILED". Failures section expanded by default. Consider: is this a configuration problem (FLT not running)? Add a note if zero passes detected.
- **Run cancelled after 3 of 12:** "3/12 COMPLETED ● 2 PASSED ● 1 FAILED ● 9 SKIPPED (run cancelled)". Clearly indicate the run was incomplete.

### Interactions

| Component | Interaction |
|-----------|-------------|
| **S02 (Aggregation)** | Provides `RunSummary` with per-verdict counts |
| **S03 (PR Comment)** | Uses display ordering and summary line |
| **C06 (Frontend)** | Uses display ordering for scenario list rendering |

### Revert/Undo

Display-only computation. No state.

### Priority: **P0** — Mixed results are the common case. Without clear accounting, results are unreadable.

---

## S13: Re-Run Comparison

**ID:** `C05-S13`
**One-liner:** Compare current run to a previous run of the same scenarios and highlight what changed.

### Detailed Description

After fixing a failure and re-running, the developer wants to see: "The 2 failures from the last run are now passing. 10 scenarios unchanged." This is distinct from diff-aware reporting (S10), which compares expectation SETS. Re-run comparison compares VERDICTS for the same expectation keys across two specific runs. The comparison is presented as a transition table: FAIL→PASS (fixed), PASS→FAIL (regressed), FAIL→FAIL (still broken), PASS→PASS (stable).

### Technical Mechanism

```csharp
// src/backend/DevMode/QaRerunComparator.cs (NEW)

public sealed class RerunComparison
{
    public string CurrentRunId { get; set; }
    public string PreviousRunId { get; set; }
    public int Fixed { get; set; }        // was FAIL, now PASS
    public int Regressed { get; set; }    // was PASS, now FAIL
    public int StillBroken { get; set; }  // was FAIL, still FAIL
    public int Stable { get; set; }       // was PASS, still PASS
    public int NewScenarios { get; set; } // not in previous run
    public List<TransitionItem> Transitions { get; set; }
}

public sealed class TransitionItem
{
    public string ScenarioTitle { get; set; }
    public string ExpectationKey { get; set; }
    public ScenarioVerdict Previous { get; set; }
    public ScenarioVerdict Current { get; set; }
    public string TransitionLabel { get; set; }  // "FIXED", "REGRESSED", "STILL BROKEN", "STABLE"
}
```

### Source Code Path

- **New file:** `src/backend/DevMode/QaRerunComparator.cs`
- **Data source:** Two `RunResult` objects from `QaResultStore.LoadRun()` (S06)
- **Triggered by:** `qa:run-failed` command (spec Appendix C, line 1212) or manual "Compare with previous run" in frontend

### Edge Cases

- **No previous run:** Comparison unavailable. All scenarios marked "NEW."
- **Scenario count changed:** New scenarios in current run have no `Previous` verdict — marked as "NEW." Scenarios removed from current run don't appear (they're in the previous run's history).
- **Same run compared to itself:** Edge case. All transitions are `STABLE`. Handle gracefully, don't crash.

### Interactions

| Component | Interaction |
|-----------|-------------|
| **S06 (History)** | Loads both run results |
| **S10 (Diff-Aware)** | Shares expectation key matching logic |
| **C06 (Frontend)** | Renders the comparison as a transition table |
| **S03 (PR Comment)** | Optionally includes a comparison summary line: "vs previous run: 2 FIXED, 0 REGRESSED" |

### Revert/Undo

Pure computation. No state.

### Priority: **P1** — Valuable for iterative fix-and-rerun workflow. Not needed for first-run scenario.

---

## S14: Human-Actionable Summaries

**ID:** `C05-S14`
**One-liner:** Generate a plain-English summary that tells the developer WHAT HAPPENED and WHAT TO DO.

### Detailed Description

Beyond structured data, the developer needs a natural-language summary: "2 regressions found, likely caused by the change in RetryPolicy.cs (line 45 → removed timeout handling). The error_path scenarios failed because the retry loop no longer has a timeout ceiling, causing infinite retries until the 60s scenario timeout kills the test. Recommendation: restore the timeout or update the retry config." This summary is generated by GPT-5.4-pro reading the `RunResult` + the PR diff context, and appears at the top of the PR comment (before the table) and in the frontend results header.

### Technical Mechanism

```csharp
// src/backend/DevMode/QaSummaryGenerator.cs (NEW)

public sealed class QaSummaryGenerator
{
    private readonly IAzureOpenAiClient _llm;

    public async Task<string> GenerateSummaryAsync(RunResult result, string prDiffContext)
    {
        if (result.Summary.OverallPass)
        {
            // Simple pass — no LLM needed
            return $"All {result.Summary.Total} scenarios passed. "
                 + $"No regressions detected. Safe to merge.";
        }

        var prompt = $"""
            You are an FLT code reviewer analyzing QA test results for PR #{result.PrId}.

            ## PR Context
            {prDiffContext}

            ## Test Results
            - {result.Summary.Passed} passed, {result.Summary.Failed} failed,
              {result.Summary.TimedOut} timed out
            - Failed scenarios:
            {FormatFailuresForLlm(result)}

            ## Task
            Write a 2-3 sentence summary that:
            1. States what failed in plain English
            2. Identifies the likely cause from the PR diff
            3. Suggests a specific action to fix it

            Be direct. No hedging. Reference specific file names and line numbers.
            """;

        var response = await _llm.CompleteAsync(prompt, maxTokens: 300);
        return response.Text;
    }
}
```

### Source Code Path

- **New file:** `src/backend/DevMode/QaSummaryGenerator.cs`
- **LLM client:** Same `IAzureOpenAiClient` used by `ScenarioGenerator` (C03) — reuses the existing GPT-5.4-pro connection
- **PR diff context from:** `PrDiffFetcher` (C01) — already loaded during scenario generation phase, cached in `QaRunContext`

### Edge Cases

- **GPT-5.4-pro unavailable:** Fallback to template-based summary: "N failures detected. See details below." No LLM-generated insights.
- **All passed:** No LLM call. Deterministic "All N scenarios passed" message. Save tokens.
- **LLM hallucinates file names:** The summary is presented as "AI-generated analysis" with a disclaimer. The structured data (table, failure details) is the source of truth. The summary is supplementary.
- **Token budget:** Summary prompt + response should be <2K tokens total. The PR diff context is truncated to the most relevant 500 lines (same context the scenario generator used).

### Interactions

| Component | Interaction |
|-----------|-------------|
| **C01 (PR Diff)** | Provides the PR diff context for LLM reasoning |
| **C03 (Scenario Generation)** | Shares the LLM client and token budget |
| **S03 (PR Comment)** | Summary inserted at the top of the PR comment, before the table |
| **C06 (Frontend)** | Summary displayed as a header card in the results panel |

### Revert/Undo

Regenerate by calling `GenerateSummaryAsync()` again. No cached state.

### Priority: **P2** — LLM-generated summaries are a polish feature. The structured failure diagnostics (S05) provide actionable information without LLM involvement.

---

## Dependency Graph

```
C01 (PR Diff) ──────────────────────────────────┐
C02 (Code Understanding) ───────────────────────┐│
C03 (Scenario Generation) ──────────────────────┤│
C04 (Execution Engine) ─── produces ──► S01 ────┤│
                                         │      ││
                                         ▼      ▼▼
                                        S02 (Aggregation)
                                         │
                              ┌──────────┼──────────┬──────────┐
                              ▼          ▼          ▼          ▼
                        S05 (Diagnostics) S11 (Perf) S12 (Partial)
                              │
                              ▼
                        S03 (PR Comment Formatting)
                              │
                    ┌─────────┼─────────┐
                    ▼         ▼         ▼
              S04 (ADO API) S08 (JUnit) S14 (Summary)
                    
              S06 (History) ◄── S02
                    │
              ┌─────┼─────┐
              ▼     ▼     ▼
        S07 (Regression) S10 (Diff) S13 (Re-run)
        
              S09 (Real-time Progress) ◄── C04 (parallel to S01)
```

## Priority Summary

| ID | Scenario | Priority | Rationale |
|----|----------|----------|-----------|
| S01 | Result Data Model | **P0** | Every downstream component depends on this |
| S02 | Aggregation Logic | **P0** | Produces the `RunResult` consumed everywhere |
| S03 | PR Comment Formatting | **P0** | Core PR workflow deliverable |
| S04 | ADO API Integration | **P0** | Posts results to the PR |
| S05 | Failure Diagnostics | **P0** | Failures without diagnostics are useless |
| S06 | Run History Persistence | **P0** | Enables regression detection, re-run comparison |
| S07 | Regression Detection | **P1** | Requires history data; not needed for single-run |
| S08 | JUnit XML Export | **P1** | CI integration (Phase 2) |
| S09 | Real-Time Progress | **P0** | Users must see execution progress |
| S10 | Diff-Aware Reporting | **P1** | Valuable for iterative development |
| S11 | Performance Report | **P2** | Basic timing is P0 in S02; detailed breakdown is P2 |
| S12 | Partial Results | **P0** | Mixed results are the common case |
| S13 | Re-Run Comparison | **P1** | Fix-and-rerun workflow |
| S14 | Human-Actionable Summaries | **P2** | LLM polish; S05 diagnostics cover the basics |

**P0 count:** 8 scenarios (S01-S06, S09, S12) — the minimum viable reporting system.
**P1 count:** 4 scenarios (S07, S08, S10, S13) — high-value additions for iterative and CI workflows.
**P2 count:** 2 scenarios (S11-detail, S14) — polish and LLM-assisted features.

---

## New Files Summary

| File | Purpose |
|------|---------|
| `src/backend/DevMode/QaResultModels.cs` | S01: Type definitions for `ScenarioResult`, `RunResult`, `RunSummary`, `PerformanceReport` |
| `src/backend/DevMode/QaResultStore.cs` | S02 + S06: Aggregation logic + history persistence |
| `src/backend/DevMode/QaAdoReporter.cs` | S03 + S04: PR comment formatter + ADO API client |
| `src/backend/DevMode/QaFailureDiagnostics.cs` | S05: Closest-miss matching, failure reason builder |
| `src/backend/DevMode/QaRegressionDetector.cs` | S07: Cross-run regression pattern detection |
| `src/backend/DevMode/QaJUnitExporter.cs` | S08: JUnit XML export for CI pipelines |
| `src/backend/DevMode/QaDiffReporter.cs` | S10: Run-to-run diff computation |
| `src/backend/DevMode/QaRerunComparator.cs` | S13: Verdict transition analysis |
| `src/backend/DevMode/QaSummaryGenerator.cs` | S14: LLM-generated human-readable summaries |

All new files follow the established DevMode pattern: `#nullable disable` + `#pragma warning disable` headers, namespace `Microsoft.LiveTable.Service.DevMode`.
