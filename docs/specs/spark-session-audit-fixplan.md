# Spark Sessions Tab — Architecture Audit & Fix Plan

**Date:** 2026-05-21
**Author:** Sana (architecture)
**Scope:** Complete overhaul of Spark session visibility

---

## Bugs (from audit)

| # | Bug | Impact | Fix |
|---|---|---|---|
| A | `_mergePendingCreated` only called from `_onSubmitted` | Poll-first/Disposed-only sessions lose identity | Call from ALL event handlers |
| B | Disposed-only sessions have wrong `startedAt` | Swimlane misplot | Merge pending in `_onDisposed` |
| C | `_onPolled` drops error fields | Failed-via-poll has no error details | Read error fields from polls |
| D | `rawOutput` emitted but dropped by `_onCompleted` | Output tab can't show raw | Store and render rawOutput |
| E | `_lastState` is wrapper-scoped, not transform-scoped | `previousState` corrupted across parallel transforms | Backend: `ConcurrentDictionary<Guid, string>` |

## Blind Spots to Fix

| # | Blind Spot | How to Fix |
|---|---|---|
| BS1 | SessionProperties.Conf never published | Backend: emit `SessionPropertiesSet` event from wrapper setter |
| BS2 | GTS session reuse invisible across iterations | Frontend: cross-card grouping by `gtsSessionId` |
| BS3 | REPL lifetime has no "gone" confirmation | Backend: emit `gtsSessionId`/`replId` on cancel events |
| BS4 | Submit retry storms collapsed into one event | Backend: emit per-retry `TransformSubmitAttempt` events |
| BS5 | Generated Spark code not on Spark tab | Backend: include code in submit event; frontend: show in detail |

## Other Fixes (from recommendations)

| # | Fix | Layer |
|---|---|---|
| R3 | Stop conflating TransformCompleted/TransformPolled | Backend |
| R4 | Emit gtsSessionId/replId on ALL events | Backend |
| R5 | Add transformationId as x-ms-client-request-id header | Backend |
| R6 | Tag Insights transforms with transformOrigin | Backend |
| R7 | Emit BackgroundTaskStarted/Completed for REPL cleanup | Backend |
| R8 | Raise spark ring buffer 200 → 2000 | Backend |
| R9 | Fix SparkGtsPattern to match /customTransformExecution/ | Backend |
| R12 | Kill warm heuristic or back with real evidence | Frontend |
| R13 | Store rawOutput | Frontend |
| R14 | Render submitError | Frontend |
| R16 | HTTP-rollup inside Spark card | Frontend |
| R18 | Dedup snapshot replay by sequenceId | Frontend |

## Priority Order

### P0 — Data correctness (bugs)
1. Bug E: _lastState per-transform (backend C#)
2. Bug A+B: merge pendingCreated from all handlers (frontend JS)
3. Bug C: read error fields from polls (frontend JS)
4. Bug D: store rawOutput (frontend JS)
5. R14: render submitError (frontend JS)

### P1 — Blind spot removal
6. BS1: publish SessionProperties.Conf (backend C#)
7. BS5: include generated Spark code in submit event (backend C#)
8. R4: emit gtsSessionId/replId on all events (backend C#)
9. BS3: replId on cancel events (subset of R4)
10. BS4: per-retry submit attempt events (backend C#)
11. R8: raise ring buffer 200→2000 (backend C#)
12. R9: fix NexusClassifier SparkGtsPattern (backend C#)

### P2 — Cross-linking & enrichment
13. R5: transformationId as correlation header (backend C#)
14. BS2: cross-iteration gtsSessionId grouping (frontend JS)
15. R6: tag Insights transforms (backend C#)
16. R7: background task lifecycle events (backend C#)
17. R16: HTTP-rollup inside Spark card (frontend JS)
18. R18: dedup snapshot replay (frontend JS)
19. R12: warm heuristic fix (frontend JS)
