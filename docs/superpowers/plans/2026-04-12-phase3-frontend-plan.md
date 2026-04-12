# Phase 3: Frontend + Wiring — Palantir-Grade Plan

> **Goal:** Bring the 11 CEO-approved interactive mocks to life inside the real EDOG Playground, wired to real data via SignalR.
> **Rule:** Individual mocks = visual contracts for tab content. Integrated mock = shell architecture (sidebar Option A + tab bar + Internals dropdown). Where they conflict, individual mocks win.

---

## The Big Picture: What Changes

```
CURRENT STATE                              TARGET STATE
═══════════════                            ═══════════════

SIDEBAR (6 flat views)                     SIDEBAR (4 views — Option A)
├── Workspace  [1]                         ├── Workspace    [1]
├── Logs       [2]   ← separate view       ├── Runtime      [2]  ← NEW parent view
├── DAG Studio [3]   ← separate view       │   ├── Tab Bar: [Logs] [Telemetry] [SysFiles] [Spark]
├── Spark      [4]   ← separate view       │   │            [Internals ▾ → 7 sub-views]
├── API        [5]                         │   ├── Connection status bar
└── Environment[6]                         │   └── 11 tab content areas (from individual mocks)
                                           ├── API Playground [3]
SIGNALR (2 events)                         └── Environment    [4]
├── LogEntry → main.js handler
└── TelemetryEvent → main.js handler       SIGNALR (11 topics via event bus)
                                           ├── connection.stream("SubscribeToTopic", topic)
NO EVENT BUS                               ├── Topic event bus: on(topic, cb) / off(topic, cb)
Single onMessage callback                  └── Each tab: activate() → subscribe, deactivate() → unsubscribe
```

---

## File Changes Summary

### New JS Files (9 tab modules + 1 runtime shell)

| File | Purpose | Size ~est | Reference Mock |
|------|---------|-----------|----------------|
| `js/runtime-view.js` | Shell: tab bar, Internals dropdown, connection status, phase transitions | 200 lines | `f04-runtime-view-integrated.html` |
| `js/tab-telemetry.js` | Telemetry tab: activity cards, duration bars, filters, cross-tab | 300 lines | `f04-mock-02-telemetry.html` |
| `js/tab-sysfiles.js` | System Files tab: file ops table, JSON viewer, lock warnings | 300 lines | `f04-mock-03-system-files.html` |
| `js/tab-spark.js` | Spark Sessions tab: session cards, commands, lifecycle | 250 lines | `f04-mock-04-spark-sessions.html` |
| `js/tab-tokens.js` | Tokens tab: TTL rings, JWT decode, timeline | 300 lines | `f04-mock-05-tokens.html` |
| `js/tab-caches.js` | Caches tab: split view, arc gauges, event stream | 250 lines | `f04-mock-06-caches.html` |
| `js/tab-http.js` | HTTP Pipeline tab: request table, timing waterfall | 300 lines | `f04-mock-07-http-pipeline.html` |
| `js/tab-retries.js` | Retries tab: chain timeline, throttle countdown | 250 lines | `f04-mock-08-retries.html` |
| `js/tab-flags.js` | Feature Flags tab: eval stream, flip detection, summary | 250 lines | `f04-mock-09-feature-flags.html` |
| `js/tab-di.js` | DI Registry tab: static table, EDOG highlight, search | 150 lines | `f04-mock-10-di-registry.html` |
| `js/tab-perf.js` | Perf Markers tab: duration bars, sparklines, anomalies | 250 lines | `f04-mock-11-perf-markers.html` |

### New CSS Files (9 tab styles + 1 runtime shell)

| File | Purpose | Reference Mock |
|------|---------|----------------|
| `css/runtime.css` | Shell: tab bar, connection bar, phase overlay, Internals dropdown | Integrated mock |
| `css/tab-telemetry.css` | Activity cards, duration bars, status badges | Mock 02 |
| `css/tab-sysfiles.css` | File ops table, JSON viewer, hex dump, lock styles | Mock 03 |
| `css/tab-spark.css` | Session cards, lifecycle bars, command list | Mock 04 |
| `css/tab-tokens.css` | TTL rings, JWT panels, timeline view | Mock 05 |
| `css/tab-caches.css` | Split view, arc gauges, event rows, key tree | Mock 06 |
| `css/tab-http.css` | Request table, timing waterfall bars, HAR | Mock 07 |
| `css/tab-retries.css` | Chain timeline, countdown bar, summary trend | Mock 08 |
| `css/tab-flags.css` | Eval table, flip detection badge, summary toggle | Mock 09 |
| `css/tab-di.css` | Registry table, lifetime pills, interception highlight | Mock 10 |
| `css/tab-perf.css` | Duration bars, sparklines, anomaly flash | Mock 11 |

### Modified Files

| File | What Changes |
|------|-------------|
| `index.html` | Restructure: replace 6-view DOM with 4-view sidebar + Runtime View parent containing tab bar + 11 content areas |
| `sidebar.js` | Change from 6 views to 4 views (workspace, runtime, api, environment). Keys 1-4. |
| `signalr-manager.js` | Add topic event bus (`on`/`off`/`subscribeTopic`/`unsubscribeTopic`). Register all 11 stream handlers. Keep backward compat for existing `onMessage`. |
| `main.js` | Wire RuntimeView shell. Delegate to tab modules via `activate()`/`deactivate()`. Remove god-object routing. |
| `build-html.py` | Add 10 new JS + 10 new CSS to module lists |
| `renderer.js` | Add breakpoint bar, bookmark gutter, error clustering (from Logs mock) |
| `filters.js` | Add marker-wise filter (breakpoint-based filtering) |

---

## Architecture: How Tabs Work

### Every Tab Module Follows This Pattern

```javascript
class TelemetryTab {
    constructor(containerEl, signalr) {
        this._el = containerEl;          // DOM container for this tab's content
        this._signalr = signalr;         // SignalRManager instance
        this._events = [];               // local data store
        this._active = false;
    }

    /** Called when tab becomes visible. Subscribe to topic, fetch initial data. */
    activate() {
        this._active = true;
        this._signalr.on('telemetry', this._onEvent);
        this._signalr.subscribeTopic('telemetry');
        // Snapshot + live events arrive through same _onEvent callback
        // (ChannelReader stream yields snapshot first, then live)
    }

    /** Called when tab becomes hidden. Unsubscribe, stop rendering. */
    deactivate() {
        this._active = false;
        this._signalr.unsubscribeTopic('telemetry');
        this._signalr.off('telemetry', this._onEvent);
    }

    _onEvent = (event) => {
        this._events.push(event.data);
        if (this._active) this._render();
    }

    _render() { /* update DOM from this._events */ }
}
```

### SignalR Event Bus (upgrade to signalr-manager.js)

```javascript
// NEW: Topic-based listener registry (replaces single onMessage callback)
this._listeners = new Map();    // topic → Set<callback>
this._activeStreams = new Map(); // topic → IStreamResult

on(topic, callback)          // register listener for a topic
off(topic, callback)         // unregister
subscribeTopic(topic)        // start ChannelReader stream
unsubscribeTopic(topic)      // cancel stream (dispose)
```

**Backward compatibility:** Keep existing `onMessage`, `onBatch`, `onSummary` callbacks for the Logs tab (which still uses the old group-broadcast path). Phase 3 migrates Logs to the new pattern last.

### Tab Switch Flow (runtime-view.js orchestrates)

```
User clicks "Telemetry" tab
  │
  ├─► RuntimeView._switchTab('telemetry')
  │     ├─► currentTab.deactivate()     // unsubscribe old topic
  │     ├─► hide old content area
  │     ├─► show new content area
  │     ├─► slide tab underline (200ms ease-out)
  │     └─► newTab.activate()           // subscribe new topic
  │
  └─► SignalR: stream("SubscribeToTopic", "telemetry")
        ├─► Server yields snapshot (buffered history)
        └─► Server yields live events (ongoing)
```

---

## Task Dependency Graph

```
LAYER 1: Infrastructure (sequential)
  Task 1: Upgrade signalr-manager.js (event bus + stream API)
  Task 2: Restructure index.html (sidebar Option A + tab DOM)
  Task 3: Update sidebar.js (4 views)
  Task 4: Create runtime-view.js (shell: tab bar, connection, phase)
  Task 5: Update main.js (wire RuntimeView, delegate to tabs)

LAYER 2: Tab Modules (parallel — 11 agents)
  Task 6:  Logs tab enhancements (breakpoints, bookmarks, clustering)
  Task 7:  Telemetry tab (tab-telemetry.js + css)
  Task 8:  System Files tab (tab-sysfiles.js + css)
  Task 9:  Spark Sessions tab (tab-spark.js + css)
  Task 10: Tokens tab (tab-tokens.js + css)
  Task 11: Caches tab (tab-caches.js + css)
  Task 12: HTTP Pipeline tab (tab-http.js + css)
  Task 13: Retries tab (tab-retries.js + css)
  Task 14: Feature Flags tab (tab-flags.js + css)
  Task 15: DI Registry tab (tab-di.js + css)
  Task 16: Perf Markers tab (tab-perf.js + css)

LAYER 3: Integration (sequential)
  Task 17: Update build-html.py (add all new modules)
  Task 18: Build + test + deploy + verify via agent-browser
```

**Layer 2 tasks are fully independent** — each tab module only needs the SignalR event bus (from Task 1) and its DOM container (from Task 2). Can dispatch 11 Opus agents simultaneously.

---

## Detailed Task Specs

### Task 1: Upgrade signalr-manager.js

**Add to existing class (don't rewrite — extend):**

```javascript
// NEW fields
this._listeners = new Map();      // topic → Set<callback>
this._activeStreams = new Map();  // topic → IStreamResult

// NEW methods
on(topic, callback)               // add listener
off(topic, callback)              // remove listener

subscribeTopic(topic) {           // start ChannelReader stream
  const stream = this.connection.stream("SubscribeToTopic", topic);
  this._activeStreams.set(topic, stream);
  stream.subscribe({
    next: (event) => {
      const cbs = this._listeners.get(event.topic || topic);
      if (cbs) cbs.forEach(cb => cb(event));
    },
    error: (err) => { console.error("Stream error ["+topic+"]:", err); this._activeStreams.delete(topic); },
    complete: () => this._activeStreams.delete(topic)
  });
}

unsubscribeTopic(topic) {         // cancel stream
  const stream = this._activeStreams.get(topic);
  if (stream) { stream.dispose(); this._activeStreams.delete(topic); }
}
```

**Keep existing** `onMessage`, `onBatch`, `onSummary`, `subscribe()`, `unsubscribe()` — backward compat for Logs tab during transition.

**On reconnect:** Re-stream all active topics from `_activeStreams` keys.

### Task 2: Restructure index.html

**Replace 6 view-panels with 4:**

```html
<!-- SIDEBAR: 4 items instead of 6 -->
<div class="sidebar-slot active" data-view="workspace">...</div>
<div class="sidebar-slot" data-view="runtime">...</div>  <!-- NEW: replaces logs+dag+spark -->
<div class="sidebar-slot" data-view="api">...</div>
<div class="sidebar-slot" data-view="environment">...</div>

<!-- VIEW PANELS: 4 instead of 6 -->
<div id="view-workspace" class="view-panel active" data-view="workspace">
  <!-- existing workspace explorer content -->
</div>

<div id="view-runtime" class="view-panel" data-view="runtime">
  <!-- NEW: Runtime View shell -->
  <div id="rt-connection-bar">...</div>
  <div id="rt-tab-bar">
    <div class="rt-tab active" data-tab="logs">Logs</div>
    <div class="rt-tab" data-tab="telemetry">Telemetry</div>
    <div class="rt-tab" data-tab="sysfiles">System Files</div>
    <div class="rt-tab" data-tab="spark">Spark Sessions</div>
    <div class="rt-tab" data-tab="internals">Internals ▾
      <div class="rt-internals-dropdown">
        <div data-sub="tokens">Tokens</div>
        <div data-sub="caches">Caches</div>
        <div data-sub="http">HTTP Pipeline</div>
        <div data-sub="retries">Retries</div>
        <div data-sub="flags">Feature Flags</div>
        <div data-sub="di">DI Registry</div>
        <div data-sub="perf">Perf Markers</div>
      </div>
    </div>
    <div class="rt-tab-indicator"></div>
  </div>
  <div id="rt-phase1-overlay"><!-- Deploy to enable --></div>
  <div id="rt-content">
    <div id="rt-tab-logs" class="rt-tab-content active"><!-- existing logs DOM stays here --></div>
    <div id="rt-tab-telemetry" class="rt-tab-content"></div>
    <div id="rt-tab-sysfiles" class="rt-tab-content"></div>
    <div id="rt-tab-spark" class="rt-tab-content"></div>
    <div id="rt-tab-tokens" class="rt-tab-content"></div>
    <div id="rt-tab-caches" class="rt-tab-content"></div>
    <div id="rt-tab-http" class="rt-tab-content"></div>
    <div id="rt-tab-retries" class="rt-tab-content"></div>
    <div id="rt-tab-flags" class="rt-tab-content"></div>
    <div id="rt-tab-di" class="rt-tab-content"></div>
    <div id="rt-tab-perf" class="rt-tab-content"></div>
  </div>
</div>

<div id="view-api" class="view-panel" data-view="api"><!-- existing --></div>
<div id="view-environment" class="view-panel" data-view="environment"><!-- existing --></div>
```

**The existing Logs DOM** (toolbar, logs-container, breakpoints-bar, bookmarks-drawer, detail panel) moves INSIDE `#rt-tab-logs`. All existing CSS selectors still work.

### Task 3: Update sidebar.js

```javascript
// Change views array
const views = ['workspace', 'runtime', 'api', 'environment'];  // was: ['workspace', 'logs', 'dag', 'spark', 'api', 'environment']

// Key mappings: 1-4 instead of 1-6
```

Phase-aware: `runtime` is disabled in Phase 1 (disconnected), enabled in Phase 2.

### Task 4: Create runtime-view.js

The orchestrator for the Runtime View. Manages:
- **Tab bar:** sliding underline, active state, keyboard Alt+1-5
- **Internals dropdown:** open/close, selection, "Internals: {name} ▾" label
- **Connection status bar:** dot colour, throughput counter, port
- **Phase transitions:** Phase 1 overlay, Phase 2 unlock animation
- **Tab lifecycle:** `activate()`/`deactivate()` on tab modules

Reference: `f04-runtime-view-integrated.html` (shell architecture)

### Task 5: Update main.js

- Remove `handleWebSocketMessage` routing for 9 new event types (tabs handle their own)
- Create tab module instances: `this.telemetryTab = new TelemetryTab(el, this.ws)`
- Wire `RuntimeView` to `sidebar.onViewChange`
- Keep existing Logs wiring (`handleWebSocketMessage` for 'log' and 'telemetry') — Logs tab uses old path during transition

### Tasks 6-16: Tab Modules

**Each tab module agent gets:**
1. Its individual mock file (the visual contract)
2. The SignalR protocol spec (event shapes)
3. The signalr-manager.js event bus API
4. The `#rt-tab-{name}` container element
5. The tab module pattern (constructor, activate, deactivate, _onEvent, _render)

**What each agent builds:**
- One `.js` file with the tab class
- One `.css` file with the tab styles
- Extracted from the individual mock: DOM generation, event handling, filters, rendering
- Wired to real SignalR data (not mock data)

**Task 6 (Logs) is special:** It enhances the EXISTING renderer.js + filters.js rather than creating new files. Adds breakpoints, bookmarks, error clustering from mock 01.

### Task 17: Update build-html.py

Add 10 new JS modules + 10 new CSS modules to the build lists.

### Task 18: Integration

- `make build` — verify HTML output
- `make test` — verify all tests pass
- Deploy to FLT
- agent-browser: verify each of the 11 tabs shows real data
- Verify tab switching is smooth (no jank, no stale data)
- Verify Phase 1 → Phase 2 transition works

---

## Execution Strategy

```
LAYER 1 (sequential, ~45 min):
  Task 1 → Task 2 → Task 3 → Task 4 → Task 5
  SignalR upgrade → HTML restructure → Sidebar → Runtime shell → main.js wiring

  ══ GATE: Logs tab still works in the new shell structure ══

LAYER 2 (parallel, ~30 min — 11 Opus agents):
  Tasks 6-16 simultaneously
  Each produces: 1 JS file + 1 CSS file

  ══ GATE: build-html.py compiles successfully ══

LAYER 3 (sequential, ~15 min):
  Task 17 → Task 18
  Build config → Deploy + verify all 11 tabs

  ══ GATE: all tabs show real data, tab switching smooth ══

TOTAL: ~1.5 hours
```

---

## Quality Rules

1. **Individual mocks are the visual contracts** — tab content must match f04-mock-01 through f04-mock-11
2. **Integrated mock is the shell contract** — sidebar, tab bar, Internals dropdown, connection bar
3. **Design Bible tokens** — all CSS uses Bible values (hex colors, Inter font, radii scale)
4. **No emoji** — SVG icons or Unicode symbols only
5. **Light theme default** — `data-theme="light"`
6. **Keyboard shortcuts** — 1-4 sidebar, Alt+1-5 tabs, Space/Ctrl+L/Ctrl+B in Logs
7. **Fixed footer** — distinct background, keyboard hints
8. **Zero JS errors** — verified via agent-browser

---

## What "Done" Looks Like

A senior FLT engineer opens `http://localhost:5555`, deploys to a lakehouse, and:
- Sidebar shows 4 items. Runtime unlocks with animation.
- Clicks Runtime → Logs tab active by default, streaming real logs
- Switches to Telemetry → activity cards with live duration bars from FLT
- Switches to System Files → file operations table showing real OneLake writes
- Opens Internals → Tokens → sees live TTL countdown rings for Bearer/MWC tokens
- Opens Internals → Feature Flags → sees real flag evaluations with flip detection
- Opens Internals → Perf Markers → sees real operation durations with anomaly detection
- Tab switching is buttery smooth — no blank screens, no stale data
- Every tab has the full filter system, search, export, keyboard shortcuts from the approved mocks

---

*"11 individual mocks = visual contracts. 1 integrated mock = shell architecture. The frontend makes them real."*
