# qa-eval — F27 P9 Eval Harness

The eval harness is the **fifth station** of the F27 P9 architecture. It is the
gate that the production-grade LLM scenario generation pipeline must pass
before serving users.

## Layout

```
tests/qa-eval/
├── README.md                  # this file
├── ground-truth/              # 3 expert-curated PRs with hand-graded scenarios (T1f-a)
│   ├── PR-NNNNNN/
│   │   ├── pr.json            # diff + metadata snapshot (immutable since T1a)
│   │   ├── diff.patch         # the LLM input (immutable since T1a)
│   │   ├── expected.json      # schema_version 1.0 (scaffold) OR 2.0 (graded scenarios + grounding)
│   │   ├── expected.json.curator  # T1f-a marker — records pass-1 timestamp + commit SHA + pass-2 status
│   │   ├── actual.json        # T1f-b output: V2 pipeline emissions (omitted in T1f-a)
│   │   └── notes.md           # curator notes
│   └── ...
├── adversarial/               # T1d injection corpus (separate scoring path)
├── score_eval.py              # T1f-a: deterministic gold-corpus scorer
├── score_floors.json          # T1f-a: absolute + regression floors (enforcement: report_only)
├── topic_aliases.json         # T1f-a: future canonical-behaviour-key taxonomy (empty scaffold)
├── capture_v2_actuals.py      # T1f-b operator script (spends real money on AOAI)
├── capture_baseline.py        # T1c-c operator script (used for current baseline.json)
├── run_eval.py                # legacy corpus loader (no scoring, sibling of score_eval.py)
└── baseline.json              # v1.1 — V2 pipeline aggregates from T1c-c; recall/precision NULL until T1f-b
```

## Expected.json schema versions

The scorer (`score_eval.py`) accepts two schema versions and treats them differently:

- **`schema_version: "1.0"`** — the T0/T1a scaffold shape. The file declares
  `curator: "PENDING_HUMAN_GRADING"` with empty `scenarios: []`. The scorer
  counts the PR under `prs_pending_grading` but DOES NOT include it in any
  recall/precision aggregate. This is the safe transient state while a
  curator is mid-grading.

- **`schema_version: "2.0"`** — the T1f-a graded shape. Each scenario carries:

  ```
  {
    "id":          "<pr-number>-sNN",       # stable within the file
    "behavior_key": "snake_case_intent",     # human-readable, future taxonomy slot
    "category":     "<ScenarioCategory>",    # ONE of {HappyPath, ErrorPath, EdgeCase, Regression, Performance}
    "verb":         "<ExpectationType>",     # ONE of {EventPresent, EventAbsent, EventCount, EventOrder, Timing, FieldMatch}
    "title":        "<one-line summary>",
    "rationale":    "<why a competent author would write this from the diff alone>",
    "criticality":  "P0|P1|P2",
    "discovered_by":"diff_inspection|v2_review",
    "grounding_changed_lines": [
       { "path": "<repo-relative path>", "side": "left|right", "lines": [N, N+1, ...] }
    ]
  }
  ```

The `category` + `verb` enums are kept in lock-step with the C# canonical
enums in `EdogQaModels.cs` (`ScenarioCategory` / `ExpectationType`) by the
source-grep test `test_categories_match_csharp_enum_set`.

## Two-pass blind grading discipline

This is the contract that keeps the gold corpus honest:

1. **Pass 1** — curator reads `diff.patch` blind (no V2 pipeline output
   yet visible) and writes the scenario list. Every scenario is tagged
   `discovered_by: diff_inspection`. The `expected.json.curator` marker
   records the pass-1 timestamp + the `edog-studio` commit SHA at
   grading time.
2. **Pass 2** — after `capture_v2_actuals.py` produces `actual.json`,
   the curator reviews V2 output and ADDS items ONLY when a competent
   QA author would have written them from the diff alone. Pass-2
   additions are tagged `discovered_by: v2_review` with explicit
   rationale. Pass-1 items must NOT be re-graded after seeing V2.

The discipline prevents the curator from silently moving the goalposts
to favour V2 once they see what V2 produces.

## Scoring algorithm

Run `python tests/qa-eval/score_eval.py` (or import `score_eval` from a
notebook). The matcher is deterministic:

1. **Primary key:** `(category, verb)` enum equality.
2. **Secondary gate:** `_max_overlap(expected, actual) > 0` — at least
   one shared changed-line number across same-path + same-side grounding
   pairs. Path comparison is case-insensitive (Windows-clone safe).
3. **Tiebreaker:** maximum shared line count.
4. Greedy in expected-declared-order; first expected scenario wins its
   chosen actual.

Precision is reported per-stage `{emitted, validated, projected}` so the
Validator and Projector contributions are visible separately.

P0+P1 recall is reported as its own aggregate so a single P0 miss
forces failure even when P2 recall is high.

Macro (per-PR weighted equally) is the headline; micro (per-scenario
weighted equally) is reported alongside for corpus-size sanity.

## Floor enforcement

`score_floors.json` carries the floor config. By default
`enforcement: "report_only"` — the scorer always exits 0 even on
violations. Pass `--strict` to flip to fail-on-violation. Floors are
calibrated low until T1f-b's first live capture; the regression guards
(`max_recall_drop`, `max_precision_drop`) will gain teeth once a real
baseline is recorded.

## Phases

- **T0 (✓):** scaffold + first ground-truth PR fixture skeleton +
  capability probe stub.
- **T1a (✓):** real capability probe + 3 ground-truth fixtures + eval
  scaffold.
- **T1b (✓):** Architect/Editor LLM client with strict json_schema.
- **T1c-a (✓):** Validator + Projector.
- **T1c-b (✓):** Orchestrator + shadow-mode wire-in.
- **T1c-c (✓):** SECURITY.md + baseline.json v1.1 (aggregates only,
  no recall/precision).
- **T1d (✓):** adversarial corpus.
- **T1e (✓):** repair loop.
- **T1f-a (this slice):** deterministic gold-corpus scorer +
  hand-graded `expected.json` v2.0 across all 3 PRs.
- **T1f-b (next):** `capture_v2_actuals.py` operator run produces
  per-PR `actual.json`; baseline.json gains real recall/precision.
- **T2:** Inspect AI multi-turn tasks; Helicone observability wired;
  weak corpus bootstrapped from production keep-rate data.
- **T3:** mutation testing over every changed file; full corpus on
  every push.

## Provider constraint

Azure OpenAI **only**. No Anthropic. No public OpenAI. Judge bias is mitigated
by ensembling **different** Azure OpenAI deployments (e.g. generator = `gpt-5.4`
→ judges = `gpt-5.5`, `gpt-5.3-codex`, `gpt-5.4` at varied effort/temperature)
plus the adversarial-calibration corpus and quarterly human calibration.
See `docs/specs/features/F27-qa-testing/p9-production-grade-llm.md` §6 + §11.

## Security

PR diffs are adversarial input. Probe / harness code must:
- never log raw diffs at INFO level (DEBUG only behind explicit opt-in)
- redact `api-key` and bearer tokens from every error path
- treat `EDOG_QA_LLM_V2` and `AZURE_OPENAI_*` env vars as the only egress
  authorization — no other LLM endpoint may be reached from this harness.

See `docs/specs/features/F27-qa-testing/p9-production-grade-llm.md` §14.

## Running

```bash
# Score the gold corpus against current actual.json files (if any).
python tests/qa-eval/score_eval.py                    # human-readable
python tests/qa-eval/score_eval.py --json             # JSON to stdout
python tests/qa-eval/score_eval.py --strict           # exit 1 on floor violations
python tests/qa-eval/score_eval.py --output report.json

# T1f-b operator turn (spends real money on Azure OpenAI):
set EDOG_QA_LLM_V2=on
set DONNA_AOAI_API_KEY=<key>
python tests/qa-eval/capture_v2_actuals.py --no-dry-run --fixture PR-977882
python tests/qa-eval/score_eval.py --output tests/qa-eval/score_report.json
```
