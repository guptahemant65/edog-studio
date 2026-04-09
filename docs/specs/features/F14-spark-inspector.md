# Feature 14: Spark Inspector

> **Phase:** V2
> **Status:** Not Started
> **Owner:** TBD
> **Spec:** docs/specs/features/F14-spark-inspector.md
> **Design Ref:** docs/specs/design-spec-v2.md §14

### Description

Full two-panel Spark HTTP request inspector. **Requires new C# interceptor:** `EdogTracingSparkClient` subclassing `GTSBasedSparkClient`, overriding `protected virtual SendHttpRequestAsync()` to capture all Spark HTTP traffic. `EdogTracingSparkClientFactory` wraps the original factory for DI swap. New WebSocket message type `spark_request`. Left panel: request list with method/endpoint/status/duration/retry badges. Right panel: tabbed view (Request, Response, Timing, Retry Chain). Key decision: capture must add <1ms overhead per request since it runs inside the FLT process hot path.
