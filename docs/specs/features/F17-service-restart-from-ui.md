# Feature 17: Service Restart from UI

> **Phase:** V2
> **Status:** Not Started
> **Owner:** TBD
> **Spec:** docs/specs/features/F17-service-restart-from-ui.md
> **Design Ref:** docs/specs/design-spec-v2.md §17

### Description

Top bar "Restart" button. Uses IPC channel: browser → POST `/api/command/restart` → EdogLogServer writes `.edog-command/restart.json` → edog.py kills service → rebuilds → relaunches. Same infrastructure as Feature 2 (Deploy) and Feature 13 (File Change Detection). Simple once IPC exists.
