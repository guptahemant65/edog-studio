# F11 — Architecture (P2)

> **Status:** LOCKED — feeds P3 (state matrix) + P5 (implementation)
> **Owner:** Sana (architecture) + Vex (C# + Python prototype)
> **Supersedes:** `research/p0-foundation.md` §3d control-plane design (SignalR-topic-based push — verified architecturally invalid; corrected here)
> **Depends on:** `ADR-005-late-di-registration-featureflighter.md`, `ADR-006-signalr-messagepack.md`

---

## 1. Scope

This document covers the panel-wide architectural decisions for F11. Per-card visual and data-shape contracts live in `components/C0{1..5}-*.md`. Per-card state machines live in `states/` (P3). This doc is the source of truth for:

- **The override control plane** for Card 3 (Feature Flags) — the headline correction over P0.
- **Cross-card data contracts** between C01–C05.
- **The three operating phases** every card must handle (disconnected / connected-wrapper-inactive / connected-wrapped).
- **Performance budgets** and **error contracts** that P5 implementers must hit.
- **DI registration timing** and the guarantees it does and does not provide.
- **Testing strategy** that Sentinel uses as the P6 gate.

Out of scope: Catalog cache git-fetch internals (covered in P0 §2 — already locked). UI rendering details (covered in components + mocks). Per-card state machines (P3).

---

## 2. Topology

```
                          (browser, port 5555)
                                    │
                                    │ HTTP (1:1 with dev-server)
                                    ▼
   ┌────────────────────────────────────────────────────────────┐
   │  dev-server.py  (Python http.server, localhost:5555)       │
   │                                                            │
   │  - holds in-memory: _feature_overrides: dict[str, bool]    │
   │  - holds in-memory: _feature_overrides_revision: int       │
   │  - exposes the public override API to the browser          │
   │  - generates EDOG_CONTROL_TOKEN per session                │
   │                                                            │
   └─────────┬──────────────────────────────────────┬───────────┘
             │                                      │
             │ HTTPS through                        │ plain HTTP, localhost,
             │ Fabric capacity edge                 │ + X-EDOG-Control-Token
             │ (browser-bound calls)                │ (server-to-server only)
             ▼                                      ▼
   Fabric workload endpoints           ┌─────────────────────────────────────┐
                                       │  EdogLogServer (FLT-side Kestrel,    │
                                       │  localhost:5557 via                  │
                                       │  EDOG_STUDIO_PORT env var)           │
                                       │                                     │
                                       │  - hosts /api/edog/feature-flags/   │
                                       │    overrides{,/{flag},/bulk,/reset} │
                                       │  - writes to EdogFeatureOverrideStore│
                                       │  - mounted UNCONDITIONALLY (not     │
                                       │    gated on apiProxy != null)       │
                                       │                                     │
                                       │   ┌────────────────────────────┐    │
                                       │   │ EdogFeatureOverrideStore   │    │
                                       │   │ (static, snapshot-based)   │    │
                                       │   │                            │    │
                                       │   │ private static volatile    │    │
                                       │   │   FrozenDictionary _snap   │    │
                                       │   └─────────▲──────────────────┘    │
                                       │             │ snapshot read          │
                                       │             │ (every IsEnabled call) │
                                       │   ┌─────────┴──────────────────┐    │
                                       │   │ EdogFeatureFlighterWrapper │    │
                                       │   │ : IFeatureFlighter         │    │
                                       │   │                            │    │
                                       │   │ - registered via late DI   │    │
                                       │   │   per ADR-005              │    │
                                       │   │ - reads store snapshot     │    │
                                       │   │   before _inner.IsEnabled  │    │
                                       │   │ - publishes "flag" topic   │    │
                                       │   │   with overridden: bool    │    │
                                       │   └─────────┬──────────────────┘    │
                                       │             │ Publish(topic="flag") │
                                       │             ▼                       │
                                       │   EdogTopicRouter  ──┐              │
                                       └──────────────────────┼──────────────┘
                                                              │
                                                              │ ChannelReader drain
                                                              ▼
                                                  EdogPlaygroundHub.SubscribeToTopic
                                                              │
                                                              │ SignalR/MessagePack
                                                              ▼
                                                          browser
```

**Key invariants:**

- **Control plane = HTTP.** Dev-server → EdogLogServer. No SignalR for writes. No fan-out. No new topic.
- **Data plane = SignalR.** Wrapper → `EdogTopicRouter` → `EdogPlaygroundHub` → browser. Existing pattern; F11 reuses the `flag` topic with one additional field (`overridden: bool`).
- **Browser never talks to :5557 directly for writes.** Browser writes go to dev-server; dev-server holds the control token and proxies to FLT.
- **Override store snapshot is the read source.** `IsEnabled()` reads a `volatile` snapshot reference, never iterates a mutable dictionary. Atomic swap on every write.

---

## 3. Override Control Plane

### 3.1 Why P0's SignalR design was rejected

P0 §3d (`research/p0-foundation.md`) and C03 §3 (`components/C03-feature-flags.md`) originally specified:

> "dev-server posts override changes to FLT via a new `flag-overrides` topic on the existing `EdogTopicRouter` hub. Wrapper subscribes on startup; on each message calls `Apply(next)`."

This is structurally impossible with the existing infrastructure:

- `EdogTopicRouter` (`src/backend/DevMode/EdogTopicRouter.cs:18-46`) is a **static publish-only buffer registry**. Interceptors call `Publish(topic, eventData)`; the only reader is `GetBuffer(topic).Reader`, which is drained by `EdogPlaygroundHub.SubscribeToTopic` and streamed OUT to SignalR clients.
- `EdogPlaygroundHub` (`src/backend/DevMode/EdogPlaygroundHub.cs:311`) exposes `SubscribeToTopic(string topic) → ChannelReader<TopicEvent>`. The hub's role is strictly publish-to-clients. There is no in-process subscriber API for FLT code to consume control messages.
- A subscriber on the FLT side would require either (a) a new hub method that mutates state when called by a SignalR *client* (which would mean dev-server acts as a SignalR client to FLT — new dependency, new failure modes), or (b) a polling loop in the wrapper (defeats the "<100ms latency" claim from P0).

**Decision:** Use HTTP instead. `EdogLogServer` is already a Kestrel host with route-mounting infrastructure; adding a write endpoint is a 30-line change. CORS is already configured for localhost callers (`EdogLogServer.cs:86-97`). Latency is single-digit ms over localhost.

### 3.2 Topology

```
dev-server.py
  POST /api/edog/feature-flags/overrides              (browser-facing)
  │
  └─►  EdogLogServer
         POST /api/edog/feature-flags/overrides/bulk  (server-to-server, full snapshot)
         X-EDOG-Control-Token: <session token>
         │
         └─►  EdogFeatureOverrideStore.ReplaceAll(newSnapshot)
                │
                └─►  Volatile.Write(ref _snapshot, frozenDict)
```

The browser-facing surface uses single-flag verbs (POST one, DELETE one, POST reset). The FLT-facing surface uses **only full-snapshot replacement** — the only verb that crosses the network is "here is the current map." This is the rubber-duck §1 atomicity fix: bulk apply must be atomic.

Per-flag verbs on dev-server translate to a snapshot rebuild + bulk push to FLT:

| Browser sends                                            | dev-server does                                  | dev-server posts to FLT                            |
|----------------------------------------------------------|--------------------------------------------------|----------------------------------------------------|
| `POST   /overrides` body `{flag,value:true}`             | mutate local map; bump `_revision`               | `POST /overrides/bulk` body `{ overrides, revision }` |
| `DELETE /overrides/{flag}`                               | remove from local map; bump revision             | `POST /overrides/bulk` body `{ overrides, revision }` |
| `POST   /overrides/reset`                                | clear local map; bump revision                   | `POST /overrides/bulk` body `{ overrides:{}, revision }` |
| `POST   /overrides/replay` (internal, reconnect handler) | no local change; just re-send                    | `POST /overrides/bulk` body `{ overrides, revision }` |

### 3.3 `EdogFeatureOverrideStore` (new static class)

`src/backend/DevMode/EdogFeatureOverrideStore.cs` (new file, this feature):

```csharp
public static class EdogFeatureOverrideStore
{
    // The only mutable state. Reads grab the reference; writes swap it atomically.
    private static volatile FrozenDictionary<string, bool> _snapshot
        = FrozenDictionary<string, bool>.Empty;

    // Monotonic — dev-server includes its revision in /bulk; we echo it back so
    // dev-server can verify "what's installed equals what I sent."
    private static long _revision;

    /// <summary>Snapshot read. Wrapper hot path. No locks. No allocations.</summary>
    public static bool TryGet(string flagName, out bool forced) =>
        _snapshot.TryGetValue(flagName, out forced);

    /// <summary>Atomic full-snapshot replacement.</summary>
    public static (long revision, string hash) ReplaceAll(
        IReadOnlyDictionary<string, bool> next, long incomingRevision)
    {
        var frozen = next.ToFrozenDictionary(StringComparer.Ordinal);
        Volatile.Write(ref _snapshot, frozen);
        Interlocked.Exchange(ref _revision, incomingRevision);
        return (incomingRevision, ComputeHash(frozen));
    }

    public static (FrozenDictionary<string, bool> snapshot, long revision, string hash)
        GetSnapshot() => (_snapshot, _revision, ComputeHash(_snapshot));

    // Hash: SHA256 of sorted "k=v" lines, hex. Cheap, deterministic, lets dev-server
    // verify a /bulk landed without trusting echo alone.
    private static string ComputeHash(FrozenDictionary<string, bool> snap) { ... }
}
```

Key properties:

- **No public mutable accessor.** Callers cannot grab the dictionary and modify it. The only write path is `ReplaceAll`.
- **Force-ON only.** The store stores `bool`, but every write path (dev-server endpoint, bulk handler) validates `value == true`. Force-OFF is rejected at the HTTP layer with 400; the store itself stays a `bool` for forward compatibility in case V2 introduces force-OFF, but V1.1 never writes `false`.
- **`StringComparer.Ordinal`.** FLT flag names are case-sensitive (verified by reading `FeatureNames.cs` in P0). Do not lowercase.
- **`FrozenDictionary<TKey, TValue>`** (.NET 8+) — read-optimized, immutable after construction. The hot path is `wrapper.IsEnabled() → store.TryGet()` which happens on every flag check.

### 3.4 Wrapper read pattern

`src/backend/DevMode/EdogFeatureFlighterWrapper.cs` becomes:

```csharp
public bool IsEnabled(string featureName, Guid? tenantId, Guid? capacityId, Guid? workspaceId)
{
    var sw = Stopwatch.StartNew();
    bool overridden = false;
    bool result;

    if (EdogFeatureOverrideStore.TryGet(featureName, out var forced) && forced == true)
    {
        result = true;
        overridden = true;
        // Do NOT call _inner.IsEnabled — short-circuit per P0 §3c.
    }
    else
    {
        result = _inner.IsEnabled(featureName, tenantId, capacityId, workspaceId);
    }
    sw.Stop();

    EdogTopicRouter.Publish("flag", new
    {
        flagName = featureName,
        tenantId = tenantId?.ToString(),
        capacityId = capacityId?.ToString(),
        workspaceId = workspaceId?.ToString(),
        result,
        durationMs = sw.Elapsed.TotalMilliseconds,
        overridden,   // NEW — C03 needs this for the "override active" indicator
    });

    return result;
}
```

The single new field on the published `flag` event is `overridden: bool`. C03's UI uses it to render the `!` glyph and the override-active row accent. Browser-side telemetry consumers already tolerate unknown fields.

### 3.5 Endpoint contracts

**On `EdogLogServer` (FLT side, localhost:5557):**

All routes require `X-EDOG-Control-Token: <token>` header. Missing or mismatched token returns 401. The token is generated by dev-server per session and passed to FLT via the `EDOG_CONTROL_TOKEN` env var (see §3.7).

```
POST /api/edog/feature-flags/overrides/bulk
  body: { "overrides": { "FLTEnableX": true }, "revision": 42 }
  200:  { "revision": 42, "hash": "ab12...", "count": 1 }
  401:  control token mismatch
  400:  malformed body, or any value !== true (force-OFF rejected at HTTP)

GET  /api/edog/feature-flags/overrides
  200:  { "overrides": { ... }, "revision": 42, "hash": "ab12..." }
```

Only `/bulk` and `GET` are exposed on the FLT side. The browser-facing per-flag verbs are dev-server's responsibility; FLT does not need to know the difference between a single-flag toggle and a full replace.

**On dev-server (browser side, localhost:5555):**

```
POST   /api/edog/feature-flags/overrides         body: { flag, value: true }
DELETE /api/edog/feature-flags/overrides/{flag}
POST   /api/edog/feature-flags/overrides/reset
GET    /api/edog/feature-flags/overrides

All responses:
{
  "overrides": { ... },
  "revision": 43,
  "fltSync": "applied" | "pending" | "failed" | "not-connected" | "wrapper-inactive",
  "fltHash": "ab12..." | null,
  "fltRevision": 42 | null,
  "warning": "<human-readable when fltSync != applied>" | null
}
```

`fltSync` field semantics (rubber-duck §10):

- **`applied`** — POST to FLT succeeded, returned hash matches what dev-server computed locally, returned revision matches the one sent. UI shows clean state.
- **`pending`** — FLT POST in flight or queued for replay. UI shows amber dot on affected rows.
- **`failed`** — FLT POST returned non-2xx, or returned hash/revision mismatch. UI shows amber dot + retry affordance.
- **`not-connected`** — FLT is in disconnected phase. Dev-server stored the override locally; will be replayed on next wrapper-reconnect. UI shows "Will apply on FLT start" pill.
- **`wrapper-inactive`** — FLT is connected but `GET /api/edog/interceptors/status` reports `FeatureFlighter.Wrapped == false`. Override stored on dev-server AND posted to FLT, but no `IsEnabled()` call will see it because the wrapper isn't in the resolved DI chain. UI shows "Interceptor inactive — Restart FLT" call-to-action (rubber-duck §6).

### 3.6 Write ordering & source-of-truth (rubber-duck §2)

Dev-server holds the durable map (in-memory only — restarts clear it). FLT holds the live `EdogFeatureOverrideStore`. They must not diverge.

**Write path order (always):**

1. Acquire `_feature_overrides_lock`.
2. Validate request (flag name shape, `value === true`).
3. Mutate `_feature_overrides`.
4. Bump `_feature_overrides_revision`.
5. Release lock.
6. Build full snapshot from local map.
7. POST `/api/edog/feature-flags/overrides/bulk` to FLT with `{overrides, revision}`.
8. Compare response `revision` and `hash` to what we sent.
   - Match → `fltSync: applied`.
   - Mismatch / non-2xx / timeout → `fltSync: failed`, schedule retry on next health tick.
   - FLT unreachable (connection refused / phase != connected) → `fltSync: not-connected`, do not retry until reconnect signal.
9. Return response to browser including local map, revision, and `fltSync`.

**Dev-server cold start (rubber-duck §2.b):**

Dev-server has no on-disk persistence for the override map. On startup:

- If FLT is not reachable → start with empty map; wait for connection.
- If FLT is reachable → call `POST /api/edog/feature-flags/overrides/bulk` with an empty payload. This clears any stale overrides left over from a previous dev-server session. The new dev-server session is authoritative.

Rationale: not surfacing "orphaned live overrides — import or reset" UI is the simpler choice. F11 is a debugging tool; preserving overrides across dev-server crashes is not a stated user need.

### 3.7 Per-session control token (rubber-duck §4)

Localhost-only + CORS is not write-protection — any local process can POST to `localhost:5557`. F11 adds a cheap session token:

**Generation (dev-server, on startup):**

```python
EDOG_CONTROL_TOKEN = secrets.token_urlsafe(32)  # 256-bit, URL-safe base64
```

**Propagation (dev-server, when launching FLT):**

```python
env["EDOG_STUDIO_PORT"] = str(FLT_INTERNAL_PORT)
env["EDOG_CONTROL_TOKEN"] = EDOG_CONTROL_TOKEN
```

Same injection point as the existing `EDOG_STUDIO_PORT` env var (`scripts/dev-server.py:1716` and `:1809`). Adds one line.

**Consumption (FLT side, EdogLogServer route middleware):**

```csharp
var expected = Environment.GetEnvironmentVariable("EDOG_CONTROL_TOKEN");
app.UseWhen(
    ctx => ctx.Request.Path.StartsWithSegments("/api/edog/feature-flags/overrides"),
    branch => branch.Use(async (ctx, next) =>
    {
        var actual = ctx.Request.Headers["X-EDOG-Control-Token"].FirstOrDefault();
        if (string.IsNullOrEmpty(expected) || !CryptographicOperations.FixedTimeEquals(
            Encoding.UTF8.GetBytes(expected), Encoding.UTF8.GetBytes(actual ?? "")))
        {
            ctx.Response.StatusCode = 401;
            return;
        }
        await next();
    }));
```

The token is **not** exposed to the browser. Browser writes go to dev-server (no token); dev-server adds the header when posting to FLT. This is the only secret-management decision in F11; reuse `secrets.token_urlsafe` for any future control endpoints.

**GET endpoints are exempt** from the token check — read-only. Same as the existing health and status routes.

### 3.8 Reconnect replay (rubber-duck §3)

Dev-server already detects FLT-reconnect via its existing health-polling and SignalR-reconnect signals. When the wrapper comes back up after an FLT restart or deploy:

1. Dev-server receives the wrapper-reconnect event (existing).
2. Dev-server computes hash of local `_feature_overrides`.
3. Dev-server POSTs `/api/edog/feature-flags/overrides/bulk` with the full local map.
4. Compares response hash to local hash.
5. If match → mark all rows `fltSync: applied`.
6. If mismatch → log error; mark `fltSync: failed`; expose the discrepancy in the panel header.

Dev-server may also periodically (every 30s) call `GET /api/edog/feature-flags/overrides` from FLT to verify the live store still matches its local map. Mismatch detection is cheap (one HTTP call + hash compare) and catches the case where FLT was restarted by an external process (build script, debugger detach) without dev-server's involvement.

---

## 4. Catalog Data Plane (unchanged from P0)

`GET /api/edog/feature-flags/catalog` and `GET /api/edog/feature-flags/observed` are served by dev-server.py only. They are read-only and require no FLT round-trip:

- **Catalog** — parses the FLT repo's `FeatureNames.cs` (~36 FLT-relevant flags) + cached FeatureManagement repo JSON (~13K flags). Cache strategy is in P0 §2 (locked).
- **Observed** — projection of the `flag` topic SignalR stream. Dev-server keeps a rolling window of recent evaluations per flag name and exposes the projection.

No architectural change. Browser fetches catalog once per session, plus on force-refresh; observed updates as new evaluations stream in.

---

## 5. Cross-card data contracts

C01–C05 were drafted by parallel agents in P1. Cross-card data flow is locked here:

| Field                  | Source              | Consumers              | Contract                                                                 |
|------------------------|---------------------|------------------------|--------------------------------------------------------------------------|
| `workspaceId`          | `GET /api/flt/config` | C01, C03               | C03's "is my workspace targeted by this ring" check uses C01's value as ground truth. Never re-fetched independently. |
| `bearerToken` presence | `GET /api/flt/config` | C02, C05               | C02 displays expiry/state; C05 references it as "Silent CBA active" evidence. |
| `mwcToken` presence    | `GET /api/flt/config` + `POST /api/edog/mwc-token` | C02 only          | C02 owns reveal/refresh. Other cards never reach for MWC.                |
| Wrapper status         | `GET /api/edog/interceptors/status` | C03                    | C03 gates the toggle UI on `FeatureFlighter.Wrapped == true`. Disconnected = toggles disabled. |
| FLT phase              | `GET /api/studio/status` `phase` | All cards              | Disconnected vs. connected. Each card's empty/disabled state derives from this. |
| `lastDeployedAt`       | `_studio_state` (new, persisted via `.edog-session.json`) | C01, C04               | C04 displays prominently; C01 shows in line with config snapshot.        |
| `fltSync`              | dev-server in-memory | C03                    | Per §3.5 — drives override-row badges.                                   |
| `restartRequired`      | C05's response       | C03 and C05            | Either C05's auth-mode change or C03's "cached startup" change can set this. Both surfaces share one restart-FLT action. See §6. |

**No card reads from another card's UI state.** Cross-card communication happens through dev-server endpoints only; localStorage is for per-card collapse state only.

---

## 6. Three operating phases (rubber-duck §5)

Every card must handle three states, not two. P0 said "disconnected vs. connected"; that is insufficient. The third state — **connected-but-wrapper-inactive** — is observable in the wild because:

- ADR-005 documents that the wrapper is registered after FLT's initial DI graph builds. There is a narrow window where FLT is serving HTTP but `WireUp.Resolve<IFeatureFlighter>()` still returns the original.
- Worse, ADR-005 §3 ("the late-binding catch") notes that any consumer that captured `IFeatureFlighter` as a constructor parameter BEFORE the wrapper was registered will hold a reference to the original implementation for the lifetime of that consumer instance. The wrapper status endpoint can tell us whether *future* resolutions will return the wrapper, but it cannot tell us about already-captured references.

| Phase                           | `GET /api/studio/status` phase | `interceptors/status` `FeatureFlighter.Wrapped` | What works                          | Card behaviors |
|---------------------------------|-------------------------------|-------------------------------------------------|-------------------------------------|----------------|
| **disconnected**                | `disconnected`                | (endpoint not reachable)                        | C01, C04, C05 disk-backed reads; C03 catalog; C02 shows "deploy first" | Overrides POST stored locally, `fltSync: not-connected` |
| **connected, wrapper-inactive** | `connected`                   | `false`                                         | Everything except override effect verification | C03 shows orange "Interceptor inactive — Restart FLT" banner; toggles still functional but flagged as "may not take effect"; C03 row badges show `wrapper-inactive` |
| **connected and wrapped**       | `connected`                   | `true`                                          | All operations including live override evaluation | Normal operation |

The "may not take effect" qualifier is a hard truth from ADR-005: even in the connected-and-wrapped state, callers that pre-captured `IFeatureFlighter` references bypass the wrapper forever. C03's user-facing language must say "Overrides apply to **future** evaluations through the wrapper. To verify, watch the live evaluation stream." Do not promise "takes effect on the next call" in copy.

---

## 7. Performance budgets

These are **hard** targets. Failure means a P6 bug, not a P5 nit.

| Operation                                                  | Target  | Measurement                                            |
|------------------------------------------------------------|---------|--------------------------------------------------------|
| `wrapper.IsEnabled` overhead (no override)                 | < 10 µs | Stopwatch from EdogFeatureFlighterWrapper, p99         |
| `wrapper.IsEnabled` overhead (override hit)                | < 5 µs  | Skips `_inner.IsEnabled` entirely; only TryGet + Publish |
| `EdogFeatureOverrideStore.TryGet`                          | < 1 µs  | FrozenDictionary lookup; benchmark in unit test        |
| `EdogFeatureOverrideStore.ReplaceAll` for 100-entry map    | < 5 ms  | Freeze + Volatile.Write; benchmark in unit test        |
| Dev-server `POST /overrides` → response                    | < 50 ms | p95, no FLT round-trip needed for local-only override  |
| Dev-server `POST /overrides` → FLT echo verified           | < 200 ms| p95, includes one HTTP hop to FLT + hash compute       |
| Card 3 initial render (catalog + overrides + observed)     | < 800 ms| p95 from "tab clicked" to "table visible"              |
| Card 3 catalog force-refresh                               | < 2 s   | Includes `git fetch --depth=1` (per P0 §2)             |
| Whole panel initial render                                 | < 1.5 s | p95 from "tab clicked" to all five cards painted       |

Anything over budget gets a perf investigation, not a "good enough" pass. Sentinel enforces this in P6.

---

## 8. Error path matrix

| Endpoint                                  | Failure                            | Dev-server response                | UI behavior                                                  |
|-------------------------------------------|------------------------------------|------------------------------------|--------------------------------------------------------------|
| `GET /api/edog/feature-flags/catalog`     | FeatureManagement git fetch failed | 502, `{error, stale: bool, asOf}` | Render cached catalog with "stale" badge; offer retry        |
| `GET /api/edog/feature-flags/catalog`     | FLT repo missing FeatureNames.cs   | 500, `{error}`                     | Show fallback catalog (FM only); show config-warning toast   |
| `POST /api/edog/feature-flags/overrides`  | Validation (value !== true)        | 400, `{error: "force-OFF not supported"}` | Toast: "Force-OFF not supported in V1.1"             |
| `POST /api/edog/feature-flags/overrides`  | FLT 401 (token mismatch)           | 502, `{error: "control-token-mismatch", fltSync: failed}` | Toast: "FLT/dev-server token mismatch — restart"   |
| `POST /api/edog/feature-flags/overrides`  | FLT 5xx                            | 502, `{fltSync: failed}`           | Amber row dot + retry button                                 |
| `POST /api/edog/feature-flags/overrides`  | FLT unreachable                    | 200, `{fltSync: not-connected}`    | Override stored locally; pill: "Will apply on FLT start"     |
| `POST /api/edog/feature-flags/overrides`  | Bulk push echo hash mismatch       | 502, `{fltSync: failed}`           | Amber row dot + "verify with FLT" diagnostic                 |
| `DELETE /overrides/{flag}` for unknown    | unknown flag                       | 404, `{error: "no such override"}` | Silent — UI already removed the row                          |
| `GET /api/studio/status` returns disconnected | n/a                                | passthrough                        | C03 disables toggles; shows "FLT not running"                |
| `GET /api/edog/interceptors/status` `FeatureFlighter.Wrapped: false` | n/a              | passthrough                        | C03 banner: "Interceptor inactive — Restart FLT"             |

---

## 9. Concurrency model

- **Dev-server `_feature_overrides`**: protected by `_feature_overrides_lock` (threading.Lock). Hold during read-modify-write. Release before HTTP call to FLT.
- **FLT `EdogFeatureOverrideStore`**: lock-free read (volatile snapshot). Writes use snapshot-replace via `Volatile.Write` + `Interlocked.Exchange` for revision counter. No reader can ever see a partially-applied bulk update.
- **Wrapper IsEnabled vs ReplaceAll**: wrapper grabs the snapshot reference once (`var snap = _snapshot`); subsequent `snap.TryGetValue` reads from that reference. If `ReplaceAll` runs in parallel, the wrapper sees the *old* snapshot for this call, the *new* snapshot for the next. Both are consistent. This is the correctness property atomicity buys.
- **Catalog cache git fetch**: serialized via a single `asyncio.Lock` in dev-server. Concurrent catalog requests wait for the in-flight fetch.
- **SignalR `flag` topic publish from wrapper**: `EdogTopicRouter.Publish` is already documented as "never throws" (`EdogTopicRouter.cs:71-73`). No further guards needed.

---

## 10. DI registration timing (ADR-005 dependency)

The wrapper is registered via the same `RunAsync()` callback pattern documented in ADR-005:

```csharp
// In EdogDevModeRegistrar.cs
WireUp.RunAsync(async () => {
    var inner = WireUp.Resolve<IFeatureFlighter>();
    var wrapped = new EdogFeatureFlighterWrapper(inner);
    WireUp.RegisterInstance<IFeatureFlighter>(wrapped);
});
```

Three timing facts F11 must encode in UI behavior:

1. **First-request window.** Between FLT process start and wrapper registration completing, `IFeatureFlighter` resolves to the original. Calls during this window bypass the wrapper. Mitigation: do not surface "live override active" until the next `IsEnabled()` evaluation has been observed on the `flag` topic with `overridden: true`.

2. **Pre-captured-reference window (permanent).** Consumers that captured `IFeatureFlighter` via constructor injection BEFORE wrapper registration hold the original reference for their lifetime. There is no programmatic way to invalidate those references. Mitigation: C03 copy says "future evaluations" not "next call"; restart-FLT action is offered as the disambiguator.

3. **Wrapper status endpoint** (`GET /api/edog/interceptors/status`) reports whether `WireUp.Resolve<IFeatureFlighter>()` currently returns the wrapper. Use this for gating UI; do not use it as proof that all callers go through the wrapper.

---

## 11. Telemetry topics (no new topics)

F11 publishes only on the existing `flag` topic, with one new field (`overridden: bool`). No new SignalR topic, no new buffer registration. Existing buffer size (1000, per `EdogTopicRouter.cs:36`) is sufficient — typical FLT evaluates < 50 flags per request.

Override-write events are **not** published on a SignalR topic; they are observable via `GET /api/edog/feature-flags/overrides` (the source of truth) and via the next `flag` evaluation event (which will carry `overridden: true`).

---

## 12. Testing strategy

**Unit (Sentinel-gated):**

- `EdogFeatureOverrideStore` — `TryGet` returns expected, `ReplaceAll` swaps atomically, `ComputeHash` is deterministic and order-independent across input ordering.
- `EdogFeatureFlighterWrapper` — passes through when no override, short-circuits when override is `true`, publishes correct `flag` event in both paths.
- `dev-server.py` override route handlers — validation rejects `value: false`; revision monotonically increases; lock ordering does not deadlock under concurrent POST + DELETE.

**Integration:**

- Spin up `EdogLogServer` in-process. Hit `POST /overrides/bulk` with and without `X-EDOG-Control-Token`. Verify 401 and 200.
- Drive end-to-end: dev-server `POST` → FLT echo → `GET` round-trip. Verify hash agreement.
- Failure injection: stop EdogLogServer mid-test; verify dev-server returns `fltSync: not-connected`; restart; verify replay restores parity.

**E2E (manual, P7 CEO review):**

- Open Card 3. Toggle one flag ON. Watch the live evaluation stream emit `overridden: true` within 5 seconds (FLT IsEnabled call timing depends on FLT workload).
- Restart FLT. Verify override replays automatically.
- Restart dev-server. Verify FLT store clears (per §3.6 cold-start policy).

---

## 13. Open questions / deferred

- **Force-OFF (`value: false`)**: Out of scope V1.1. Asymmetric model is intentional — see C03 §1. If/when V2 enables force-OFF, the store schema is already `bool` and the wrapper logic is one branch change.
- **Multi-flag bulk UI**: V1.1 toggles one flag at a time. A "Force ON: enable list" mass-toggle could land in V1.2 without store changes — just changes the browser-side aggregation.
- **Override expiry**: V1.1 overrides live until cleared or dev-server restart. Time-bounded overrides (e.g., "force ON for 30 min") would require a background sweep on dev-server.
- **Cross-session override persistence**: Explicitly out of scope (§3.6). If a user demands it, the right move is `.edog-session.json` persistence in dev-server, not durable FLT-side storage. Architecture allows this addition without protocol changes.

---

*"What does this running FLT think is true?" — one snapshot, one writer, no SignalR gymnastics.*
