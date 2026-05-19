# PR 910832 — Curator Notes

**Title:** Merged PR 910832: Notebook user facing messages
**Base:** `4e185f32a16b14b647664f20f73728c278ff03ed`
**Head:** `8052934fbaf4779091d0d79cb02f1c09fbc61826`
**Files changed:** 17

## PR description (from commit body)

> ## 📝 PR Description
> <!-- Provide a clear and concise description of what this PR does -->
> This PR changes the format of notebook specific user facing error messages
> AB#4898960
>
> ##1st error
>    Magic error message before
>    ![image.png](https://dev.azure.com/powerbi/a105411b-b849-4666-89bf-3a0d2f3fdba7/_apis/git/repositories/3928e7e3-8fac-45ed-a94b-a7bf0702934b/pullRequests/910832/attachments/image.png)
>
>    Magic error message after changes
>    ![image (2).png](https://dev.azure.com/powerbi/a105411b-b849-4666-89bf-3a0d2f3fdba7/_apis/git/repositories/3928e7e3-8fac-45ed-a94b-a7bf0702934b/pullRequests/910832/attachments/image%20%282%29.png)
>
> ##2nd Error
>    No pyspark MLV error before changes
> ![image (3).png](https://dev.azure.com/powerbi/a105411b-b849-4666-89bf-3a0d2f3fdba7/_apis/git/repositories/3928e7e3-8fac-45ed-a94b-a7bf0702934b/pullRequests/910832/attachments/image%20%283%29.png)
>
>   After changes
> ![image (4).png](https://dev.azure.com/powerbi/a105411b-b849-4666-89bf-3a0d2f3fdba7/_apis/git/repositories/3928e7e3-8fac-45ed-a94b-a7bf0702934b/pullRequests/910832/attachments/image%20%284%29.png)
>
> ##3rd Error
> MLV_DEFINITION_CONFLICT
>
> before changes
> ![image (5).png](https://dev.azure.com/powerbi/a105411b-b849-4666-89bf-3a0d2f3fdba7/_apis/git/repositories/3928e7e3-8fac-45ed-a94b-a7bf0702934b/pullRequests/910832/attachments/image%20%285%29.png)
>
> after changes
> ![image (6).png](https://dev.azure.com/powerbi/a105411b-b849-4666-89bf-3a0d2f3fdba7/_apis/git/repositories/3928e7e3-8fac-45ed-a94b-a7bf0702934b/pullRequests/910832/attachments/image%20%286%29.png)
>
> ##4th Error
> | Field | Old (before PR) | New (this PR) |
>  |---|---|---|
>  | **Message** | `[Workspace: ..., Notebook: ...] Notebook content has been modified since last retrieval. ETag mismatch detected.` | `MLV_ETAG_CHANGED: Contents in the Notebook [Workspace: ..., Notebook:
>  ...] changed after the operation started. Refresh and try again.` |
>  | **Status code** | `412 PreconditionFailed` | `422 UnprocessableEntity` |
>  | **ErrorCode** | *(none)* | `MLV_ETAG_CHANGED` |
>
> [MLV_ETAG_CHANGED]: Contents in the Notebook [Workspace: ..., Notebook: ...] changed after the operation started. Refresh and try again. failureType: UserError
>
> ### What changes are being made?
>
> ### Why are these changes needed? What problem does this solve?
> ---
>
> ## 🔗 Related Links
> <!-- Link to Design Documents, or related PRs -->
> - Design Document:
> - Related PRs:
> - Feature Flag path in FeatureManagement Repo:
>
> ---
>
> ## ✅ PR Checklist
>
> ### 🚦 Readiness
> - [ ] My changes are production-ready (not WIP or exploratory).
> - [ ] I've thoroughly E2E tested my changes.
> - [ ] This PR is based on an **approved design**.
> - [ ] Feature Flag for features for critical changes
>
> ### 🧪 Testing
> - [ ] Attached E2E test report in the **PR description**.
> - [ ] Added **targeted unit tests** that fail without the fix and pass with it.
> - [ ] If applicable, CSTs tests are included for critical features.
> - [ ] Devbox required for testing this PR?
>
> ### 📄 ...

## Files changed

- `Service/Microsoft.LiveTable.Service/Common/Constants.cs` (+39 / -0)
- `Service/Microsoft.LiveTable.Service/Controllers/LiveTableController.cs` (+58 / -34)
- `Service/Microsoft.LiveTable.Service/ErrorMapping/ErrorCode.cs` (+5 / -0)
- `Service/Microsoft.LiveTable.Service/ErrorMapping/ErrorRegistry.cs` (+5 / -3)
- `Service/Microsoft.LiveTable.Service/Notebook/Exceptions/NotebookException.cs` (+97 / -7)
- `Service/Microsoft.LiveTable.Service/Notebook/Exceptions/NotebookParsingException.cs` (+0 / -77)
- `Service/Microsoft.LiveTable.Service/Notebook/NotebookExecutionContext.cs` (+15 / -16)
- `Service/Microsoft.LiveTable.Service/Notebook/NotebookHttp/NotebookApiClient.cs` (+6 / -3)
- `Service/Microsoft.LiveTable.Service/Utils/NodeExecutionUtils.cs` (+41 / -9)
- `pr-division-plan.md` (+486 / -0)
- `test/Microsoft.LiveTable.Service.UnitTests/ControllerTests/LiveTableControllerTests.cs` (+40 / -39)
- `test/Microsoft.LiveTable.Service.UnitTests/ControllerTests/NotebookErrorRegistryE2ETests.cs` (+693 / -0)
- `test/Microsoft.LiveTable.Service.UnitTests/DagTests/DagExecutionHandlerV2Tests.cs` (+106 / -9)
- `test/Microsoft.LiveTable.Service.UnitTests/ErrorMappingTests/ErrorRegistryTests.cs` (+126 / -3)
- `test/Microsoft.LiveTable.Service.UnitTests/NotebookTests/{NotebookParsingExceptionTests.cs => NotebookExceptionTests.cs}` (+16 / -16)
- `test/Microsoft.LiveTable.Service.UnitTests/NotebookTests/NotebookExecutionContextTests.cs` (+29 / -29)
- `test/Microsoft.LiveTable.Service.UnitTests/NotebookTests/NotebookHttpTests/NotebookApiClientTests.cs` (+4 / -3)

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
