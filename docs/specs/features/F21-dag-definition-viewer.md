# Feature 21: DAG Definition Viewer

> **Phase:** V2
> **Status:** Not Started
> **Owner:** TBD
> **Spec:** docs/specs/features/F21-dag-definition-viewer.md
> **Design Ref:** docs/specs/design-spec-v2.md §21

### Description

View MLV SQL definitions per DAG node. `codeReference` in DAG response has notebook IDs + cell indices, not actual SQL. **Requires:** `GET /v1/workspaces/{id}/notebooks/{id}/content` → extract cells at specified indices. For SQL-type nodes (`kind="sql"`): query catalog or SQL endpoint. Displayed as syntax-highlighted read-only code panel when a DAG node is selected in Feature 8.
