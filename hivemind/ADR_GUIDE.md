# EDOG-STUDIO Architecture Decision Records (ADR)

> **Status:** 🟢 ACTIVE
> **Applies To:** All edog-studio agents
> **Last Updated:** 2026-04-08

---

## What Is an ADR?

An **Architecture Decision Record** captures an important architectural decision along with its context and consequences. It's a snapshot in time that explains:
- What decision was made
- Why it was made
- What alternatives were considered
- What the consequences are

### Why ADRs Matter for edog-studio

edog-studio has unusual constraints — single-file HTML, no frameworks, three languages, interceptors injected into another team's codebase. Many of our decisions feel counterintuitive ("why not just use React?"). ADRs ensure that:

1. **New agents understand the "why"** — not just the "what"
2. **We don't re-litigate settled decisions** — the ADR is the final word
3. **We know when to reconsider** — if the context changes, we can revisit
4. **The CEO has a decision audit trail** — Hemant can see every architectural choice

---

## When to Write an ADR

Write an ADR when you're making a decision that:
- Constrains how the system can evolve
- Affects more than one layer (frontend, Python, C#)
- Is hard to reverse once code depends on it
- Required deliberation between agents
- A future agent might question

### Examples

| Write ADR | Don't Need ADR |
|-----------|----------------|
| Choosing the interceptor pattern | Naming a CSS variable |
| Deciding the build system approach | Fixing a log formatting bug |
| Selecting the IPC mechanism | Adding a keyboard shortcut |
| Defining the feature flag override strategy | Refactoring a JS class |
| Choosing OKLCH over HSL | Following the 4px spacing grid |

---

## ADR Format

### File Naming

```
docs/adr/
├── ADR-001-two-phase-lifecycle.md
├── ADR-002-vanilla-js-no-frameworks.md
├── ADR-003-single-file-html-build.md
├── ADR-004-subclass-gts-spark-client.md
├── ADR-005-late-di-registration-featureflighter.md
└── ...
```

Format: `ADR-NNN-short-title-in-kebab-case.md`

### Status Lifecycle

```
PROPOSED → ACCEPTED → [DEPRECATED/SUPERSEDED]
    ↓
  REJECTED
```

| Status | Meaning |
|--------|---------|
| PROPOSED | Under discussion between agents |
| ACCEPTED | Decision made, in effect — treat as settled |
| DEPRECATED | Context changed, no longer applies |
| SUPERSEDED | Replaced by a newer ADR |
| REJECTED | Considered but not adopted |

---

## ADR Template

```markdown
# ADR-NNN: [Title]

## Status
[PROPOSED | ACCEPTED | DEPRECATED | SUPERSEDED | REJECTED]

**Date**: YYYY-MM-DD
**Deciders**: [Agent names/roles]
**Supersedes**: [ADR-XXX if applicable]
**Superseded by**: [ADR-YYY if applicable]

## Context

[Describe the situation. What problem needs solving? What constraints
exist? What forces are at play in edog-studio specifically?]

## Decision

[State the decision clearly. Use "We will..." language.]

## Consequences

### Positive
- [Good outcome 1]
- [Good outcome 2]

### Negative
- [Trade-off 1]
- [Trade-off 2]

### Neutral
- [Side effect that's neither good nor bad]

## Alternatives Considered

### [Alternative 1]
**Summary**: [Brief description]
**Why rejected**: [Reason]

### [Alternative 2]
**Summary**: [Brief description]
**Why rejected**: [Reason]

## Related

- [Link to design spec section]
- [Link to related ADR]

## Notes

[Any additional context or future considerations]
```

---

## ADR Index

| ADR | Title | Status | Date |
|-----|-------|--------|------|
| 001 | Two-Phase Lifecycle (Disconnected/Connected) | ACCEPTED | 2026-04-08 |
| 002 | Vanilla JS Only — No Frontend Frameworks | ACCEPTED | 2026-04-08 |
| 003 | Single HTML File Output via build-html.py | ACCEPTED | 2026-04-08 |
| 004 | Subclass GTSBasedSparkClient for Spark Interception | ACCEPTED | 2026-04-08 |
| 005 | Late DI Registration for IFeatureFlighter Wrapper | ACCEPTED | 2026-04-08 |

*Update this index when adding new ADRs.*

---

## ADR Process for edog-studio

### 1. Propose

- Any agent can propose an ADR
- Create the file in `docs/adr/` with status PROPOSED
- Notify Sana (architecture) or Kael (UX) depending on domain

### 2. Decide

- Architecture decisions: Sana reviews → CEO approves
- UX decisions: Kael reviews → CEO approves
- Cross-cutting: both Sana and Kael review
- No minimum discussion period — bias toward action for reversible decisions

### 3. Record

- Update status to ACCEPTED
- Update the ADR Index in this file
- If it changes how agents work, update ENGINEERING_STANDARDS.md

### 4. Revisit

When context changes:
- Create new ADR that SUPERSEDES the old one
- Update old ADR status to SUPERSEDED BY ADR-NNN
- Link both ADRs to each other

---

## Best Practices

### Writing Good ADRs

1. **Be concise** — 1 page is ideal. This is a decision record, not a design doc.
2. **State the obvious** — future agents don't have your context.
3. **Include rejected alternatives** — shows due diligence.
4. **Be honest about downsides** — no decision is without trade-offs.
5. **Link to the design spec** — ADRs implement spec decisions, not replace them.

### Common Mistakes

- Writing ADRs after the fact (write them during the decision)
- Omitting alternatives (looks like no analysis was done)
- Too much implementation detail (ADR says *what*, not *how*)
- Not updating status when a decision is superseded
- Re-litigating ACCEPTED ADRs without new context

### ADR vs Design Spec

| ADR | Design Spec |
|-----|-------------|
| Records a single decision | Details a full feature |
| 1 page | 5–20 pages |
| Why we chose X | How X works |
| Permanent record | Evolves with the product |
| One decision per ADR | Many decisions per spec |

---

*"The best time to record a decision is when you make it. The second best time is now."*

— edog-studio architecture
