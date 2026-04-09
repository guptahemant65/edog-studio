# Feature 20: Quick Environment Clone

> **Phase:** V2
> **Status:** Not Started
> **Owner:** TBD
> **Spec:** docs/specs/features/F20-quick-environment-clone.md
> **Design Ref:** docs/specs/design-spec-v2.md §20

### Description

"Clone this lakehouse setup to a new workspace" — automated multi-step wizard. Create workspace + assign capacity + create lakehouse + copy notebooks. **Notebook copy API has ⚠️ status.** Fallback: create empty workspace/lakehouse, provide manual instructions for notebook copying. Uses same APIs as Feature 16.
