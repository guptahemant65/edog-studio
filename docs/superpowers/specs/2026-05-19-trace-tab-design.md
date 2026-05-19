# Trace Tab — Cross-Tab Causal Correlation

> **Feature:** F28 — Trace Tab
> **Status:** Design approved
> **Date:** 2026-05-19
> **Author:** Donna + Hemant

---

## Overview

A new runtime view tab called **Trace** that assembles the complete execution
story for a DAG iteration by correlating events across all SignalR topics.
Proactive narrative on landing + reactive deep-dive on click.

## Architecture — Three Layers

### Layer 1: Correlation Engine (`correlation-engine.js`)

Singleton module. Subscribes to ALL SignalR topics. Indexes every event by
linkage keys. Builds causal chain trees on demand.

**Index structure:**
- `byIteration: Map<iterationId, Set<eventRef>>`
- `byCorrelation: Map<correlationId, Set<eventRef>>`
- `byTransformation: Map<transformationId, Set<eventRef>>`
- `byGtsSession: Map<gtsSessionId, Set<eventRef>>`
- `byNode: Map<nodeName, Set<eventRef>>`
- `byEndpoint: Map<normalizedUrl, Set<eventRef>>`

**Strategy:** Index eagerly (Map.set per event, microseconds). Build chain
tree lazily (on demand when trace is opened).

**Capacity:** 50 iterations FIFO, ~25K event refs max.

**Chain builder:** `buildChain(iterationId)` collects all events for an
iteration, sorts by timestamp, walks the linkage rules (see below) to
assign parent-child relationships, returns a tree.

### Layer 2: Narrative Generator

Rule-based story assembly from the causal chain. Classifies each iteration
into an archetype and generates a 2-3 sentence summary.

**Archetypes:**
- Clean Run — all succeeded, no retries, <2min
- Slow Run — succeeded but >3x average
- Retry Storm — >3 retries in one iteration
- Auth Failure — token expiry near a 401
- User Error — ErrorSource === 'User'
- System Error — ErrorSource === 'System'
- Partial Failure — some nodes succeeded, some failed
- Cancelled — user cancellation detected

**Clickable narrative:** Every noun is a link to the event in the tree.

### Layer 3: Trace Tab UI (`tab-trace.js` + `tab-trace.css`)

Three-panel layout:
- Top: Iteration selector + narrative summary
- Left: Causal tree (vertical timeline with collapsible sub-chains)
- Right: Event detail panel (rendered using source tab's detail format)

## Causal Chain Rules

### Confidence Levels

| Level | Criteria | Visual |
|-------|----------|--------|
| Definite | Same key match (transformationId, sessionTrackingId, etc.) | Solid arrow |
| Strong | Same key + time order + logical dependency | Solid arrow |
| Inferred | Time proximity + endpoint/audience match, no shared key | Dashed arrow + "likely" label |

### Link Rules

| Child Event | Parent Event | Link Key | Confidence |
|---|---|---|---|
| TransformSubmitted | Created | sessionTrackingId | Definite |
| TransformPolled | TransformSubmitted | transformationId | Definite |
| TransformCompleted | last TransformPolled | transformationId | Definite |
| TransformCancelled | TransformSubmitted | transformationId | Definite |
| Disposed | Created | sessionTrackingId | Definite |
| HTTP call during transform | TransformSubmitted | correlationId or gtsSessionId + time window | Strong |
| Retry event | HTTP error | endpoint + time proximity (<2s) | Strong |
| Token refresh | HTTP 401 | token audience matches endpoint host | Inferred |
| Cache miss | Subsequent HTTP call | cacheName + time proximity | Inferred |

### Unlinked Events

Events sharing iterationId but not causally connected appear in a
collapsible "Other events (unlinked)" section below the tree.

## Honesty Rules (Non-Negotiable)

1. Never claim causation from time proximity alone — require at least one
   shared key OR a known logical relationship.
2. Never say "root cause" — say "first error in this chain" or "failure
   originated at."
3. Never hide confidence level — inferred links show dashed lines +
   "likely" qualifier.
4. Never fabricate missing data — show gaps explicitly: "No HTTP error
   observed before this failure."
5. Never paper over unlinked events — show them in the unlinked section.

## Narrative Language by Confidence

- Definite: "Node 'X' failed with MLV_SPARK_TRANSFORM_EXECUTION_FAILED"
- Strong: "The failure occurred after 3 retries against GTS"
- Inferred: "A token refresh was observed shortly before — this **may**
  have been triggered by the 401"
- Unknown: "We observed a cache eviction but could not determine its
  relationship to the failure"

## Color Coding

| Source | Color |
|--------|-------|
| Spark | Purple |
| HTTP | Blue |
| Token | Green |
| Retry | Amber |
| Error/Failure | Red |
| DAG lifecycle | Teal |
| Cache | Cyan |
| Telemetry | Gray |

## Interaction

- Click any event in tree → detail panel shows full event data
- Click noun in narrative → scrolls tree to that event
- Collapse/expand node sub-chains in tree
- Failed chains have red left border
- Time deltas shown on connecting arrows ("247ms later", "+3.2s")
- Keyboard: j/k navigate tree, Enter expand, Esc close detail, / search

## Integration

- Registered as runtime view tab alongside Logs, Telemetry, Spark, etc.
- Correlation engine initialized in main.js, shared across tabs
- Any tab can call `engine.buildChain(iterationId)` for its own use
- Tab-specific detail renderers reused from source tabs
