# ADR-009: Skill Orchestration Architecture — Single-Threaded Workflow, Not Multi-Agent

## Status
ACCEPTED

**Date**: 2026-06-20
**Deciders**: Sana Reeves (Architecture Lead), Hemant Gupta (CEO)
**Drafted by**: Donna (with frontier research + design-spec audit)

## Context

The FLT PR Scenario Validator skill (`skills/flt-pr-scenario-validator/`, design spec
`docs/superpowers/specs/2026-06-20-flt-pr-scenario-validator-design.md`) is a long-running,
multi-phase workflow: it resolves a PR, understands the change, locks a target, deploys,
runs scenarios, correlates signals, and emits an evidence-cited verdict (the "seven-beat
journey", spec §6).

As Phase 1 came together, a real concern surfaced: the single `SKILL.md` (~14 KB) plus its
reference docs is accumulating a lot of context, and Beat 5 (deploy + run) produces large
observation payloads (deploy logs, telemetry, 11 interceptor streams, trace bundles). Two
candidate architectures were on the table:

1. **Monolith** — one agent context drives all seven beats.
2. **Master/slave (hub-and-spoke multi-agent)** — a master orchestrator dispatches a slave
   per phase, owning end-to-end execution.

The decision matters because the validator's workload has properties that constrain the
choice far more than aesthetics do:

- **Hard-sequential and stateful** — beats have strict ordering; each consumes the prior's
  output (locked target → deployed commit → evidence bundle → verdict).
- **Heavy shared *mutable* state and real side effects** — one run-lock, one teardown
  ledger, one locked GUID target, **one FLT instance (singleton on :5557)**, global feature-flag
  overrides, real-money capacities (spec §9.A).
- **The parallel-looking part is not parallelizable** — happy/edge/perf scenarios share the
  FLT singleton and global flag state, so the spec already runs them **serially** behind a
  **global single-validation lock** (spec §9.A-4-bis).
- **Deterministic guardrails, human-gated** — the `qa_*` primitives and the verification pass
  are Python, not agents; a human confirms at every beat boundary (spec §9, §10).

Two frontier engineering sources were consulted as primary evidence:

- **Anthropic, *Building Effective Agents*** (Schluntz & Zhang, 2024). Draws a hard line
  between **workflows** ("LLMs and tools orchestrated through predefined code paths") and
  **agents** ("LLMs dynamically direct their own processes"), and advises: *"find the
  simplest solution possible… add complexity only when it demonstrably improves outcomes."*
  The parallelization pattern it endorses is for **independent** subtasks (e.g. running
  guardrails as a separate concern from the core response).
- **Cognition, *Don't Build Multi-Agents*** (Walden Yan, 2025). Two principles: **(1)** share
  full context/traces; **(2)** *"actions carry implicit decisions, and conflicting decisions
  carry bad results."* It argues to **rule out** architectures that violate these, defaults to
  a **single-threaded linear agent**, and endorses sub-agents only in the Claude-Code shape:
  **non-parallel, well-defined, read-mostly** tasks whose benefit is keeping bulky context out
  of the main agent's history.

Both converge: they warn against **parallel multi-agent with dispersed decisions over shared
state**, and both endorse **sequential, context-isolated delegation of well-defined sub-tasks.**

## Decision

**The skill is architected as a single-threaded, phase-gated *workflow* (orchestrator-workers +
prompt-chaining hybrid), not a multi-agent system.** Specifically:

1. **Brain/body split is retained** (spec §3). The LLM reasons; EDOG endpoints and the `qa_*`
   primitives are deterministic tools. The deterministic guardrails (locked-target check,
   ledger, invariants, `qa_verdict.verify`) run as a **separate concern** from the reasoning —
   this is Anthropic's endorsed "sectioning for guardrails", not a second agent.

2. **The brain runs as one continuous context with cross-turn persistence** (`state.json`,
   spec §6 fire-and-poll) by default. This is Cognition's single-threaded default and
   Anthropic's "simplest solution".

3. **Context-heavy phases are extracted into non-parallel sub-agents only under measured
   pressure — never pre-emptively.** When a beat's context weight demonstrably degrades the
   run, it is delegated to a sub-agent in the **Claude-Code shape**: it does the heavy work and
   returns a **compressed result** (an evidence bundle / verdict fragment), so the orchestrator
   never holds the raw streams. The expected first (and possibly only) candidate is **Beat 5
   (deploy + observe)**.

4. **If/when sub-agents are introduced, the master is the single writer of all shared mutable
   state** (lock, ledger, flag overrides, locked target). Slaves are sequential, read-mostly,
   and fed full context via explicit **context-bridge** (extract-and-inject, not "go read the
   file"). A slave never acquires the lock and never makes a mutating decision on the FLT
   singleton.

5. **The only sanctioned parallelism is read-only.** (a) The deterministic guardrails already
   run as a separate concern — keep that. (b) Higher-confidence verdicts, if ever needed, may
   use a **multi-model vote over the already-collected evidence bundle** (read-only, full shared
   context — the dev-loop/Anvil review pattern). Scenario *execution* is never parallelized.

**Migration trigger (evidence-based, not calendar-based):** extract Beat 5 into a sub-agent
when the validate-the-validator corpus (spec §13.9) shows verdict quality degrading on
long runs (dropped or hallucinated correlations in Beat 6), or when orchestrator context for a
single run routinely approaches the window limit. Decide the shape now; let the live Task-12
run and the precision/recall harness decide the timing.

This mirrors the **`common:dev-loop` (Anvil) toolkit already installed locally**, which is this
exact consensus shipped: sequential spokes, fresh context per phase, context-bridge handoff,
and the *only* parallel step a read-only 3-model review vote.

## Consequences

### Positive
- Matches both frontier positions and the spec's existing design (single lock, serial
  scenarios, fire-and-poll, deterministic guardrails) — no rework of settled decisions.
- Avoids the fatal failure mode: parallel scenario agents making conflicting flag/state
  decisions on the one FLT instance, which would silently produce garbage verdicts.
- Keeps the cheapest architecture that works (Anthropic "simplest first"); complexity is added
  only where measured evidence justifies it.
- Context isolation is available exactly where it helps (Beat 5's observation volume) without
  paying multi-agent coordination cost everywhere.

### Negative
- A pure-monolith Phase 1 will eventually feel context pressure on Beat 5/6 before the
  extraction lands; we accept that as a known, monitored debt rather than pre-optimizing.
- The "extract under pressure" rule requires a measurement (the §13.9 harness) to be running,
  so the trigger has a dependency.
- Single-threaded execution caps throughput at one validation at a time (already a spec
  constraint from the FLT singleton, not new).

### Neutral
- The master/slave shape Hemant proposed is compatible — it is adopted *conditionally* (under
  the single-writer, non-parallel, read-mostly constraints), not rejected.
- Per-phase model selection (cheap models for provision/cleanup, Opus for understand/adjudicate)
  is available to offset sub-agent token cost when extraction happens.

## Alternatives Considered

### Parallel scenario sub-agents (fan out happy/edge/perf concurrently)
**Summary**: Run each scenario in its own agent for speed.
**Why rejected**: Cognition Principle 2 + the FLT singleton. Concurrent scenarios make
conflicting implicit decisions on shared flag-override and DAG state against one FLT instance →
false verdicts. Anthropic's "multi-agent worth it" test (parallelizable + read-only + value >
~15x tokens) fails two of three here.

### Full hub-and-spoke (4 spokes: understand / provision / exercise / adjudicate) on day one
**Summary**: Decompose into spokes immediately.
**Why rejected (as a day-1 build)**: Premature. Anthropic: add complexity only when it
"demonstrably improves outcomes". The monolith is not yet proven end-to-end (Task 12 is blocked
on a live env), so a full decomposition would be refactoring against an unvalidated design. The
4-spoke shape is retained as the *migration destination*, reached incrementally.

### Multi-agent "debate to consensus"
**Summary**: Let phase agents negotiate conflicts.
**Why rejected**: Cognition: cross-agent context-passing "only results in fragile systems" in
2025. No reliability benefit over a single coherent context for our task.

### Pure monolith, permanently
**Summary**: Never decompose.
**Why rejected**: Beat 5's observation volume (logs + telemetry + interceptor streams + trace
bundles) will overflow context, inducing the "lost in the middle" degradation by Beat 6 →
hallucinated correlations. Extraction-under-pressure is the safety valve.

## Related
- Design spec `docs/superpowers/specs/2026-06-20-flt-pr-scenario-validator-design.md`
  (§3 brain/body, §6 seven beats, §9 guardrails, §9.A-4-bis single-validation lock, §13.9
  validate-the-validator)
- Implementation plan `docs/superpowers/plans/2026-06-20-flt-pr-scenario-validator.md`
- Anthropic, *Building Effective Agents* — https://www.anthropic.com/engineering/building-effective-agents
- Cognition, *Don't Build Multi-Agents* — https://cognition.com/blog/dont-build-multi-agents
- Local precedent: `common:dev-loop` (Anvil) toolkit — hub-and-spoke with sequential spokes and
  a single read-only multi-model review vote.
