# Phase 2: C# Interceptors — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan. Each interceptor is an independent task.

**Goal:** Build 9 interceptors that dynamically capture ALL runtime data from FLT and broadcast via SignalR to the EDOG Playground frontend. Zero hardcoding — any new service, cache, flag, or HTTP client added to FLT is automatically detected.

**Architecture:** Each interceptor wraps an FLT interface (decorator pattern, DelegatingHandler, or callback hook), captures operation data, and broadcasts via `EdogLogServer.hubContext.Clients.Group(topic).SendAsync()`. All interceptors are registered through a single `EdogDevModeRegistrar.cs` entry point, conditional on EDOG dev mode.

**CEO Mandate:** Future-proof. Zero hardcoding. If someone adds a new cache, flag, HTTP client, or service — it auto-detects. No maintenance needed.

---

## FLT Data Audit Findings (Verified)

| # | Data Source | FLT Interface | Pattern | Risk | Named Clients/Instances |
|---|---|---|---|---|---|
| 1 | Feature Flags | `IFeatureFlighter` | Decorator | LOW | 1 (FeatureFlighter) |
| 2 | Perf Markers | `IServiceMonitoringCallback` | Replace callback | LOW | 1 (LiveTableServiceMonitoringCallback) |
| 3 | Tokens | `ITokenProvider` + DelegatingHandler | Handler chain | LOW | 6 named HttpClients, 3 token providers |
| 4 | System Files | `IFileSystem` via `IFileSystemFactory` | Factory decorator | LOW | 1 (OnelakeFileSystemFactory) |
| 5 | HTTP Pipeline | `DelegatingHandler` chain | Handler insertion | LOW | 4 existing handlers, 6 clients |
| 6 | Retries | `IRetryStrategy<T>` + `RetryExecutor` | Strategy wrapper | LOW | 2 strategies (Standard + Capacity) |
| 7 | Caches | `ISqlEndpointMetadataCache` + pattern scan | Decorator + discovery | MEDIUM | 2 known + auto-detect others |
| 8 | Spark Sessions | `ISparkClientFactory` | Factory wrapper | MEDIUM | 1 factory, N clients per iteration |
| 9 | DI Registry | `WireUp` static methods | Method hook | MEDIUM | 30+ registrations |

---

## Future-Proof Architecture

### Dynamic Discovery Principle

Every interceptor MUST auto-detect new instances. The approach per interceptor:

| Interceptor | How It Auto-Detects |
|---|---|
| **Feature Flags** | Wraps single `IFeatureFlighter.IsEnabled()` — any flag name auto-captured |
| **Perf Markers** | Replaces `IServiceMonitoringCallback` — any CodeMarker scope auto-captured |
| **Tokens** | Wraps `ITokenProvider` — any token provider auto-captured. Plus DelegatingHandler captures all auth headers on ALL HttpClients |
| **System Files** | Wraps `IFileSystemFactory` — any filesystem instance created through factory auto-captured |
| **HTTP Pipeline** | Wraps `IHttpClientFactory` (returned by `HttpClientFactoryRegistry`) — ALL named HttpClients auto-get our handler. New clients auto-included |
| **Retries** | Wraps `RetryExecutor<T>` constructor or hooks `RetryPolicyProviderV2` — any new retry strategy auto-captured |
| **Caches** | Hook `WireUp.RegisterSingletonType()` and detect any registration implementing Get/Set/Evict patterns (via interface detection at registration time) |
| **Spark Sessions** | Wraps `ISparkClientFactory.CreateSparkClientAsync()` — any new Spark client auto-captured |
| **DI Registry** | Hook `WireUp.RegisterSingletonType()`, `RegisterInstance()`, `RegisterType()` — every registration auto-captured at runtime |

### Safety Rule (Non-Negotiable)

Every interceptor broadcast MUST be wrapped:
```csharp
try { await hubContext.Clients.Group(topic).SendAsync(method, data); }
catch { /* swallow — NEVER fail FLT code for debug tooling */ }
```

### Single Entry Point

All interceptors register through `EdogDevModeRegistrar.cs`:
```csharp
public static class EdogDevModeRegistrar
{
    public static void RegisterAll(EdogLogServer server)
    {
        // Called from WorkloadApp.cs RunAsync() callback
        // Replaces/wraps DI registrations for all 9 interceptors
        // Conditional: only runs when EDOG_DEV_MODE env var is set
    }
}
```

---

## File Map

```
src/backend/DevMode/
├── EdogDevModeRegistrar.cs          ← CREATE: single entry point for all interceptor DI
├── EdogPlaygroundHub.cs             ← EXISTS (Phase 1)
├── EdogLogServer.cs                 ← EXISTS (Phase 1, add new SendAsync methods per topic)
├── EdogLogModels.cs                 ← MODIFY: add models for all 11 event types
├── Interceptors/
│   ├── EdogFeatureFlighterWrapper.cs    ← CREATE: IFeatureFlighter decorator
│   ├── EdogPerfMarkerCallback.cs        ← CREATE: IServiceMonitoringCallback replacement
│   ├── EdogTokenInterceptor.cs          ← CREATE: DelegatingHandler for auth capture
│   ├── EdogFileSystemInterceptor.cs     ← CREATE: IFileSystem decorator via factory
│   ├── EdogHttpPipelineHandler.cs       ← CREATE: DelegatingHandler for all HTTP
│   ├── EdogRetryInterceptor.cs          ← CREATE: RetryExecutor wrapper
│   ├── EdogCacheInterceptor.cs          ← CREATE: ISqlEndpointMetadataCache decorator + discovery
│   ├── EdogSparkSessionInterceptor.cs   ← CREATE: ISparkClientFactory wrapper
│   └── EdogDiRegistryCapture.cs         ← CREATE: WireUp hook for DI enumeration
├── EdogLogInterceptor.cs            ← EXISTS (unchanged)
├── EdogTelemetryInterceptor.cs      ← EXISTS (unchanged)
├── EdogApiProxy.cs                  ← EXISTS (unchanged)
└── .editorconfig                    ← EXISTS
```

---

## Implementation Order (Simplest → Most Complex)

### Task 2.1: EdogDevModeRegistrar + EdogLogModels expansion

**Create the orchestrator + event models first.** Every subsequent interceptor just adds itself here.

- `EdogDevModeRegistrar.cs` — single static class, `RegisterAll(EdogLogServer server)` method
- `EdogLogModels.cs` — add event models: `FeatureFlagEvalEvent`, `PerfMarkerEvent`, `TokenEvent`, `FileOperationEvent`, `HttpRequestEvent`, `RetryEvent`, `CacheEvent`, `SparkSessionEvent`, `DiRegistrationEvent`
- Each model: timestamp, topic-specific fields, iterationId where applicable
- `EdogLogServer.cs` — add `BroadcastToGroup(string topic, string method, object data)` helper that wraps try/catch

### Task 2.2: EdogFeatureFlighterWrapper (Simplest)

**Intercept:** `IFeatureFlighter.IsEnabled(featureName, tenantId?, capacityId?, workspaceId?)`
**Pattern:** Decorator — wrap original, call through, capture result
**DI:** Replace `WireUp.RegisterSingletonType<IFeatureFlighter, FeatureFlighter>()` with wrapper
**SignalR topic:** `flag`
**Event:** `{ flagName, tenantId, capacityId, workspaceId, result: bool, timestamp, durationMs }`
**Auto-detect:** Any new flag name appears automatically — we capture the method args

### Task 2.3: EdogPerfMarkerCallback

**Intercept:** `IServiceMonitoringCallback` — called by every `MonitoredCodeMarker.CreateScope()` completion
**Pattern:** Replace callback — our callback captures all scope completions
**DI:** Replace `WireUp.RegisterSingletonType<IServiceMonitoringCallback, LiveTableServiceMonitoringCallback>()` with our wrapper that chains to the original
**SignalR topic:** `perf`
**Event:** `{ operationName, durationMs, result (Success/Failure), dimensions, correlationId, timestamp }`
**Auto-detect:** Any new CodeMarker subclass auto-captured — callback is global

### Task 2.4: EdogTokenInterceptor

**Intercept:** Auth headers on ALL HttpClient requests
**Pattern:** Custom DelegatingHandler inserted into the HttpClient pipeline
**DI:** Wrap the `IHttpClientFactory` returned by `HttpClientFactoryRegistry.CreateHttpClientFactoryWithNamedClients()` — this wraps ALL named clients automatically
**SignalR topic:** `token`
**Event:** `{ tokenType, scheme, audience (from JWT aud claim), expiryUtc, issuedUtc, httpClientName, endpoint, timestamp }`
**Auto-detect:** Wrapping `IHttpClientFactory` means ANY named client (existing or future) gets our handler. Zero per-client registration.

### Task 2.5: EdogFileSystemInterceptor

**Intercept:** All `IFileSystem` method calls (Read, Write, Delete, List, Metadata, Exists)
**Pattern:** Decorator wrapping `IFileSystemFactory` — all filesystem instances created through factory get our wrapper
**DI:** Replace `WireUp.RegisterSingletonType<IFileSystemFactory, OnelakeFileSystemFactory>()` with our wrapping factory
**SignalR topic:** `fileop`
**Event:** `{ operation (Read/Write/Delete/List/Exists), path, contentSizeBytes, durationMs, hasContent, ttl, iterationId, timestamp }`
**Auto-detect:** Factory wrapping means any new IFileSystem usage through the factory is auto-captured. Content size computed from string.Length or byte[].Length.

### Task 2.6: EdogHttpPipelineHandler

**Intercept:** All outbound HTTP requests through all named HttpClients
**Pattern:** DelegatingHandler added to the pipeline via the IHttpClientFactory wrapper (from Task 2.4)
**SignalR topic:** `http`
**Event:** `{ method, url, statusCode, durationMs, requestHeaders, responseHeaders, responseBodyPreview (first 4KB), retryCount, correlationId, httpClientName, timestamp }`
**Auto-detect:** Same IHttpClientFactory wrapper as tokens — all clients covered. Response body: copy stream, read first 4KB, reset position.

Note: Tasks 2.4 and 2.6 share the same `IHttpClientFactory` wrapper. Token extraction and HTTP pipeline capture are two aspects of the same DelegatingHandler — or two separate handlers in the chain.

### Task 2.7: EdogRetryInterceptor

**Intercept:** All retry operations through `RetryPolicyProviderV2`
**Pattern:** Wrap `RetryPolicyProviderV2` — it creates `RetryExecutor<T>` instances. Our wrapper intercepts executor creation to track all retries.
**DI:** Replace `WireUp.RegisterSingletonType<RetryPolicyProviderV2>()` with wrapper
**SignalR topic:** `retry`
**Event:** `{ endpoint, statusCode, retryAttempt, totalAttempts, waitDurationMs, strategyName (Standard/Capacity), reason, isThrottle (429/430), retryAfterMs, iterationId, timestamp }`
**Auto-detect:** Wrapping the provider means any new retry strategy registered through it is auto-captured.

### Task 2.8: EdogCacheInterceptor

**Intercept:** `ISqlEndpointMetadataCache` (primary cache) + any other cache-like registrations
**Pattern:** Decorator for known caches + dynamic discovery via WireUp hook (from Task 2.9)
**DI:** Replace `WireUp.RegisterSingletonType<ISqlEndpointMetadataCache, SqlEndpointMetadataCache>()` with decorator
**SignalR topic:** `cache`
**Event:** `{ cacheName, operation (Get/Set/Evict), key, hitOrMiss, valueSizeBytes, ttlSeconds, evictionReason, durationMs, timestamp }`
**Auto-detect:** The DI hook (Task 2.9) scans all registrations for cache-like interfaces (anything with Get/Set/Evict or GetOrResolve methods). Those get auto-wrapped too.

### Task 2.9: EdogDiRegistryCapture + EdogSparkSessionInterceptor

**DI Registry:**
**Intercept:** All `WireUp.RegisterSingletonType()`, `RegisterInstance()`, `RegisterType()` calls
**Pattern:** Our registrar runs AFTER all FLT registrations in WorkloadApp constructor. It queries the container to enumerate what's registered. For the RunAsync late registrations, we capture them via our position in the callback chain.
**SignalR topic:** `di`
**Event:** `{ serviceType, implementationType, lifetime, isEdogIntercepted, registrationSource, timestamp }`
**Approach:** After all FLT registrations complete, enumerate by reflecting on the WireUp container's internal state, or by maintaining our own registry in EdogDevModeRegistrar (since we wrap several types, we know what's registered).

**Spark Sessions:**
**Intercept:** `ISparkClientFactory.CreateSparkClientAsync()`
**Pattern:** Factory wrapper — intercept creation, track lifecycle
**DI:** Replace `WireUp.RegisterSingletonType<ISparkClientFactory, GTSBasedSparkClientFactory>()` with wrapper
**SignalR topic:** `spark`
**Event:** `{ sessionTrackingId (generated), tenantId, workspaceId, artifactId, iterationId, status (Created/Active/Disposed/Error), durationMs, tokenType, timestamp }`
**Auto-detect:** Factory wrapping captures all Spark client creation. No hardcoded session types.

---

## Registration in WorkloadApp.cs (Patch Strategy)

The existing patch replaces the telemetry reporter registration. For Phase 2, we extend the WorkloadApp.cs patch to call `EdogDevModeRegistrar.RegisterAll()` AFTER all standard FLT registrations:

```csharp
// EDOG DevMode - Register all runtime interceptors
var edogServer = WireUp.Resolve<Microsoft.LiveTable.Service.DevMode.EdogLogServer>();
Microsoft.LiveTable.Service.DevMode.EdogDevModeRegistrar.RegisterAll(edogServer);
```

This single line replaces/wraps 9 DI registrations. The registrar handles all the DI swaps internally.

---

## edog.py Changes

1. Add all new `.cs` files to `DEVMODE_FILES` dict
2. Add `EdogDevModeRegistrar.RegisterAll()` call to the WorkloadApp.cs patch
3. Update revert to clean up the new registration line

---

## Completion Criteria

Per interceptor:
- [ ] C# file created in `src/backend/DevMode/Interceptors/`
- [ ] Registered in `EdogDevModeRegistrar.RegisterAll()`
- [ ] Broadcasts via SignalR to correct topic group
- [ ] try/catch around every broadcast (never fails FLT)
- [ ] Auto-detects new instances (zero hardcoding)
- [ ] Added to `DEVMODE_FILES` in `edog.py`
- [ ] Builds cleanly with FLT (`dotnet build` passes)
- [ ] Verified via agent-browser: data flows to frontend

Overall:
- [ ] `make test` passes (85+ tests)
- [ ] `make build` passes (HTML under 800KB)
- [ ] All 9 interceptors broadcast to their SignalR topic
- [ ] FLT service runs normally with interceptors active
- [ ] No performance degradation (<1ms per interceptor call)
