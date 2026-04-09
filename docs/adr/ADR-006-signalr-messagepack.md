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
- +1 NuGet package (MessagePack protocol)
- JS SignalR client adds ~40KB to HTML (acceptable within 800KB budget)
- All 11 sub-views use same SignalR connection with group filtering
- Replaces current raw WebSocket implementation in EdogLogServer

