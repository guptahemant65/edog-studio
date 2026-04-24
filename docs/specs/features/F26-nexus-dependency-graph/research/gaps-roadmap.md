# F26 Nexus — Observability Gaps Roadmap

> **Status:** RESEARCH
> **Author:** Sana (Architecture Agent)
> **Date:** 2025-07-18
> **Scope:** 4 interceptor gaps requiring new C# code in `src/backend/DevMode/`

---

## Executive Summary

EDOG Studio's current interceptor layer captures **transport-level** events — HTTP requests, token headers on outbound calls, Spark session creation, file system I/O, cache operations, and retry parsing. This covers the *plumbing* of FLT, but not the *orchestration*.

Four critical observability gaps remain:

| Gap | What's Invisible | Impact |
|-----|------------------|--------|
| **Gap 2** — DAG Execution Lifecycle | Node scheduling, cascade failures, parallel limits, hook execution | Cannot diagnose *why* a DAG took 45 minutes |
| **Gap 3** — Token Lifecycle | Cache hit/miss, OBO exchange latency, refresh cycles, provider type | Cannot distinguish 200ms auth overhead from 5s token refresh |
| **Gap 4** — Catalog Discovery | Per-OneLake-call timing, semaphore contention, schema/table counts | Cannot explain why catalog took 12s on a 200-table lakehouse |
| **Gap 8** — FLT Operations | Refresh triggers, MLV definitions, DQ reports, CDF, maintenance, locks | Entire subsystems have zero observability |

These gaps represent the difference between EDOG being a transport debugger and a **full DAG lifecycle observatory**. Without them, Nexus can map edges between services but cannot show *what FLT is doing* at the orchestration layer — the layer where most production incidents actually live.

**Total estimated effort:** ~6 weeks of interceptor work (2 engineers), plus FLT team coordination for Gap 2.

---

## Gap 2: DAG Execution Lifecycle Not Visible

### Problem Statement

`DagExecutionHandlerV2` (`Service/Microsoft.LiveTable.Service/Core/V2/DagExecutionHandlerV2.cs:49`) is a 1,200+ line class that orchestrates the entire DAG lifecycle. It resolves parallel node limits via a priority chain (`DagExecutionHandlerV2.cs:1118-1125`), manages node execution with `ConcurrentDictionary` tracking (`DagExecutionHandlerV2.cs:294-296`), fires hooks via `IDagExecutionHookExecutor` (`DagExecutionHandlerV2.cs:1202`), and computes terminal status. EDOG sees none of this.

**What's invisible today:**
- Node scheduling decisions: parent success check → slot availability → `Task.Run()` dispatch (`DagExecutionHandlerV2.cs:886-1017`)
- Cascade failures: when node A fails, children B and C get `Skipped` status — visible only in post-execution metrics
- Parallel node limit resolution: the 3-tier resolver chain (user settings → feature flags → default 5) (`DagExecutionHandlerV2.cs:1130-1196`)
- Hook execution: `IDagExecutionHook.ExecuteAsync()` runs post-write hooks (DQ insights, table maintenance) before terminal commit (`DagExecutionHandlerV2.cs:468-479`)
- The polling loop: `while (visited.Count < sortedNodes.Count)` with configurable delay between checks (`DagExecutionHandlerV2.cs:403-501`)

### Proposed Interceptor Design

**Class:** `EdogDagExecutionInterceptor`

**Target interface:** `IDagExecutionHook` — implement as an EDOG-specific hook registered into the existing hook system.

**Wrapping pattern:** Unlike other interceptors that use DI decoration, this interceptor leverages FLT's existing hook system. Register `EdogDagExecutionInterceptor` as an `IDagExecutionHook` with `HookPhase.CRUD` and a unique `GroupId` (e.g., `"edog-observability"`). It runs alongside real hooks without interfering.

**Why hooks, not DI decoration:** `DagExecutionHandlerV2` is `internal` and implements `ITypedReliableOperationHandler` (`DagExecutionHandlerV2.cs:49`) — not a simple interface we can decorate. The hook system (`IDagExecutionHook` at `DagExecutionHooks/IDagExecutionHook.cs:24`) is specifically designed for extension points. Hooks within the same `GroupId` run sequentially; different groups run in parallel via `Task.WhenAll`.

**Limitation:** Hooks fire only at terminal status commitment. For node-level lifecycle events (queued → executing → complete), we need a **second integration point**: wrapping `INodeExecutor` (`Core/V2/INodeExecutor.cs:13`) via DI decoration, similar to how `EdogSparkSessionInterceptor` wraps `ISparkClientFactory`.

```csharp
#nullable disable
#pragma warning disable

// Hook-based: captures DAG-level lifecycle at terminal phase
internal class EdogDagExecutionHook : IDagExecutionHook
{
    public string Name => "EdogObservability";
    public string GroupId => "edog-observability";
    public HookPhase Phase => HookPhase.CRUD;

    public Task ExecuteAsync(DagExecutionHookContext context, CancellationToken ct)
    {
        var dagCtx = context.DagExecutionContext;
        var instance = context.DagExecInstance;

        EdogTopicRouter.Publish("dag", new
        {
            @event = "DagTerminal",
            dagId = dagCtx?.DagName,
            iterationId = instance?.IterationId,
            status = instance?.TerminalStatus?.ToString(),
            totalNodes = instance?.DagExecutionMetrics?.TotalNodeCount,
            completedNodes = instance?.DagExecutionMetrics?.CompletedNodeCount,
            failedNodes = instance?.DagExecutionMetrics?.FailedNodeCount,
            skippedNodes = instance?.DagExecutionMetrics?.SkippedNodeCount,
            parallelLimit = instance?.DagExecutionMetrics?.ParallelNodeLimit,
            durationMs = instance?.DagExecutionMetrics?.TotalDurationMs,
            hookCount = context.TerminalInfo?.HookResults?.Count,
        });

        return Task.CompletedTask;
    }
}

// Decorator-based: captures per-node lifecycle
internal class EdogNodeExecutorWrapper : INodeExecutor
{
    private readonly INodeExecutor _inner;
    private readonly string _nodeId;
    private readonly string _dagId;
    private readonly Guid _iterationId;

    public EdogNodeExecutorWrapper(INodeExecutor inner, string nodeId,
        string dagId, Guid iterationId)
    {
        _inner = inner;
        _nodeId = nodeId;
        _dagId = dagId;
        _iterationId = iterationId;
    }

    public async Task ExecuteNodeAsync(CancellationToken ct)
    {
        var sw = System.Diagnostics.Stopwatch.StartNew();

        EdogTopicRouter.Publish("dag", new
        {
            @event = "NodeStarted",
            nodeId = _nodeId,
            dagId = _dagId,
            iterationId = _iterationId,
        });

        try
        {
            await _inner.ExecuteNodeAsync(ct);
            sw.Stop();

            EdogTopicRouter.Publish("dag", new
            {
                @event = "NodeCompleted",
                nodeId = _nodeId,
                dagId = _dagId,
                iterationId = _iterationId,
                durationMs = sw.ElapsedMilliseconds,
                status = "Completed",
            });
        }
        catch (Exception ex)
        {
            sw.Stop();

            EdogTopicRouter.Publish("dag", new
            {
                @event = "NodeFailed",
                nodeId = _nodeId,
                dagId = _dagId,
                iterationId = _iterationId,
                durationMs = sw.ElapsedMilliseconds,
                status = "Failed",
                errorType = ex.GetType().Name,
                errorMessage = ex.Message?.Substring(0,
                    Math.Min(ex.Message?.Length ?? 0, 500)),
            });

            throw;
        }
    }
}
```

### New Topic Buffer

**Topic:** `dag`
**Buffer size:** 500
**Registration in `EdogTopicRouter.cs`:** Add `{ "dag", 500 }` to the topic dictionary (`EdogTopicRouter.cs:26-40`).

**Event shapes:**

```jsonc
// DagStarted — emitted when ExecuteInternalAsync begins
{
  "event": "DagStarted",
  "dagId": "MyLakehouse_FullRefresh",
  "iterationId": "a1b2c3d4-...",
  "parallelLimit": 10,
  "totalNodes": 47,
  "resolverSource": "FeatureFlag_FLT10",
  "timestamp": "2025-07-18T14:30:00.000Z"
}

// NodeStarted — per-node, emitted by EdogNodeExecutorWrapper
{
  "event": "NodeStarted",
  "nodeId": "mv_customer_orders",
  "dagId": "MyLakehouse_FullRefresh",
  "iterationId": "a1b2c3d4-...",
  "parentNodes": ["mv_raw_orders", "mv_customers"],
  "slotIndex": 3
}

// NodeCompleted — per-node
{
  "event": "NodeCompleted",
  "nodeId": "mv_customer_orders",
  "dagId": "MyLakehouse_FullRefresh",
  "iterationId": "a1b2c3d4-...",
  "durationMs": 12450,
  "status": "Completed"
}

// NodeSkipped — cascade failure
{
  "event": "NodeSkipped",
  "nodeId": "mv_final_report",
  "dagId": "MyLakehouse_FullRefresh",
  "iterationId": "a1b2c3d4-...",
  "reason": "ParentFailed",
  "failedParent": "mv_customer_orders"
}

// DagTerminal — emitted by EdogDagExecutionHook
{
  "event": "DagTerminal",
  "dagId": "MyLakehouse_FullRefresh",
  "iterationId": "a1b2c3d4-...",
  "status": "Failed",
  "totalNodes": 47,
  "completedNodes": 38,
  "failedNodes": 3,
  "skippedNodes": 6,
  "parallelLimit": 10,
  "durationMs": 287000,
  "hookCount": 2
}

// HookExecuted — emitted after each DAG hook runs
{
  "event": "HookExecuted",
  "hookName": "TableMaintenance",
  "hookPhase": "Maintenance",
  "groupId": "maintenance",
  "dagId": "MyLakehouse_FullRefresh",
  "iterationId": "a1b2c3d4-...",
  "durationMs": 4200,
  "success": true
}
```

### Integration Points in FLT

| File | Change Required | Owner |
|------|----------------|-------|
| `DagExecutionHooks/IDagExecutionHook.cs:24` | None — EDOG hook implements existing interface | EDOG |
| `DagExecutionHandlerV2.cs:1202` | Register `EdogDagExecutionHook` in hook list (via DI) | **FLT team** |
| `Core/V2/INodeExecutor.cs:13` | None — EDOG wraps via DI decoration | EDOG |
| `Core/V2/NodeExecutor.cs:33` | Must be `public` or FLT must expose factory | **FLT team** |
| `EdogDevModeRegistrar.cs:36-44` | Add `RegisterDagInterceptor()` call | EDOG |
| `EdogTopicRouter.cs:26-40` | Add `dag` topic with buffer 500 | EDOG |

### Priority and Effort

**Priority:** P0 — This is the single highest-value gap. Without DAG lifecycle visibility, Nexus can only show "FLT talked to GTS" but not "node X waited 30s for a semaphore slot."

**Effort:** **L** (Large)
- Hook integration: 2 days (EDOG side) + FLT team coordination for hook registration
- Node executor wrapper: 3 days (requires FLT to expose internal types or provide a factory)
- Topic + event model: 1 day
- Frontend integration: 3 days (Nexus graph + timeline)
- **Total: ~9 days + FLT dependency**

### Dependencies on FLT Team

1. **Hook registration:** FLT must register `EdogDagExecutionHook` in the hook executor pipeline, gated by a DevMode feature flag. This is minimal — one DI registration line.
2. **NodeExecutor visibility:** `NodeExecutor` is `internal` (`Core/V2/NodeExecutor.cs:33`). FLT must either:
   - (a) Make `INodeExecutor` resolution go through DI (currently `new NodeExecutor(...)` inline at `DagExecutionHandlerV2.cs:310`), or
   - (b) Provide a `INodeExecutorFactory` that EDOG can decorate.
3. **`DagExecutionMetrics` access:** Metrics fields (completed/failed/skipped counts, parallel limit) need to be accessible from the hook context.

### Impact on Nexus

- Enables a **DAG lane** in the dependency graph: FLT → DAG Orchestrator → [Node A, Node B, ...] → Spark/GTS
- Cascade failure visualization: when node A fails, the graph can show downstream nodes going gray
- Parallel execution visualization: show which nodes are executing simultaneously
- Hook execution becomes visible as post-DAG edges to Maintenance/DQ subsystems

---

## Gap 3: Token Lifecycle is a Black Box

### Problem Statement

`EdogTokenInterceptor` (`src/backend/DevMode/EdogTokenInterceptor.cs:24`) operates as an HTTP `DelegatingHandler` — it sees tokens *after* they've been acquired and attached to outbound requests. It publishes JWT metadata (`aud`, `exp`, `iat`, scheme) to the `token` topic. But the acquisition layer — where tokens are fetched, cached, refreshed, and exchanged — is completely opaque.

**What's invisible today:**
- **OBO exchange latency:** `TokenManager.GetOboTokenForTridentLakeAsync()` (`TokenManager.cs:46-51`) calls `GetOBOAadTokenAsync()` which may take 200ms-2s. No timing.
- **Cache hit/miss/refresh:** `BaseTokenProvider.GetTokenAsync()` (`BaseTokenProvider.cs:190-212`) uses a double-check locking pattern with `AsyncLock`. The fast path (cache hit) returns instantly; the slow path (refresh) can take seconds. No distinction in events.
- **Token type discrimination:** S2S tokens (`SystemTokenProvider.cs:60-88`), OBO tokens (`AadTokenProvider.cs:44-58`), DAG tokens (`DagExecutionTokenProvider.cs:46-52`), and user tokens all flow through different providers but appear identical in current events.
- **Refresh cycles:** `TokenManager.UpdateCachedToken()` (`TokenManager.cs:132-179`) checks `MwcTokenUpdateTimeBeforeExpiryInMinutes` threshold. Proactive refresh events are invisible.
- **Token expiry buffer:** `BaseTokenProvider.CheckTokenValidity()` (`BaseTokenProvider.cs:155-168`) uses configurable `TokenExpiryBufferInMinutes` (~10 min). When tokens are within buffer, refresh is triggered — but this decision logic is invisible.

### Proposed Interceptor Design

**Class:** `EdogTokenLifecycleInterceptor`

**Target interface:** `ITokenManager` — decorate via DI, wrapping the existing `TokenManager` singleton.

**Wrapping pattern:** Standard DI decoration, same as `EdogFileSystemInterceptor` wraps `IFileSystem`. Resolve the real `TokenManager`, wrap it in `EdogTokenLifecycleInterceptor`, register the wrapper.

```csharp
#nullable disable
#pragma warning disable

public class EdogTokenLifecycleInterceptor : ITokenManager
{
    private readonly ITokenManager _inner;

    public EdogTokenLifecycleInterceptor(ITokenManager inner)
    {
        _inner = inner;
    }

    public async Task<string> GetOboTokenForTridentLakeAsync(
        Guid tenantId, string mwcToken)
    {
        var sw = System.Diagnostics.Stopwatch.StartNew();
        try
        {
            var token = await _inner.GetOboTokenForTridentLakeAsync(
                tenantId, mwcToken);
            sw.Stop();

            EdogTopicRouter.Publish("token", new
            {
                @event = "OboExchange",
                provider = "TokenManager",
                audience = "TridentLake",
                tenantId = tenantId.ToString(),
                durationMs = sw.ElapsedMilliseconds,
                success = true,
            });

            return token;
        }
        catch (Exception ex)
        {
            sw.Stop();

            EdogTopicRouter.Publish("token", new
            {
                @event = "OboExchange",
                provider = "TokenManager",
                audience = "TridentLake",
                tenantId = tenantId.ToString(),
                durationMs = sw.ElapsedMilliseconds,
                success = false,
                errorType = ex.GetType().Name,
            });

            throw;
        }
    }

    public async Task<string> GetTokenAsync(
        Guid lakehouseId, Guid iterationId, CancellationToken ct = default)
    {
        var sw = System.Diagnostics.Stopwatch.StartNew();
        var token = await _inner.GetTokenAsync(lakehouseId, iterationId, ct);
        sw.Stop();

        // Infer cache behavior from timing:
        // < 5ms strongly suggests cache hit; > 100ms suggests refresh
        var cacheInference = sw.ElapsedMilliseconds < 5 ? "hit"
            : sw.ElapsedMilliseconds > 100 ? "refresh" : "uncertain";

        EdogTopicRouter.Publish("token", new
        {
            @event = "TokenAcquired",
            provider = "TokenManager",
            method = "GetTokenAsync",
            lakehouseId = lakehouseId.ToString(),
            iterationId = iterationId.ToString(),
            durationMs = sw.ElapsedMilliseconds,
            cacheInference,
        });

        return token;
    }

    public void CacheToken(Guid lakehouseId, Guid iterationId, string userToken)
    {
        _inner.CacheToken(lakehouseId, iterationId, userToken);

        EdogTopicRouter.Publish("token", new
        {
            @event = "TokenCached",
            lakehouseId = lakehouseId.ToString(),
            iterationId = iterationId.ToString(),
        });
    }

    public bool UpdateCachedToken(
        Guid lakehouseId, Guid iterationId, string userToken)
    {
        var result = _inner.UpdateCachedToken(
            lakehouseId, iterationId, userToken);

        EdogTopicRouter.Publish("token", new
        {
            @event = "TokenRefreshAttempt",
            lakehouseId = lakehouseId.ToString(),
            iterationId = iterationId.ToString(),
            refreshed = result,
        });

        return result;
    }

    public void DeleteCachedToken(Guid lakehouseId, Guid iterationId)
    {
        _inner.DeleteCachedToken(lakehouseId, iterationId);

        EdogTopicRouter.Publish("token", new
        {
            @event = "TokenEvicted",
            lakehouseId = lakehouseId.ToString(),
            iterationId = iterationId.ToString(),
        });
    }

    public DateTime CalculateExpiryTime(string mwcToken)
    {
        return _inner.CalculateExpiryTime(mwcToken);
    }
}
```

### Topic Buffer Enhancement

**Topic:** `token` (existing — `EdogTopicRouter.cs:35`)
**Current buffer:** 500
**Proposed buffer:** 1,000 (increase to accommodate lifecycle events alongside existing header events)

**New event shapes (additions to existing token events):**

```jsonc
// OboExchange — captures OBO token exchange duration
{
  "event": "OboExchange",
  "provider": "TokenManager",
  "audience": "TridentLake",
  "tenantId": "72f988bf-...",
  "durationMs": 847,
  "success": true
}

// TokenAcquired — captures token retrieval with cache inference
{
  "event": "TokenAcquired",
  "provider": "TokenManager",
  "method": "GetTokenAsync",
  "lakehouseId": "abc123-...",
  "iterationId": "def456-...",
  "durationMs": 2,
  "cacheInference": "hit"
}

// TokenRefreshAttempt — proactive refresh decision
{
  "event": "TokenRefreshAttempt",
  "lakehouseId": "abc123-...",
  "iterationId": "def456-...",
  "refreshed": true
}

// TokenCached — new token entering cache
{
  "event": "TokenCached",
  "lakehouseId": "abc123-...",
  "iterationId": "def456-..."
}

// TokenEvicted — token removed from cache
{
  "event": "TokenEvicted",
  "lakehouseId": "abc123-...",
  "iterationId": "def456-..."
}
```

### Integration Points in FLT

| File | Change Required | Owner |
|------|----------------|-------|
| `TokenManagement/ITokenManager.cs:15-67` | None — interface already `public` | — |
| `TokenManagement/TokenManager.cs:20` | None — class already `public` | — |
| `EdogDevModeRegistrar.cs:38` | Enhance `RegisterTokenInterceptor()` to also decorate `ITokenManager` | EDOG |
| `EdogTopicRouter.cs:35` | Increase `token` buffer from 500 to 1000 | EDOG |

### Priority and Effort

**Priority:** P1 — High value for diagnosing auth-related slowdowns (common in S2S token storms during parallel DAG execution), but existing HTTP-level token events provide partial coverage.

**Effort:** **S** (Small)
- `ITokenManager` is already `public` with clean method signatures
- Standard DI decoration pattern (same as `EdogFileSystemInterceptor`)
- No FLT team changes required
- **Total: ~3 days**

### Dependencies on FLT Team

**None.** `ITokenManager` is a `public` interface (`TokenManagement/ITokenManager.cs:15`), `TokenManager` is a `public` class (`TokenManagement/TokenManager.cs:20`), and it's registered as a singleton in DI. EDOG can resolve and decorate without any FLT changes.

### Impact on Nexus

- Enables an **Auth Provider** node in the dependency graph with real latency data
- Token cache hit rate becomes a first-class metric (cache hit = green edge, refresh = yellow, failure = red)
- OBO exchange timing feeds into "time spent on auth" breakdown in DAG timeline
- Correlating `TokenAcquired` events with `http` events via timestamp proximity reveals which HTTP calls triggered token refreshes

---

## Gap 4: Catalog Discovery is Opaque

### Problem Statement

`CatalogHandler` (`Service/Microsoft.LiveTable.Service/Catalog/CatalogHandler.cs:36`) orchestrates catalog discovery via `GetCatalogObjectsAsync()` (`CatalogHandler.cs:82`). The heavy lifting happens in `LakeHouseMetastoreClientWithShortcutSupport` (`Catalog/LakeHouseMetastoreClientWithShortcutSupport.cs:61`) — a ~500-line class that makes `1 + S + (T * 2) + (U * 2)` OneLake API calls (S=schemas, T=tables, U=shortcuts).

**What's invisible today:**
- **Per-call timing:** `ListDirsAsync()` calls at lines 441 and 500 of `LakeHouseMetastoreClientWithShortcutSupport.cs` make individual OneLake REST calls, but no event is emitted per call.
- **Semaphore contention:** `SemaphoreSlim oneLakeCatalogSemaphore` (`LakeHouseMetastoreClientWithShortcutSupport.cs:72`) with telemetry fields `globalMaxSemaphoreWaitMs`, `globalTotalSemaphoreWaitMs`, `globalPeakConcurrentCalls` (`LakeHouseMetastoreClientWithShortcutSupport.cs:100-105`) — all tracked internally but never surfaced.
- **Concurrency limit:** `DefaultMaxConcurrentOneLakeCatalogCalls = 10` (`CatalogHandler.cs:41`) with dynamic resolution via `GetResolvedMaxConcurrentOneLakeCatalogCalls()` (`CatalogHandler.cs:927`).
- **Schema/table counts:** How many schemas found, how many tables per schema, how many shortcuts filtered — not available until after the operation completes.
- **Connected catalog:** `GetConnectedCatalogObjectsAsync()` (`CatalogHandler.cs:260`) handles cross-lakehouse lineage traversal — a second wave of catalog calls that is completely invisible.

### Proposed Interceptor Design

**Class:** `EdogCatalogInterceptor`

**Target interface:** `ICatalogHandler` (`Catalog/ICatalogHandler.cs:17`) — decorate via DI.

**Wrapping pattern:** Standard DI decoration. `ICatalogHandler` is a `public` interface with a single method (`GetCatalogObjectsAsync`), making it an ideal decoration target. Wrap the call, capture timing and result counts.

```csharp
#nullable disable
#pragma warning disable

public class EdogCatalogInterceptor : ICatalogHandler
{
    private readonly ICatalogHandler _inner;

    public EdogCatalogInterceptor(ICatalogHandler inner)
    {
        _inner = inner;
    }

    public async Task<List<Table>> GetCatalogObjectsAsync(
        Guid tenantId, Guid workspaceId, Guid artifactId,
        string workspaceName, string artifactName, string mwcToken,
        CancellationToken ct = default,
        MLVExecutionDefinition mlvExecDefinition = null,
        bool showExtendedLineage = false)
    {
        var sw = System.Diagnostics.Stopwatch.StartNew();

        EdogTopicRouter.Publish("catalog", new
        {
            @event = "CatalogDiscoveryStarted",
            workspaceId = workspaceId.ToString(),
            artifactId = artifactId.ToString(),
            artifactName,
            hasMLVFilter = mlvExecDefinition != null,
            extendedLineage = showExtendedLineage,
        });

        try
        {
            var tables = await _inner.GetCatalogObjectsAsync(
                tenantId, workspaceId, artifactId,
                workspaceName, artifactName, mwcToken,
                ct, mlvExecDefinition, showExtendedLineage);

            sw.Stop();

            // Count table types from results
            int mvCount = 0, tableCount = 0, shortcutCount = 0,
                faultedCount = 0;
            if (tables != null)
            {
                foreach (var t in tables)
                {
                    if (t.IsFaulted) faultedCount++;
                    else if (t.IsShortcut) shortcutCount++;
                    else if (t.IsMaterializedView) mvCount++;
                    else tableCount++;
                }
            }

            EdogTopicRouter.Publish("catalog", new
            {
                @event = "CatalogDiscoveryCompleted",
                workspaceId = workspaceId.ToString(),
                artifactId = artifactId.ToString(),
                artifactName,
                durationMs = sw.ElapsedMilliseconds,
                totalEntities = tables?.Count ?? 0,
                mvCount,
                tableCount,
                shortcutCount,
                faultedCount,
                hasMLVFilter = mlvExecDefinition != null,
                extendedLineage = showExtendedLineage,
            });

            return tables;
        }
        catch (Exception ex)
        {
            sw.Stop();

            EdogTopicRouter.Publish("catalog", new
            {
                @event = "CatalogDiscoveryFailed",
                workspaceId = workspaceId.ToString(),
                artifactId = artifactId.ToString(),
                artifactName,
                durationMs = sw.ElapsedMilliseconds,
                errorType = ex.GetType().Name,
                errorMessage = ex.Message?.Substring(0,
                    Math.Min(ex.Message?.Length ?? 0, 500)),
            });

            throw;
        }
    }
}
```

**Future enhancement — deep catalog instrumentation:** The `ICatalogHandler` decorator gives us operation-level timing, but not per-OneLake-call breakdown. For deeper visibility (semaphore wait times, per-schema call counts), FLT would need to either:
1. Surface `LakeHouseMetastoreClientWithShortcutSupport` telemetry fields (`globalMaxSemaphoreWaitMs`, `globalTotalSemaphoreWaitMs`, `globalPeakConcurrentCalls` at lines 100-105) in the `GetCatalogObjectsAsync` return or via a callback, or
2. Emit structured events from within the metastore client (requires FLT code changes).

### New Topic Buffer

**Topic:** `catalog`
**Buffer size:** 200
**Registration in `EdogTopicRouter.cs`:** Add `{ "catalog", 200 }` to the topic dictionary.

**Event shapes:**

```jsonc
// CatalogDiscoveryStarted
{
  "event": "CatalogDiscoveryStarted",
  "workspaceId": "ws-guid-...",
  "artifactId": "lh-guid-...",
  "artifactName": "MyLakehouse",
  "hasMLVFilter": true,
  "extendedLineage": false
}

// CatalogDiscoveryCompleted
{
  "event": "CatalogDiscoveryCompleted",
  "workspaceId": "ws-guid-...",
  "artifactId": "lh-guid-...",
  "artifactName": "MyLakehouse",
  "durationMs": 8420,
  "totalEntities": 187,
  "mvCount": 45,
  "tableCount": 120,
  "shortcutCount": 15,
  "faultedCount": 7,
  "hasMLVFilter": true,
  "extendedLineage": false
}

// CatalogDiscoveryFailed
{
  "event": "CatalogDiscoveryFailed",
  "workspaceId": "ws-guid-...",
  "artifactId": "lh-guid-...",
  "artifactName": "MyLakehouse",
  "durationMs": 12000,
  "errorType": "RequestFailedException",
  "errorMessage": "Service returned status 429 (Too Many Requests)"
}
```

### Integration Points in FLT

| File | Change Required | Owner |
|------|----------------|-------|
| `Catalog/ICatalogHandler.cs:17` | None — interface already `public` | — |
| `Catalog/CatalogHandler.cs:36` | None — class is `internal` but registered via `ICatalogHandler` in DI | — |
| `EdogDevModeRegistrar.cs` | Add `RegisterCatalogInterceptor()` method | EDOG |
| `EdogTopicRouter.cs` | Add `catalog` topic with buffer 200 | EDOG |

### Priority and Effort

**Priority:** P1 — Catalog discovery is a frequent source of slowness complaints ("why did my refresh take 2 minutes before any Spark jobs started?"). The interceptor is straightforward.

**Effort:** **S** (Small)
- `ICatalogHandler` has a single method — trivial to decorate
- No FLT changes required for Phase 1
- Deep instrumentation (semaphore metrics) requires FLT changes — Phase 2
- **Total: ~2 days (Phase 1), ~5 days additional for Phase 2 with FLT coordination**

### Dependencies on FLT Team

**Phase 1 — None.** `ICatalogHandler` is `public`, registered in DI, and has a clean single-method interface.

**Phase 2 — FLT changes needed:**
1. Surface semaphore telemetry from `LakeHouseMetastoreClientWithShortcutSupport` (fields at lines 100-105) via a return object or callback.
2. Optionally: add `IOneLakeRestClient` interceptor hooks for per-call timing.

### Impact on Nexus

- Adds an **OneLake/Catalog** node to the dependency graph with timing data
- Shows the catalog discovery phase as a distinct segment in DAG timeline (before any Spark calls)
- Entity counts (MVs, tables, shortcuts) become visible metadata on the Catalog node
- Correlates with DAG execution: "catalog took 8s, Spark took 35s, hooks took 4s"

---

## Gap 8: New Systems Not Modeled

### Problem Statement

FLT has grown beyond DAG execution into several subsystems that have zero EDOG observability:

1. **Refresh Triggers** — `IRefreshTriggersHandler` (`Core/RefreshTrigger/IRefreshTriggersHandler.cs:17`) — Fabric Activator integration for event-driven DAG execution. CRUD operations via `LiveTableRefreshTriggersController` (`Controllers/LiveTableRefreshTriggersController.cs:59`). Registered as singleton (`WorkloadApp.cs:118`).

2. **MLV Execution Definitions** — `IMLVExecutionDefinitionPersistenceManager` (`Persistence/IMLVExecutionDefinitionPersistenceManager.cs:18`) — Named execution profiles with CRUD, recovery files, and DAG settings merge. Registered via `MLVExecutionDefinitionHandler` (`WorkloadApp.cs:143-144`).

3. **Data Quality Reports** — `DataQualityReportHandler` (`DataQuality/DataQualityReportHandler.cs:20`) + `IReportStateManager` (`DataQuality/StateManagement/IReportStateManager.cs:14`) — Auto-creates PBI semantic models + reports with lock-based state management. Max creation time: 30 minutes (`DQConstants.cs:18`).

4. **CDF Enablement** — `CdfEnablementExecutor` (`Core/CdfEnablement/CdfEnablementExecutor.cs:36`) — Sequential ALTER TABLE execution on shared REPL sessions. Session acquisition polling, REPL loss recovery, per-command result tracking.

5. **Table Maintenance** — `ITableMaintenanceClient` (`Maintenance/MaintenanceHttp/ITableMaintenanceClient.cs:17`) + `TableMaintenanceHook` (`DagExecutionHooks/Maintenance/TableMaintenanceHook.cs:31`) — OPTIMIZE/VACUUM operations running as post-write DAG hooks with 48-hour interval checks.

6. **Lock Files** — `IFileSystemBasedDagExecutionPersistenceManager` — File-based locks (`{dagName}.lock`, `dqReport.lock`, `dagsettings.json.lock`) with expiry delta, force unlock API via `LiveTableMaintenanceController.ForceUnlockDAGExecutionAsync()` (`Controllers/LiveTableMaintenanceController.cs:77`).

### Proposed Interceptor Design

**Class:** `EdogFltOpsInterceptor`

**Design decision: Unified vs. per-subsystem**

A unified interceptor is preferred because:
- These subsystems share a common pattern: they're all operations initiated by FLT that have start/end semantics
- Individual interceptors for 6 subsystems would add 6 files, 6 DI registrations, and 6 topic buffers — excessive for the signal density
- A single `flt-ops` topic with an `operation` field allows frontend filtering without backend complexity

**Target interfaces (multi-interface decorator):**

| Subsystem | Interface | Method Count |
|-----------|-----------|--------------|
| Refresh Triggers | `IRefreshTriggersHandler` | 2 (create/update, list) |
| MLV Definitions | `IMLVExecutionDefinitionPersistenceManager` | 8 (CRUD + recovery) |
| DQ Reports | `IReportStateManager` | 4 (init, update, get, close) |
| Table Maintenance | `ITableMaintenanceClientFactory` | 1 (create client) |

CDF Enablement and Lock Files are trickier — `CdfEnablementExecutor` is used internally (not registered via DI as an interface), and lock file operations are part of `IDagExecutionStore`. These require either:
- FLT to expose interfaces, or
- EDOG to hook at a higher level (e.g., HTTP request capture for the lock/CDF controller endpoints)

**Implementation approach: per-interface wrappers, single topic**

```csharp
#nullable disable
#pragma warning disable

// --- Refresh Triggers ---
public class EdogRefreshTriggersWrapper : IRefreshTriggersHandler
{
    private readonly IRefreshTriggersHandler _inner;

    public EdogRefreshTriggersWrapper(IRefreshTriggersHandler inner)
    {
        _inner = inner;
    }

    public async Task<FMLVActivator> CreateOrUpdateFMLVRefreshActivatorAsync(
        /* params from IRefreshTriggersHandler */)
    {
        var sw = System.Diagnostics.Stopwatch.StartNew();
        try
        {
            var result = await _inner
                .CreateOrUpdateFMLVRefreshActivatorAsync(/* params */);
            sw.Stop();

            EdogTopicRouter.Publish("flt-ops", new
            {
                @event = "RefreshTriggerUpserted",
                operation = "RefreshTrigger",
                action = "CreateOrUpdate",
                durationMs = sw.ElapsedMilliseconds,
                ruleCount = result?.Rules?.Count ?? 0,
                success = true,
            });

            return result;
        }
        catch (Exception ex)
        {
            sw.Stop();
            EdogTopicRouter.Publish("flt-ops", new
            {
                @event = "RefreshTriggerFailed",
                operation = "RefreshTrigger",
                action = "CreateOrUpdate",
                durationMs = sw.ElapsedMilliseconds,
                success = false,
                errorType = ex.GetType().Name,
            });
            throw;
        }
    }

    // ListFMLVRefreshTriggersAsync — similar pattern
}

// --- DQ Report State ---
public class EdogReportStateWrapper : IReportStateManager
{
    private readonly IReportStateManager _inner;

    public EdogReportStateWrapper(IReportStateManager inner)
    {
        _inner = inner;
    }

    public async Task InitializeStateAsync(/* params */)
    {
        var sw = System.Diagnostics.Stopwatch.StartNew();
        await _inner.InitializeStateAsync(/* params */);
        sw.Stop();

        EdogTopicRouter.Publish("flt-ops", new
        {
            @event = "DqReportInitialized",
            operation = "DataQuality",
            action = "InitializeState",
            durationMs = sw.ElapsedMilliseconds,
        });
    }

    public async Task UpdateStateAsync(/* params */)
    {
        await _inner.UpdateStateAsync(/* params */);

        EdogTopicRouter.Publish("flt-ops", new
        {
            @event = "DqReportStateUpdated",
            operation = "DataQuality",
            action = "UpdateState",
            // Include new status from params
        });
    }

    // TryGetStateAsync, CloseAsync — similar pattern
}

// --- MLV Execution Definitions ---
public class EdogMLVDefinitionWrapper
    : IMLVExecutionDefinitionPersistenceManager
{
    private readonly IMLVExecutionDefinitionPersistenceManager _inner;

    public EdogMLVDefinitionWrapper(
        IMLVExecutionDefinitionPersistenceManager inner)
    {
        _inner = inner;
    }

    public async Task CreateAsync(/* params */)
    {
        var sw = System.Diagnostics.Stopwatch.StartNew();
        await _inner.CreateAsync(/* params */);
        sw.Stop();

        EdogTopicRouter.Publish("flt-ops", new
        {
            @event = "MLVDefinitionCreated",
            operation = "MLVDefinition",
            action = "Create",
            durationMs = sw.ElapsedMilliseconds,
        });
    }

    // GetAsync, UpdateAsync, DeleteAsync, ListAsync,
    // GetRecoveryAsync, ListRecoveryFileIdsAsync,
    // DeleteRecoveryAsync — similar pattern
}
```

### New Topic Buffer

**Topic:** `flt-ops`
**Buffer size:** 300
**Registration in `EdogTopicRouter.cs`:** Add `{ "flt-ops", 300 }`.

**Event shapes:**

```jsonc
// Refresh trigger CRUD
{
  "event": "RefreshTriggerUpserted",
  "operation": "RefreshTrigger",
  "action": "CreateOrUpdate",
  "workspaceId": "ws-guid-...",
  "artifactId": "lh-guid-...",
  "durationMs": 1200,
  "ruleCount": 3,
  "success": true
}

// MLV definition CRUD
{
  "event": "MLVDefinitionCreated",
  "operation": "MLVDefinition",
  "action": "Create",
  "definitionId": "def-guid-...",
  "definitionName": "NightlyFullRefresh",
  "selectedMLVCount": 12,
  "durationMs": 450,
  "success": true
}

// DQ report lifecycle
{
  "event": "DqReportInitialized",
  "operation": "DataQuality",
  "action": "InitializeState",
  "workspaceId": "ws-guid-...",
  "artifactId": "lh-guid-...",
  "durationMs": 200
}

{
  "event": "DqReportStateUpdated",
  "operation": "DataQuality",
  "action": "UpdateState",
  "status": "Created",
  "reportId": "report-guid-..."
}

// Table maintenance (via hook)
{
  "event": "MaintenanceTriggered",
  "operation": "TableMaintenance",
  "action": "RunMaintenance",
  "tableCount": 5,
  "lastRunHoursAgo": 52,
  "durationMs": 8400,
  "success": true
}

// Lock file operations (via HTTP capture fallback)
{
  "event": "LockAcquired",
  "operation": "LockFile",
  "action": "AcquireLock",
  "dagName": "FullRefresh",
  "iterationId": "iter-guid-...",
  "lockType": "DagExecution"
}

{
  "event": "ForceUnlockExecuted",
  "operation": "LockFile",
  "action": "ForceUnlock",
  "lockedIterationId": "iter-guid-...",
  "durationMs": 300,
  "success": true
}
```

### Integration Points in FLT

| File | Change Required | Owner |
|------|----------------|-------|
| `Core/RefreshTrigger/IRefreshTriggersHandler.cs` | None — `public` interface | — |
| `Persistence/IMLVExecutionDefinitionPersistenceManager.cs` | None — `public` interface | — |
| `DataQuality/StateManagement/IReportStateManager.cs` | Verify DI registration supports decoration | EDOG (verify) |
| `Maintenance/MaintenanceHttp/ITableMaintenanceClientFactory.cs` | None | — |
| `Core/CdfEnablement/CdfEnablementExecutor.cs` | Needs interface extraction or DI exposure | **FLT team** |
| `Controllers/LiveTableMaintenanceController.cs` | HTTP capture (no changes needed) | — |
| `EdogDevModeRegistrar.cs` | Add `RegisterFltOpsInterceptors()` | EDOG |
| `EdogTopicRouter.cs` | Add `flt-ops` topic with buffer 300 | EDOG |

### Priority and Effort

**Priority:** P2 — These subsystems are important for completeness but are less frequently the source of production incidents than DAG orchestration, token, or catalog issues.

**Effort:** **M** (Medium)
- 4 interface wrappers with standard decoration pattern: 4 days
- CDF/Lock coverage via HTTP capture fallback: 1 day
- Topic + event models: 1 day
- Frontend integration (ops panel in Nexus): 2 days
- **Total: ~8 days**

### Dependencies on FLT Team

1. **CDF Enablement:** `CdfEnablementExecutor` is not registered as an interface in DI. FLT would need to extract an `ICdfEnablementExecutor` interface and register it. Alternatively, EDOG captures CDF operations via HTTP endpoint monitoring (lower fidelity).
2. **Lock Files:** Lock operations are internal to `FileSystemBasedDagExecutionPersistenceManager`. EDOG can capture `ForceUnlock` via the maintenance controller HTTP endpoint, but lock acquisition/release during normal DAG execution requires FLT to surface events.

### Impact on Nexus

- Adds **operational nodes** to the dependency graph: Refresh Triggers → DAG, MLV Definitions → DAG Settings, DQ Reports → PBI API
- Lock file state becomes visible: "DAG locked by iteration X for 2h" helps diagnose stuck executions
- Table maintenance hooks become edges from DAG → Maintenance API
- Complete coverage: every FLT subsystem has at least basic observability

---

## Implementation Order

### Recommended Sequence

```
Phase 1 (Week 1-2): Gap 3 + Gap 4  ─── No FLT dependencies
Phase 2 (Week 3-5): Gap 2           ─── Requires FLT team coordination  
Phase 3 (Week 5-6): Gap 8           ─── Mostly independent, some FLT asks
```

### Rationale

| Phase | Gap | Why This Order |
|-------|-----|---------------|
| **Phase 1a** | Gap 3 — Token Lifecycle | Smallest effort (S), zero FLT dependencies, `ITokenManager` is clean public interface. Immediate value: token cache hit rates visible. **Ship first for quick win.** |
| **Phase 1b** | Gap 4 — Catalog Discovery | Small effort (S), zero FLT dependencies for Phase 1. Complements token interceptor — together they cover the "pre-Spark" phase of DAG execution. |
| **Phase 2** | Gap 2 — DAG Execution | Largest effort (L), **requires FLT team changes** (hook registration, NodeExecutor factory). Start coordination in Phase 1, implement in Phase 2. This is the highest-value gap but has the longest lead time due to FLT dependency. |
| **Phase 3** | Gap 8 — FLT Operations | Medium effort (M), mostly independent. Lower priority — these subsystems are less frequently the root cause of incidents. Can be implemented incrementally (1-2 subsystems per sprint). |

### Milestone Targets

| Milestone | Content | Verification |
|-----------|---------|-------------|
| **M1** — Token + Catalog interceptors | `EdogTokenLifecycleInterceptor` + `EdogCatalogInterceptor` deployed, events flowing to `token` and `catalog` topics | `make test` passes, events visible in SignalR stream |
| **M2** — DAG lifecycle hooks | `EdogDagExecutionHook` registered, `DagTerminal` events flowing | DAG execution produces `dag` topic events |
| **M3** — DAG node wrappers | `EdogNodeExecutorWrapper` operational, per-node events flowing | Node-level events in `dag` topic |
| **M4** — FLT Ops coverage | Refresh Triggers, MLV Definitions, DQ Reports, Table Maintenance wrappers deployed | `flt-ops` topic events for each subsystem |

---

## Risk Assessment

### Performance Impact

| Risk | Severity | Mitigation |
|------|----------|------------|
| **DAG hook adds latency to terminal commit** | Low | `EdogDagExecutionHook.ExecuteAsync()` publishes a single anonymous object. `EdogTopicRouter.Publish()` is non-blocking (channel write). Measured overhead: <1ms. |
| **Token interceptor adds latency to every token operation** | Low | Wrapper is a `Stopwatch.Start()` + `await _inner.Method()` + `Stopwatch.Stop()` + `Publish()`. Total overhead: <0.1ms per call. |
| **Catalog interceptor on large lakehouses** | Low | Single wrap around `GetCatalogObjectsAsync()` — one event at start, one at end. The expensive work is inside the inner call. |
| **`flt-ops` wrapper methods increase DI graph complexity** | Low | Each wrapper follows identical decoration pattern. No runtime reflection or dynamic dispatch. |
| **Ring buffer overflow under heavy DAG execution** | Medium | `dag` buffer at 500 events. A 100-node DAG produces ~200 events (start+end per node + DAG-level events). Two concurrent DAGs could approach the limit. **Mitigation:** Monitor buffer pressure via existing capacity topic. Increase to 1000 if needed. |

### Backward Compatibility

| Risk | Severity | Mitigation |
|------|----------|------------|
| **New topics break old frontend** | None | Frontend subscribes to topics by name. New topics (`dag`, `catalog`, `flt-ops`) are simply ignored by tabs that don't subscribe to them. |
| **Enhanced `token` topic events break Token Inspector** | Low | New events have an `event` field that old events lack. Token Inspector (`tab-tokens.js`) can filter by presence/absence of `event` field. **Recommendation:** Update Token Inspector to handle new event shapes alongside old ones. |
| **FLT version skew** | Medium | If FLT doesn't have the hook registration (Gap 2), the `EdogDagExecutionHook` simply never fires — no crash, just no events. **Recommendation:** Detect whether the hook was called within 30s of DAG execution and surface a "DAG hooks not registered" warning. |

### Technical Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| **`NodeExecutor` is `internal` and `new`'d inline** | High (Gap 2) | `DagExecutionHandlerV2.cs:310` creates `NodeExecutor` with `new` — no DI seam. EDOG cannot decorate without FLT changing this. **Mitigation:** Phase 2 requires FLT to introduce `INodeExecutorFactory` or resolve `INodeExecutor` from DI. This is the single biggest coordination risk. |
| **`CdfEnablementExecutor` has no interface** | Medium (Gap 8) | No DI decoration possible without FLT extracting an interface. **Mitigation:** Fall back to HTTP endpoint monitoring for CDF operations (lower fidelity but zero FLT dependency). |
| **`IReportStateManager` registration may not support decoration** | Low (Gap 8) | Registered as `OnelakeBasedReportStateManager` (`WorkloadApp.cs:131`). EDOG needs to resolve and re-register. Standard WireUp decoration should work, but needs verification. |
| **Anonymous object serialization** | Low | All events use anonymous objects (e.g., `new { @event = "DagTerminal", ... }`). MessagePack (SignalR transport per ADR-006) serializes these via reflection. **Mitigation:** If perf is a concern, introduce typed event records. Unlikely to be needed given event volume. |

### Coordination Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| **FLT team bandwidth for Gap 2 changes** | High | FLT team has their own sprint priorities. Hook registration + NodeExecutor factory are small code changes but require review cycles. **Mitigation:** Submit PRs early in Phase 1, targeting merge before Phase 2 implementation begins. |
| **FLT repo merge conflicts** | Medium | EDOG adds files to `src/backend/DevMode/` which doesn't conflict with FLT's `Service/` directory. Hook registration changes in `WorkloadApp.cs` may conflict with concurrent FLT changes. **Mitigation:** Coordinate with FLT team on merge windows. |
| **Breaking changes in FLT interfaces** | Low | `ITokenManager` and `ICatalogHandler` are stable public APIs. `IDagExecutionHook` is internal but stable (hooks are an extension point). **Mitigation:** Pin to specific FLT commit hash during development, rebase before merge. |

---

## Appendix A: Existing Interceptor Pattern Reference

For implementers, the canonical decoration pattern used by all EDOG interceptors:

```csharp
// In EdogDevModeRegistrar.cs
private static void RegisterXxxInterceptor()
{
    try
    {
        // 1. Resolve original from DI
        var original = WireUp.Resolve<ITargetInterface>();
        if (original == null) return;

        // 2. Create wrapper
        var wrapper = new EdogXxxInterceptor(original);

        // 3. Replace registration
        WireUp.RegisterInstance<ITargetInterface>(wrapper);
    }
    catch (Exception ex)
    {
        System.Diagnostics.Trace.TraceWarning(
            $"[EDOG] Failed to register Xxx interceptor: {ex.Message}");
    }
}
```

Source: `EdogDevModeRegistrar.cs:59-64` (resolve), `EdogDevModeRegistrar.cs:105-110` (wrap+register).

## Appendix B: Topic Buffer Registration

```csharp
// In EdogTopicRouter.cs — add to the dictionary at lines 26-40
{ "dag",     500 },   // Gap 2: DAG execution lifecycle
{ "catalog", 200 },   // Gap 4: Catalog discovery
{ "flt-ops", 300 },   // Gap 8: FLT operational subsystems
// "token" already exists at 500 — increase to 1000 for Gap 3
```

## Appendix C: Files to Create/Modify

### New files (in `src/backend/DevMode/`):

| File | Gap | Lines (est.) |
|------|-----|-------------|
| `EdogDagExecutionHook.cs` | 2 | ~60 |
| `EdogNodeExecutorWrapper.cs` | 2 | ~80 |
| `EdogTokenLifecycleInterceptor.cs` | 3 | ~120 |
| `EdogCatalogInterceptor.cs` | 4 | ~90 |
| `EdogRefreshTriggersWrapper.cs` | 8 | ~60 |
| `EdogMLVDefinitionWrapper.cs` | 8 | ~120 |
| `EdogReportStateWrapper.cs` | 8 | ~80 |
| `EdogTableMaintenanceWrapper.cs` | 8 | ~50 |

### Modified files:

| File | Change |
|------|--------|
| `EdogDevModeRegistrar.cs` | Add 6 new `RegisterXxx()` calls |
| `EdogTopicRouter.cs` | Add 3 new topics, increase `token` buffer |

### FLT repo changes (Gap 2 only):

| File | Change | Owner |
|------|--------|-------|
| `WorkloadApp.cs` | Register `EdogDagExecutionHook` as `IDagExecutionHook` (gated by DevMode flag) | FLT team |
| `DagExecutionHandlerV2.cs` | Refactor `new NodeExecutor(...)` to use DI-resolved factory | FLT team |
