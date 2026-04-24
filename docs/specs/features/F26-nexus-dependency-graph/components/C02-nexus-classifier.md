# C02 — Nexus Classifier: Component Deep Spec

> **Component:** EdogNexusClassifier (URL/topic → canonical dependency ID mapping)
> **Feature:** F26 — Nexus: Real-Time Cross-Workload Dependency Graph
> **File:** `src/backend/DevMode/EdogNexusClassifier.cs` (new)
> **Owner:** Vex (C# backend)
> **Complexity:** MEDIUM
> **Depends On:** C01 Nexus Models (`EdogNexusModels.cs` — `NormalizedDependencyEvent`, `DependencyId` constants)
> **Consumed By:** C03 Nexus Aggregator (`EdogNexusAggregator.cs`)
> **Priority:** P1 (blocks aggregator — classifier is the first stage in the pipeline)
> **Status:** P1 — DRAFT
> **Last Updated:** 2025-07-25

---

## Table of Contents

1. [Overview](#1-overview)
2. [Canonical Dependency IDs](#2-canonical-dependency-ids)
3. [Class Design & API Surface](#3-class-design--api-surface)
4. [Scenarios](#4-scenarios)
   - [S01 — HTTP URL Classification](#s01--http-url-classification)
   - [S02 — Topic-Based Classification](#s02--topic-based-classification)
   - [S03 — Unknown Fallback & Signature Tracking](#s03--unknown-fallback--signature-tracking)
   - [S04 — Ambiguous URL Resolution](#s04--ambiguous-url-resolution)
   - [S05 — Classification Rule Extensibility](#s05--classification-rule-extensibility)
   - [S06 — Performance](#s06--performance)
   - [S07 — Filesystem Filtering](#s07--filesystem-filtering)
   - [S08 — Error Code Classification](#s08--error-code-classification)
   - [S09 — GTS Polling Phase Detection](#s09--gts-polling-phase-detection)
5. [URL Pattern Table](#5-url-pattern-table)
6. [State Machine](#6-state-machine)
7. [Security](#7-security)
8. [Error Handling](#8-error-handling)
9. [Testing Strategy](#9-testing-strategy)
10. [Implementation Notes](#10-implementation-notes)

---

## 1. Overview

### 1.1 Purpose

EdogNexusClassifier is a **pure, stateless function** that maps raw topic events into canonical dependency IDs. It is the first stage of the Nexus pipeline: every event published to `http`, `token`, `spark`, `retry`, `cache`, or `fileop` topics flows through the classifier before reaching the aggregator.

The classifier's job is deterministic: given an event's topic name, URL, and `httpClientName`, it returns exactly one `DependencyId` string. No side effects, no I/O, no shared mutable state.

### 1.2 Component Boundaries

**EdogNexusClassifier owns:**
- URL pattern matching for `http` topic events → dependency IDs
- HTTP status code–based classification override (430 → `capacity`, pre-URL)
- Throttle detection for HTTP 429/430 responses (`IsThrottled`, `ThrottleType`)
- GTS polling phase detection for `spark-gts` events (`EndpointHint` = `gts:submit`/`gts:poll`/`gts:result`)
- Error code extraction from `responseBodyPreview` for HTTP error responses (S08)
- Topic-name-based classification for non-HTTP topics (`token`, `spark`, `cache`, `fileop`)
- The `unknown` fallback path with URL signature extraction
- Priority resolution when a URL matches multiple patterns
- The `isInternal` flag for filesystem dependency events

**EdogNexusClassifier does NOT own:**
- Subscribing to topic streams — owned by C03 Aggregator
- Aggregating metrics (p50/p95, error rates) — owned by C03 Aggregator
- Publishing to the `nexus` topic — owned by C03 Aggregator
- Defining DTO shapes — owned by C01 Models
- Anomaly detection or baseline tracking — owned by C03 Aggregator

### 1.3 Relationship to Other Components

| Direction | Component | Channel | Data |
|-----------|-----------|---------|------|
| C01 → C02 | Models → Classifier | Compile-time reference | `DependencyId` constants, `NormalizedDependencyEvent` DTO, `NexusErrorClassification` |
| C02 → C03 | Classifier → Aggregator | `Classify()` return value | `ClassificationResult { DependencyId, EndpointHint, IsInternal, IsThrottled, ThrottleType }` |
| Topics → C02 | TopicRouter events → Classifier | Method argument | Raw event `object` from `TopicEvent.Data` |

---

## 2. Canonical Dependency IDs

From the approved design spec (`docs/superpowers/specs/2026-04-24-nexus-design.md:91-101`):

| ID | Description | Source Topics |
|----|-------------|---------------|
| `spark-gts` | Spark sessions via GTS (Livy) | `http` (URL match), `spark` (topic) |
| `fabric-api` | Fabric public REST APIs | `http` (URL match) |
| `platform-api` | FLT service APIs via capacity relay host | `http` (URL match) |
| `auth` | Token acquisition (AAD/Entra/MWC) | `token` (topic), `http` (URL match) |
| `capacity` | Capacity management APIs (HTTP 430 or URL match) | `http` (status code 430 or URL match) |
| `cache` | Cache operations | `cache` (topic) |
| `retry-system` | Retry telemetry (enrichment) | `retry` (topic) |
| `filesystem` | File I/O via OneLake | `fileop` (topic) |
| `unknown` | Unmatched HTTP events | `http` (fallback) |

---

## 3. Class Design & API Surface

```csharp
/// <summary>
/// Pure classifier: maps raw topic events to canonical dependency IDs.
/// Stateless — safe to call from any thread without synchronization.
/// </summary>
public static class EdogNexusClassifier
{
    /// <summary>
    /// Classifies an event from any topic into a canonical dependency.
    /// </summary>
    /// <param name="topic">Source topic name ("http", "token", "spark", etc.).</param>
    /// <param name="eventData">Raw event payload from TopicEvent.Data.</param>
    /// <returns>Classification result with dependency ID, endpoint hint, and internal flag.</returns>
    public static ClassificationResult Classify(string topic, object eventData);

    /// <summary>
    /// Extracts a normalized URL signature for unknown-bucket tracking.
    /// Replaces GUIDs and numeric IDs with placeholders.
    /// Example: "/v1/workspaces/{id}/items/{id}" from a real URL.
    /// </summary>
    internal static string ExtractUrlSignature(string url);
}

/// <summary>
/// Result of classifying a single event.
/// </summary>
public readonly struct ClassificationResult
{
    public string DependencyId { get; init; }
    public string EndpointHint { get; init; }
    public bool IsInternal { get; init; }
    public bool IsThrottled { get; init; }
    public string ThrottleType { get; init; }
}
```

---

## 4. Scenarios

### S01 — HTTP URL Classification

**Trigger:** An event arrives on the `http` topic. `EdogNexusAggregator` calls `Classify("http", eventData)`.

**Expected behavior:** The classifier extracts the `url` field from the event, tests it against an ordered list of regex patterns, and returns the first matching `DependencyId`.

**Technical mechanism (C# pseudocode with actual URL patterns from codebase):**

```csharp
// URL patterns derived from real codebase URLs:
//
// 1. Spark/GTS — Livy session management
//    Source: filters.js:132 Spark preset includes /Livy/i, /Session/i, /Transform/i
//    Source: spec.md:97 "*/spark/*, */livysessions/*"
private static readonly Regex SparkGtsPattern = new(
    @"/(livy|livysessions|spark|sparkSessions)/",
    RegexOptions.Compiled | RegexOptions.IgnoreCase);

// 2. Platform APIs via capacity relay host (FLT service endpoints)
//    Source: EdogApiProxy.cs:92 BuildBaseUrl() constructs:
//    "https://{capId}.pbidedicated.windows-int.net/webapi/capacities/{capId}/workloads/..."
//    Paths: /liveTable/*, /liveTableSchedule/*
//    Source: api-client.js:402 '/liveTable/getLatestDag'
//    Source: api-client.js:407 '/liveTableSchedule/runDAG/{iterationId}'
//    Source: api-client.js:412 '/liveTableSchedule/cancelDAG/{iterationId}'
private static readonly Regex PlatformApiPattern = new(
    @"(pbidedicated|powerbi-df).*/(webapi|liveTable|liveTableSchedule)/",
    RegexOptions.Compiled | RegexOptions.IgnoreCase);

// 3. Capacity management
//    Source: spec.md:98 "*/capacities/*"
//    Source: EdogApiProxy.cs:92 URL path contains "/capacities/{capId}/"
private static readonly Regex CapacityPattern = new(
    @"/capacities/[0-9a-fA-F-]+/(workloads|)",
    RegexOptions.Compiled | RegexOptions.IgnoreCase);

// 4. Auth / token endpoints
//    Source: spec.md:98 "*/generatemwctoken, */token"
//    Source: EdogTokenInterceptor.cs:63-72 token topic emits endpoint as PathAndQuery
private static readonly Regex AuthPattern = new(
    @"/(generatemwctoken|oauth2/v2\.0/token|token)(\?|$|/)",
    RegexOptions.Compiled | RegexOptions.IgnoreCase);

// 5. Fabric public REST APIs
//    Source: api-client.js:80 '/workspaces?$top=100'
//    Source: api-client.js:88 '/workspaces/{id}/lakehouses'
//    Source: api-client.js:92 '/workspaces/{id}/lakehouses/{id}/tables'
//    Source: api-client.js:395 '/workspaces/{id}/environments'
//    Host: api.fabric.microsoft.com
private static readonly Regex FabricApiPattern = new(
    @"(api\.fabric\.microsoft\.com|/api/fabric)/(v1/)?(workspaces|lakehouses|notebooks|environments|items)",
    RegexOptions.Compiled | RegexOptions.IgnoreCase);

// 6. Notebook execution (Jupyter/Livy sessions for notebooks)
//    Source: api-client.js:332 '/api/notebook/create-session'
//    Source: api-client.js:355 '/api/notebook/execute-cell'
//    Source: EdogRetryInterceptor.cs:60-62 NotebookRetryRegex matches notebook retry patterns
//    Notebooks are a sub-category of spark-gts (same GTS backend)
private static readonly Regex NotebookPattern = new(
    @"/(notebooks?|jupyter)/",
    RegexOptions.Compiled | RegexOptions.IgnoreCase);
```

**Classification evaluation order (first match wins):**

```csharp
private static readonly (Regex Pattern, string DependencyId)[] UrlRules =
{
    // Order matters — more specific patterns first
    (AuthPattern,       "auth"),         // Token endpoints before general platform
    (SparkGtsPattern,   "spark-gts"),    // Spark/Livy before general platform
    (NotebookPattern,   "spark-gts"),    // Notebooks route to spark-gts (same backend)
    (PlatformApiPattern,"platform-api"), // Capacity host relay endpoints
    (CapacityPattern,   "capacity"),     // Capacity management (subset of platform host)
    (FabricApiPattern,  "fabric-api"),   // Fabric public REST
};

public static ClassificationResult Classify(string topic, object eventData)
{
    if (topic == "http")
        return ClassifyHttp(eventData);

    return ClassifyByTopic(topic, eventData);
}

private static ClassificationResult ClassifyHttp(object eventData)
{
    var url = ExtractField(eventData, "url") ?? string.Empty;
    var statusCode = ExtractIntField(eventData, "statusCode");
    var method = ExtractField(eventData, "method") ?? string.Empty;
    var endpointHint = ExtractPathOnly(url);

    // ── PRIORITY 0: HTTP 430 = capacity throttling (before URL patterns) ──
    // HTTP 430 is FLT's canonical "Spark Job Capacity Throttling" signal.
    // When GTS returns 430, it means the capacity management system rejected
    // the request — regardless of what URL was called. This takes precedence
    // over URL-based classification because the capacity topic buffer
    // (EdogTopicRouter.cs:39) is empty in V1; 430 is the only capacity signal.
    if (statusCode == 430)
    {
        return new ClassificationResult
        {
            DependencyId = "capacity",
            EndpointHint = endpointHint,
            IsInternal = false,
            IsThrottled = true,
            ThrottleType = "capacity-430",
        };
    }

    // ── URL pattern matching (first match wins) ──
    foreach (var (pattern, depId) in UrlRules)
    {
        if (pattern.IsMatch(url))
        {
            var result = new ClassificationResult
            {
                DependencyId = depId,
                EndpointHint = endpointHint,
                IsInternal = false,
            };

            // Enrich with throttle info for 429 (rate limiting on any dependency)
            if (statusCode == 429)
            {
                result = result with
                {
                    IsThrottled = true,
                    ThrottleType = "rate-limit-429",
                };
            }

            // Enrich spark-gts events with GTS polling phase detection
            if (depId == "spark-gts")
            {
                result = result with
                {
                    EndpointHint = DeriveGtsPhaseHint(method, url, endpointHint),
                };
            }

            return result;
        }
    }

    // No match — falls to unknown
    return new ClassificationResult
    {
        DependencyId = "unknown",
        EndpointHint = ExtractUrlSignature(url),
        IsInternal = false,
        IsThrottled = statusCode == 429,
        ThrottleType = statusCode == 429 ? "rate-limit-429" : null,
    };
}

// ── GTS polling phase detection (Gap 5) ──
// After submitting a Spark transform, FLT polls for completion via repeated
// GET requests. The polling loop can run for minutes. Phase detection enables
// the aggregator to track: polling count per transform, average polling
// interval, and total polling duration.
//
// FLT's GTS interaction pattern:
//   POST /transforms/ (submit job) → returns transformId
//   GET  /transforms/{id} (poll status) × N times
//   GET  /transforms/{id}/result (fetch result)
//
// Source: EdogHttpPipelineHandler.cs:50,69 (method + url fields)

private static readonly Regex GtsResultPattern = new(
    @"/(transforms|livysessions)/[^/]+/result",
    RegexOptions.Compiled | RegexOptions.IgnoreCase);

private static readonly Regex GtsPollPattern = new(
    @"/(transforms|livysessions)/[0-9a-fA-F-]+(/statements/\d+)?$",
    RegexOptions.Compiled | RegexOptions.IgnoreCase);

private static string DeriveGtsPhaseHint(string method, string url, string defaultHint)
{
    var upperMethod = method?.ToUpperInvariant();

    // POST/PUT to /transforms/ or /livysessions/ = submit
    if (upperMethod is "POST" or "PUT")
        return "gts:submit";

    if (upperMethod == "GET")
    {
        // GET /transforms/{id}/result = result fetch
        if (GtsResultPattern.IsMatch(url))
            return "gts:result";

        // GET /transforms/{id} (status poll)
        if (GtsPollPattern.IsMatch(url))
            return "gts:poll";
    }

    return defaultHint;
}
```

**Source code paths:**
- URL captured: `src/backend/DevMode/EdogHttpPipelineHandler.cs:51` (RedactUrl of request URI)
- URL published: `src/backend/DevMode/EdogHttpPipelineHandler.cs:69` (url field in http topic event)
- Relay base URL: `src/backend/DevMode/EdogApiProxy.cs:92` (BuildBaseUrl with pbidedicated host)
- Fabric API paths: `src/frontend/js/api-client.js:80-92` (workspaces, lakehouses, tables)
- FLT service paths: `src/frontend/js/api-client.js:402-412` (liveTable, liveTableSchedule)
- Spark filter patterns: `src/frontend/js/filters.js:132` (Spark/GTS/Livy/Session/Transform)

**Edge cases:**
1. URL is `null` or empty → classify as `unknown` with empty endpoint hint
2. URL contains SAS tokens already redacted (`sig=[redacted]`) → regex must tolerate query params
3. URL contains both `/capacities/` and `/liveTable/` → `platform-api` wins (PlatformApiPattern tested before CapacityPattern)
4. Localhost URLs from EDOG dev server (e.g., `http://localhost:5555/api/...`) → `unknown` (intentional: these are EDOG-internal, not FLT dependencies)
5. HTTP 430 from a Spark/Livy URL → classified as `capacity` (NOT `spark-gts`), because 430 takes precedence over URL patterns. The capacity management system rejected the request.
6. HTTP 429 from any URL → dependency ID is NOT overridden (URL match preserved), but `IsThrottled = true`, `ThrottleType = "rate-limit-429"`. Rate limiting can happen on any dependency.
7. HTTP 430 + URL matches nothing → still classified as `capacity` (430 always wins)
8. GTS polling detection: POST to `/livysessions/` → `"gts:submit"`, repeated GETs to same URL → `"gts:poll"`, final GET with `/result` → `"gts:result"`

**Interactions:**
- HTTP events already have SAS redaction from `EdogHttpPipelineHandler.RedactUrl()` — classifier receives clean URLs
- `httpClientName` field available as secondary signal but NOT used for V1 classification (URL-only keeps rules auditable)

**Revert mechanism:** Classifier is pure and stateless — removing or replacing the class has no persistent side effects. The aggregator falls back to treating all events as `unknown` if the classifier is absent.

**Priority:** P1 — blocks C03 aggregator.

---

### S02 — Topic-Based Classification

**Trigger:** An event arrives on a non-HTTP topic (`token`, `spark`, `cache`, `fileop`). `EdogNexusAggregator` calls `Classify("token", eventData)`.

**Expected behavior:** The classifier maps the topic name directly to a canonical dependency ID. No URL matching needed — the topic itself is the classification signal.

**Technical mechanism:**

```csharp
private static ClassificationResult ClassifyByTopic(string topic, object eventData)
{
    var (depId, isInternal) = topic switch
    {
        "token"  => ("auth",         false),
        "spark"  => ("spark-gts",    false),
        "cache"  => ("cache",        false),
        "retry"  => ("retry-system", false),
        "fileop" => ("filesystem",   true),  // Internal by default
        _        => ("unknown",      false),
    };

    return new ClassificationResult
    {
        DependencyId = depId,
        EndpointHint = ExtractTopicHint(topic, eventData),
        IsInternal = isInternal,
    };
}

private static string ExtractTopicHint(string topic, object eventData)
{
    return topic switch
    {
        "token" => ExtractField(eventData, "endpoint") ?? "token-acquisition",
        "spark" => ExtractField(eventData, "sessionTrackingId") ?? "spark-session",
        "cache" => ExtractField(eventData, "cacheName") ?? "cache-op",
        "retry" => ExtractField(eventData, "endpoint") ?? "retry",
        "fileop" => ExtractField(eventData, "operation") + ":" +
                    TruncatePath(ExtractField(eventData, "path")),
        _ => topic,
    };
}
```

**Source code paths:**
- Token event shape: `src/backend/DevMode/EdogTokenInterceptor.cs:63-72` (tokenType, scheme, audience, endpoint)
- Spark event shape: `src/backend/DevMode/EdogSparkSessionInterceptor.cs:67-79,86-98` (sessionTrackingId, event, workspace/artifact)
- Cache event shape: `src/backend/DevMode/EdogCacheInterceptor.cs:46-56` (cacheName, operation, key)
- Retry event shape: `src/backend/DevMode/EdogRetryInterceptor.cs:186-198` (endpoint, retryAttempt, isThrottle)
- Fileop event shape: `src/backend/DevMode/EdogFileSystemInterceptor.cs:252-262` (operation, path, durationMs)

**Edge cases:**
1. `retry` topic events enrich existing dependency edges (via correlation) — they don't create new nodes but still need a dependency ID for routing to the aggregator
2. `spark` topic captures `Created`/`Error` lifecycle events which may not have HTTP URLs — topic-based classification ensures they still route to `spark-gts`
3. Unknown topic name (e.g., future `perf` topic routed here) → maps to `unknown`. Note: the `capacity` topic (`EdogTopicRouter.cs:39`) is empty in V1 — capacity signals come from HTTP 430 responses, not from the capacity topic. If `capacity` topic events arrive in future, they should map to `"capacity"` via the topic switch.

**Interactions:**
- Token events arrive from `EdogTokenInterceptor` AND matching HTTP events arrive from `EdogHttpPipelineHandler` for the same request — the aggregator deduplicates, but the classifier correctly classifies both independently
- The `retry` topic events include an `endpoint` field with format `Artifact:{guid}/Node:{name}` (from `EdogRetryInterceptor.cs:167`) — this is preserved as the endpoint hint for aggregator correlation

**Revert mechanism:** Same as S01 — stateless, no side effects.

**Priority:** P1.

---

### S03 — Unknown Fallback & Signature Tracking

**Trigger:** An `http` topic event's URL matches none of the defined URL patterns.

**Expected behavior:** The classifier returns `DependencyId = "unknown"` with a normalized URL signature as the endpoint hint. The signature replaces GUIDs, numeric IDs, and SAS params with placeholders to group similar unknown URLs.

**Technical mechanism:**

```csharp
// GUID pattern: 8-4-4-4-12 hex or 32 hex (no dashes)
private static readonly Regex GuidPattern = new(
    @"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|[0-9a-fA-F]{32}",
    RegexOptions.Compiled);

// Numeric path segments (e.g., /statements/123)
private static readonly Regex NumericSegment = new(
    @"(?<=/)(\d{2,})(?=/|$|\?)",
    RegexOptions.Compiled);

internal static string ExtractUrlSignature(string url)
{
    if (string.IsNullOrEmpty(url)) return "empty";

    // Strip query string
    var pathOnly = url.Contains('?') ? url[..url.IndexOf('?')] : url;

    // Strip protocol + host
    var pathStart = pathOnly.IndexOf("//");
    if (pathStart >= 0)
    {
        var hostEnd = pathOnly.IndexOf('/', pathStart + 2);
        pathOnly = hostEnd >= 0 ? pathOnly[hostEnd..] : "/";
    }

    // Replace GUIDs and numeric IDs
    pathOnly = GuidPattern.Replace(pathOnly, "{id}");
    pathOnly = NumericSegment.Replace(pathOnly, "{n}");

    return pathOnly;
}
```

**Example transformations:**

| Raw URL | Signature |
|---------|-----------|
| `https://unknown-host.com/v1/workloads/abc-def-123/status/456` | `/v1/workloads/{id}/status/{n}` |
| `https://something.windows.net/path/00000000-0000-0000-0000-000000000000/data` | `/path/{id}/data` |
| (empty) | `empty` |

**Source code path:** New method in `EdogNexusClassifier.cs`.

**Edge cases:**
1. URL with only query params and no path (`?key=val`) → signature is `/`
2. URL with base64 segments that look like GUIDs but aren't → over-normalization is acceptable (groups more aggressively, which is safe for unknown tracking)
3. Very long URLs (>2KB) → truncate signature to 256 chars

**Interactions:**
- The aggregator uses these signatures to surface "top unknown endpoints" in the Nexus detail panel — helps operators add new classification rules
- Signatures are NOT used for node identity — all unknowns collapse to a single `unknown` node

**Revert mechanism:** Stateless.

**Priority:** P1.

---

### S04 — Ambiguous URL Resolution

**Trigger:** A URL could match multiple patterns. For example, a URL like `https://{capId}.pbidedicated.windows-int.net/webapi/capacities/{capId}/workloads/.../liveTable/getLatestDag` matches both `PlatformApiPattern` and `CapacityPattern`.

**Expected behavior:** The **first matching rule wins**. The rule order in `UrlRules` is the priority order. This is a deliberate design choice: ordered evaluation is simple, predictable, and debuggable.

**Technical mechanism:**

The `UrlRules` array is ordered by specificity (descending):

```
Priority 1: AuthPattern       — token endpoints (most specific path segments)
Priority 2: SparkGtsPattern   — /livy*, /spark* (specific path segments)
Priority 3: NotebookPattern   — /notebooks* (specific path segments → spark-gts)
Priority 4: PlatformApiPattern — host-based (pbidedicated/powerbi-df) + path
Priority 5: CapacityPattern   — /capacities/{id}/ (subset of platform host URLs)
Priority 6: FabricApiPattern  — api.fabric.microsoft.com or /api/fabric paths
```

**Real ambiguity scenarios from codebase:**

| URL (from codebase) | Matches | Winner | Rationale |
|------|---------|--------|-----------|
| `https://{cap}.pbidedicated.../capacities/{cap}/workloads/.../liveTable/getLatestDag` | PlatformApi, Capacity | `platform-api` | PlatformApi tested first; it's the more specific classification for FLT service calls |
| `https://login.microsoftonline.com/oauth2/v2.0/token` | Auth | `auth` | Only matches auth pattern |
| `https://{cap}.pbidedicated.../livysessions/123/statements` | SparkGts, PlatformApi | `spark-gts` | SparkGts tested before PlatformApi; Spark calls transit through relay but are semantically Spark |

**Source code paths:**
- Relay URL format: `src/backend/DevMode/EdogApiProxy.cs:92` (BuildBaseUrl)
- FLT DAG paths: `src/frontend/js/api-client.js:402-412`
- Spark/Livy references: `src/frontend/js/filters.js:132`

**Edge cases:**
1. A new URL pattern is added at the wrong position → wrong dependency ID assigned. Mitigation: unit tests with explicit priority assertions (see Testing Strategy)
2. Host-only matching (no distinctive path) → use the most general applicable bucket

**Interactions:** None beyond the aggregator consuming the result.

**Revert mechanism:** Stateless.

**Priority:** P1.

---

### S05 — Classification Rule Extensibility

**Trigger:** An operator discovers a cluster of `unknown` events that should be a named dependency.

**Expected behavior:** Adding a new classification rule requires:
1. Adding one regex + dependency ID entry to the `UrlRules` array (or a new topic mapping in the switch)
2. Optionally adding a new `DependencyId` constant in C01 Models
3. No changes to the aggregator, frontend, or transport

**Technical mechanism:**

```csharp
// To add a new dependency (e.g., "metadata-service"):
// 1. Add constant in EdogNexusModels.cs:
//    public const string MetadataService = "metadata-service";
//
// 2. Add rule in EdogNexusClassifier.cs UrlRules array at correct priority:
//    (new Regex(@"/metadata/v[12]/", RegexOptions.Compiled | RegexOptions.IgnoreCase),
//     "metadata-service"),
//
// 3. Add unit test asserting the new pattern classifies correctly.
//
// No other files require changes.
```

**Source code path:** `src/backend/DevMode/EdogNexusClassifier.cs` (UrlRules array).

**Edge cases:**
1. New rule conflicts with existing rule → priority order resolves it; test suite must cover
2. Regex too broad (e.g., `/api/`) → captures unrelated URLs. Mitigation: require path specificity in review

**Interactions:**
- Frontend `tab-nexus.js` renders whatever dependency IDs appear in the snapshot — adding a new ID automatically appears as a new node (no frontend change needed)
- Unknown signature tracking provides the data to inform new rules

**Revert mechanism:** Remove the array entry and constant.

**Priority:** P2 (process documentation, not code).

---

### S06 — Performance

**Trigger:** Every event from subscribed topics passes through `Classify()`. Under load, FLT can generate hundreds of HTTP events per second.

**Expected behavior:** Classification completes in <50μs per event. No allocations beyond the `ClassificationResult` struct return value on the fast path (matched URL). The method must be safe to call from the aggregator's hot loop without measurable impact.

**Technical mechanism:**

```csharp
// Performance guarantees:
// 1. All Regex instances use RegexOptions.Compiled — JIT compiles to IL
// 2. ClassificationResult is a readonly struct — stack-allocated, zero GC pressure
// 3. UrlRules is a static readonly array — no per-call allocation
// 4. Topic-based classification is a switch expression — O(1) branch
// 5. ExtractField uses lightweight reflection/duck-typing via anonymous object
//    property access — cached delegate after first call per type
// 6. No locks, no shared mutable state, no I/O
```

**Benchmark targets:**

| Scenario | Target | Mechanism |
|----------|--------|-----------|
| HTTP 430 (pre-URL short-circuit) | <2μs | Integer comparison, no regex |
| HTTP URL match (first rule hits) | <10μs | Compiled regex, early exit |
| HTTP URL match (last rule hits) | <50μs | 6 compiled regex tests |
| HTTP URL match + GTS phase | <60μs | URL match + 2 additional compiled regex for phase |
| HTTP URL miss (unknown fallback) | <60μs | All 6 patterns + signature extraction |
| HTTP with error code extraction | <80μs | URL match + regex on responseBodyPreview (4KB max) |
| Topic-based (non-HTTP) | <1μs | Switch expression, no regex |

**Source code paths:**
- Topic buffer sizes set the throughput ceiling: `src/backend/DevMode/EdogTopicRouter.cs:28-39` (http=2000, spark=200, token=500, etc.)
- Stream channel backpressure: `src/backend/DevMode/EdogPlaygroundHub.cs:70-76` (DropOldest at 1000)

**Edge cases:**
1. Pathological regex input (very long URL with catastrophic backtracking) → all patterns use non-greedy anchored segments; no `.*` without bounds
2. High-frequency burst (>500 events/sec) → classifier itself is not the bottleneck; bounded ring buffers in TopicRouter absorb pressure upstream

**Interactions:**
- The aggregator calls `Classify()` synchronously on its consumer thread — classifier latency directly adds to aggregator processing time
- If classification becomes a bottleneck in the future, the static method can be trivially parallelized across a partitioned consumer

**Revert mechanism:** N/A — performance is a quality attribute, not a toggle.

**Priority:** P1.

---

### S07 — Filesystem Filtering

**Trigger:** An event arrives on the `fileop` topic.

**Expected behavior:** The classifier returns `DependencyId = "filesystem"` with `IsInternal = true`. The `IsInternal` flag signals the aggregator to include this dependency in the graph model but the frontend hides it by default behind the Internals toggle.

**Technical mechanism:**

```csharp
// In ClassifyByTopic():
"fileop" => ("filesystem", true),  // IsInternal = true

// ClassificationResult carries the flag:
public readonly struct ClassificationResult
{
    public string DependencyId { get; init; }   // "filesystem"
    public string EndpointHint { get; init; }   // "Write:/path/to/file"
    public bool IsInternal { get; init; }       // true
    public bool IsThrottled { get; init; }      // false (fileop never throttled)
    public string ThrottleType { get; init; }   // null
}
```

The aggregator always processes `filesystem` events into the graph model (node metrics, edge stats). The frontend's Internals toggle controls visibility — the classifier does not suppress events.

**Source code paths:**
- Fileop event shape: `src/backend/DevMode/EdogFileSystemInterceptor.cs:252-262` (operation, path, contentSizeBytes, durationMs, iterationId)
- Existing Internals toggle pattern: runtime-view.js Internals dropdown with tabs (referenced in P0 research: `src/frontend/js/runtime-view.js:26-27,314-316`)

**Edge cases:**
1. File system operations that are actually OneLake API calls (HTTP) → classified by the `http` path as `fabric-api` or `platform-api`, NOT as `filesystem`. Only wrapped `IFileSystem` decorator calls hit the `fileop` topic.
2. High-volume file ops during DAG execution (metadata reads, checkpoint writes) → all route to single `filesystem` node. The aggregator may want per-operation-type sub-bucketing in future, but V1 treats `filesystem` as one node.

**Interactions:**
- Product decision from P0 research: "filesystem dependencies should be collected but hidden behind Internals by default" (`docs/specs/features/F26-nexus-dependency-graph/research/p0-foundation.md:116-117`)
- The `cache` dependency is NOT internal — it's visible by default because cache effectiveness directly impacts triage

**Revert mechanism:** Change `true` to `false` in the topic switch to make filesystem visible by default.

**Priority:** P1.

---

### S08 — Error Code Classification

**Trigger:** An HTTP event has `statusCode >= 400` and the `responseBodyPreview` field contains text that may include an FLT error code.

**Expected behavior:** The classifier extracts the first recognizable FLT error code from the response body preview using `NexusErrorClassification.ErrorCodePattern` (C01 Models) and populates the `ErrorCode` and `ErrorSeverity` fields on the resulting `NexusNormalizedEvent`. This is a best-effort enrichment — if no error code is found, both fields remain `null` and `IsError = true` is set based on HTTP status alone.

**Technical mechanism:**

```csharp
// Called by the aggregator's normalization step after ClassifyHttp() returns.
// The classifier produces ClassificationResult; the aggregator builds
// NexusNormalizedEvent and calls this enrichment for error events.

private static (string ErrorCode, string ErrorSeverity) ExtractErrorInfo(object eventData, int statusCode)
{
    if (statusCode < 400) return (null, null);

    var bodyPreview = ExtractField(eventData, "responseBodyPreview");
    if (string.IsNullOrEmpty(bodyPreview)) return (null, null);

    // Attempt regex extraction of FLT error code from response body
    // Source: EdogHttpPipelineHandler.cs:65,75 — responseBodyPreview is
    // first 4KB of response body (EdogHttpPipelineHandler.cs:195)
    var match = NexusErrorClassification.ErrorCodePattern.Match(bodyPreview);
    if (!match.Success) return (null, null);

    var errorCode = match.Groups[1].Value;
    var severity = NexusErrorClassification.Classify(errorCode);
    return (errorCode, severity);
}
```

**FLT error code prefixes:**
- `FLT_` — FabricLiveTable service-layer errors
- `FMLV_` — Fabric Materialized Lake View errors
- `MLV_` — legacy Materialized Lake View errors
- Bare codes (e.g., `MV_NOT_FOUND`, `CONCURRENT_REFRESH`) — pre-prefix era codes still in use

**Example extractions:**

| HTTP Status | Response Body Snippet | Extracted ErrorCode | ErrorSeverity |
|---|---|---|---|
| 404 | `{"errorCode":"MV_NOT_FOUND","message":"..."}` | `MV_NOT_FOUND` | `user` |
| 500 | `{"errorCode":"SYSTEM_ERROR","details":"..."}` | `SYSTEM_ERROR` | `system` |
| 503 | `{"errorCode":"SPARK_SESSION_ACQUISITION_FAILED","retry":true}` | `SPARK_SESSION_ACQUISITION_FAILED` | `transient` |
| 430 | `{"errorCode":"SPARK_JOB_CAPACITY_THROTTLING","message":"..."}` | `SPARK_JOB_CAPACITY_THROTTLING` | `transient` |
| 409 | `{"errorCode":"CONCURRENT_REFRESH","message":"..."}` | `CONCURRENT_REFRESH` | `user` |
| 500 | `Internal Server Error` (plain text, no JSON) | `null` | `null` |
| 502 | `{"error":"bad gateway"}` (no FLT error code) | `null` | `null` |

**Source code paths:**
- Response body capture: `src/backend/DevMode/EdogHttpPipelineHandler.cs:65` (CaptureBodyPreview call)
- Body preview field: `src/backend/DevMode/EdogHttpPipelineHandler.cs:75` (`responseBodyPreview` in published event)
- Body preview size: `src/backend/DevMode/EdogHttpPipelineHandler.cs:195` (first 4KB, skips binary/large payloads)
- Error classification: `EdogNexusModels.cs` — `NexusErrorClassification.Classify()` (C01 §3A)

**Edge cases:**
1. Response body is `null` (e.g., connection timeout, no response received) → `ErrorCode = null`, rely on HTTP status.
2. Response body is `[body >10MB, skipped]` (`EdogHttpPipelineHandler.cs:203`) → regex won't match, `ErrorCode = null`.
3. Response body contains multiple error codes (nested error object) → first regex match wins. This is acceptable for V1 diagnostic purposes.
4. Error code not in `KnownErrors` dictionary but matches prefix pattern (e.g., new `FLT_SOME_NEW_ERROR`) → `ErrorCode` is populated but `ErrorSeverity = null`. The code is captured for observability even without severity classification.
5. Non-JSON error responses (HTML error pages, plain text) → regex is format-agnostic; it searches for the pattern anywhere in the string.

**Interactions:**
- The aggregator uses `ErrorCode` and `ErrorSeverity` to compute per-edge error severity distributions (e.g., "80% of errors on spark-gts are transient → likely self-healing")
- The frontend `tab-nexus.js` can render error code breakdown in the drill-through panel
- `NexusAlert` generation can use `ErrorSeverity` to distinguish "user errors spiking" (config problem) from "transient errors spiking" (infra problem)

**Revert mechanism:** Stateless — remove the extraction call and both fields remain `null`.

**Priority:** P1.

---

### S09 — GTS Polling Phase Detection

**Trigger:** An HTTP event is classified as `spark-gts` by URL pattern matching (S01).

**Expected behavior:** The classifier further annotates `spark-gts` events with an operation phase that distinguishes the three stages of GTS interaction: job submission, status polling, and result fetching. This phase is encoded in the `EndpointHint` field as a `"gts:{phase}"` prefix.

After submitting a Spark transform to GTS, FLT enters a polling loop: repeated GET requests to the same transform URL until the job completes. This loop can run for minutes on large transforms with varying intervals. Without phase detection, these polling GETs are indistinguishable from the initial submission in the Nexus graph — making it impossible to diagnose "slow transform" vs "many poll iterations" vs "slow result fetch".

**Technical mechanism:**

```csharp
// Phase detection regex patterns (compiled, static):

// Result fetch: GET /transforms/{id}/result or /livysessions/{id}/result
private static readonly Regex GtsResultPattern = new(
    @"/(transforms|livysessions)/[^/]+/result",
    RegexOptions.Compiled | RegexOptions.IgnoreCase);

// Status poll: GET /transforms/{guid} or /livysessions/{id}/statements/{n}
private static readonly Regex GtsPollPattern = new(
    @"/(transforms|livysessions)/[0-9a-fA-F-]+(/statements/\d+)?$",
    RegexOptions.Compiled | RegexOptions.IgnoreCase);

// Phase derivation logic:
private static string DeriveGtsPhaseHint(string method, string url, string defaultHint)
{
    var upperMethod = method?.ToUpperInvariant();

    // POST/PUT to /transforms/ or /livysessions/ = submit
    if (upperMethod is "POST" or "PUT")
        return "gts:submit";

    if (upperMethod == "GET")
    {
        // GET /transforms/{id}/result = result fetch
        if (GtsResultPattern.IsMatch(url))
            return "gts:result";

        // GET /transforms/{id} (status poll)
        if (GtsPollPattern.IsMatch(url))
            return "gts:poll";
    }

    return defaultHint;
}
```

**Phase mapping:**

| HTTP Method | URL Pattern | EndpointHint | OperationPhase (on NexusNormalizedEvent) |
|---|---|---|---|
| POST | `/transforms/` | `gts:submit` | `"submit"` |
| PUT | `/livysessions/{id}/statements` | `gts:submit` | `"submit"` |
| GET | `/transforms/{guid}` | `gts:poll` | `"polling"` |
| GET | `/livysessions/{id}/statements/{n}` | `gts:poll` | `"polling"` |
| GET | `/transforms/{guid}/result` | `gts:result` | `"result-fetch"` |
| DELETE | `/livysessions/{id}` | (default hint) | `null` |

**Aggregator consumption:** The aggregator maps `EndpointHint` prefixes to `NexusNormalizedEvent.OperationPhase`:
- `"gts:submit"` → `OperationPhase = "submit"`
- `"gts:poll"` → `OperationPhase = "polling"`
- `"gts:result"` → `OperationPhase = "result-fetch"`
- anything else → `OperationPhase = null`

This enables the aggregator to compute per-transform:
- **Polling count**: number of `"polling"` events per correlation ID
- **Average polling interval**: time between consecutive poll events
- **Total polling duration**: time from first poll to result-fetch

**Source code paths:**
- HTTP method captured: `src/backend/DevMode/EdogHttpPipelineHandler.cs:50` (`method`)
- HTTP URL captured: `src/backend/DevMode/EdogHttpPipelineHandler.cs:51` (`url`)
- GTS transform submission: Spark session interceptor tracks `POST /transforms/` (`EdogSparkSessionInterceptor.cs:67-79`)
- Livy session statements: `PUT /livysessions/{id}/statements` for statement submission

**Edge cases:**
1. DELETE to `/livysessions/{id}` (session cleanup) → not a recognized GTS phase, uses default hint. The aggregator ignores unknown phases.
2. POST to `/livysessions/{id}/statements` vs POST to `/transforms/` → both are `"gts:submit"` (statement execution is semantically a submission)
3. Polling loop with PATCH method (hypothetical) → falls through to default hint. Only GET is recognized as polling.
4. URL with query parameters (e.g., `/transforms/{id}?type=summary`) → `GtsPollPattern` anchors on `$` after optional `/statements/\d+`, so query params cause a non-match. This is acceptable — query-param variations are rare in GTS URLs.

**Interactions:**
- The `CorrelationId` field (from HTTP headers) enables the aggregator to group submit + poll + result events for the same transform
- GTS polling volume is a key triage signal — "300 poll iterations over 5 minutes" means a slow transform, not a broken dependency

**Revert mechanism:** Remove `DeriveGtsPhaseHint()` call from `ClassifyHttp()`; all spark-gts events get default endpoint hint. No persistent side effects.

**Priority:** P1.

---

## 5. URL Pattern Table

Complete mapping of real FLT URL patterns to dependency IDs, with codebase evidence:

| Pattern | Regex | Dependency ID | Codebase Evidence |
|---------|-------|---------------|-------------------|
| **HTTP 430 (pre-URL)** | `statusCode == 430` | `capacity` | `EdogHttpPipelineHandler.cs:63,71` — FLT canonical "Spark Job Capacity Throttling" signal. Evaluated BEFORE URL patterns. |
| Livy/Spark sessions | `/(livy\|livysessions\|spark\|sparkSessions)/` | `spark-gts` | `filters.js:132` Spark preset, `spec.md:97` |
| OAuth2 token endpoints | `/(generatemwctoken\|oauth2/v2\.0/token\|token)(\?\|$\|/)` | `auth` | `spec.md:98`, `EdogTokenInterceptor.cs:63-72` |
| Notebook/Jupyter | `/(notebooks?\|jupyter)/` | `spark-gts` | `api-client.js:332,355`, `EdogRetryInterceptor.cs:60-62` |
| Capacity relay host | `(pbidedicated\|powerbi-df).*/(webapi\|liveTable\|liveTableSchedule)/` | `platform-api` | `EdogApiProxy.cs:92`, `api-client.js:402-412` |
| Capacity management | `/capacities/[0-9a-fA-F-]+/` | `capacity` | `spec.md:98`, `EdogApiProxy.cs:92` |
| Fabric REST APIs | `(api\.fabric\.microsoft\.com\|/api/fabric)/(v1/)?(workspaces\|lakehouses\|...)` | `fabric-api` | `api-client.js:80-92,395` |
| Everything else | (no match) | `unknown` | Fallback |

**GTS phase sub-classification (applied after `spark-gts` URL match):**

| HTTP Method | URL Sub-Pattern | EndpointHint | Phase |
|---|---|---|---|
| POST/PUT | `/(transforms\|livysessions)/` | `gts:submit` | Submit |
| GET | `/(transforms\|livysessions)/[id]/result` | `gts:result` | Result fetch |
| GET | `/(transforms\|livysessions)/[id]` | `gts:poll` | Status poll |

---

## 6. State Machine

The classifier is stateless — there is no state machine. It is a pure function:

```
Input: (topic: string, eventData: object)
Output: ClassificationResult { DependencyId, EndpointHint, IsInternal, IsThrottled, ThrottleType }
```

No transitions, no lifecycle, no initialization. The `UrlRules` array and compiled regex instances are static readonly — initialized once at class load time by the CLR.

**Evaluation order for HTTP events:**
1. Check `statusCode == 430` → return `capacity` with `IsThrottled = true` (pre-URL, highest priority)
2. Test URL against `UrlRules` array (first match wins)
3. If URL matched and `statusCode == 429` → enrich with `IsThrottled = true`, `ThrottleType = "rate-limit-429"`
4. If URL matched `spark-gts` → enrich with GTS phase hint via `DeriveGtsPhaseHint()`
5. No URL match → return `unknown`

---

## 7. Security

1. **No raw secrets pass through the classifier.** Input URLs are already SAS-redacted by `EdogHttpPipelineHandler.RedactUrl()` (`EdogHttpPipelineHandler.cs:92-103`). Token values are never present in topic events (`EdogTokenInterceptor.cs:97-98`).
2. **URL signatures in unknown tracking strip query parameters** — no risk of leaking SAS fragments into aggregated data.
3. **No I/O, no network calls, no file access** — zero attack surface.

---

## 8. Error Handling

1. **Null/empty topic:** Returns `unknown` with empty hint.
2. **Null eventData:** Returns classification based on topic alone; EndpointHint is empty.
3. **Field extraction failure** (eventData doesn't have expected fields): Returns the topic-default classification with best-effort hint. Never throws.
4. **Regex match exception** (theoretically impossible with compiled patterns): Catch, log via `Debug.WriteLine`, return `unknown`. Follows interceptor convention: `EdogHttpPipelineHandler.cs:80-83`.

```csharp
// Defensive envelope — matches existing interceptor convention
public static ClassificationResult Classify(string topic, object eventData)
{
    try
    {
        // ... classification logic
    }
    catch (Exception ex)
    {
        Debug.WriteLine($"[EDOG] NexusClassifier error: {ex.Message}");
        return new ClassificationResult
        {
            DependencyId = "unknown",
            EndpointHint = topic ?? "error",
            IsInternal = false,
        };
    }
}
```

---

## 9. Testing Strategy

### 9.1 Unit tests (owned by Sentinel)

| Test Case | Input | Expected Output | Validates |
|-----------|-------|-----------------|-----------|
| Spark Livy URL | `("http", { url: "https://host/livysessions/123/statements" })` | `spark-gts` | S01 SparkGts pattern |
| Platform DAG URL | `("http", { url: "https://cap.pbidedicated.windows-int.net/webapi/capacities/cap/workloads/.../liveTable/getLatestDag" })` | `platform-api` | S01 PlatformApi pattern |
| Fabric API URL | `("http", { url: "https://api.fabric.microsoft.com/v1/workspaces/abc/lakehouses" })` | `fabric-api` | S01 FabricApi pattern |
| Auth token URL | `("http", { url: "https://login.microsoftonline.com/oauth2/v2.0/token" })` | `auth` | S01 Auth pattern |
| Capacity URL | `("http", { url: "https://host/capacities/abc-def-123/" })` | `capacity` | S01 Capacity pattern |
| Notebook URL | `("http", { url: "https://host/notebooks/abc/cells" })` | `spark-gts` | S01 Notebook → spark-gts |
| Unknown URL | `("http", { url: "https://mystery.example.com/api/v3/stuff" })` | `unknown` | S03 fallback |
| Token topic | `("token", { endpoint: "/oauth2/token" })` | `auth` | S02 topic-based |
| Spark topic | `("spark", { sessionTrackingId: "edog-spark-1" })` | `spark-gts` | S02 topic-based |
| Cache topic | `("cache", { cacheName: "TokenManager" })` | `cache` | S02 topic-based |
| Fileop topic | `("fileop", { operation: "Write", path: "/data/file.parquet" })` | `filesystem` + `IsInternal=true` | S07 internal flag |
| Retry topic | `("retry", { endpoint: "Artifact:abc/Node:transform" })` | `retry-system` | S02 topic-based |
| Null URL | `("http", { url: null })` | `unknown` | S01 null safety |
| Empty topic | `("", { })` | `unknown` | Error handling |
| Priority: Spark over Platform | `("http", { url: "https://cap.pbidedicated.../livysessions/1/statements" })` | `spark-gts` | S04 priority |
| Priority: Auth before Platform | `("http", { url: "https://cap.pbidedicated.../generatemwctoken" })` | `auth` | S04 priority |
| URL signature normalization | `ExtractUrlSignature("https://host/v1/workspaces/abc-123/items/456")` | `/v1/workspaces/{id}/items/{n}` | S03 signature |
| **HTTP 430 → capacity** | `("http", { url: "https://host/livysessions/123", statusCode: 430 })` | `capacity` + `IsThrottled=true` + `ThrottleType="capacity-430"` | S01 HTTP 430 pre-URL override |
| **HTTP 430 from Spark URL** | `("http", { url: "https://host/spark/sessions/1", statusCode: 430 })` | `capacity` (NOT `spark-gts`) | S01 430 beats URL match |
| **HTTP 430 from unknown URL** | `("http", { url: "https://mystery.example.com/api", statusCode: 430 })` | `capacity` + `IsThrottled=true` | S01 430 from any URL = capacity |
| **HTTP 429 on Spark URL** | `("http", { url: "https://host/livysessions/123", statusCode: 429 })` | `spark-gts` + `IsThrottled=true` + `ThrottleType="rate-limit-429"` | S01 429 preserves dependency ID |
| **HTTP 429 on unknown URL** | `("http", { url: "https://mystery.com/api", statusCode: 429 })` | `unknown` + `IsThrottled=true` + `ThrottleType="rate-limit-429"` | S01 429 on unknown |
| **HTTP 200 (no throttle)** | `("http", { url: "https://host/livysessions/123", statusCode: 200 })` | `spark-gts` + `IsThrottled=false` | S01 normal path |
| **GTS submit (POST)** | `("http", { url: "https://host/transforms/", method: "POST", statusCode: 200 })` | `spark-gts` + EndpointHint=`"gts:submit"` | S09 GTS submit phase |
| **GTS poll (GET)** | `("http", { url: "https://host/transforms/abc-123", method: "GET", statusCode: 200 })` | `spark-gts` + EndpointHint=`"gts:poll"` | S09 GTS poll phase |
| **GTS result (GET)** | `("http", { url: "https://host/transforms/abc-123/result", method: "GET", statusCode: 200 })` | `spark-gts` + EndpointHint=`"gts:result"` | S09 GTS result-fetch phase |
| **GTS Livy submit (PUT)** | `("http", { url: "https://host/livysessions/1/statements", method: "PUT", statusCode: 200 })` | `spark-gts` + EndpointHint=`"gts:submit"` | S09 Livy statement submit |
| **GTS Livy poll (GET)** | `("http", { url: "https://host/livysessions/1/statements/42", method: "GET", statusCode: 200 })` | `spark-gts` + EndpointHint=`"gts:poll"` | S09 Livy statement poll |
| **GTS DELETE (no phase)** | `("http", { url: "https://host/livysessions/1", method: "DELETE", statusCode: 200 })` | `spark-gts` + EndpointHint=(default) | S09 non-phase method |
| **Error: MV_NOT_FOUND** | `("http", { statusCode: 404, responseBodyPreview: '{"errorCode":"MV_NOT_FOUND"}' })` | ErrorCode=`"MV_NOT_FOUND"`, ErrorSeverity=`"user"` | S08 user error extraction |
| **Error: SYSTEM_ERROR** | `("http", { statusCode: 500, responseBodyPreview: '{"errorCode":"SYSTEM_ERROR"}' })` | ErrorCode=`"SYSTEM_ERROR"`, ErrorSeverity=`"system"` | S08 system error extraction |
| **Error: SPARK_SESSION_ACQUISITION_FAILED** | `("http", { statusCode: 503, responseBodyPreview: '{"errorCode":"SPARK_SESSION_ACQUISITION_FAILED"}' })` | ErrorCode=`"SPARK_SESSION_ACQUISITION_FAILED"`, ErrorSeverity=`"transient"` | S08 transient error |
| **Error: CONCURRENT_REFRESH** | `("http", { statusCode: 409, responseBodyPreview: '{"errorCode":"CONCURRENT_REFRESH"}' })` | ErrorCode=`"CONCURRENT_REFRESH"`, ErrorSeverity=`"user"` | S08 user error (conflict) |
| **Error: unknown FLT code** | `("http", { statusCode: 500, responseBodyPreview: '{"errorCode":"FLT_NEW_ERROR"}' })` | ErrorCode=`"FLT_NEW_ERROR"`, ErrorSeverity=`null` | S08 unknown code captured |
| **Error: no FLT code in body** | `("http", { statusCode: 502, responseBodyPreview: 'Bad Gateway' })` | ErrorCode=`null`, ErrorSeverity=`null` | S08 no code fallback |
| **Error: null body** | `("http", { statusCode: 500, responseBodyPreview: null })` | ErrorCode=`null`, ErrorSeverity=`null` | S08 null body safety |
| **Error: 430 + error code** | `("http", { statusCode: 430, responseBodyPreview: '{"errorCode":"SPARK_JOB_CAPACITY_THROTTLING"}' })` | `capacity` + ErrorCode=`"SPARK_JOB_CAPACITY_THROTTLING"`, ErrorSeverity=`"transient"` | S08 + S01 combined |

### 9.2 Benchmark test

A dedicated benchmark test asserting that 10,000 `Classify()` calls complete in <500ms (i.e., <50μs per call average). Regression gate in CI.

---

## 10. Implementation Notes

1. **File conventions:** Follow existing DevMode file patterns — `#nullable disable`, `#pragma warning disable`, namespace `Microsoft.LiveTable.Service.DevMode`. See all existing interceptors for reference.

2. **Field extraction:** The `eventData` parameter is an anonymous object. Use lightweight reflection to read named properties. Cache `PropertyInfo` lookups per type using a `ConcurrentDictionary<Type, PropertyInfo[]>` for performance. Alternatively, if C01 Models introduces typed DTOs consumed by the aggregator, the classifier can accept those typed objects directly.

3. **Regex compilation:** All `Regex` instances must use `RegexOptions.Compiled`. This is consistent with `EdogHttpPipelineHandler.cs:30-32` (SasTokenPattern) and `EdogRetryInterceptor.cs:39-62` (all retry patterns).

4. **No external dependencies:** The classifier must not reference any NuGet package beyond `System.Text.RegularExpressions`. It operates entirely on string matching.

5. **Registration:** The classifier is a static utility class — no DI registration needed. The aggregator (C03) calls `EdogNexusClassifier.Classify()` directly as a static method.
