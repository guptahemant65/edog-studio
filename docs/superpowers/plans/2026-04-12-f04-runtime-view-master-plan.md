# F04 Runtime View — Master Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the complete F04 Runtime View — all 11 tabs, 200+ states, 7 C# interceptors, SignalR transport, with zero bugs and pitch-perfect visual quality matching the Design Bible.

**Architecture:** Five sequential phases, each gated by CEO approval before proceeding: (0) Standalone interactive mock pages for all 11 tabs → (1) SignalR + MessagePack transport migration → (2) C# interceptors for all 7 new data sources → (3) Real frontend modules + backend wiring + integration → (4) Full testing suite. Every phase runs Sentinel's full gauntlet (make lint + make test + make build + manual browser check).

**Tech Stack:** Vanilla JS (class-based modules), CSS (Design Bible tokens), C# (ASP.NET Core SignalR + MessagePack), Python (dev-server, build-html.py), pytest

**CEO Directive (2026-04-12):** "Supreme quality. Crazy interactions. Crazy smoothness. Level of sophistication no one ever saw. NO BUGS. At any stage, any doubts — ask before assuming."

---

## Authority Chain (Read First)

| Priority | Document | What It Governs |
|----------|----------|-----------------|
| **TIER 0** | `docs/design/design-bible-part4a.html` | Log entry patterns, HTTP patterns, token visualization |
| **TIER 0** | `docs/design/design-bible-part{1,2,3,4b,4c}.html` | All component patterns, animations, empty states |
| **TIER 0** | `docs/design/component-library.html` | Icons, badges, CRUD, tables, interactions |
| **TIER 1** | `docs/specs/features/F04-runtime-view/states.md` | 200+ state definitions (the behavioral truth) |
| **TIER 1** | `docs/specs/features/F04-enhanced-logs.md` | Breakpoints + bookmarks feature spec |
| **TIER 1** | `docs/specs/design-spec-v2.md §5-7` | Logs, DAG, Spark spec sections |
| **TIER 1** | `docs/specs/MVP-DECISIONS.md` (F04 section) | Tab structure, interceptor list, sub-phases |
| **SETTLED** | `docs/adr/ADR-006-signalr-messagepack.md` | SignalR + MessagePack transport (replaces raw WS) |
| **SETTLED** | `docs/adr/ADR-005-late-di-registration-featureflighter.md` | IFeatureFlighter wrapper DI pattern |
| **SETTLED** | `docs/adr/ADR-004-subclass-gts-spark-client.md` | Spark interception approach |

**Rule:** If you're unsure about ANYTHING — a state transition, an animation timing, a data shape, a colour token — **ASK THE CEO**. Do not guess. Do not assume. The cost of asking is seconds. The cost of a wrong assumption is a bug.

---

## Phase Overview

```
PHASE 0: MOCKS ──────────────────────────── You Are Here
  11 standalone interactive HTML mock pages.
  Each demonstrates every state, animation, interaction.
  CEO approves each mock before proceeding.
  ═══════════════════════════════════════════
  GATE: CEO approval of all 11 mocks
  ═══════════════════════════════════════════

PHASE 1: SIGNALR FOUNDATION ─────────────── After mocks approved
  Replace raw WebSocket with SignalR + MessagePack.
  EdogPlaygroundHub.cs. JS client migration.
  Verify: existing logs + telemetry still work.
  ═══════════════════════════════════════════
  GATE: Sentinel gauntlet + manual browser verify
  ═══════════════════════════════════════════

PHASE 2: C# INTERCEPTORS ───────────────── After SignalR works
  7 new interceptors, one at a time.
  Each tested against live FLT service.
  ═══════════════════════════════════════════
  GATE: dotnet build + interceptor isolation test + Sentinel
  ═══════════════════════════════════════════

PHASE 3: FRONTEND + WIRING ─────────────── After interceptors work
  Real JS modules for all 11 tabs.
  Wire to SignalR hub. Connect to interceptor data.
  Implement every state from the state matrix.
  ═══════════════════════════════════════════
  GATE: Full gauntlet per tab + CEO browser review
  ═══════════════════════════════════════════

PHASE 4: TESTING ────────────────────────── After wiring complete
  Automated tests. Browser scenario tests.
  State matrix walkthrough (every state verified).
  Performance profiling (1000 msg/s, 10K entries).
  ═══════════════════════════════════════════
  GATE: Sentinel APPROVED verdict + CEO sign-off
  ═══════════════════════════════════════════
```

---

## PHASE 0: INTERACTIVE MOCKS (11 Tasks)

### Purpose

Build a standalone interactive HTML mock page for each of the 11 Runtime View tabs. Each mock is:

- **Self-contained** — single HTML file, opens in browser directly (no server needed)
- **Interactive** — buttons click, filters filter, tabs switch, drawers slide, entries select
- **State-complete** — demonstrates every state from `states.md` for that tab
- **Animation-accurate** — exact timings from states.md §7.5 and Design Bible tokens
- **Design Bible-faithful** — uses Bible tokens (colours, radii, shadows, transitions, fonts)
- **Keyboard-navigable** — all shortcuts from states.md §7.3 that apply to that tab

These are NOT throwaway prototypes. They are the **visual contract** — the CEO-approved reference that the real implementation must match pixel-for-pixel.

### Mock File Location

```
docs/design/mocks/
├── f04-mock-01-logs.html              ← Logs tab (the biggest — 97 states)
├── f04-mock-02-telemetry.html         ← Telemetry tab
├── f04-mock-03-system-files.html      ← System Files tab
├── f04-mock-04-spark-sessions.html    ← Spark Sessions tab
├── f04-mock-05-tokens.html            ← Tokens (Internals)
├── f04-mock-06-caches.html            ← Caches (Internals)
├── f04-mock-07-http-pipeline.html     ← HTTP Pipeline (Internals)
├── f04-mock-08-retries.html           ← Retries & Throttling (Internals)
├── f04-mock-09-feature-flags.html     ← Feature Flag Evals (Internals)
├── f04-mock-10-di-registry.html       ← DI Registry (Internals)
└── f04-mock-11-perf-markers.html      ← Perf Markers (Internals)
```

### Design System for All Mocks

Every mock MUST use the Design Bible tokens from `docs/design/design-bible-part1.html`:

```css
/* Copied from Design Bible — these are TIER 0 authoritative */
:root {
  --accent:   #6d5cff;
  --green:    #18a058;
  --amber:    #e5940c;
  --red:      #e5453b;
  --blue:     #2d7ff9;
  --purple:   #a855f7;
  --teal:     #0d9488;
  --font:     'Inter', system-ui, sans-serif;
  --mono:     'Cascadia Code', 'Consolas', monospace;
  --transition: 160ms cubic-bezier(0.4,0,0.2,1);
  /* ... full token set from AUTHORITY.md */
}
```

### Interaction Quality Bar

Each mock must pass this bar before CEO review:

| Criterion | Minimum Standard |
|-----------|-----------------|
| **Fidelity** | Looks indistinguishable from the final product |
| **States** | Every state from states.md for this tab is demonstrable |
| **Animations** | Exact timings from §7.5 — not faster, not slower, not different easing |
| **Keyboard** | All applicable shortcuts from §7.3 work |
| **Empty states** | Shown with correct copy, icon, and action button |
| **Error states** | Shown with actionable message and retry/dismiss options |
| **Data density** | Realistic FLT data — real component names, real GUID formats, real error messages |
| **Hover/Focus** | Every interactive element has visible hover and focus states |
| **Dark theme** | Both light and dark themes work (toggle in mock) |

---

### Task 0.1: Logs Tab Mock

**Output:** `docs/design/mocks/f04-mock-01-logs.html`

**States to demonstrate (97 total — all from states.md §2):**

| State Group | States | Key Interactions |
|-------------|--------|------------------|
| WebSocket connection | LOG-CONN-001→009 | Connecting spinner, connected green dot, reconnecting with attempt counter, failed with retry button, throughput counter (animated number roll) |
| Stream rendering | LOG-STRM-001→015 | Empty stream, first entry animation, auto-scroll indicator, "47 new entries" pill, pause/resume with buffer count, clear with confirmation, throttled rendering banner, ring buffer rotation, virtual scroll position indicator |
| Level filters | LOG-FILT-001→007 | All/V/I/W/E pills with live counts (number roll animation), multi-select with Ctrl+click, error count red flash, zero-entry dimmed pill, empty filtered view |
| Component filter | LOG-FILT-010→013 | Dropdown with search, multi-select checkboxes, frequency-sorted, new component auto-added |
| Text search | LOG-FILT-020→026 | Input with Ctrl+/, live filter at 2 chars, amber highlight on matches, ▲/▼ navigation, regex mode toggle, no-results state |
| Time range | LOG-FILT-030→033 | Preset pills (All/1m/5m/15m/1h/Custom), custom date-time picker |
| RAID filter | LOG-FILT-040→042 | Dropdown with recency-sorted RAIDs, count + time range per RAID |
| Presets | LOG-FILT-050→053 | All/FLT/DAG/Spark toggle group |
| Filter management | LOG-FILT-060→061 | Active filter count badge, dropdown listing all filters with ✕, clear all (Ctrl+Shift+F) |
| Breakpoints | LOG-BRK-001→010 | Collapsed bar → expand → regex input + 5 colour presets → pill appears (scale animation) → retroactive highlight → toggle (strikethrough) → remove (scale down) → high match rate tooltip |
| Bookmarks | LOG-BMK-001→012 | Gutter star (30%→80% opacity), fill animation (bounce), gold border, drawer slide (280px), navigate to entry (gold pulse), stale "(out of buffer)", export JSON/HTML dropdown, clear all with confirmation, survive log clear |
| Error clustering | LOG-CLST-001→007 | Cluster header inline (red border + ×N badge), expand/collapse (staggered), growing count pulse, single-entry dissolve, summary bar with mini-pills, compare diff view |
| Entry interaction | LOG-ENTRY-001→012 | Hover highlight, select (accent border + detail panel), JSON tree viewer, stack trace with file:line links, correlation filter links, copy (toast), context menu, panel resize drag, layout toggle (bottom/right) |

**Mock data requirements:**
- 50+ realistic FLT log entries with real component names: `DagExecutionHandler`, `SparkClient`, `OneLakeFileSystem`, `CatalogManager`, `RetryPolicyProvider`, `TokenManager`
- Mix of levels: ~60% Message, ~20% Verbose, ~15% Warning, ~5% Error
- 3+ error entries with similar messages (to trigger clustering)
- Entries with full properties (IterationId, RAID, correlationId, nested JSON)
- 2+ entries with stack traces
- Timestamps spanning ~5 minutes

**Keyboard shortcuts to implement in mock:**
- `Space` — pause/resume
- `Ctrl+/` — focus search
- `Ctrl+B` — toggle bookmarks drawer
- `Shift+E` — jump to next error
- `Escape` — dismiss detail/drawer/search
- `↑`/`↓` — navigate entries

- [ ] **Step 1:** Create the mock file with Design Bible tokens, dark/light theme toggle, and the complete Logs tab layout (toolbar + breakpoints bar + stream area + detail panel + bookmarks drawer)
- [ ] **Step 2:** Implement mock data generator with 50+ realistic FLT log entries
- [ ] **Step 3:** Implement virtual-scroll-like rendering with all LOG-STRM states (auto-scroll indicator, pause/resume, new entries pill, throttle banner)
- [ ] **Step 4:** Implement filter toolbar — level pills with animated counts, component dropdown, text search with highlight, time range, RAID, presets, active filter badge
- [ ] **Step 5:** Implement breakpoint system — add form, regex validation, colour picker, pills with toggle/remove, retroactive highlight, high-match tooltip
- [ ] **Step 6:** Implement bookmark system — gutter stars with bounce animation, drawer with navigation/export/clear, stale entry handling
- [ ] **Step 7:** Implement error clustering — normalize, hash, cluster headers with expand/collapse/grow, summary bar
- [ ] **Step 8:** Implement entry interaction — hover, select, detail panel (JSON tree, stack trace, correlation links), copy, context menu, resize, layout toggle
- [ ] **Step 9:** Implement WebSocket connection states — connecting/connected/reconnecting/failed indicators (simulated with buttons to toggle states)
- [ ] **Step 10:** Wire all keyboard shortcuts
- [ ] **Step 11:** Test every state from LOG-* in states.md. Fix any missing states.
- [ ] **Step 12:** CEO review — open in browser, walk through all 97 states

---

### Task 0.2: Telemetry Tab Mock

**Output:** `docs/design/mocks/f04-mock-02-telemetry.html`

**States to demonstrate (13 — from states.md §3):**

| State | Key Interaction |
|-------|-----------------|
| TELE-001 | Empty: activity icon + "Waiting for telemetry events..." |
| TELE-002 | First event: fade out empty, slide in first card |
| TELE-003 | Streaming: activity cards with name + status badge + animated duration bar + correlation IDs |
| TELE-004 | Completed: ● → ✓ or ✕, duration bar freeze, colour transition |
| TELE-005 | Failed: red border, error summary, expandable |
| TELE-006 | Long-running (>30s): amber duration bar, tooltip |
| TELE-007 | Many concurrent: ACTIVE section pinned top, COMPLETED section below |
| TELE-008 | Detail panel: full activity, child activities, correlated log link |
| TELE-009 | Cross-tab: "View in Logs" link (simulated tab switch) |
| TELE-010 | Filter by name: real-time, partial match, counter |
| TELE-011 | Filter by status: All/Running/Succeeded/Failed pills |
| TELE-012 | Filter by duration: range slider |
| TELE-013 | Export: JSON/CSV dropdown |

**Mock data:** 15+ realistic SSR telemetry activities — RunDAG, GetLatestDag, RefreshSource, SparkExecute, CatalogUpdate. Mix of running/succeeded/failed/long-running. Nested child activities for RunDAG.

- [ ] **Step 1:** Create mock with layout: filter bar + activity card list + detail panel
- [ ] **Step 2:** Implement activity cards with animated duration bars, status transitions
- [ ] **Step 3:** Implement filters (name, status pills, duration slider)
- [ ] **Step 4:** Implement detail panel with child activities and cross-tab correlation
- [ ] **Step 5:** Test all 13 TELE-* states
- [ ] **Step 6:** CEO review

---

### Task 0.3: System Files Tab Mock

**Output:** `docs/design/mocks/f04-mock-03-system-files.html`

**States to demonstrate (14 — from states.md §4):**

SYSF-001→014: Empty, first operation, streaming table (path/op/size/time), hover with full path tooltip, selected with detail panel, JSON content preview (formatted + syntax-highlighted), binary hex dump, content unavailable, directory filter, operation type filter (Read/Write/Delete badges), path search, lock file highlight (amber + stale warning), export.

**Mock data:** 30+ file operations — DagExecutionMetrics reads/writes, lock acquire/release, dagsettings.json updates, environment.json reads. Include 2 stale locks (>60s). Mix of JSON and binary files.

- [ ] **Step 1:** Create mock with data table + detail panel (content preview)
- [ ] **Step 2:** Implement file operation rows with colour-coded operation badges
- [ ] **Step 3:** Implement JSON content viewer (collapsible, syntax-highlighted, line numbers)
- [ ] **Step 4:** Implement lock file warning system (amber border, stale detection)
- [ ] **Step 5:** Implement filters (directory, operation type, path search)
- [ ] **Step 6:** Test all 14 SYSF-* states
- [ ] **Step 7:** CEO review

---

### Task 0.4: Spark Sessions Tab Mock

**Output:** `docs/design/mocks/f04-mock-04-spark-sessions.html`

**States to demonstrate (14 — from states.md §5):**

SPARK-001→014: Empty, first session, session created (blue), active with pulsing dot + command list, command executing (spinner + elapsed), disposed (grey), timed out (amber), error (red), session reuse (cyan badge + boundary marker), expanded command history, multiple sessions (ACTIVE/HISTORY sections), command detail (syntax-highlighted code), cross-tab "View in Logs", export.

**Mock data:** 4 Spark sessions — 1 active (executing cell 3 of 7), 1 disposed (lived 4m 32s), 1 timed out (idle 3m), 1 reused. Each with 3-7 commands mixing SQL and PySpark.

- [ ] **Step 1:** Create mock with session card list + detail panel
- [ ] **Step 2:** Implement session cards with lifecycle progress bars and status transitions
- [ ] **Step 3:** Implement command list within cards (collapsible, syntax-highlighted)
- [ ] **Step 4:** Implement session reuse boundary marker
- [ ] **Step 5:** Test all 14 SPARK-* states
- [ ] **Step 6:** CEO review

---

### Task 0.5: Tokens Tab Mock (Internals)

**Output:** `docs/design/mocks/f04-mock-05-tokens.html`

**States to demonstrate (6 — from states.md §6.1):**

INT-TOK-001→006: Empty, streaming token cards (type badge + audience + live TTL countdown with colour transitions), detail with JWT decode (header/payload/signature) + usage stream, expired (red + "(replaced)"), timeline view toggle, search by type/audience/claim.

**Mock data:** 5 tokens — Bearer (expires in 42m), MWC (expires in 8m — amber), S2S (expired 3m ago — red), OBO (fresh), MWC replacement. Full JWT payloads with realistic claims (oid, tid, aud, iss, exp, iat, roles). Usage stream per token showing API calls.

- [ ] **Step 1:** Create mock with token card list + detail panel + timeline view
- [ ] **Step 2:** Implement live TTL countdown with colour transitions (green → amber → red)
- [ ] **Step 3:** Implement JWT decode panel (header, payload table, signature truncated)
- [ ] **Step 4:** Implement timeline view (horizontal, tokens plotted by issued→expiry)
- [ ] **Step 5:** Test all 6 INT-TOK-* states
- [ ] **Step 6:** CEO review

---

### Task 0.6: Caches Tab Mock (Internals)

**Output:** `docs/design/mocks/f04-mock-06-caches.html`

**States to demonstrate (5 — from states.md §6.2):**

INT-CACHE-001→005: Empty, streaming with left sidebar (10 cache managers + event count badges) + right event stream (Get/Set/Evict badges), detail (full key, JSON value, TTL, eviction reason), eviction event (TTL vs LRU), search across managers.

**Mock data:** 10 cache managers (TokenCacheManager, DagExecutionStore, MlvDefinitionCache, FeatureFlagCache, SparkSessionPool, CatalogCache, LockStateCache, MetricsSummaryCache, PartitionCache, SettingsCache). 40+ events across them. Include TTL evictions and LRU evictions.

- [ ] **Step 1:** Create mock with split layout (manager list + event stream + detail)
- [ ] **Step 2:** Implement cache manager sidebar with event count badges
- [ ] **Step 3:** Implement event stream with Get/Set/Evict badges and JSON content viewer
- [ ] **Step 4:** Implement eviction display (reason, TTL remaining, LRU position)
- [ ] **Step 5:** Test all 5 INT-CACHE-* states
- [ ] **Step 6:** CEO review

---

### Task 0.7: HTTP Pipeline Tab Mock (Internals)

**Output:** `docs/design/mocks/f04-mock-07-http-pipeline.html`

**States to demonstrate (6 — from states.md §6.3):**

INT-HTTP-001→006: Empty, streaming request table (method badge + URL + status + duration + retry + handlers), request detail (headers, body, response, timing waterfall), failed request (4xx/5xx, 429 "Throttled" badge), filter bar (method/status/URL/duration/handler), export as HAR.

**Mock data:** 25+ HTTP requests — OneLake (GET/PUT), GTS Spark (POST), PBI redirect (GET), Fabric API (GET/PATCH). Mix of 200/201/401/429/500 statuses. Include retried requests. Realistic URLs, headers, JSON bodies.

**Key visual:** Timing waterfall per request (DNS → Connect → TLS → Send → Wait → Receive) — this is the Chrome DevTools Network-like visualization.

- [ ] **Step 1:** Create mock with request table + detail panel (tabbed: Request/Response/Timing)
- [ ] **Step 2:** Implement request table with colour-coded method and status badges
- [ ] **Step 3:** Implement timing waterfall visualization (horizontal bars per phase)
- [ ] **Step 4:** Implement filters and HAR export
- [ ] **Step 5:** Test all 6 INT-HTTP-* states
- [ ] **Step 6:** CEO review

---

### Task 0.8: Retries & Throttling Tab Mock (Internals)

**Output:** `docs/design/mocks/f04-mock-08-retries.html`

**States to demonstrate (5 — from states.md §6.4):**

INT-RETRY-001→005: Empty, streaming event cards (Retry/Throttle/Capacity Wait badges), detail with retry chain timeline visualization, active throttle with live countdown bar, summary trend bar ("12 retries, 3 throttled" with ▲/▼ trend).

**Mock data:** 15+ events — 429 throttle responses with retry-after, 430 capacity admission waits (20s/40s/60s windows), standard retry attempts on 5xx errors. Include one active countdown.

**Key visual:** Retry chain timeline — horizontal visualization: attempt 1 → 20s wait → attempt 2 → 40s wait → attempt 3 → success. Each attempt shows request duration + wait duration.

- [ ] **Step 1:** Create mock with event cards + detail panel + summary bar
- [ ] **Step 2:** Implement retry chain timeline visualization
- [ ] **Step 3:** Implement live countdown for active throttle (animated bar)
- [ ] **Step 4:** Implement summary trend with ▲/▼ indicators
- [ ] **Step 5:** Test all 5 INT-RETRY-* states
- [ ] **Step 6:** CEO review

---

### Task 0.9: Feature Flag Evals Tab Mock (Internals)

**Output:** `docs/design/mocks/f04-mock-09-feature-flags.html`

**States to demonstrate (6 — from states.md §6.5):**

INT-FLAG-001→006: Empty, streaming eval table (flag name + tenant + capacity + workspace + true/false colour-coded result), detail (evaluation path, context params, duration), search with auto-complete, **flip detection** (same flag returns different result — accent flash + "Changed" badge + strikethrough previous), summary toggle (unique flags with eval count, true%, false%).

**Mock data:** 30+ evaluations across 8 flags — FLTDagExecutionHandlerV2, FLTSparkSessionPooling, FLTOneLakePartitionPruning, FLTCacheEvictionPolicy, etc. Include 2 flips (flag changed mid-session). Realistic tenant/capacity/workspace GUIDs.

- [ ] **Step 1:** Create mock with eval stream table + detail + summary toggle
- [ ] **Step 2:** Implement colour-coded true/false result column
- [ ] **Step 3:** Implement flip detection (strikethrough + "Changed" badge + flash)
- [ ] **Step 4:** Implement summary aggregation view
- [ ] **Step 5:** Test all 6 INT-FLAG-* states
- [ ] **Step 6:** CEO review

---

### Task 0.10: DI Registry Tab Mock (Internals)

**Output:** `docs/design/mocks/f04-mock-10-di-registry.html`

**States to demonstrate (5 — from states.md §6.6):**

INT-DI-001→005: Empty, registry loaded (static table: 25+ rows), registration detail (full type names, constructor params, registration source), search, "Show EDOG only" toggle (filters to intercepted registrations with accent borders).

**Mock data:** 27 DI registrations from WorkloadApp.cs — ISparkClientFactory → EdogTracingSparkClientFactory (Singleton, EDOG intercepted), IFeatureFlighter → EdogFeatureFlighterWrapper (Singleton, EDOG intercepted), IDagExecutionHandler → DagExecutionHandler (Scoped), etc. Realistic .NET type names.

- [ ] **Step 1:** Create mock with static data table + detail panel
- [ ] **Step 2:** Implement Singleton/Transient/Scoped lifetime badges (coloured pills)
- [ ] **Step 3:** Implement EDOG-intercepted highlighting (accent left border)
- [ ] **Step 4:** Implement search + "Show EDOG only" toggle
- [ ] **Step 5:** Test all 5 INT-DI-* states
- [ ] **Step 6:** CEO review

---

### Task 0.11: Perf Markers Tab Mock (Internals)

**Output:** `docs/design/mocks/f04-mock-11-perf-markers.html`

**States to demonstrate (7 — from states.md §6.7):**

INT-PERF-001→007: Empty, streaming table (operation + duration with colour coding + inline bar + timestamp + IterationId), detail with sparkline history (last 20 durations), summary toggle (min/avg/max/p50/p95/p99 per operation), **anomaly detection** (>3× average → red flash + "Slow" badge + "3.2× slower than average"), filter by operation name or duration threshold, export.

**Mock data:** 40+ perf markers — PingApi (5-15ms), GetLatestDag (50-200ms), RunDAG (2-45s), ForceUnlockExecution (10-30ms), CatalogResolve (20-80ms). Include 2 anomalies (one PingApi at 450ms = 30× avg, one GetLatestDag at 2.1s = 15× avg).

**Key visual:** Sparkline charts — mini inline line charts showing the last 20 durations for each operation. Trend visible at a glance.

- [ ] **Step 1:** Create mock with perf table + inline duration bars + detail panel
- [ ] **Step 2:** Implement duration colour coding (green <100ms, amber 100-500ms, red >500ms)
- [ ] **Step 3:** Implement sparkline mini-charts for duration history
- [ ] **Step 4:** Implement anomaly detection visual (red flash + "Slow" badge + multiplier text)
- [ ] **Step 5:** Implement summary view (min/avg/max/p50/p95/p99 table)
- [ ] **Step 6:** Test all 7 INT-PERF-* states
- [ ] **Step 7:** CEO review

---

## Phase 0 Completion Criteria

All 11 mocks must be:
1. ✅ Self-contained HTML files in `docs/design/mocks/`
2. ✅ Interactive — every state demonstrable by clicking/typing
3. ✅ Animation-accurate to states.md §7.5 timings
4. ✅ Design Bible token-faithful (Tier 0 colours, fonts, radii)
5. ✅ Dark + light theme working
6. ✅ All keyboard shortcuts for that tab functional
7. ✅ Realistic FLT mock data (not lorem ipsum)
8. ✅ CEO reviewed and approved each one

**After Phase 0:** CEO approves → Phase 1 plan written → SignalR migration begins.

---

## PHASE 1-4: High-Level Outline (Detailed Plans Written After Phase 0)

### Phase 1: SignalR Foundation

| Task | Description | Owner |
|------|-------------|-------|
| 1.1 | Add `Microsoft.AspNetCore.SignalR.Protocols.MessagePack` NuGet | Vex |
| 1.2 | Create `EdogPlaygroundHub.cs` with Subscribe/Unsubscribe groups | Vex |
| 1.3 | Migrate EdogLogServer to serve SignalR hub instead of raw WS | Vex |
| 1.4 | Inline `@microsoft/signalr` JS client in build-html.py | Vex + Pixel |
| 1.5 | Replace `websocket.js` with SignalR client (group-aware) | Pixel |
| 1.6 | Verify logs + telemetry still stream correctly | Sentinel |

### Phase 2: C# Interceptors (7 new)

| Task | Interceptor | DI Pattern | Priority |
|------|-------------|------------|----------|
| 2.1 | EdogFileSystemInterceptor | IFileSystem decorator | High |
| 2.2 | EdogSparkSessionInterceptor | NotebookExecutionContext wrapper | High |
| 2.3 | EdogTokenInterceptor | DelegatingHandler | High |
| 2.4 | EdogCacheInterceptor\<T\> | ICacheManager decorator (×10) | Medium |
| 2.5 | EdogHttpPipelineInterceptor | DelegatingHandler (4 clients) | Medium |
| 2.6 | EdogRetryInterceptor | RetryPolicyProviderV2 hook | Medium |
| 2.7 | EdogFeatureFlighterWrapper | IFeatureFlighter (ADR-005) | Medium |

### Phase 3: Frontend + Wiring (11 tabs)

Build real JS modules per tab, wire to SignalR groups, connect to interceptor data streams. Each tab implemented and verified against the approved mock from Phase 0.

### Phase 4: Testing

- Automated: pytest for Python, MSTest for C# interceptors
- State matrix walkthrough: every state ID verified in browser
- Performance: 1000 msg/s sustained, 10K ring buffer, <5ms per entry
- Regression: existing features (F01-F03, F05-F07) still work
- Full Sentinel gauntlet with APPROVED verdict

---

*"11 mocks. 11 tabs. Zero assumptions. Zero bugs. The mocks are the contract — if it's not in the mock, it's not approved."*
