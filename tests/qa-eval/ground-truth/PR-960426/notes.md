# PR 960426 — Curator Notes

**Title:** Merged PR 960426: Align Insights APIs with latest PM specs: pagination, filters, top errors, swagger AB#5227527
**Base:** `5e9949a7b43d282d5f5ac983df115ce0f2670a7e`
**Head:** `001641bb6be6a9183bdc564beb4390321d75e41f`
**Files changed:** 17

## PR description (from commit body)

> ## Summary
> Aligns 4 Insights API endpoints with PM spec (requirements-spec.md). Adds KPI deltas, pagination, top errors endpoint, feature gate, and weekly grouping.
>
> **Work Item:** AB#5227527
>
> ## Changes
>
> ### KPI Period-over-Period Deltas (P0)
> - `insights/summary` returns `totalRunsDeltaPct`, `successRateDeltaPct`, `avgDurationDeltaPct`, `failedRunsDeltaPct`
> - Queries both current and previous period in a single SQL scan
>
> ### Pagination (P0)
> - `insights/runs` returns `InsightsRunsPageResponse` with `items[]` + `totalCount`
> - `displayName` partial match with LIKE escaping (`EscapeLikePattern`)
>
> ### Top Errors Endpoint (P1 — IC-04)
> - NEW `GET /insights/errors/top` — top N error codes from `sys_node_metrics`
> - Configurable `limit` param (1-20, default 5)
>
> ### Weekly Grouping
> - `insights/trends?groupBy=week` — DATEFIRST-independent formula, CONVERT style 120
>
> ### Feature Gate + refreshMode Removed
> - `[FeatureGate(FLTInsightsMetrics)]` at controller class level
> - refreshMode removed from params, response, SQL — to be re-added later
>
> ## API Response Samples (EDog dev mode — May 5, 2026)
>
> ### GET /insights/summary?dateRange=3
> ```json
> {
>   "totalRuns": 3,
>   "totalRunsDeltaPct": 0.0,
>   "completedRuns": 3,
>   "successRatePct": 100.0,
>   "successRateDeltaPct": 66.7,
>   "avgDurationMin": 6.6,
>   "avgDurationDeltaPct": 46.7,
>   "failedRuns": 0,
>   "failedRunsDeltaPct": -100.0,
>   "skippedRuns": 0,
>   "cancelledRuns": 0,
>   "lastUpdatedAt": "2026-05-04T09:18:04Z"
> }
> ```
>
> ### GET /insights/runs?pageSize=2
> ```json
> {
>   "items": [{
>     "iterationId": "8ab756dc-...",
>     "displayName": "hmglh",
>     "status": "Completed",
>     "durationMs": 371937,
>     "errorCode": null,
>     "totalNodes": 1,
>     "succeededNodes": 1,
>     "failedNodes": 0,
>     "skippedNodes": 0
>   }],
>   "totalCount": 6
> }
> ```
>
> ### GET /insights/trends?dateRange=7
> ```json
> {
>   "dailyTrend": [
>     {"runDate": "2026-05-02", "completed": 1, "failed": 2, "skipped": 0, "cancelled": 0},
>     {"runDate": "2026-05-03", "completed": 1, "failed": 0, "skipped": 0, "cancelled": 0},
>     {"runDate": "2026-05-04", "completed": 2, "failed": 0, "skipped": 0, "cancelled": 0}
>   ]
> }
> ```
>
> ### GET /insights/errors/top?dateRange=7
> ```json
> {
>   "topErrors": [
>     {"errorCode": "MLV_NOT_FOUND", "errorSource": "User", "count": 1}
>   ]
> }
> ```
>
> ## Build & Coverage
> - **Build:** ✅ Green (5547 tests, 0 failures)
> - **Diff coverage:** ✅ 91.96% (target 90%)
> - **Review threads:** ✅ All 7 resolved
>
> ## Files Changed
> **Prod:** Controller, QueryBuilder, SqlEndpointQueryService, IInsightsQueryService, ThrottlingConstants, WorkloadApp, Models (7)
> **Tests:** ControllerTests (+8), QueryBuilderTests (+1), QueryServiceTests (+11)
> **Docs:** design-spec.md, Swagger.json
>
> AB#5227527
>
> Related work items: #2093047

## Files changed

- `Features/5054458/design-spec.md` (+224 / -16)
- `Service/Microsoft.LiveTable.Service/Controllers/LiveTableInsightsController.cs` (+149 / -33)
- `Service/Microsoft.LiveTable.Service/Swagger/Swagger.json` (+262 / -23)
- `Service/Microsoft.LiveTable.Service/Throttling/ThrottlingConstants.cs` (+4 / -0)
- `Service/Microsoft.LiveTable.Service/Trends/IInsightsQueryService.cs` (+31 / -5)
- `Service/Microsoft.LiveTable.Service/Trends/InsightsQueryBuilder.cs` (+80 / -21)
- `Service/Microsoft.LiveTable.Service/Trends/Models/ErrorCountEntry.cs` (+5 / -1)
- `Service/Microsoft.LiveTable.Service/Trends/Models/InsightsRunResponse.cs` (+4 / -4)
- `Service/Microsoft.LiveTable.Service/Trends/Models/InsightsRunsPageResponse.cs` (+23 / -0)
- `Service/Microsoft.LiveTable.Service/Trends/Models/InsightsSummaryResponse.cs` (+42 / -1)
- `Service/Microsoft.LiveTable.Service/Trends/Models/InsightsTopErrorsResponse.cs` (+20 / -0)
- `Service/Microsoft.LiveTable.Service/Trends/Models/InsightsTrendsResponse.cs` (+0 / -4)
- `Service/Microsoft.LiveTable.Service/Trends/SqlEndpointQueryService.cs` (+175 / -48)
- `Service/Microsoft.LiveTable.Service/WorkloadApp.cs` (+1 / -0)
- `test/Microsoft.LiveTable.Service.UnitTests/ControllerTests/LiveTableInsightsControllerTests.cs` (+376 / -34)
- `test/Microsoft.LiveTable.Service.UnitTests/TrendsTests/InsightsQueryBuilderTests.cs` (+408 / -3)
- `test/Microsoft.LiveTable.Service.UnitTests/TrendsTests/SqlEndpointQueryServiceTests.cs` (+133 / -4)

## Change-shape classification

_Pending: classify per F27 P9 §6 (controller / retry / DAG / schema / config)._

## Expected scenarios (hand-grade)

_Pending: enumerate the scenarios a production-grade LLM SHOULD generate
for this diff, with grounding evidence. These become `expected.json`._

## Rejected alternatives

_Pending: scenarios the LLM might generate that should be rejected
(over-grounded, hallucinated, irrelevant, low-value)._

## Curator workflow

1. Read `diff.patch` carefully — identify every behavioural change.
2. For each behavioural change, draft a scenario:
   - `behavior_key`: stable snake_case identifier for the behavior.
   - `category`: one of HappyPath, EdgeCase, ErrorPath, Regression, Performance.
   - `verb`: one of FieldMatch, FieldRangeMatch, EventPresent, EventAbsent, … (closed 16-verb vocabulary; see EdogQaLlmClient.cs).
   - `title`: one-line summary of what the scenario asserts.
   - `rationale`: WHY this scenario matters — link to the load-bearing change.
   - `criticality`: P0 / P1 / P2 / P3.
   - `discovered_by`: 'diff_inspection' for hand-graded scenarios.
   - `grounding_changed_lines`: list of `{path, side, lines}` pointing at the exact lines that motivate the scenario.
3. Promote `expected.json` from `PENDING_HUMAN_GRADING` to `GRADED_PASS_1` by filling `curator_state`, `curated_at`, `curator`, `pass_1_basis`.
4. Once promoted, run `python tests/qa-eval/capture_v2_actuals.py --fixture PR-{pr_number}` to capture the LLM's actual output (paid).
5. Run `python tests/qa-eval/score_eval.py` to re-score the corpus.
