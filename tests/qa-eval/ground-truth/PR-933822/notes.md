# PR 933822 — Curator Notes

**Title:** Merged PR 933822: Expose x-ms-continuation-token in CORS for JavaScript access
**Base:** `c5b066ea2d31eab6d318738c4a41ef752145097d`
**Head:** `45a07672d2b7d6c65f916850de56c380bddd33ff`
**Files changed:** 1

## PR description (from commit body)

> Add .WithExposedHeaders(\
> x-ms-continuation-token\) to CORS policy so browser JavaScript can read the pagination header. Without this, browsers block access to custom response headers per CORS spec. One-line change in WorkloadEndpointSetup.cs.
>
> ![image.png](https://dev.azure.com/powerbi/a105411b-b849-4666-89bf-3a0d2f3fdba7/_apis/git/repositories/3928e7e3-8fac-45ed-a94b-a7bf0702934b/pullRequests/933822/attachments/image.png)
> ----
> #### AI description  (iteration 1)
> #### PR Classification
> API change to expose a response header via CORS so JavaScript clients can read the continuation token.
>
> #### PR Summary
> Updates CORS configuration to expose the `x-ms-continuation-token` header for browser-based access.
> - `Service/Microsoft.LiveTable.Service/Initialization/WorkloadEndpointSetup.cs`: Added `WithExposedHeaders("x-ms-continuation-token")` to the CORS policy configuration.
> <!-- GitOpsUserAgent=GitOps.Apps.Server.pullrequestcopilot -->
>
> Related work items: #2049475

## Files changed

- `Service/Microsoft.LiveTable.Service/Initialization/WorkloadEndpointSetup.cs` (+2 / -1)

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
