# ADR-001: Two-Phase Lifecycle (Disconnected / Connected)

## Status
ACCEPTED

**Date**: 2026-04-08
**Deciders**: Sana Reeves (Tech Lead), Kael Andersen (UX Lead), Hemant Gupta (CEO)

## Context

EDOG Studio needs to be useful to FLT engineers even when they haven't deployed their FLT service to a lakehouse. Many tasks — browsing workspaces, managing tokens, exploring Fabric APIs, checking feature flags — don't require a running FLT service.

However, some features — live logs, DAG control, Spark inspection — require active C# interceptors inside a running FLT process, which only exist after deployment.

We need a UX model that makes this distinction clear without making the tool feel broken when "disconnected."

## Decision

We will implement a **two-phase lifecycle**:

1. **Phase 1 — Disconnected**: The user has a bearer token (Azure AD) but has not deployed to a lakehouse. Available features: Workspace Explorer, Favorites, Feature Flag browsing, API Playground (read-only Fabric APIs), Token management.

2. **Phase 2 — Connected**: The user has deployed to a lakehouse. This triggers MWC token acquisition, FLT codebase patching, DevMode build, and FLT service launch with interceptors. Additional features: Live Logs, DAG Studio, Spark Inspector, Telemetry, full API Playground.

The sidebar navigation shows all views but grays out Phase 2 views when disconnected. The "Deploy to this Lakehouse" action is the primary transition trigger.

## Consequences

### Positive
- Tool is immediately useful on launch (Phase 1 requires only a browser certificate)
- Clear mental model for users: "I can browse, then I can deploy and debug"
- Sidebar always shows the full feature set — users know what's available
- Graceful degradation: if FLT service crashes, tool reverts to Phase 1 features

### Negative
- UI complexity: must track phase state and enable/disable views
- Two token types to manage (bearer + MWC) with different lifetimes
- Some features (e.g., API Playground) work differently in each phase
- Users might not realize they need to deploy to access full features

### Neutral
- The deploy action is a one-time step per lakehouse target
- Phase state persists for the session — no automatic phase transitions

## Alternatives Considered

### Single-Phase (Require Deployment First)
**Summary**: Don't show the UI until the user deploys to a lakehouse.
**Why rejected**: Too much friction. Engineers often just want to browse workspaces or check a token. Requiring deployment for read-only tasks is unnecessary.

### Three-Phase (Disconnected / Connecting / Connected)
**Summary**: Add an intermediate "connecting" phase with progress indicators.
**Why rejected**: Overcomplicates the UX. The deploy action is fast enough that a progress indicator during the single action is sufficient. A persistent third phase adds state management complexity without user benefit.

## Related
- Design spec Section 2.1: Two-Phase Lifecycle
- ADR-005: Late DI Registration (Phase 2 mechanism)
