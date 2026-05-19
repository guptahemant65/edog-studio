# PR 934326 — Curator Notes

**Title:** Merged PR 934326: [SECURITY] Bump Scriban from 6.2.0 to 7.0.0
**Base:** `fcbba54071d6b452c3a97f4e0f75bd5b06665224`
**Head:** `0cef073124fc4e529f27294b15c7654b9fd8024d`
**Files changed:** 1

## PR description (from commit body)

> _(no commit body)_

## Files changed

- `Directory.Packages.props` (+1 / -1)

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
