# EDOG Studio — Phased Implementation Plan

> **Author:** Nadia Kovács, Senior Technical Program Manager
> **Status:** ACTIVE — Living document
> **Source of Truth:** `docs/specs/design-spec-v2.md`
> **Team:** 9-agent hivemind (see `hivemind/agents/ROSTER.md`)
> **Last Updated:** 2026-04-09

---

## Part 1: Executive Summary

### Vision

EDOG Studio is a localhost developer cockpit at `http://localhost:5555` for FabricLiveTable (FLT) engineers. It replaces a fragmented workflow — separate terminal windows for logs, browser tabs for Fabric portal, manual config editing, ad-hoc cURL commands — with a single unified interface used 8+ hours/day.

The cockpit operates in two phases:

1. **Disconnected (Browse & Explore):** Bearer token → Fabric APIs → browse workspaces, lakehouses, tables. Manage feature flags. Test APIs. No FLT service required.
2. **Connected (Full DevTools):** Deploy to a lakehouse → MWC token → real-time logs, DAG Studio, Spark Inspector, API Playground with FLT endpoints.

### Scope

23 features across 3 phases, built on an existing foundation of C# interceptors (EdogLogServer, EdogApiProxy, EdogLogInterceptor, EdogTelemetryInterceptor), a Python CLI (edog.py), and a full mock-up prototype (19 JS modules, 19 CSS modules, single-file HTML build).

### Phase Timeline (Relative)

| Phase | Features | Dependency Gate |
|-------|----------|-----------------|
| **MVP** | 7 features | Enables core new workflow: browse → deploy → work |
| **V1.1** | 6 features | Completes the cockpit with all 6 views fully functional |
| **V2** | 10 features | Advanced features requiring new interceptors or partially-confirmed APIs |

No calendar dates. Ordering is by dependency chain and value delivered.

### Key Risks and Mitigations

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| Fabric API scopes insufficient for EDOG's cert-based token | Workspace Explorer, Deploy flow blocked | Medium | Runtime-verify all ⚠️ APIs early in MVP. Fallback: request scope changes from Fabric team. |
| Single-file HTML grows too large for maintainability | Build times, developer experience | Low | build-html.py already handles 19+19 modules. Monitor output size. |
| IPC channel reliability (file-based polling) | Restart, token refresh commands delayed | Medium | Implement file-based first (proven). If latency unacceptable, upgrade to edog.py HTTP server on :5556. |
| SVG DAG rendering performance for large graphs | DAG Studio unusable for complex DAGs | Medium | Virtual viewport + level-based layout. Test with 50+ node DAGs early. |
| Mock flag (`?mock=true`) adds dead code to production build | Bundle size, maintenance | Low | Mock modules are gated at runtime. No production code path references mock data without the flag check. |

---

## Part 2: Architecture Overview

### System Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        Developer's Machine                             │
│                                                                        │
│  ┌─────────────┐         ┌──────────────────────────────────────────┐  │
│  │  edog.py     │         │  FLT Service Process (dotnet)           │  │
│  │  (Python CLI)│         │                                          │  │
│  │             ├──patch──>│  ┌─────────────────────────────────┐    │  │
│  │  • Auth     │  +build  │  │  EdogLogServer (Kestrel :5555)  │    │  │
│  │  • Token    │  +launch │  │  • GET  /api/flt/config         │    │  │
│  │  • Patch    │          │  │  • GET  /api/logs               │    │  │
│  │  • Build    │          │  │  • GET  /api/telemetry           │    │  │
│  │  • Launch   │          │  │  • WS   /ws (log streaming)     │    │  │
│  │  • Watch    │          │  │  • POST /api/command/* (IPC)     │    │  │
│  │             │          │  └──────────┬──────────────────────┘    │  │
│  │  Port 5556  │◄─IPC────>│             │                           │  │
│  │  (control)  │  (.edog- │  ┌──────────┴──────────────────────┐    │  │
│  └─────────────┘  command)│  │  Interceptors (DI-injected)     │    │  │
│        │                  │  │  • EdogLogInterceptor           │    │  │
│        │ Playwright       │  │  • EdogTelemetryInterceptor     │    │  │
│        │ auth             │  │  • EdogFeatureFlighterWrapper   │ V1.1│  │
│        ▼                  │  │  • EdogTracingSparkClient       │ V2 │  │
│  ┌──────────┐             │  └─────────────────────────────────┘    │  │
│  │ Browser  │             └──────────────────────────────────────────┘  │
│  │ (cert    │                                                          │
│  │  login)  │                                                          │
│  └──────────┘                                                          │
│                                                                        │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │  Browser: EDOG Studio UI (localhost:5555)                       │   │
│  │                                                                  │   │
│  │  ┌──────────────────────────────────────────────────────────┐   │   │
│  │  │  Single HTML file (built by build-html.py)                │   │   │
│  │  │  19 CSS modules + 19 JS modules inlined                  │   │   │
│  │  │                                                           │   │   │
│  │  │  Views: Workspace | Logs | DAG | Spark | API | Env        │   │   │
│  │  │                                                           │   │   │
│  │  │  WebSocket ──→ EdogLogServer (log stream)                 │   │   │
│  │  │  fetch()   ──→ EdogLogServer (REST APIs)                  │   │   │
│  │  │  fetch()   ──→ api.fabric.microsoft.com (Fabric APIs)     │   │   │
│  │  │  fetch()   ──→ FLT service endpoints (MWC token)          │   │   │
│  │  └──────────────────────────────────────────────────────────┘   │   │
│  └─────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
```

### Data Flow: Token Serving

```
1. edog.py launches Playwright → cert-based login → AAD/Entra bearer token
2. Bearer token cached to .edog-token-cache (gitignored)
3. EdogApiProxy reads token → serves via GET /api/flt/config
4. Browser JS reads /api/flt/config on init → stores bearer token in memory
5. Browser uses bearer token for Fabric API calls (api.fabric.microsoft.com/v1/*)

On Deploy:
6. edog.py calls fetch_mwc_token(workspace_id) using bearer token
7. MWC token written to edog-config.json
8. edog.py patches FLT code with MWC token → builds → launches
9. EdogApiProxy now serves BOTH tokens via /api/flt/config
10. Browser uses MWC token for FLT service endpoints
```

### Data Flow: Log Streaming

```
FLT service → EdogLogInterceptor → captures Tracer.Write calls
  → EdogLogServer.AddLog(entry) → 10K ring buffer
  → WebSocket broadcast (150ms batched) → Browser
  → renderer.js → virtual scroll DOM → user sees live logs
```

### Data Flow: IPC (edog.py ↔ EdogLogServer)

```
Browser → POST /api/command/{action} → EdogLogServer
  → writes .edog-command/{action}.json to disk
  → edog.py polls .edog-command/ every 2-5s
  → executes command (restart, refresh-token, etc.)
  → writes .edog-command/{action}-result.json
  → EdogLogServer reads result → optional WebSocket notification
```

### New Components Per Phase

| Phase | Frontend (JS) | Frontend (CSS) | Backend (C#) | Python | Build |
|-------|---------------|----------------|--------------|--------|-------|
| **MVP** | `workspace-tree.js`, `deploy-flow.js`, `favorites.js`, `breakpoints.js`, `bookmarks.js` | Updates to existing modules | POST endpoints in EdogLogServer, bearer token in EdogApiProxy | Fabric API proxy in edog.py, favorites persistence | build-html.py module order updates |
| **V1.1** | `dag-graph.js`, `dag-gantt.js`, `api-playground.js`, `token-inspector.js`, `feature-flags.js`, `error-decoder.js`, `file-watcher-ui.js` | Updates to existing modules | `EdogFeatureFlighterWrapper.cs` | File watcher (watchdog), IPC command server, flag file parsing | Error code JSON generation script |
| **V2** | `spark-list.js`, `spark-detail.js`, `execution-compare.js`, `env-wizard.js`, `session-timeline.js` | Updates to existing modules | `EdogTracingSparkClient.cs`, `EdogTracingSparkClientFactory.cs` | Notebook API integration, environment cloning | — |

---

## Part 3: Feature Specs Index

Each feature has its own spec document in `docs/specs/features/`. Each spec follows Palantir-style format: Problem, Objective, Owner, Inputs, Outputs, Technical Design, Acceptance Criteria, Dependencies, Risks, Moonshot Vision.

### MVP (7 Features — Ship First)

| # | Feature | Owner | Spec | Status |
|---|---------|-------|------|--------|
| F01 | Workspace Explorer | Zara + Mika | [F01-workspace-explorer.md](specs/features/F01-workspace-explorer.md) | Not Started |
| F02 | Deploy to Lakehouse | Elena + Zara | [F02-deploy-to-lakehouse.md](specs/features/F02-deploy-to-lakehouse.md) | Not Started |
| F03 | Favorites / Named Environments | Zara + Elena | [F03-favorites-named-environments.md](specs/features/F03-favorites-named-environments.md) | Not Started |
| F04 | Enhanced Logs | Zara + Mika | [F04-enhanced-logs.md](specs/features/F04-enhanced-logs.md) | Not Started |
| F05 | Top Bar | Zara + Mika + Elena | [F05-top-bar.md](specs/features/F05-top-bar.md) | Not Started |
| F06 | Sidebar Navigation | Zara + Mika | [F06-sidebar-navigation.md](specs/features/F06-sidebar-navigation.md) | Not Started |
| F07 | Command Palette | Zara | [F07-command-palette.md](specs/features/F07-command-palette.md) | Not Started |

### V1.1 (6 Features — Completes the Cockpit)

| # | Feature | Owner | Spec | Status |
|---|---------|-------|------|--------|
| F08 | DAG Studio | Zara + Dev | [F08-dag-studio.md](specs/features/F08-dag-studio.md) | Not Started |
| F09 | API Playground | Zara + Dev | [F09-api-playground.md](specs/features/F09-api-playground.md) | Not Started |
| F10 | Token Inspector | Zara + Elena | [F10-token-inspector.md](specs/features/F10-token-inspector.md) | Not Started |
| F11 | Environment Panel | Elena + Zara + Arjun + Dev | [F11-environment-panel.md](specs/features/F11-environment-panel.md) | Not Started |
| F12 | Error Code Decoder | Zara + Ren + Dev | [F12-error-code-decoder.md](specs/features/F12-error-code-decoder.md) | Not Started |
| F13 | File Change Detection | Elena + Zara | [F13-file-change-detection.md](specs/features/F13-file-change-detection.md) | Not Started |

### V2 (10 Features — Advanced)

| # | Feature | Spec | Status |
|---|---------|------|--------|
| F14 | Spark Inspector | [F14-spark-inspector.md](specs/features/F14-spark-inspector.md) | Not Started |
| F15 | Execution Comparison | [F15-execution-comparison.md](specs/features/F15-execution-comparison.md) | Not Started |
| F16 | New Test Environment Wizard | [F16-new-test-environment-wizard.md](specs/features/F16-new-test-environment-wizard.md) | Not Started |
| F17 | Service Restart from UI | [F17-service-restart-from-ui.md](specs/features/F17-service-restart-from-ui.md) | Not Started |
| F18 | Session History/Timeline | [F18-session-history-timeline.md](specs/features/F18-session-history-timeline.md) | Not Started |
| F19 | Capacity Health Indicator | [F19-capacity-health-indicator.md](specs/features/F19-capacity-health-indicator.md) | Not Started |
| F20 | Quick Environment Clone | [F20-quick-environment-clone.md](specs/features/F20-quick-environment-clone.md) | Not Started |
| F21 | DAG Definition Viewer | [F21-dag-definition-viewer.md](specs/features/F21-dag-definition-viewer.md) | Not Started |
| F22 | Table Schema/Preview/Stats | [F22-table-schema-preview-stats.md](specs/features/F22-table-schema-preview-stats.md) | Not Started |
| F23 | CRUD Operations (Fabric Items) | [F23-crud-operations-fabric-items.md](specs/features/F23-crud-operations-fabric-items.md) | Not Started |

---

## Part 4: Cross-Cutting Concerns

### Mock Flag: How `?mock=true` Works

**Principle:** Mock data stays in the build but never executes in production mode.

```
On page load (main.js init):
  const useMock = new URLSearchParams(window.location.search).get('mock') === 'true';

  if (useMock) {
    MockRenderer.init();   // Renders mock data into all views
  } else {
    App.init();            // Real API connections, WebSocket, live data
  }
```

- `mock-data.js` — Static data objects for all views (workspaces, logs, DAG nodes, etc.)
- `mock-renderer.js` — Populates UI using mock data objects
- Both files remain in `build-html.py` module list, always included in output
- Real modules (workspace-explorer.js, renderer.js, etc.) are also always included
- The mock flag determines which initialization path runs — both code paths exist but only one executes
- Testing: `make test-mock` opens browser with `?mock=true` for visual verification

### Testing Strategy

| Layer | Framework | What to Test | How |
|-------|-----------|-------------|-----|
| **Python** | pytest | Token parsing, config management, build script, favorites I/O, flag file parsing, IPC command handling | `make test` (runs pytest) |
| **C#** | MSTest | EdogFeatureFlighterWrapper behavior, log model serialization, API proxy response format | `dotnet test` in FLT solution |
| **JavaScript** | Manual browser | All 6 views render, keyboard shortcuts work, WebSocket streaming, filter controls, command palette | Browser testing checklist per ENGINEERING_STANDARDS.md |
| **Integration** | End-to-end manual | Deploy flow, token refresh, phase transitions, IPC commands | Launch edog, walk through full workflow |
| **Build** | Automated | `build-html.py` produces valid single-file HTML, no external resources | `make build` + validate output |

**Per-feature test requirements:**

- Every Python function gets a pytest test
- Every C# public method gets an MSTest test
- Every new JS view gets a browser testing checklist entry
- No feature ships without passing `make lint && make test && make build`

### Build Pipeline Evolution

**Current (`build-html.py`):**

```
CSS modules (19) + JS modules (19) + index.html → single edog-logs.html
```

**MVP additions:**

- No new modules — existing modules updated in place
- Module order may need adjustment if new JS classes have dependencies

**V1.1 additions:**

New JS modules added to `JS_MODULES` list in `build-html.py`:
- `js/dag-graph.js` (after `control-panel.js`)
- `js/dag-gantt.js` (after `dag-graph.js`)
- `js/api-playground.js` (after `command-palette.js`)
- `js/token-inspector.js` (after `topbar.js`)
- `js/feature-flags.js` (after `workspace-explorer.js`)
- `js/error-decoder.js` (after `error-intel.js`)
- `js/file-watcher-ui.js` (after `topbar.js`)

Error codes JSON inlined as a `<script>` block or embedded in `error-decoder.js`.

**V2 additions:**

- `js/spark-list.js`, `js/spark-detail.js`
- `js/execution-compare.js`
- `js/env-wizard.js`
- `js/session-timeline.js`

**Build ownership:** Ren Aoki. All module order changes must be approved by Ren.

### IPC Architecture: edog.py ↔ EdogLogServer

**File-based command channel (MVP implementation):**

```
Directory: .edog-command/ (in project root, gitignored)

Command flow:
  Browser → POST /api/command/{action} → EdogLogServer
    → writes .edog-command/{action}.json with payload
    → edog.py polls .edog-command/ every 2 seconds
    → reads command file, executes, deletes command file
    → writes .edog-command/{action}-result.json
    → EdogLogServer reads result on next poll or via WebSocket notification

Commands:
  deploy          {workspaceId, artifactId, capacityId}
  restart         {}
  refresh-token   {}
  set-overrides   {overrides: {flagName: bool, ...}}
```

**Alternative (V1.1 upgrade if latency unacceptable):**

```
edog.py runs HTTP server on port 5556
  POST :5556/command/restart
  POST :5556/command/refresh-token
  POST :5556/command/deploy

EdogLogServer proxies /api/command/* to :5556
Browser still talks to :5555 only
```

### Token Flow

| Phase | Token | Source | Used For |
|-------|-------|--------|----------|
| **Disconnected** | AAD/Entra Bearer | Playwright cert-based login → edog.py → EdogApiProxy → browser | Fabric public APIs (`api.fabric.microsoft.com/v1/*`) |
| **Connected** | Bearer + MWC | Bearer (same) + `fetch_mwc_token()` for specific workspace | Bearer: Fabric APIs. MWC: FLT service endpoints. |

**Token lifecycle:**

1. edog.py authenticates via Playwright → caches bearer token
2. On deploy: edog.py calls `fetch_mwc_token(workspace_id)` using bearer token → caches MWC token
3. EdogApiProxy reads both cached tokens → serves via `/api/flt/config`
4. Browser JS stores tokens in memory (never localStorage)
5. Token countdown in top bar tracks nearest expiry
6. On expiry: Token Inspector auto-opens. "Refresh" triggers IPC → edog.py re-authenticates.

**Security rules:**
- Tokens never logged (even in debug mode)
- Token cache file (`.edog-token-cache`) is gitignored, user-read-only permissions
- API proxy validates requests are from localhost only

### Error Handling Philosophy

**Three tiers:**

1. **User-facing errors (UI):** Toast notifications with clear message + suggested action. Example: "Cannot list workspaces — token may have expired. [Refresh Token]"

2. **Operational errors (logs):** Specific exception types, never bare `except`. Example:
   ```python
   except FabricApiError as e:
       log.error(f"Fabric API {e.endpoint} returned {e.status}: {e.message}")
       notify_ui("api_error", {"endpoint": e.endpoint, "status": e.status})
   ```

3. **Infrastructure errors (build/deploy):** Clear step-level failure with context. Example: "Deploy failed at Step 3/5: Build error — see terminal output"

**Never:**
- Swallow exceptions silently
- Show raw stack traces to users
- Retry indefinitely without backoff
- Show "Something went wrong" without actionable next steps

---

## Part 5: Dependency Graph

### Feature Dependencies

```
                    ┌──────────────────┐
                    │  EdogApiProxy    │
                    │  (bearer token   │
                    │   in config)     │
                    └────────┬─────────┘
                             │
               ┌─────────────┼─────────────┐
               │             │             │
               ▼             ▼             ▼
    ┌──────────────┐  ┌────────────┐  ┌────────────┐
    │ F1: Workspace│  │ F5: Top Bar│  │ F6: Sidebar│
    │    Explorer  │  │            │  │            │
    └──────┬───────┘  └─────┬──────┘  └─────┬──────┘
           │                │               │
           │    ┌───────────┼───────────────┘
           │    │           │
           ▼    ▼           ▼
    ┌──────────────┐  ┌────────────┐
    │ F2: Deploy   │  │ F7: Command│
    │ to Lakehouse │  │   Palette  │
    └──────┬───────┘  └────────────┘
           │
           ▼
    ┌──────────────┐
    │ F3: Favorites│
    └──────────────┘

    ┌──────────────┐
    │ F4: Enhanced │   (independent — no feature dependencies)
    │    Logs      │
    └──────────────┘
```

### MVP Execution Order

```
Wave 1 (parallel — no dependencies between them):
  ├── F1: Workspace Explorer  (Zara + Mika + Dev)
  ├── F4: Enhanced Logs       (Zara + Mika)
  ├── F5: Top Bar             (Zara + Mika + Elena)
  └── F6: Sidebar             (Zara + Mika)

Wave 2 (depends on Wave 1):
  ├── F2: Deploy to Lakehouse (Elena + Zara + Arjun)  ← needs F1, F5, F6
  └── F7: Command Palette     (Zara)                  ← needs F1, F6

Wave 3 (depends on Wave 2):
  └── F3: Favorites           (Zara + Elena)          ← needs F1, F2
```

### V1.1 Execution Order

```
Wave 4 (parallel — all depend on MVP being complete):
  ├── F8:  DAG Studio          (Zara + Dev)         ← needs connected phase
  ├── F9:  API Playground      (Zara + Dev)         ← needs token serving
  ├── F10: Token Inspector     (Zara + Elena)       ← needs token serving
  └── F12: Error Code Decoder  (Zara + Ren + Dev)   ← needs build script

Wave 5 (depends on Wave 4):
  ├── F11: Environment Panel   (Elena + Zara + Arjun + Dev)  ← needs IPC + connected phase
  └── F13: File Change Detect  (Elena + Zara)                ← needs IPC channel
```

### V2 Execution Order

```
Wave 6 (parallel):
  ├── F14: Spark Inspector     (Arjun + Zara)       ← new C# interceptor
  ├── F17: Service Restart     (Elena + Zara)        ← uses existing IPC
  ├── F18: Session Timeline    (Zara)                ← client-side only
  └── F19: Capacity Health     (Zara + Dev)          ← API research needed

Wave 7 (depends on Wave 6):
  ├── F15: Execution Compare   (Zara)                ← needs F8 (DAG Studio)
  ├── F21: DAG Definition      (Zara + Dev)          ← needs F8 + Notebook API
  └── F22: Table Schema        (Zara + Dev)          ← needs SQL endpoint research

Wave 8 (depends on Wave 7):
  ├── F16: Test Env Wizard     (Elena + Zara)        ← needs API research complete
  ├── F20: Quick Env Clone     (Elena + Zara)        ← needs F16 research
  └── F23: CRUD Operations     (Zara + Dev)          ← extends F1
```

### Parallelization Summary

| Phase | Max Parallel Streams | Bottleneck |
|-------|---------------------|------------|
| MVP Wave 1 | 4 features | Zara is on all 4 — stagger starts |
| MVP Wave 2 | 2 features | Elena needed for Deploy + IPC setup |
| MVP Wave 3 | 1 feature | Sequential after deploy flow works |
| V1.1 Wave 4 | 4 features | Zara is on all 4 — stagger by complexity |
| V1.1 Wave 5 | 2 features | Arjun needed for C# interceptor |

**Agent utilization across MVP:**

| Agent | Wave 1 | Wave 2 | Wave 3 |
|-------|--------|--------|--------|
| Zara (JS) | F1, F4, F5, F6 | F2 (UI), F7 | F3 |
| Mika (CSS) | F1, F4, F5, F6 | — | — |
| Elena (Python) | F5 (config) | F2 (deploy) | F3 (persistence) |
| Arjun (C#) | — | F2 (endpoints) | — |
| Dev (FLT) | F1 (API review) | — | — |
| Kael (UX) | Review all | Review all | Review all |
| Sana (Arch) | — | F2 (IPC review) | — |
| Ines (QA) | Test all | Test all | Test all |
| Ren (Build) | — | — | — |

---

*"A plan is not a schedule. It's a dependency map with named owners and testable exit criteria. Everything else is noise."*

— Nadia Kovács