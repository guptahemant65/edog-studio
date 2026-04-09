# Feature 16: New Test Environment Wizard

> **Phase:** V2
> **Status:** Not Started
> **Owner:** TBD
> **Spec:** docs/specs/features/F16-new-test-environment-wizard.md
> **Design Ref:** docs/specs/design-spec-v2.md §16

### Description

Inline horizontal stepper (not modal) at the bottom of Workspace Explorer. 6 steps: Create Workspace → Assign Capacity → Create Lakehouse → Create Notebook + Write MLV SQL → Run Notebook → Verify DAG. **API concerns:** Notebook creation/content/execution APIs have ⚠️ status — require runtime verification. Capacity assignment scope unclear. Fallback: skip steps with manual instructions if APIs unavailable.
