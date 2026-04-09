# Feature 19: Capacity Health Indicator

> **Phase:** V2
> **Status:** Not Started
> **Owner:** TBD
> **Spec:** docs/specs/features/F19-capacity-health-indicator.md
> **Design Ref:** docs/specs/design-spec-v2.md §19

### Description

Before deploying, check target capacity for throttling. `GET api.fabric.microsoft.com/v1/capacities/{id}` — **scope may require admin access**. If available: show CU usage %, throttling state. If unavailable: infer from 429/430 responses in Spark Inspector after connecting. Show as color-coded badge in Workspace Explorer inspector panel.
