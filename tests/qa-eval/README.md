# qa-eval — F27 P9 Eval Harness

The eval harness is the **fifth station** of the F27 P9 architecture. It is the
gate that the production-grade LLM scenario generation pipeline must pass
before serving users.

## Layout

```
tests/qa-eval/
├── README.md                  # this file
├── ground-truth/              # 5–10 expert-curated PRs with hand-graded scenarios (T0)
│   ├── PR-NNNNNN/
│   │   ├── pr.json            # diff + metadata snapshot
│   │   ├── expected.json      # gold-standard scenarios + grounding
│   │   └── notes.md           # curator notes (why these scenarios, what's wrong with alternatives)
│   └── ...
├── weak/                      # production-accepted PR outputs (T2+, grows from telemetry)
│   └── ...
├── judge-calibration/         # judge-bias detection corpus
│   ├── adversarial.json       # synthetic scenarios designed to trip biased judges
│   └── human-calibration/     # quarterly Spearman rho ≥ 0.5 calibration runs
├── promptfoo.yaml             # prompt regression config (T1)
├── inspect/                   # Inspect AI tasks for multi-turn / agentic runs (T2)
├── run_eval.py                # entrypoint: `python tests/qa-eval/run_eval.py [--corpus gold|weak] [--shadow]`
└── baseline.json              # frozen scores from the legacy bridge pipeline (T0 exit artifact)
```

## Phases

- **T0 (this PR):** scaffold + first ground-truth PR fixture skeleton + capability probe stub.
  `baseline.json` recorded against the legacy `EdogQaLlmProvider` pipeline so any
  P9 work has a non-trivial floor to beat.
- **T1:** promptfoo wired + triple-judge ensemble of sibling Azure OpenAI models
  + `EDOG_QA_LLM_V2=shadow` reads from the new path and the harness diffs the
  two outputs. Exit gate: `pass^3 ≥ 0.85` over the gold corpus.
- **T2:** Inspect AI multi-turn tasks; Helicone observability wired; weak corpus
  bootstrapped from production keep-rate data.
- **T3:** mutation testing over every changed file; full corpus on every push.

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
# T0 (this commit): scaffold only — run_eval.py not yet implemented.
# T1: invoke from repo root.
python tests/qa-eval/run_eval.py --corpus gold
```
