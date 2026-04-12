# ADR-006: SignalR + MessagePack for Real-Time Messaging

## Status: ACCEPTED (CEO decision, 2026-04-09)

## Context
EDOG Playground streams 11 event types from C# interceptors to browser.
1000+ events/sec at peak. Need: topic subscription, backpressure, reconnection.

## Options Evaluated
1. Raw WebSocket + MessagePack (custom)
2. **SignalR + MessagePack** (selected)
3. NATS (external broker)
4. gRPC streaming
5. Redis Streams
6. ZeroMQ
7. SSE

## Decision
**SignalR with MessagePack hub protocol.**

## Rationale
- Zero new infra — Kestrel already runs in EdogLogServer
- Hub groups = natural topic subscription (logs, tokens, fileops, etc.)
- MessagePack protocol = binary wire format (30-50% smaller than JSON)
- Auto-reconnect with state recovery built-in
- Same tech as Azure DevOps, VS Live Share, GitHub Codespaces
- Official JS client can be inlined or use raw WebSocket with SignalR protocol
- Adding a SignalR hub to EdogLogServer.cs is ~20 lines

## Implementation
- C# NuGet: Microsoft.AspNetCore.SignalR (already in ASP.NET Core)
- C# NuGet: Microsoft.AspNetCore.SignalR.Protocols.MessagePack
- JS: @microsoft/signalr client (inline in single HTML file)
- Hub: EdogPlaygroundHub with groups per topic
- Each interceptor calls hub.Clients.Group(topic).SendAsync()
- Client joins/leaves groups on tab switch
- Bounded Channel per topic on server (drop-oldest on backpressure)

## Consequences
- +1 NuGet package (MessagePack protocol) — DEFERRED: version conflict with FLT's MessagePack.Annotations
- JS SignalR client adds ~47KB to HTML (acceptable within 800KB budget)
- All 11 sub-views use same SignalR connection with streaming per topic
- Replaces current raw WebSocket implementation in EdogLogServer

## Addendum (2026-04-12): JSON Protocol + Streaming Architecture

**MessagePack DEFERRED.** The `Microsoft.AspNetCore.SignalR.Protocols.MessagePack` NuGet package causes NU1603 version conflict with FLT's existing `MessagePack.Annotations` dependency under central package version management. Using **JSON protocol** (built-in, zero additional NuGet) until version alignment is resolved. All hub features work identically.

**Streaming replaces groups.** Instead of group-based broadcast (`Clients.Group(topic).SendAsync`), we use **SignalR server-to-client streaming** with `ChannelReader<T>`. Client calls `connection.stream("SubscribeToTopic", topic)` and receives a unified stream: snapshot (buffered history) first, then live events. This eliminates the REST-fetch-for-history gap, provides built-in backpressure via bounded channels, and guarantees per-topic ordering.

See `docs/specs/SIGNALR_PROTOCOL.md` for the full v2 protocol specification.

