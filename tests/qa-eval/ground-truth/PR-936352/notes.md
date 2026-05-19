# PR 936352 — Curator Notes

**Title:** Merged PR 936352: feat: Add FMLV-DevSkills plugin hook (Phase 1 - keep local skill)
**Base:** `cea71b50354966db250a6987e443f2c2945a212d`
**Head:** `37c58e1f40fc42009dcc1a43fa56f97df0153eea`
**Files changed:** 1

## PR description (from commit body)

> ## Summary
>
> Add sessionStart hook to auto-install FMLV-DevSkills plugins. Local `cst-pool-manager` skill is kept as-is for zero-impact rollout.
>
> ## Changes
>
> - **Add** `.github/hooks/hooks.json` — auto-installs `common` + `livetable` plugins from FMLV-DevSkills marketplace on every Copilot CLI session
>
> ## What's NOT changed
>
> - `.github/skills/cst-pool-manager/` — kept as-is (local copy takes priority over plugin)
> - `copilot-instructions.md` — unchanged
>
> ## Rollout Plan
>
> 1. **Phase 1 (this PR)**: Add hook only. Local skill still works. Plugin installs silently in background.
> 2. **Phase 2 (follow-up PR)**: After team has picked up the plugin (~few days), remove local `.github/skills/cst-pool-manager/` so the plugin version takes over.
>
> ## Zero User Impact
>
> - Local skill has higher priority than plugin skill — no behavior change after merge
> - Plugin installs automatically on first session, available from second session onwards
>
> Related work items: #2051076

## Files changed

- `.github/hooks/hooks.json` (+15 / -0)

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
