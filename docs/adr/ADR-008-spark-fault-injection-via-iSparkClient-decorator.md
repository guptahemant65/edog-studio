# ADR-008: Spark Fault Injection via ISparkClient Decorator

## Status
ACCEPTED

**Date**: 2026-06-07
**Deciders**: Vex (Backend), Sana Reeves (Architecture), Hemant Gupta (CEO)
**Supersedes**: ADR-004 — for the **fault-injection** scope only. ADR-004's Spark Inspector observability rationale remains in force; the two concerns now coexist inside the same wrapper.

## Context

EDOG Studio's Error Code Simulator (F-ESIM) registers fault rules in `EdogHttpFaultStore` targeting the `customTransformExecution` URL substring for three of its four channels:

- **Channel 1** — GTS Status Forge (HTTP 200 + `{"state":"Failed","error":{...}}`) — `EdogErrorSimEngine.cs:156`
- **Channel 2** — GTS Submit Forge (HTTP 4xx/5xx with error envelope) — `EdogErrorSimEngine.cs:165`
- **Channel 4** — Exception Injection (`TaskCanceledException` via `"timeout"` family) — `EdogErrorSimEngine.cs:178`

All three rely on `EdogHttpPipelineHandler.SendAsync` being in the outbound `HttpClient` handler chain. Per `docs/reference/runDAG-lifecycle.md` §4.3.4 (Fact 1), the GTS `HttpClient` is constructed by WCL's `WorkloadCommunicationProvider.Get1PWorkloadHttpClientAsync("Lakehouse", "LakehouseService", ...)` at `GTSBasedSparkClient.cs:119-123`. This call does **not** go through `IHttpClientFactory`, so `EdogHttpClientFactoryWrapper.CreateClient()` is never invoked for it, and `EdogHttpPipelineHandler` is **never inserted** into the chain.

Net effect: rules for Channels 1, 2, and 4 are registered correctly in `_flatRules` but `TryMatchFault` is never called for the GTS calls they target. The simulator silently no-fires. This is a **pipeline-not-in-chain** failure, not an AsyncLocal failure.

The fix requires intercepting at a layer that the GTS HttpClient cannot bypass.

## Decision

We will **intercept at the `ISparkClient` semantic layer** by extending the existing `EdogSparkClientWrapper` (already DI-registered via `EdogSparkSessionInterceptor` at `EdogDevModeRegistrar.cs:394-400`) to consult `EdogHttpFaultStore` and synthesize the appropriate semantic response types (`TransformExecutionSubmitResponse` / `TransformExecutionResponse`) directly — without forging `HttpResponseMessage` and without changing the FLT `GTSBasedSparkClient` source.

```csharp
// Inside EdogSparkClientWrapper.SendTransformRequestAsync (simplified):
if (EdogHttpFaultStore.TryPeekSparkFault(node?.NodeId.ToString(), out var entry))
{
    if (entry.Fault == "http_error" && entry.StatusCode != 200)
    {
        // Channel 2 — Submit Forge: short-circuit with synthesized Failed submit response.
        EdogHttpFaultStore.IncrementMatchCount(entry.RuleId);
        return BuildSynthesizedSubmitFailureResponse(transformationId, entry);
    }
    if (entry.Fault == "timeout")
    {
        // Channel 4 — Exception Injection: synthesize the SAME response the inner
        // client produces when it catches TaskCanceledException at GTSBasedSparkClient.cs:185-202.
        // We never throw — the inner client itself swallows TCE to a Failed response.
        EdogHttpFaultStore.IncrementMatchCount(entry.RuleId);
        return BuildSynthesizedTimeoutResponse(transformationId);
    }
    // Channel 1 — Status Forge (StatusCode == 200): pass through to inner submit;
    // the synthesis happens at GetTransformStatusAsync time.
}
return await _inner.SendTransformRequestAsync(transformationId, node, ...);
```

The wrapper tracks per-`transformationId` "already fired" state in a `ConcurrentDictionary<Guid, byte>` so Channel 1's synthesized Failed status fires exactly once per transformation regardless of polling cadence.

## Consequences

### Positive
- **Wiring already exists.** `EdogSparkClientWrapper` is registered today for Spark Inspector observability — adding fault injection is a code change in one file, with zero new DI registrations, zero new `edog.py` patches, and zero changes to FLT source.
- **Stable contract.** `ISparkClient` is a public interface inside the FLT assembly. The signatures of `SendTransformRequestAsync`, `GetTransformStatusAsync`, `CancelTransformAsync` are stable API contracts. Far more stable than `protected async virtual Task<HttpResponseMessage> SendHttpRequestAsync` (the override point Path A would target — protected methods can change without breaking-change ceremony).
- **Single fault registry.** All rules remain in `EdogHttpFaultStore`. No duplicated rule storage. Existing telemetry (`EdogErrorSimEngine.OnNodeExecutionCompleted` → `ErrorSimRuleMatched/Unmatched`) continues to work unchanged via the same `FaultRuleState.FireCount` counter.
- **No HTTP forgery.** We construct semantic response objects directly, avoiding the fragility of replicating GTS HTTP response shapes and FLT's response parsers (`ConvertToTransformAcceptanceResponseAsync`, `ConvertToTransformExecutionResponseAsync`).
- **Channel 4 mirrors production.** The inner FLT client itself catches `TaskCanceledException` at `GTSBasedSparkClient.cs:185-202` and converts it to `State=Failed, Retriable=true, MLV_SPARK_SESSION_ACQUISITION_TIMEOUT`. By synthesizing the same shape we never need to throw an exception across the wrapper boundary, eliminating any risk of differential exception handling between the inner client and a hypothetical wrapper-thrown TCE.
- **Reversible.** All changes live in a single file (`EdogSparkClientWrapper.cs`) plus two new public helpers on `EdogHttpFaultStore`. Revert is trivial.
- **Co-located with observability.** Fault injection and observability share the same per-iteration wrapper — both can correlate by `_trackingId` and `_iterationId` for joint telemetry.

### Negative
- **Couples `EdogSparkClientWrapper` to fault-store semantics.** Previously the wrapper was pure decoration; now it has a non-observability code path that can short-circuit `_inner` calls. Mitigated by: (a) explicit guard via `EdogHttpFaultStore.TryPeekSparkFault` returning `false` whenever no rule is armed, so the existing pass-through is the default; (b) unit tests pinning the no-rule-armed path.
- **Channel 4 no longer raises `TaskCanceledException`.** The simulator now produces the same semantic outcome that the inner client would produce after catching a real TCE. Any future test that asserts "an unhandled `TaskCanceledException` propagates out of `SendTransformRequestAsync`" would need rewriting — but no such test exists today (the inner client itself never lets TCE escape).
- **ADR-004 supersession for fault-injection scope.** ADR-004 explicitly rejected the wrapper pattern. That rejection was correct for its scope (HttpClient decoration) but does not apply to ISparkClient (interface, not concrete class). The supersession is partial — ADR-004's Spark Inspector observability rationale is unchanged.

### Neutral
- **One match increment per fired rule.** Submit-time Channel 2/4 matches increment `FireCount` once per submit attempt (NodeExecutor may retry; each retry counts as one fire — same as production HTTP-pipeline semantics). Status-time Channel 1 matches increment exactly once per transformation regardless of poll count, via the `_firedStatusForges` dedup set.
- **Rule lookup by NodeId.** The wrapper has `Node node` in scope, so `node.NodeId.ToString()` is the rule-match key. This is strictly higher-fidelity than the HTTP pipeline's `EdogNodeExecutionContext.Current` AsyncLocal read.

## Alternatives Considered

### Path A — Subclass `GTSBasedSparkClient` and override `SendHttpRequestAsync`
**Summary**: New EDOG class `EdogSparkClient : GTSBasedSparkClient` overriding `SendHttpRequestAsync` at `GTSBasedSparkClient.cs:334`; new DI registration replacing the original client; new `edog.py` patch to install it.
**Why rejected**:
- `GTSBasedSparkClient` is `internal class` (`GTSBasedSparkClient.cs:38`) — subclassing requires being in the same assembly. Workable for DevMode overlay files but conceptually wrong (we're depending on internal-access semantics).
- The override point is `protected async virtual`, not a public API contract. FLT can change its signature without that counting as a breaking change. ISparkClient is a public interface — far more stable.
- Requires fabricating `HttpResponseMessage` objects that the inner client's response parsers must accept; this doubles the failure surface (HTTP construction + parser quirks) compared to constructing semantic types directly.
- Requires a new `edog.py` patch (DI override at runtime), plus tests for that patch, plus revert symmetry — significantly more surface than extending a wrapper that already exists.
- Was the original ADR-004 recommendation but written before `EdogSparkClientWrapper` existed.

### Path C — Add a `DelegatingHandler` to the WCL HttpClient
**Summary**: Mutate the WCL HttpClient's handler chain after construction to insert `EdogHttpPipelineHandler`.
**Why rejected**:
- WCL doesn't expose the handler chain for mutation. Would require reflection against an external library we don't own.
- Even if it worked, it would intercept ALL WCL traffic — not just Spark — leaking fault rules into Notebook and LiveTableCommunicationClient calls. Out of scope.

### Path D — Patch `GTSBasedSparkClient` source via `edog.py` to read the fault store
**Summary**: New `edog.py` patch that injects fault-store lookups directly into `GTSBasedSparkClient.SendTransformRequestAsync`.
**Why rejected**:
- Adds a new coupled patch to the already complex Patch 1-8 set.
- Changes FLT source for every developer running EDOG. Path B keeps the change isolated to the EDOG wrapper.
- No upstream benefit — the wrapper does the same job from outside.

## Related
- ADR-004 (superseded for fault-injection scope; Spark Inspector observability rationale unchanged)
- ADR-005 (Late DI Registration — same registration pattern used by `EdogSparkSessionInterceptor`)
- `docs/reference/runDAG-lifecycle.md` §4.3 (the pipeline-not-in-chain diagnosis)
- `docs/reference/runDAG-lifecycle.md` §6.4 (EDOG known limitations)
- Vex owns implementation; Sana monitors for upstream FLT interface drift
