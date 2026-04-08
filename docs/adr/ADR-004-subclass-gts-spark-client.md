# ADR-004: Subclass GTSBasedSparkClient for Spark Interception

## Status
ACCEPTED

**Date**: 2026-04-08
**Deciders**: Sana Reeves (Tech Lead), Arjun Mehta (Sr. C#), Dev Patel (FLT Expert), Hemant Gupta (CEO)

## Context

EDOG Studio's Spark Inspector feature needs to capture Spark HTTP requests made by the FLT service. The FLT service uses `GTSBasedSparkClient` to send requests to the Spark Livy endpoint. We need to intercept these requests to display them in the UI — showing request/response pairs, timing, payload sizes, and error details.

There are two main approaches to HTTP interception in the .NET ecosystem:
1. **DelegatingHandler** — a middleware in the HttpClient pipeline
2. **Subclassing** — extend the client class and override the send method

## Decision

We will **subclass `GTSBasedSparkClient`** and override `SendHttpRequestAsync()` to intercept Spark requests. We will NOT use a `DelegatingHandler` on the `HttpClient`.

```csharp
public class EdogSparkClient : GTSBasedSparkClient
{
    protected override async Task<HttpResponseMessage> SendHttpRequestAsync(
        HttpRequestMessage request,
        CancellationToken cancellationToken)
    {
        // Capture request details for edog display
        var captured = CaptureRequest(request);

        var response = await base.SendHttpRequestAsync(request, cancellationToken)
            .ConfigureAwait(false);

        // Capture response details
        CaptureResponse(captured, response);

        return response;
    }
}
```

DI registration replaces the original client:
```csharp
services.AddSingleton<GTSBasedSparkClient, EdogSparkClient>();
```

## Consequences

### Positive
- Clean override point — `SendHttpRequestAsync()` is the single method where all Spark requests flow
- Access to the full `GTSBasedSparkClient` context (configuration, auth, endpoint info)
- No changes to HttpClient pipeline — doesn't affect non-Spark HTTP traffic
- Follows the OOP interception pattern used elsewhere in FLT
- Easy to capture both request and response in the same scope

### Negative
- Tightly coupled to `GTSBasedSparkClient` class hierarchy — if FLT team changes the class (seals it, renames it, restructures), our code breaks
- Must monitor FLT codebase for changes to this class
- Subclassing is less composable than middleware (can't stack multiple interceptors easily)

### Neutral
- The DI replacement is straightforward but must be done in the right order (after FLT registers the original)
- Only captures Spark traffic, not general HTTP — this is a feature, not a limitation

## Alternatives Considered

### DelegatingHandler on HttpClient
**Summary**: Add a `DelegatingHandler` to the `HttpClient` used by `GTSBasedSparkClient` to intercept all requests.
**Why rejected**: The `HttpClient` may be shared with non-Spark components. Adding a handler would capture unrelated HTTP traffic. Also, accessing the `HttpClient` registration in DI requires knowing how FLT registers it — more fragile than subclassing the client directly.

### HttpClient Decorator Pattern
**Summary**: Wrap the `HttpClient` instance with a decorator that logs requests.
**Why rejected**: `HttpClient` is not designed for decoration — it's a concrete class, not an interface. Creating a wrapper requires reimplementing the `HttpClient` API surface, which is large and version-sensitive.

### IL Weaving / AOP
**Summary**: Use Fody or similar to weave interception logic at compile time.
**Why rejected**: Extreme overkill. Adds build-time dependency. Hard to debug. Not maintainable by the team.

## Related
- ADR-005: Late DI Registration (same DI override pattern)
- Design spec Section 14: Spark Inspector
- Arjun Mehta owns implementation
- Dev Patel monitors GTSBasedSparkClient for FLT changes
