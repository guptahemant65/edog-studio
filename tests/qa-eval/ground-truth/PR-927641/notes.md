# PR 927641 — Curator Notes

**Title:** Merged PR 927641: [Multi-Schedule][Public API][PATCH] : clear stale SelectedMLVs when mode changes away from SelectedOnly
**Base:** `cb474f80538df4a257a40ab2a9278a0da5f2e0b6`
**Head:** `0e1b7d224a45055764b5a309de05d80b58b3f56f`
**Files changed:** 2

## PR description (from commit body)

> **Scenario:** User has an execution definition in SelectedOnly mode with SelectedMLVs = ["TableA", "TableB"].
>
>   They PATCH to switch to All mode:
>
>    {
>      "currentLakehouseExecutionContext": {
>        "currentLakehouseExecutionMode": "All"
>      }
>    }
>
>   **Before the fix:** The PATCH merge logic saw no new SelectedMlvs in the request, so it preserved the existing ["TableA", "TableB"]. Now the definition says mode=All but still carries stale MLV names. When
>   CatalogHandler runs, it checks SelectedMLVs.Any() — without checking the mode — and filters to only TableA/TableB ancestors. The user expected all MLVs but got an incomplete lineage.
>
>   **After the fix:** If the resolved mode is not SelectedOnly, we clear SelectedMLVs to an empty list, so CatalogHandler's filter never activates
>
> **With Fix :** When mode is changes from one MV to All
> Iteration is executing all MVs
> ![image.png](https://dev.azure.com/powerbi/a105411b-b849-4666-89bf-3a0d2f3fdba7/_apis/git/repositories/3928e7e3-8fac-45ed-a94b-a7bf0702934b/pullRequests/927641/attachments/image.png)
>
> PATCH API ![image (2).png](https://dev.azure.com/powerbi/a105411b-b849-4666-89bf-3a0d2f3fdba7/_apis/git/repositories/3928e7e3-8fac-45ed-a94b-a7bf0702934b/pullRequests/927641/attachments/image%20%282%29.png)
>
> Related work items: #2030648

## Files changed

- `Service/Microsoft.LiveTable.Service/Contracts/Api/MLVExecutionDefinitionPublicPatchRequest.cs` (+10 / -3)
- `test/Microsoft.LiveTable.Service.UnitTests/ContractTests/MLVExecutionDefinitionPublicModelTests.cs` (+53 / -4)

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
