# PR 879735 — Curator Notes

**Title:** Merged PR 879735: Add cursor-based pagination for listDAGExecutionIterationIds API
**Base:** `f29e7569f12c4224a00c74bc4e5d6066d56d43e7`
**Head:** `f77df9a4ed7f6e468e8ba5a42a1b5bfdb4fd75f2`
**Files changed:** 28

## PR description (from commit body)

> ## Overview
> Implementation of pagination for listDAGExecutionIterationIds
>
> ## Key Features
> - **Backward Compatible**: Response body unchanged; existing clients work without modification
> - **Cursor-Based**: Stable pagination immune to concurrent data changes
> - **Multi-Folder Support**: Handles nested DAGs across multiple `Index_StartTime_*` folders
> - **Filter-Aware**: Detects filter changes between pages and gracefully restarts
> - **Memory-Safe**: Paged cursor-finding prevents OOM for large execution histories
> ## Feature Flag: `FLTListDagAPIPagination`
> ## API Usage
> ```http
> # First page
> GET .../listDAGExecutionIterationIds?historyCount=25
>
> # Response header (if more pages exist)
> x-ms-continuation-token: OTIyMzM3MjAzNTA4NDc0ODMxN18xMGQzZjFkOS1kNTAy...
>
> # Next page
> GET .../listDAGExecutionIterationIds?historyCount=25&continuationToken=OTIyMzM3MjAzNTA4NDc0ODMxN18xMGQzZjFkOS1kNTAy...
> ```
> ### API Validation
> #### Test 1: Baseline (Single Call)
> ```
> GET .../listDAGExecutionIterationIds?historyCount=5000
> → 200 OK | 4,492 items | 23,281 ms | x-ms-continuation-token: (none — all items returned)
> ```
>
> #### Test 2: Paginated (pageSize=25, 180 API calls)
> ```
> Page 1:   GET ...?historyCount=25                              → 25 items | 5,681 ms | token: ✅
> Page 2:   GET ...?historyCount=25&continuationToken=OTIy...    → 25 items | 5,689 ms | token: ✅
>   ...
> Page 179: GET ...?historyCount=25&continuationToken=OTIy...    → 25 items | 2,155 ms | token: ✅
> Page 180: GET ...?historyCount=25&continuationToken=OTIy...    → 17 items | 2,874 ms | token: (none — last page)
> ```
> #### Test 3: Consistency (without vs with Pagination)
>
> | Check | Result | Detail |
> |-------|--------|--------|
> | Count match | ✅ PASS | Baseline 4,492 = Paginated 4,492 |
> | No duplicates | ✅ PASS | 0 duplicate iterationIds across 180 pages |
> | Order match | ✅ PASS | All 4,492 items in identical descending order |
> | No missing items | ✅ PASS | Every baseline item found in paginated results |
> | Last page | ✅ PASS | Page 180 returns 17 items with no continuation token |
> | Token absent on last page | ✅ PASS | No `x-ms-continuation-token` header |
>
> ## Feature Flag: FLTListDagAPIPagination
> ### Flag OFF (pagination disabled)
> | Client sends historyCount | Effective historyCount | Continuation Token | Response Header |
> |---|---|---|---|
> | (not sent) | **500** | **null** (ignored) | No `x-ms-continuation-token` |
> | 20 | **20** | **null** (ignored) | No `x-ms-continuation-token` |
> | 1000 | **500** (clamped) | **null** (ignored) | No `x-ms-continuation-token` |
>
> ### Flag ON (pagination enabled, DefaultHistoryCount=500 for initial rollout)
>
> | Client sends historyCount | Effective historyCount | Continuation Token | Response Header |
> |---|---|---|---|
> | (not sent) | **500** (from manifest) | flows through | `x-ms-continuation-token` if more pages |
> | 20 | **20** (respected) | flows through | `x-ms-continuation-token` if more pages |
> | 1000 | **500** (clamped) | flows through | `x-ms-continuation-token` if more pages |
>
> ...

## Files changed

- `.gitignore` (+1 / -0)
- `Service/Microsoft.LiveTable.Service.EntryPoint/WorkloadParameters/ParametersManifest.json` (+2 / -0)
- `Service/Microsoft.LiveTable.Service/Controllers/LiveTableController.cs` (+36 / -6)
- `Service/Microsoft.LiveTable.Service/Core/LiveTableHandler.cs` (+9 / -5)
- `Service/Microsoft.LiveTable.Service/DataModel/ListDagExecutionIterationsRequestFilters.cs` (+2 / -0)
- `Service/Microsoft.LiveTable.Service/FeatureFlightProvider/FeatureNames.cs` (+7 / -0)
- `Service/Microsoft.LiveTable.Service/Initialization/WorkloadParameterNames.cs` (+8 / -1)
- `Service/Microsoft.LiveTable.Service/Persistence/FileSystemBasedDagExecutionPersistenceManager.cs` (+393 / -17)
- `Service/Microsoft.LiveTable.Service/Persistence/Fs/IFileSystem.cs` (+27 / -0)
- `Service/Microsoft.LiveTable.Service/Persistence/Fs/OnelakeBasedFileSystem.cs` (+58 / -0)
- `Service/Microsoft.LiveTable.Service/Persistence/IDagExecutionPersistenceManager.cs` (+17 / -5)
- `Service/Microsoft.LiveTable.Service/Store/DagExecutionStore.cs` (+1 / -1)
- `Service/Microsoft.LiveTable.Service/Store/IDagExecutionStore.cs` (+8 / -4)
- `Service/Microsoft.LiveTable.Service/Swagger/Swagger.json` (+8 / -0)
- `Service/Microsoft.LiveTable.Service/Utils/ContinuationTokenHelper.cs` (+222 / -0)
- `docs/design/pagination_design.md` (+1010 / -0)
- `test/Microsoft.LiveTable.Service.UnitTests/ControllerTests/LiveTableControllerTests.cs` (+259 / -7)
- `test/Microsoft.LiveTable.Service.UnitTests/CoreTests/InMemoryMLVExecutionDefFSStub.cs` (+33 / -0)
- `test/Microsoft.LiveTable.Service.UnitTests/CoreTests/LiveTableHandlerAdditionalTests.cs` (+3 / -2)
- `test/Microsoft.LiveTable.Service.UnitTests/DagPersistenceTests/FileSystemBasedDagExecutionPersistenceManagerTests.cs` (+653 / -833)
- `test/Microsoft.LiveTable.Service.UnitTests/DagPersistenceTests/FileSystemBasedDagExecutionPersistenceManagerTests_CriticalIssues.cs` (+33 / -33)
- `test/Microsoft.LiveTable.Service.UnitTests/DagPersistenceTests/FileSystemBasedDagExecutionPersistenceManagerTests_EdgeCases.cs` (+18 / -18)
- `test/Microsoft.LiveTable.Service.UnitTests/DagPersistenceTests/FileSystemBasedDagExecutionPersistenceManagerTests_V1.cs` (+29 / -29)
- `test/Microsoft.LiveTable.Service.UnitTests/DagPersistenceTests/InMemoryFileSystemStub.cs` (+39 / -0)
- `test/Microsoft.LiveTable.Service.UnitTests/DagPersistenceTests/InMemoryFileSystemStubForMultiMLV.cs` (+28 / -0)
- `test/Microsoft.LiveTable.Service.UnitTests/DagStoreTests/DagExecutionStoreCoverageTests.cs` (+3 / -2)
- `test/Microsoft.LiveTable.Service.UnitTests/UtilsTests/ContinuationTokenHelperTests.cs` (+725 / -0)
- `test/Microsoft.LiveTable.Service.UnitTests/WorkloadParameters/ParametersManifest.json` (+2 / -0)

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
