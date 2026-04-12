# F04 Runtime View — Implementation Progress Tracker

> **Feature:** F04 Runtime View (Debugging Cockpit)
> **Plan:** `docs/superpowers/plans/2026-04-12-f04-runtime-view-master-plan.md`
> **Started:** 2026-04-12
> **CEO:** Hemant Gupta
> **Mandate:** Zero bugs. Supreme quality. Ask before assuming.

---

## Phase 0: Interactive Mocks (11 tabs)

Each mock is a standalone HTML file CEO reviews in browser before approval.

| # | Tab | States | File | Status | Approved |
|---|-----|--------|------|--------|----------|
| 01 | **Logs** | 97 | `docs/design/mocks/f04-mock-01-logs.html` | ✅ DONE | ✅ 2026-04-12 |
| 02 | **Telemetry** | 13 | `docs/design/mocks/f04-mock-02-telemetry.html` | ✅ DONE | ✅ 2026-04-12 |
| 03 | **System Files** | 14 | `docs/design/mocks/f04-mock-03-system-files.html` | ✅ DONE | ✅ 2026-04-12 |
| 04 | **Spark Sessions** | 14 | `docs/design/mocks/f04-mock-04-spark-sessions.html` | ✅ DONE | ✅ 2026-04-12 |
| 05 | **Tokens** | 6 | `docs/design/mocks/f04-mock-05-tokens.html` | ✅ DONE | ✅ 2026-04-12 |
| 06 | **Caches** | 5 | `docs/design/mocks/f04-mock-06-caches.html` | ✅ DONE | ✅ 2026-04-12 |
| 07 | **HTTP Pipeline** | 6 | `docs/design/mocks/f04-mock-07-http-pipeline.html` | ✅ DONE | ✅ 2026-04-12 |
| 08 | **Retries** | 5 | `docs/design/mocks/f04-mock-08-retries.html` | ✅ DONE | ✅ 2026-04-12 |
| 09 | **Feature Flags** | 6 | `docs/design/mocks/f04-mock-09-feature-flags.html` | ✅ DONE | ✅ 2026-04-12 |
| 10 | **DI Registry** | 5 | `docs/design/mocks/f04-mock-10-di-registry.html` | ✅ DONE | ✅ 2026-04-12 |
| 11 | **Perf Markers** | 7 | `docs/design/mocks/f04-mock-11-perf-markers.html` | ✅ DONE | ✅ 2026-04-12 |

**Phase 0 gate: ✅ ALL 11 MOCKS CEO-APPROVED → proceed to Phase 1.**

---

## Phase 1: SignalR + MessagePack Foundation (ADR-006)

| Task | Description | Status |
|------|-------------|--------|
| 1.1 | Add SignalR.Protocols.MessagePack NuGet | ✅ Switched to JSON (NuGet conflict) |
| 1.2 | Create EdogPlaygroundHub.cs (Subscribe/Unsubscribe groups) | ✅ DONE |
| 1.3 | Migrate EdogLogServer from raw WS to SignalR hub | ✅ DONE |
| 1.4 | Inline @microsoft/signalr JS client in build-html.py | ✅ DONE (47KB) |
| 1.5 | Replace websocket.js with SignalR client (group-aware) | ✅ DONE |
| 1.6 | Verify existing logs + telemetry still stream correctly | ✅ VERIFIED via agent-browser |

**Phase 1 gate: ✅ Sentinel gauntlet passed + browser verified (3788→4570 logs in 5s) → proceed to Phase 2.**

---

## Phase 2: C# Interceptors (7 new)

| Task | Interceptor | DI Pattern | Status |
|------|-------------|------------|--------|
| 2.1 | EdogFileSystemInterceptor | IFileSystem decorator | ⬜ PENDING |
| 2.2 | EdogSparkSessionInterceptor | NotebookExecutionContext wrapper | ⬜ PENDING |
| 2.3 | EdogTokenInterceptor | DelegatingHandler | ⬜ PENDING |
| 2.4 | EdogCacheInterceptor\<T\> | ICacheManager decorator (×10) | ⬜ PENDING |
| 2.5 | EdogHttpPipelineInterceptor | DelegatingHandler (4 clients) | ⬜ PENDING |
| 2.6 | EdogRetryInterceptor | RetryPolicyProviderV2 hook | ⬜ PENDING |
| 2.7 | EdogFeatureFlighterWrapper | IFeatureFlighter (ADR-005) | ⬜ PENDING |

**Phase 2 gate:** dotnet build + interceptor isolation tests + Sentinel → Phase 3.

---

## Phase 3: Frontend + Wiring (11 tabs)

| Tab | JS Module | CSS Module | Wired to SignalR | Status |
|-----|-----------|------------|------------------|--------|
| Logs | renderer.js (modify) | logs.css (modify) | log group | ⬜ PENDING |
| Telemetry | telemetry.js (modify) | telemetry.css (modify) | telemetry group | ⬜ PENDING |
| System Files | system-files.js (new) | system-files.css (new) | fileop group | ⬜ PENDING |
| Spark Sessions | spark-sessions.js (new) | spark.css (modify) | spark group | ⬜ PENDING |
| Tokens | tokens.js (new) | token-inspector.css (modify) | token group | ⬜ PENDING |
| Caches | caches.js (new) | caches.css (new) | cache group | ⬜ PENDING |
| HTTP Pipeline | http-pipeline.js (new) | http-pipeline.css (new) | http group | ⬜ PENDING |
| Retries | retries.js (new) | retries.css (new) | retry group | ⬜ PENDING |
| Feature Flags | feature-flags.js (new) | feature-flags.css (new) | flag group | ⬜ PENDING |
| DI Registry | di-registry.js (new) | di-registry.css (new) | di group | ⬜ PENDING |
| Perf Markers | perf-markers.js (new) | perf-markers.css (new) | perf group | ⬜ PENDING |

**Phase 3 gate:** Full gauntlet per tab + CEO browser review → Phase 4.

---

## Phase 4: Testing

| Task | Description | Status |
|------|-------------|--------|
| 4.1 | Python tests for SignalR integration | ⬜ PENDING |
| 4.2 | C# MSTest for all 7 interceptors | ⬜ PENDING |
| 4.3 | State matrix walkthrough (200+ states in browser) | ⬜ PENDING |
| 4.4 | Performance: 1000 msg/s sustained, 10K buffer, <5ms/entry | ⬜ PENDING |
| 4.5 | Regression: F01-F03, F05-F07 still work | ⬜ PENDING |
| 4.6 | Sentinel APPROVED verdict | ⬜ PENDING |
| 4.7 | CEO final sign-off | ⬜ PENDING |

---

## Decision Log

| Date | Decision | By |
|------|----------|----|
| 2026-04-12 | Design Bible is supreme authority (AUTHORITY.md created) | CEO |
| 2026-04-12 | ADR-006 SignalR + MessagePack is the transport foundation | CEO (prior) |
| 2026-04-12 | Mocks first → CEO approval → SignalR → interceptors → frontend → testing | CEO |
| 2026-04-12 | Light theme is the default (not dark) | CEO |
| 2026-04-12 | Breakpoint marker-wise filtering added to Logs spec | CEO |
| 2026-04-12 | All 11 tabs in scope — no phasing out, ship everything | CEO |
| 2026-04-12 | Agents may override Design Bible if they have more advanced ideas | CEO |
| 2026-04-12 | Zero bugs mandate — ask before assuming, no exceptions | CEO |
| 2026-04-12 | JSON protocol (MessagePack NuGet conflict with FLT) | Vex + CEO |
| 2026-04-12 | Future-proof: zero hardcoding, auto-detect everything | CEO |
| 2026-04-12 | ChannelReader streaming with snapshot hydration (replaces REST+groups) | CEO + Sana |
| 2026-04-12 | Sidebar Option A: Runtime View as parent with internal tab bar | CEO |
| 2026-04-12 | 9 interceptors (not 7) — includes DI Registry + Perf Markers | Sana |
| 2026-04-12 | Caches tab: 2 real caches in FLT (not 10) — mock needs updating | Sana (audit) |
| 2026-04-12 | DateTimeOffset.UtcNow for all new event models (not DateTime) | Audit finding |
| 2026-04-12 | CORS restricted to localhost/127.0.0.1 only (not wildcard) | Audit finding |
| 2026-04-12 | Interceptor idempotency guard: skip if already wrapped | Audit finding |
| 2026-04-12 | Flat file layout for interceptors (no Interceptors/ subdir) | Plan decision |

---

## Audit Findings (2 audits, 2026-04-12)

28 total findings (12 blocking, 16 non-blocking). Key fixes incorporated:

| Finding | Status |
|---------|--------|
| No snapshot hydration | ✅ Fixed: ChannelReader streaming (SIGNALR_PROTOCOL.md v2) |
| No batching/backpressure | ✅ Fixed: TopicBuffer + bounded channel + DropOldest |
| Task.Run per event | ✅ Fixed: synchronous Publish to TopicRouter |
| Event ordering | ✅ Fixed: monotonic sequenceId per topic |
| Memory budget undefined | ✅ Fixed: per-topic sizes, 50MB total |
| Security redaction | ✅ Fixed: per-field rules in protocol spec |
| ADR-006 stale | ✅ Fixed: addendum added |
| Single onMessage callback | ✅ Fixed: topic event bus in protocol spec v2 |
| Interceptor stacking | Documented: idempotency guard pattern |
| DateTime serialization | Documented: DateTimeOffset.UtcNow rule |
| CORS too permissive | Documented: restrict to localhost |
| Sidebar architecture | ✅ Decided: Option A (Runtime parent + sub-tabs) |
| 7 vs 9 interceptors | Documented: 9 is correct |
| Caches mock wrong (10 vs 2) | Documented: update mock before Phase 3 |

---

## Notes for Future Sessions

- Master plan: `docs/superpowers/plans/2026-04-12-f04-runtime-view-master-plan.md`
- Phase 2 plan: `docs/superpowers/plans/2026-04-12-phase2-interceptors.md`
- SignalR protocol: `docs/specs/SIGNALR_PROTOCOL.md` (v2 — streaming architecture)
- Authority hierarchy: `hivemind/AUTHORITY.md` (Design Bible = Tier 0 supreme)
- State matrix: `docs/specs/features/F04-runtime-view/states.md` (200+ states)
- Design Bible: `docs/design/design-bible-part{1,2,3,4a,4b,4c}.html`
- ADR-006: `docs/adr/ADR-006-signalr-messagepack.md` (SignalR + JSON addendum)
- Mocks directory: `docs/design/mocks/` (11 individual + 1 integrated)
- FLT data audit: verified 9 interfaces, 11 data gaps, 7 LOW risk, 2 MEDIUM
- Final audit: 28 findings (12 blocking → all addressed or documented)
