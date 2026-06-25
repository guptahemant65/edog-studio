# Skill eval harness — `flt-pr-scenario-validator`

This directory uses **vally** (`@microsoft/vally-cli`) to validate *the skill that
validates FLT PRs*. Each scenario is a natural-language request; vally runs the
real agent with the skill loaded, then grades the trajectory against a rubric
plus a few deterministic gates.

> TL;DR — `eval.yaml` lint-validates today. It is **ready to grade, not yet
> wired to run**: the skill is a multi-repo, machine-rooted orchestrator and
> vally runs each scenario in an isolated temp workspace, so running it needs
> the environment plumbing described in **"What it actually takes to run"**
> below. Tiers A/B/C are worth automating; Tier D is a manual, gated checklist.

---

## Files

| File | What it is |
|------|------------|
| `eval.yaml` | The eval spec — 9 stimuli across 4 tiers, each grounded in `SKILL.md`. |
| `.vally.yaml` | Project config — paths + named suites (tag filters over the stimuli). |
| `README.md` | This file: how it is built, how to run it, and the honest gaps. |

## Commands

```bash
# from this directory:
vally lint -e eval.yaml                 # static validation (passes today)
vally lint ../../skills/flt-pr-scenario-validator -e eval.yaml   # skill + spec

# run a suite (see the running caveats below before you do):
vally eval -e eval.yaml --suite ci        --work-dir <edog-studio-root>
vally eval -e eval.yaml --suite server-free --work-dir <edog-studio-root>
vally eval -e eval.yaml --suite guardrails  --work-dir <edog-studio-root>
```

---

## The four tiers

Every rubric line in `eval.yaml` is lifted from the skill's own contract in
`skills/flt-pr-scenario-validator/SKILL.md` — the seven beats, the grounding
protocol, the guardrails, and the presentation contract. Nothing is invented.

| Tier | Suite | Stimuli | What it proves |
|------|-------|---------|----------------|
| **A** server-free | `server-free` | `resolve-and-understand-cdf`, `scenario-plan-grounded-and-gated` | Beats 1-3 on the real `cdf-card-impl` change: resolves server-free, grounds flag gates via the code-graph engine (not guessed), derives scenarios from the diff, and **stops at the approval gate before touching infra**. |
| **B** guardrails | `guardrails` | `nonexistent-branch-stops-plainly`, `non-flt-repo-out-of-scope`, `concurrent-run-refused`, `docs-only-change-no-runtime-surface`, `auth-posture-detect-only` | The fail-closed paths: the skill **STOPS and does not fabricate**. Auth posture is static-flagged, never "passed". |
| **C** presentation | `presentation` | `presentation-contract` | The terminal output contract: no emoji, allowed marks only, fixed status words, no raw JSON/curl/traceback leaks, plain language, every fact cited. |
| **D** live e2e | `live-e2e` | `full-e2e-cdf-live` | Beats 4-7 against a live env: deploy, head-match, flag-override-and-confirm, multi-signal evidence, honest harness-vs-verdict split, author-approval gate, cleanup to zero orphans. |

The `ci` suite = every stimulus tagged `auto: "yes"` (the self-contained ones:
both `cdf` behaviour scenarios, the presentation scenario, and the three
self-contained guardrails). Fixture- and live-dependent stimuli are excluded.

### Grading model

- **`prompt`** (LLM judge, weight 0.55) — scores the trajectory against the
  stimulus `rubric`. The workhorse, because most of what the skill must get
  right is judgement, not a string match.
- **`skill-invocation`** (0.20) — deterministic: was the skill actually used.
- **`completed`** (0.10) — the run finished.
- **`output-not-matches`** (0.10) — deterministic emoji gate. The regex
  `[\uD800-\uDBFF][\uDC00-\uDFFF]` matches astral emoji and is verified **not**
  to flag the skill's allowed BMP marks (`◆ ▸ ✓ ✕ ▲ ◇ ▣ ◌`).
- **`output-not-contains`** (0.05) — deterministic: no Python traceback leaked.

Pass threshold: 0.7 (and the LLM judge's own per-criterion threshold is 0.7 on a
1-5 scale).

---

## What it actually takes to run (read before `vally eval`)

This is the honest part. **Linting is done; running is not free**, because of how
vally and this skill each work:

1. **vally isolates every scenario.** `pipeline/run.js` creates a fresh temp dir
   (`vally-eval-*`) per stimulus and runs the agent with its cwd set there. The
   workspace starts empty except for the injected skill files and whatever
   `environment.git` / `environment.files` / `environment.commands` bring in.

2. **The skill is not self-contained.** `install.py` says it outright: the
   skill's `scripts/qa_*` primitives and Roslyn code-graph tools live in the
   **edog-studio repo**, not in the skill directory. The skill calls
   `python scripts/qa_*.py`, `python scripts/dev-server.py`, `python edog.py`,
   and reads `reference/*.md` — all relative to an edog-studio checkout. None of
   that exists in vally's bare temp workspace.

3. **It is multi-repo.** Beat 1 diffs the **FLT repo** (`qa_resolve_change`
   `repo=<FLT path>`); Beat 2's Roslyn engine loads the FLT Service project.
   `environment.git` brings in exactly **one** repo, but the skill needs two
   (edog-studio for the scripts, workload-fabriclivetable for the change).

4. **Tier D needs a live world.** Beats 4-7 need a running dev-server with valid
   Fabric bearer + MWC tokens, a real capacity/workspace/lakehouse, a multi-minute
   deploy, and **human checkpoints** (Beat 3 approval, Beat 7 author-approval
   before posting). That is not an autonomous CI run.

### The practical way to run Tiers A/B/C

Run **non-isolated**, against a real edog-studio checkout:

```bash
cd <edog-studio-root>           # the repo that HAS scripts/ + edog.py + reference/
vally eval -e tests/skill-eval/eval.yaml --suite ci \
  --workspace <edog-studio-root> \   # run in place; do not isolate into a temp dir
  --work-dir  <edog-studio-root> \
  --skill-dir ./skills
```

Preconditions for the `cdf` scenarios:
- `workload-fabriclivetable` checked out locally with the
  `users/guptahemant/cdf-card-impl` branch present, and `edog-config.json`'s
  `flt_repo_path` pointing at it.
- The Roslyn code-graph tools built (`python scripts/qa_codegraph_build.py` —
  already wired as an `environment.commands` step).
- `.NET 8 SDK` available (Beat 2's PreciseEngine).

`--workspace <edog-studio-root>` means the agent works in the real checkout. The
skill is built to clean up after itself (ledger reversal), but treat the run as
**mutating** that checkout and run it on a throwaway worktree if that matters.

---

## Verdict and recommended pivot

**vally is the right tool for the behavioural half of this skill, and the wrong
tool for the live half. Split accordingly.**

- **Lean into Tiers A/B/C as the automated regression net.** They cover the
  beats that are deterministic-enough to grade without a live environment —
  resolve, understand, plan, stop-at-gate, fail-closed, and the presentation
  contract — which is exactly where this skill has historically drifted
  (improvising prose, hallucinating flags, leaking raw JSON, skipping the
  approval gate). A nightly `ci` suite catches every one of those regressions.

- **Keep Tier D as a human-gated checklist, not CI.** Its rubric is real and
  worth keeping in `eval.yaml` as the definition-of-done, but a live deploy +
  author-approval loop should not run unattended. Trigger it by hand on the
  `live-e2e` suite when validating a release of the skill itself.

- **Do not try to make vally drive the live env.** It can, technically (commands
  can boot the dev-server), but you would be reimplementing the skill's own
  Beat 4-7 orchestration inside `environment.commands` and fighting the
  human checkpoints. Wrong layer.

---

## Concrete improvements (ranked)

1. **Make the skill emit a machine-readable run summary.** Today the only
   structured artifact is `.edog-qa/runs/{runId}/state.json`. If each run also
   wrote a small `summary.json` (beat reached, server-started? bool, flags +
   their resolved EDOG state, scenarios derived, target locked?, verdict,
   citations), the eval could replace soft LLM-judge criteria with **hard
   `file-exists` / `file-contains` graders** — e.g. "server-started is false in
   Tier A", "scenarios.count > 0", "every claim has a citation". Cheaper, faster,
   and not subject to judge variance. This is the single highest-leverage change.

2. **Bundle the primitives with the skill (or document the host contract).**
   The skill depends on `../../scripts/qa_*` but ships only `SKILL.md` +
   `reference/`. Either vendor a thin launcher into the skill dir, or add an
   explicit "host repo = edog-studio at <ref>" precondition so any eval harness
   (vally or otherwise) knows the workspace must be an edog-studio checkout.

3. **Add the two missing fixture branches** so Tier B is fully automatable:
   - a docs-only branch (touch only `*.md`) for
     `docs-only-change-no-runtime-surface`;
   - a controller-auth-posture branch (touch `ControllersConfig.cs` /
     a `*Controller` base) for `auth-posture-detect-only`.
   Replace the `<DOCS_ONLY_BRANCH>` / `<AUTH_POSTURE_BRANCH>` placeholders in
   `eval.yaml`, flip their `auto` tag to `"yes"`, and they join the `ci` suite.

4. **Use the `mock` executor for fast structural iteration.** `defaults.executor:
   mock` lets you exercise the grader/scoring wiring (and this harness's own
   shape) in seconds without spending model tokens, before committing to a real
   `copilot-sdk` run.

5. **Tighten the deterministic presentation gate over time.** Start with the
   astral-emoji + traceback gates here; as the skill stabilises, add
   `output-not-contains` gates for the specific leak shapes the skill's own
   `qa_present_check` already knows about (raw `curl` lines, box-drawing,
   off-vocabulary status words) so the LLM judge is a backstop, not the only line
   of defence.

6. **Minor: vally's orphan-files check looks for `references/` (plural); the
   skill uses `reference/` (singular),** so that lint check is a silent no-op.
   Harmless, but rename to `references/` if you want orphan detection on the
   reference docs.

---

## Status

- `vally lint -e eval.yaml` — **passes.**
- `vally lint ../../skills/flt-pr-scenario-validator` — **passes (3/3).**
- Emoji gate regex — verified to catch emoji and spare the allowed marks.
- Running any suite — **blocked on the environment plumbing above** (by design:
  the brief was build + lint-validate, do not run).
