# Feature 15: Execution Comparison

> **Phase:** V2
> **Status:** Not Started
> **Owner:** TBD
> **Spec:** docs/specs/features/F15-execution-comparison.md
> **Design Ref:** docs/specs/design-spec-v2.md §15

### Description

Side-by-side diff of two DAG executions. Builds on Feature 8 (DAG Studio) history table. User selects two runs → shows which nodes changed status (was green, now red), timing differences (node X: 2s → 45s), new errors. Rendered as a split view with color-coded diff indicators. All data available from existing execution telemetry — no new APIs needed.
