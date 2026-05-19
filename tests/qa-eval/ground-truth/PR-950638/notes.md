# PR 950638 — Curator Notes

**Title:** Merged PR 950638: DQ 3 -  Add DQ suite parsing and DAG build integration AB#5154322
**Base:** `9bcb3060d40f70dc3388303215ca15b86df8934c`
**Head:** `25cb2993d3ecbf07bcf48c65a7544a85effffad2`
**Files changed:** 6

## PR description (from commit body)

> ## What
> DQ notebook discovery and parsing during DAG build. Discovery only — no execution wired yet.
>
>  This PR makes FLT discover DQ configurations during DAG build so it knows which nodes need DQ checks later.
>
> ## Changes
>
>   Table.cs — Read DQ config from catalog
>
>   Why: The Spark team writes two catalog properties on each MLV table that has DQ registered: fabric.mlv.dq.notebook.id and fabric.mlv.dq.workspace.id. FLT needs to read these to know "does this MLV have a DQ notebook attached?"
>
>   What it does:
>
>    - GetDqNotebookId() — reads notebook ID from table properties, returns Guid?
>    - GetDqWorkspaceId() — reads workspace ID from table properties, returns Guid?
>    - HasDqConfiguration() — returns true only if both IDs are present
>
>   ---------------------------------------------------------------------------------------------------------------------------------------
>
>   NotebookExecutionContext.cs — Parse DQ cells from notebook
>
>   Why: Once we know the DQ notebook ID, we need to fetch the notebook and find which cells contain DQ validation code for each MLV. The notebook can have multiple @fmlv.dq_suite("table_name") decorators — one per MLV.
>
>   What it does:
>
>    - During FetchAndParseContentForAllMLVsAsync, detects @fmlv.dq_suite("dbo.my_table") decorators using the ANTLR parser
>    - Stores a mapping: mlv_name → [cell indexes] in the dqSuiteCommand dictionary
>    - GetDqSuiteCommandIndexes(mlvName) — looks up which cells to run for a given MLV. Uses bidirectional suffix matching (e.g., dbo.table matches workspace.lakehouse.dbo.table and vice versa)
>    - DQ cells are stored without common cells — DQ scripts are self-contained
>
>   ---------------------------------------------------------------------------------------------------------------------------------------
>
>   Dag.cs — Wire DQ config during DAG build
>
>   Why: When FLT builds the DAG (discovers all MLVs from catalog), it needs to check each node for DQ config and prepare the DQ notebook context so it's available at execution time (when mwcToken is no longer available).
>
>   What it does:
>
>    - For each MLV node: calls table.GetDqNotebookId() + GetDqWorkspaceId()
>    - If both exist: sets node.DqCodeReference (notebook + workspace ID)
>    - Fetches the DQ notebook, parses it via NotebookExecutionContext, caches in Dag.NotebookExecutionContexts
>    - Try/catch: if notebook fetch fails, logs error but continues — the node will fail later at DQ hook execution time with MLV_COLUMN_DQ_CHECK_FAILED
>
> ## Impact
> - Sets `DqCodeReference` on nodes during DAG build but nothing consumes it until the execution hook is wired in PR 4/5
> - Existing behavior unchanged — DQ discovery is additive
>
> ## Testing
> - Build: 0 warnings, 0 errors
> - 6 new DQ parsing tests
>
> ## Related
> - PBI #5154322
> - Part 3 of 5 PRs for DQ feature
> - Depends on: PR #948097 (merged), PR #949624 (merged)
>
> Related work items: #2069784

## Files changed

- `Service/Microsoft.LiveTable.Service/DataModel/Catalog/Table.cs` (+42 / -0)
- `Service/Microsoft.LiveTable.Service/DataModel/Dag/Dag.cs` (+155 / -0)
- `Service/Microsoft.LiveTable.Service/Notebook/NotebookExecutionContext.cs` (+262 / -4)
- `test/Microsoft.LiveTable.Service.UnitTests/CatalogTests/TableTests.cs` (+198 / -0)
- `test/Microsoft.LiveTable.Service.UnitTests/DagTests/DagUnitTests.cs` (+467 / -0)
- `test/Microsoft.LiveTable.Service.UnitTests/NotebookTests/DqSuiteCommandTests.cs` (+151 / -0)

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
