# PR 929467 — Curator Notes

**Title:** Merged PR 929467: TokenManager - Tokens are not getting cleared after Dag iteration run gets over
**Base:** `0e1b7d224a45055764b5a309de05d80b58b3f56f`
**Head:** `9aa96ddeabc183619e5638b122f2564c48002b27`
**Files changed:** 7

## PR description (from commit body)

> #### PR Summary
> This PR fixes the issue where tokens were not being cleared after a DAG iteration completes by refactoring the logic to either delete or update tokens based on terminal status and a new feature flag. The changes include improved error handling and additional tests to validate behavior across different execution statuses.
>
> Related work items: #2033065

## Files changed

- `Service/Microsoft.LiveTable.Service/Controllers/LiveTableSchedulerRunController.cs` (+54 / -33)
- `Service/Microsoft.LiveTable.Service/DataModel/Dag/DagExecutionMetrics.cs` (+9 / -4)
- `Service/Microsoft.LiveTable.Service/DataModel/Dag/SchedulerRunStatus.cs` (+3 / -5)
- `Service/Microsoft.LiveTable.Service/FeatureFlightProvider/FeatureNames.cs` (+6 / -0)
- `Service/Microsoft.LiveTable.Service/TokenManagement/TokenManager.cs` (+3 / -2)
- `test/Microsoft.LiveTable.Service.UnitTests/ControllerTests/LiveTableSchedulerRunControllerTests.cs` (+204 / -1)
- `test/Microsoft.LiveTable.Service.UnitTests/DataModelTests/SchedulerRunStatusTests.cs` (+2 / -1)

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
