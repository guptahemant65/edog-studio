# Feature 22: Table Schema + Preview + Stats

> **Phase:** V2
> **Status:** Not Started
> **Owner:** TBD
> **Spec:** docs/specs/features/F22-table-schema-preview-stats.md
> **Design Ref:** docs/specs/design-spec-v2.md §22

### Description

In Workspace Explorer inspector panel (right panel), show: column schema (name, type, nullable), first 5 data rows preview, row count, file count, total size, partition info. **Requires SQL endpoint connection or Delta metadata reading** — not available via standard Fabric REST APIs. Research: SQL analytics endpoint (`{lakehouse}.dfs.fabric.microsoft.com`) with bearer token.
