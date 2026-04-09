# Feature 18: Session History / Timeline

> **Phase:** V2
> **Status:** Not Started
> **Owner:** TBD
> **Spec:** docs/specs/features/F18-session-history-timeline.md
> **Design Ref:** docs/specs/design-spec-v2.md §18

### Description

Persistent log of EDOG actions: deploys, DAG runs, token refreshes, error events. Stored in localStorage with timestamps. Displayed as a vertical timeline in a collapsible bottom panel or drawer. Like `git reflog` for EDOG sessions. Client-side only, no backend changes.
