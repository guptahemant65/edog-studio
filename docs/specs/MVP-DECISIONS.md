# EDOG Playground — MVP Feature Decisions & Open Questions

> **Project:** EDOG Playground (formerly EDOG Studio)
> **Date:** 2026-04-09
> **Status:** MVP decisions locked by CEO, open for team questions
> **Platform:** Web app (localhost, single HTML file)

---

## MVP FEATURES (7 features, ship this week)

### F01: Workspace Explorer
**Status:** 70% built, needs MWC token flow for tables

| Decision | Resolution | Rationale |
|----------|-----------|-----------|
| When to generate MWC tokens? | **Auto-generate on workspace expand** | Senior engineer expects instant table listing on lakehouse click. No 2s wait. |
| Tables for schema-enabled lakehouses? | Via `MwcToken` auth on capacity host DataArtifact endpoint | FLT always uses schema-enabled. Public API returns 400 for these. |
| What token scheme for capacity host? | `Authorization: MwcToken {token}` (NOT Bearer) | Discovered by decompiling CreateHttpMWCTokenClient |
| Required header for capacity host? | `x-ms-workload-resource-moniker: {lakehouseId}` | Required by all Lakehouse service endpoints |

**Open questions for team:**
- [ ] Should non-lakehouse items (notebooks, pipelines) be clickable to show metadata, or just "Open in Fabric" link?
- [ ] How many workspaces do we expect? Need pagination or infinite scroll beyond 50?

---

### F02: Deploy to Lakehouse
**Status:** Mock flow exists, needs real implementation

| Decision | Resolution | Rationale |
|----------|-----------|-----------|
| Where does deploy logic run? | **Embedded in web server** (single process) | No separate edog.py terminal needed. Simpler. |
| MWC token for deploy? | **Reuse from workspace expand** (already cached) | Don't fetch twice. TokenManager pool keyed by ws:lh:cap. |
| Deploy steps | Config update → patch code → dotnet build → launch FLT | Same as edog.py but driven from web server |

**Open questions for team:**
- [ ] Should deploy automatically trigger FLT build, or offer "patch only" vs "patch + build + launch"?
- [ ] What's the FLT repo path? Auto-detect from git, or user configures at setup?
- [ ] Should we support deploying to a lakehouse that's already deployed (hot-swap)?

---

### F03: Favorites
**Status:** Done (localStorage)

| Decision | Resolution | Rationale |
|----------|-----------|-----------|
| Scope of favorites? | **Per-tenant** | Different tenants have different workspaces/lakehouses |
| Storage? | localStorage keyed by tenant name | Simple, no server needed |

**Open questions for team:**
- [ ] Should favorites include "last deployed" timestamp?
- [ ] One-click deploy from favorites?

---

### F04: Runtime View (THE BIG ONE)
**Status:** 0% — needs full UI/UX design + C# interceptors

**Layout:**
```
┌─ RUNTIME VIEW ───────────────────────────────────────────────────┐
│ [Logs] [Telemetry] [System Files] [Spark Sessions] [Internals ▾]│
│                                                     ├─ Tokens    │
│                                                     ├─ Caches    │
│                                                     ├─ HTTP Pipe │
│                                                     ├─ Retries   │
│                                                     ├─ Flags     │
│                                                     ├─ DI        │
│                                                     └─ Perf      │
│ ─────────────────────────────────────────────────────────────── │
│                                                                   │
│  (each sub-view has its OWN tailored layout)                      │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

| Decision | Resolution | Rationale |
|----------|-----------|-----------|
| Tab structure? | 4 top-level + Internals dropdown (7 sub-views) | Logs/Telemetry/SysFiles/Spark are constant-use, Internals are deep-debug |
| Each sub-view layout? | **Own tailored layout** (not unified stream) | Tokens need TTL gauges, Caches need key/value tables, HTTP needs waterfall |
| All in MVP? | **Yes, but ship in sub-phases** | Phase A: Logs + Telemetry (existing). Phase B: System Files + Tokens. Phase C: Rest of Internals. |
| C# interceptors? | 7 new interceptors, all via WebSocket | Same pattern as existing EdogLogInterceptor |
| Content visibility? | **Full content, full token, no security restrictions** | Internal tool, 15 trusted engineers, localhost only |

**Sub-views that need UI/UX design:**

| Sub-view | Data shape | Layout needed | C# interceptor |
|----------|-----------|---------------|-----------------|
| **Logs** | Existing | Existing (enhance with breakpoints + bookmarks) | Existing EdogLogInterceptor |
| **Telemetry** | Existing | Existing SSR cards | Existing EdogTelemetryInterceptor |
| **System Files** | File ops: path, op, content, size, TTL, metadata | Stream + click-to-expand content + active locks panel | NEW: EdogFileSystemInterceptor (IFileSystem decorator) |
| **Spark Sessions** | Session create/reuse/dispose, MLV command→cell map, timeout | Session cards with lifecycle timeline | NEW: EdogSparkSessionInterceptor |
| **Tokens** | Token type, scheme, audience, TTL, JWT claims, usage stream | Active tokens panel + usage stream + JWT decode | NEW: EdogTokenInterceptor (DelegatingHandler) |
| **Caches** | 10 cache managers, get/set/evict with full content + iterationId | Cache list + entry table + content viewer | NEW: Cache wrappers per manager |
| **HTTP Pipeline** | URL, method, status, duration, retries, correlation IDs | Waterfall chart / request list (like Chrome DevTools Network) | NEW: EdogHttpPipelineInterceptor (DelegatingHandler) |
| **Retries & Throttling** | Retry attempts, delays, 429/430 responses, rate limiter state | Retry timeline + throttle state dashboard | NEW: EdogRetryInterceptor (hooks into RetryPolicyProviderV2) |
| **Feature Flag Evals** | flagName, tenantId, capacityId, workspaceId, result | Stream table: flag | inputs | result (true/false colored) | NEW: EdogFeatureFlighterWrapper (IFeatureFlighter decorator) |
| **DI Registry** | 25+ registrations from WorkloadApp.cs | Static table: type → implementation → lifetime | NEW: Capture at startup (one-time dump) |
| **Perf Markers** | Operation name, duration, success/fail | Timeline bars / sorted-by-duration table | NEW: EdogPerfMarkerInterceptor |

**Open questions for team:**
- [ ] For System Files — should we show READ operations too, or only WRITE/CREATE/DELETE? (Reads are noisy but useful for "what did it look for?")
- [ ] For Caches — should we show a real-time entry count/size summary at the top of each cache, or just the operation stream?
- [ ] For HTTP Pipeline — should this replace the existing Spark Inspector (F14) concept, or are they separate views?
- [ ] For Retries — should we show a visual retry timeline (like: attempt 1 → 20s wait → attempt 2 → 40s wait → attempt 3 → success)?
- [ ] For Feature Flags — should we allow TOGGLING flags from this view (like the Environment panel), or keep it read-only here?
- [ ] For DI Registry — is a one-time dump at startup enough, or do we need to detect runtime re-registrations?
- [ ] Should the Internals dropdown remember the last-selected sub-view across sessions?

---

### F05: Top Bar
**Status:** Mostly done

| Decision | Resolution | Rationale |
|----------|-----------|-----------|
| Brand name? | **EDOG Playground** | CEO rename |
| What to show? | `EDOG Playground | {TenantName} | {ServiceStatus} | Token: {TTL} | {gitBranch} | {patches} | [Restart]` | Tenant name yes, workspace/lakehouse no (visible in tree) |
| Capacity health? | Show in Capacity Command Center view (F24), not top bar | Too crowded for top bar |

**Open questions for team:**
- [ ] Should the Restart button do a full rebuild or just restart the FLT process?
- [ ] Should token countdown show all active MWC tokens or just the "main" one?

---

### F06: Sidebar Navigation
**Status:** Done, needs enhancement

| Decision | Resolution | Rationale |
|----------|-----------|-----------|
| Show all icons? | **Yes, all 6 — grayed out for unavailable** | Engineers know what's coming, creates anticipation |
| Icon hover? | **Show view name tooltip on hover** | Discoverability without labels taking space |
| Phase-aware? | Connected-only views grayed with "Deploy to enable" message | Clear action path |

**Open questions for team:**
- [ ] Should sidebar icons show a badge/dot for activity? (e.g., red dot on Logs when errors streaming, green dot on DAG when execution running)
- [ ] Keyboard shortcuts 1-6 for view switching — keep or change?

---

### F07: Command Palette (Ctrl+K)
**Status:** Existing, needs wiring to real data

| Decision | Resolution | Rationale |
|----------|-----------|-----------|
| MVP scope? | **Navigate + Deploy + Quick Actions** | No search-across-logs in MVP |
| Navigate commands? | Switch views, jump to workspace/lakehouse/table | From cached workspace tree data |
| Deploy commands? | "Deploy to {lakehouse name}" for each favorited + recent lakehouse | One-keystroke deploy |
| Quick actions? | Refresh token, restart service, clear logs, force unlock | Common debug actions |

**Open questions for team:**
- [ ] Should Ctrl+K also work as a quick search across table names?
- [ ] Should recent commands be shown at the top (like VS Code's command palette)?
- [ ] Fuzzy match or prefix match?

---

## STARTUP FLOW (cross-cutting)

```
Tenant Selection → Authenticate (Playwright) → Dashboard → Browse → Deploy
```

| Decision | Resolution |
|----------|-----------|
| Tenant config? | Configurable list in edog-config.json |
| Token caching? | Bearer: 1 per tenant (disk). MWC: N per session (memory, keyed by ws:lh:cap) |
| MWC auto-generate? | On workspace expand (background, for each lakehouse visible) |
| MWC reuse? | Yes — deploy reuses cached MWC from expand |

**Open questions for team:**
- [ ] Should we support multiple tenants simultaneously (split-screen comparing PPE vs staging)?
- [ ] Token auto-refresh: silent in background, or show a notification?

---

## CROSS-CUTTING DECISIONS

| Topic | Decision |
|-------|---------|
| Project name | **EDOG Playground** |
| Platform | **Web app** (evaluated WinUI 3, decided web looks better) |
| Security | **None** — internal tool, localhost, trusted engineers |
| Performance | Lazy view loading + web workers + virtual rendering (documented in PERFORMANCE_ARCHITECTURE.md) |
| Robustness | Error isolation + graceful degradation (documented in ROBUSTNESS_ARCHITECTURE.md) |
| Token auth | Bearer (PBI audience) for redirect host, MwcToken for capacity host |
| OneLake access | Runtime interception only (no direct access with PBI token) |

---

## TEAM: Please add your questions below

### PM Questions
- 

### Engineering Questions (Arjun — C#)
- 

### Engineering Questions (Elena — Python)
- 

### Engineering Questions (Zara — Frontend JS)
- 

### Engineering Questions (Dev — FLT Domain)
- 

### Engineering Questions (Mika — CSS/Visual)
- 

### QA Questions (Ines)
- 

### DevOps Questions (Ren)
- 
