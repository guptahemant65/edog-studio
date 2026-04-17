# F12 — Error Intelligence & Log Experience: Phase 0 Foundation Research

> **Generated:** 2026-04-17
> **Status:** COMPLETE
> **Agents:** Pixel (§1, §4) · Vex (§2) · Sana (§3)
> **Spec ref:** `docs/specs/features/F12-error-intelligence/spec.md`

---

## Table of Contents

- [§1 — Existing Code Audit](#1--existing-code-audit)
  - [1.1 renderer.js — Virtual Scroll & Row Population](#11-rendererjs--virtual-scroll--row-population)
  - [1.2 state.js — Ring Buffer & Filter Index](#12-statejs--ring-buffer--filter-index)
  - [1.3 logs-enhancements.js — Breakpoints, Bookmarks, Error Clustering](#13-logs-enhancementsjs--breakpoints-bookmarks-error-clustering)
  - [1.4 error-intel.js — ErrorIntelligence Class](#14-error-inteljs--errorintelligence-class)
  - [1.5 auto-detect.js — AutoDetector (Error Code Extraction)](#15-auto-detectjs--autodetector-error-code-extraction)
  - [1.6 anomaly.js — AnomalyDetector](#16-anomalyjs--anomalydetector)
  - [1.7 main.js — Application Orchestrator](#17-mainjs--application-orchestrator)
  - [1.8 filters.js — FilterManager](#18-filtersjs--filtermanager)
  - [1.9 detail-panel.js — Detail Panel](#19-detail-paneljs--detail-panel)
  - [1.10 CSS Files — logs.css, logs-enhancements.css, variables.css](#110-css-files)
  - [1.11 build-html.py — Build Pipeline](#111-build-htmlpy--build-pipeline)
  - [1.12 Implications for F12](#112-implications-for-f12)
- [§2 — ErrorRegistry.cs Analysis](#2--errorregistrycs-analysis)
  - [2.1 Presence in This Repository](#21-presence-in-this-repository)
  - [2.2 Error Code Format (Inferred from Codebase)](#22-error-code-format-inferred-from-codebase)
  - [2.3 Proposed error-codes.json Schema](#23-proposed-error-codesjson-schema)
  - [2.4 Parser Strategy](#24-parser-strategy)
  - [2.5 Implications for F12](#25-implications-for-f12)
- [§3 — Industry Research](#3--industry-research)
  - [3.1 Datadog Log Explorer](#31-datadog-log-explorer)
  - [3.2 Grafana Loki + Explore](#32-grafana-loki--explore)
  - [3.3 Seq (Datalust)](#33-seq-datalust)
  - [3.4 Chrome DevTools Console](#34-chrome-devtools-console)
  - [3.5 Azure Monitor / Application Insights](#35-azure-monitor--application-insights)
  - [3.6 Comparison Matrix](#36-comparison-matrix)
  - [3.7 Patterns to Adopt](#37-patterns-to-adopt)
  - [3.8 Implications for F12](#38-implications-for-f12)
- [§4 — innerHTML Security Audit](#4--innerhtml-security-audit)
  - [4.1 Current textContent Usage Map](#41-current-textcontent-usage-map)
  - [4.2 Current Escaping Infrastructure](#42-current-escaping-infrastructure)
  - [4.3 Places Already Using innerHTML Safely](#43-places-already-using-innerhtml-safely)
  - [4.4 The Transition: textContent → innerHTML for Log Messages](#44-the-transition-textcontent--innerhtml-for-log-messages)
  - [4.5 Allowed HTML Whitelist](#45-allowed-html-whitelist)
  - [4.6 Escaping Pipeline Design](#46-escaping-pipeline-design)
  - [4.7 Performance Analysis: innerHTML vs textContent at Scale](#47-performance-analysis-innerhtml-vs-textcontent-at-scale)
  - [4.8 XSS Attack Vectors and Mitigations](#48-xss-attack-vectors-and-mitigations)
  - [4.9 Implications for F12](#49-implications-for-f12)

---

## §1 — Existing Code Audit

### 1.1 renderer.js — Virtual Scroll & Row Population

**File:** `src/frontend/js/renderer.js` (727 lines)

#### Class: `RowPool` (lines 8–85)

DOM element recycling pool for virtual scroll performance.

| Method | Lines | What It Does | F12 Impact |
|--------|-------|--------------|------------|
| `constructor(poolSize)` | 9–16 | Allocates `poolSize` pre-built row DOM elements | None — pool size stays the same |
| `_createRowTemplate()` | 18–53 | Creates a `div.log-row` with 4 child spans: `.log-time`, `.level-badge`, `.log-component`, `.log-message` | **HIGH** — F12 highlight engine may need to restructure `.log-message` to contain `<mark>` / `<span>` child elements |
| `acquire()` | 55–66 | Returns an unused row from pool; grows pool if exhausted | None |
| `release(row)` | 68–74 | Marks row unused, removes from DOM | None |
| `releaseAll()` | 76–84 | Releases all rows; called on full rerender | None |

**Key data structure:** Each row element has custom properties:
```
row._time      // <span class="log-time">
row._level     // <span class="level-badge">
row._component // <span class="log-component">
row._message   // <span class="log-message">
row._seq       // sequence number from RingBuffer
row._inUse     // pool tracking flag
```

**F12 impact:** The `_createRowTemplate` creates `.log-message` as a flat `<span>`. For highlight/error code decoration, we need either:
- (A) Set `innerHTML` on `row._message` with pre-escaped + marked-up content, or
- (B) Build child `<span>`/`<mark>` nodes programmatically inside `row._message`

Option (A) is simpler but needs strict escaping. Option (B) is safer but more complex and slower for 50K rows. §4 analyzes this in depth.

#### Class: `Renderer` (lines 89–726)

The core rendering engine. Virtual scroll with DOM recycling.

| Method | Lines | What It Does | F12 Impact |
|--------|-------|--------------|------------|
| `constructor(state)` | 90–121 | Sets ROW_HEIGHT=34, OVERSCAN=8, MAX_VISIBLE=80; creates RowPool; defines _levelLetters, _categoryRules | **P2** — Add stream state (LIVE/PAUSED) indicator references |
| `initVirtualScroll()` | 125–150 | Creates scroll sentinel, binds click + scroll event delegation | None |
| `_onContainerClick(e)` | 154–182 | Event delegation: component pill → exclude, row → detail panel | **P1** — Add click handler for error code badges within `.log-message` |
| `_onScroll()` | 184–203 | Detects user scroll-up → disables autoScroll, shows resume button. Auto-scroll mode suppresses manual-scroll-triggered renders to avoid feedback loop | **P2** — This is the core of LIVE→PAUSED detection. Needs: buffered count badge, PAUSED indicator |
| `scheduleRender()` | 207–221 | Throttled RAF scheduling (100ms) | None |
| `flush()` | 223–263 | Main render loop: updates filter index, renders virtual scroll, updates telemetry + stats. **When `state.paused`**: still updates filter index and stats but **skips DOM rendering** (lines 227–238) | **P2** — Paused state already implemented! Flush correctly skips DOM. Need to add buffered count tracking (how many new logs arrived since pause) |
| `_renderVirtualScroll()` | 267–363 | Core virtual scroll: calculates visible range, recycles rows, populates visible rows via `_populateRow`, auto-scrolls if enabled | None — highlight happens inside _populateRow |
| **`_populateRow(row, entry, seq, filteredIdx)`** | **376–419** | **THE KEY METHOD** — populates each row element with log data using `textContent` exclusively | **CRITICAL** — F12's highlight engine and error code decorator both modify this method |
| `_getComponentCategory(component)` | 367–372 | Classifies component names into CSS categories | None |
| `_formatTimeFast(isoString)` | 422–444 | Fast time formatter avoiding Date.toLocaleTimeString | None |
| `passesFilter(entry)` | 528–602 | Multi-criteria filter: level, correlation, preset, time, endpoint, component, RAID, text search | **P3** — Error timeline may need access to filter state; no modification needed |
| `rerenderAllLogs()` | 606–627 | Full rerender: rebuilds filter index, releases all rows, re-renders | None — called indirectly from filter changes |
| `escapeHtml(text)` | 649–652 | String-based HTML escaping: `& < > "` → entities | **CRITICAL** — This is the escaping function F12 will use in the innerHTML pipeline |
| `updateLogsStatus()` | 654–659 | Updates visible/total count display | **P2** — Add LIVE/PAUSED badge update |
| `updateSearchCount()` | 661–671 | Shows filter match count | **P1** — May show highlighted match count |
| `updateStats()` | 673–680 | Updates stat-logs, stat-ssr, stat-errors elements | None |
| `scrollToBottom(container)` | 688–694 | Programmatic scroll to end | **P2** — Resume action calls this |

##### Deep Dive: `_populateRow` (lines 376–419)

This is the single most important method for F12. Current implementation:

```javascript
_populateRow(row, entry, seq, filteredIdx) {
  row._seq = seq;
  
  // Time — textContent (line 383)
  row._time.textContent = this._formatTimeFast(entry.timestamp);
  
  // Level — textContent + className (line 386-387)
  row._level.textContent = this._levelLetters[levelLower] || 'I';
  row._level.className = 'level-badge ' + levelLower;
  
  // Component — textContent + data-category (lines 390-393)
  row._component.textContent = component;
  row._component.dataset.category = this._getComponentCategory(component);
  
  // *** THE MESSAGE *** — textContent only, truncated at 500 chars (lines 396-397)
  const msg = entry.message || '';
  row._message.textContent = msg.length > 500 ? msg.substring(0, 500) + '\u2026' : msg;
  
  // Error/warning row styling (lines 400-409)
  // Stripe styling (lines 412-416)
  // rootActivityId data attribute (line 418)
}
```

**What F12 changes:**
1. **Line 397** — `row._message.textContent = ...` must become `row._message.innerHTML = highlightedHTML` where `highlightedHTML` is the escaped + decorated message
2. **After line 397** — Error code badges need to be injected into the message span
3. **Before line 400** — Search highlight markup needs to be applied

**Critical constraint:** The `_populateRow` runs for every visible row on every scroll/render. With OVERSCAN=8 and ~80 visible rows, this is called ~80 times per render cycle at 100ms throttle. The highlight computation must be <0.5ms per row.

##### Event Delegation Click Handler (lines 154–182)

```javascript
_onContainerClick = (e) => {
  // Walks DOM up to find .log-row
  // If e.target is .log-component → exclude component
  // Otherwise → open detail panel
}
```

**F12 must add:** If `e.target` is `.error-code-badge` (or `.error-code-decorated`) → open error context card popover. This fits naturally into the existing delegation pattern. Add a check at line 170 before the component click check:

```javascript
// Error code badge click → show error context card
if (e.target.classList.contains('error-code-badge')) {
  e.stopPropagation();
  // show popover card
  return;
}
```

##### Auto-Scroll / Scroll Detection (lines 184–203)

```javascript
_onScroll = () => {
  // When auto-scroll is ON and we haven't just pinned:
  //   Check if scrolled away from bottom
  //   If yes → state.autoScroll = false, show resume button
  //
  // When auto-scroll is ON: skip render scheduling (avoid loop)
  // When manual scroll: schedule render via flush()
}
```

**F12 P2 enhancements:**
- `_onScroll` already detects scroll-up → auto-pause. F12 needs to also set `state.paused = true` (or a new `state.streamMode = 'PAUSED'`) and start the buffered count badge.
- Currently `state.autoScroll` and `state.paused` are separate booleans. F12 should unify these into a stream state machine.

##### Existing `flush` Paused Behavior (lines 227–238)

```javascript
if (this.state.paused) {
  if (this.state.newLogsSinceRender > 0) {
    this.state.filterIndex.updateIncremental(
      this.state.logBuffer,
      (entry) => this.passesFilter(entry)
    );
    this.state.newLogsSinceRender = 0;
  }
  this.updateStats();
  this.renderScheduled = false;
  return;  // ← skips DOM rendering
}
```

**Key finding:** Pause support **already exists** in `flush()`. When `state.paused = true`, the renderer correctly:
1. Still updates the filter index (so counts stay accurate)
2. Still updates stats
3. Skips DOM rendering (saves CPU)

What's missing for F12:
- No visual indicator (LIVE/PAUSED badge)
- No buffered count badge
- `newLogsSinceRender` resets to 0 even while paused — we need a separate `bufferedWhilePaused` counter that only resets on resume
- Scroll-up doesn't set `paused = true` (only sets `autoScroll = false`)

---

### 1.2 state.js — Ring Buffer & Filter Index

**File:** `src/frontend/js/state.js` (223 lines)

#### Class: `RingBuffer` (lines 8–63)

Fixed-capacity circular buffer for log storage.

| Method | Lines | Signature | F12 Impact |
|--------|-------|-----------|------------|
| `constructor(capacity)` | 9–15 | `new RingBuffer(10000)` for logs, `5000` for telemetry | None |
| `push(item)` | 19–25 | Returns sequence number (monotonically increasing) | None |
| `pushBatch(items)` | 27–36 | Returns `[firstSeq, lastSeq]` range | None |
| `getBySeq(seq)` | 38–44 | O(1) access by sequence number | Used extensively in rendering |
| `forEach(fn)` | 49–55 | Iterates oldest→newest | Used for filter rebuild |
| `clear()` | 57–62 | Full reset | None |

**Properties:** `capacity`, `buffer`, `head`, `count`, `totalPushed`, `oldestSeq`, `newestSeq`, `length`

#### Class: `FilterIndex` (lines 67–121)

Precomputed index of sequence numbers that pass current filters.

| Method | Lines | Signature | F12 Impact |
|--------|-------|-----------|------------|
| `rebuild(ringBuffer, filterFn)` | 73–81 | Full rebuild — walks entire ring buffer | Called on filter change |
| `updateIncremental(ringBuffer, filterFn)` | 83–111 | Adds only new entries since `lastCheckedSeq`; prunes evicted | Called on every render via `flush()` |
| `seqAt(pos)` | 115 | O(1) access to filtered sequence at position | Used by virtual scroll |
| `length` | 113 | Count of filtered entries | Used for scroll height calculation |

**F12 impact on FilterIndex:**
- **P3 (Error Timeline):** Needs access to filtered entries with timestamps for time-bucketing. Could iterate `filterIndex.indices` and look up timestamps via `ringBuffer.getBySeq()`.
- **P2 (Buffered Count):** `updateIncremental` returns the number of added entries — this could feed the "238 new" badge.

#### Class: `LogViewerState` (lines 125–223)

Central state object.

| Property | Lines | Type | F12 Impact |
|----------|-------|------|------------|
| `logBuffer` | 127 | `RingBuffer(10000)` | Source data for all F12 features |
| `filterIndex` | 128 | `FilterIndex` | Drives virtual scroll |
| `activeLevels` | 130 | `Set(['Message', 'Warning', 'Error'])` | Filter criterion |
| `searchText` | 131 | `string` | **P1** — search highlighting reads this |
| `correlationFilter` | 132 | `string\|null` | Filter criterion |
| `excludedComponents` | 133 | `Set` | Filter criterion |
| `activePreset` | 134 | `'flt'\|'all'\|'dag'\|'spark'` | Filter criterion |
| `autoScroll` | 135 | `boolean` | **P2** — Part of stream state |
| `paused` | 136 | `boolean` | **P2** — Part of stream state |
| `stats` | 138–141 | `{totalLogs, verbose, message, warning, error, totalEvents, succeeded, failed}` | Source for analytics |
| `newLogsSinceRender` | 144 | `number` | Resets each flush; **P2** needs a separate buffered counter |
| `addLog(entry)` | 203–212 | Pushes to ring buffer, increments stats | None |
| `addTelemetry(event)` | 214–222 | Pushes to telemetry buffer | None |

**New state properties F12 will add:**
```javascript
// P1 — Error decoder
this.errorCodesDB = {};       // loaded from embedded JSON
this.errorOccurrences = {};   // { code: count } runtime tracking

// P2 — Stream control
this.streamMode = 'LIVE';     // 'LIVE' | 'PAUSED'
this.bufferedCount = 0;       // logs received while paused
this.pauseReason = null;      // 'scroll' | 'manual' | 'hover'

// P3 — Error analytics
this.errorTimeline = [];      // time-bucketed error counts
this.errorClusters = [];      // global cluster data
this.errorFrequency = {};     // { code: { rate, trend, firstSeen, lastSeen } }
```

---

### 1.3 logs-enhancements.js — Breakpoints, Bookmarks, Error Clustering

**File:** `src/frontend/js/logs-enhancements.js` (1067 lines)

#### Class: `LogsEnhancements` (lines 14–1067)

Enhancement layer that wraps the renderer without modifying it.

**Static constants:**
- `BP_COLORS` (line 17): 5 breakpoint colors
- `CLUSTER_THRESHOLD` (line 20): 3 — minimum consecutive errors to form cluster
- `MAX_BOOKMARKS` (line 23): 200

**Constructor properties (lines 33–57):**
```javascript
this._logsContainer  // #logs-container element
this._breakpointsBar // #breakpoints-bar element
this._bookmarksDrawer// #bookmarks-drawer element
this._state          // shared LogViewerState
this._renderer       // Renderer instance
this._breakpoints    // Map<id, BreakpointEntry>
this._bookmarks      // Map<seq, BookmarkEntry>
this._errorClusters  // ErrorCluster[]
this._activeMarkers  // string[] — active bp ids for filtering
```

#### Breakpoints Subsystem (lines 88–662)

| Method | Lines | F12 Impact |
|--------|-------|------------|
| `addBreakpoint(name, logIndex, opts)` | 88–114 | None — regex breakpoints are independent of error codes |
| `removeBreakpoint(id)` | 120–138 | None |
| `jumpToBreakpoint(id)` | 144–159 | Pattern for F12's "jump to error" |
| `toggleBreakpointEnabled(id)` | 165–171 | None |

#### Bookmarks Subsystem (lines 176–242)

| Method | Lines | F12 Impact |
|--------|-------|------------|
| `toggleBookmark(logEntry)` | 182–213 | None |
| `getBookmarks()` | 218–222 | None |
| `exportBookmarksJSON()` | 358–366 | **P1** — Export upgrade should include bookmarks option |

#### Error Clustering Subsystem (lines 248–318)

**THIS IS THE CRITICAL SECTION FOR F12.**

| Method | Lines | Signature | F12 Impact |
|--------|-------|-----------|------------|
| `detectClusters(entries)` | 255–299 | Takes full entries array, returns `ErrorCluster[]` | **P3** — Currently only detects **consecutive** clusters. F12 needs **global** signature-based grouping |
| `toggleCluster(clusterId)` | 305–310 | UI expand/collapse | None |
| `getClusters()` | 316–318 | Returns current clusters | None |
| `refreshClusters()` | 1056–1066 | Re-runs detection on current buffer | **P3** — Will be replaced/extended |

**Current clustering algorithm (lines 255–299):**

```javascript
detectClusters(entries) {
  // Walks entries sequentially
  // Groups CONSECUTIVE errors with same _errorSignature
  // Only forms cluster if count >= CLUSTER_THRESHOLD (3)
  // Breaks cluster on non-error entry
}
```

**Limitation for F12:** This algorithm only groups consecutive errors. If errors A, B, A appear (with B between two A's), they get two separate clusters instead of one. F12 needs a global approach:

```
Current:  [A, A, A, B, A, A] → Cluster{A, 3}, skip B, Cluster{A, 2}
F12 goal: [A, A, A, B, A, A] → Cluster{A, 5} (global signature grouping)
```

**Error signature function (lines 1002–1007):**
```javascript
_errorSignature(entry) {
  const msg = (entry.message || '').substring(0, 80);
  const match = msg.match(/^(\w+Exception|\w+Error)/);
  return match ? match[1] : msg.replace(/[0-9a-f-]{8,}/gi, '***').substring(0, 60);
}
```

**F12 enhancement:** Extend signature to include the `MLV_` / `FLT_` / `SPARK_` error codes. If an error code is present, it becomes the primary signature. This gives much better grouping.

#### Gutter Injection Pattern (lines 492–555)

**Important design pattern:** LogsEnhancements wraps `_populateRow` non-destructively:

```javascript
_injectGutterColumn() {
  const origPopulate = this._renderer._populateRow.bind(this._renderer);
  this._renderer._populateRow = function(row, entry, seq, filteredIdx) {
    origPopulate(row, entry, seq, filteredIdx);
    // ... add gutter, bookmark star, breakpoint marker
  };
}
```

**F12 implication:** The F12 highlight engine should follow this same pattern — wrap `_populateRow` and add its decorations after the base population. This preserves the layered architecture where each enhancement extends without modifying the core.

**However**, there's a conflict: the base `_populateRow` sets `textContent` on the message span. If F12 wraps it and then sets `innerHTML`, the `textContent` set by the base would be overwritten anyway. A cleaner approach: F12 modifies the base `_populateRow` directly (replacing `textContent` with `innerHTML` for `.log-message`), and the gutter injection wraps as before.

#### Keyboard Bindings (lines 895–922)

- `Ctrl+B` → toggle bookmark (line 901)
- `Ctrl+Shift+B` → open breakpoint input (line 910)

**F12 additions needed:**
- `End` → resume LIVE mode (P2)
- `Ctrl+↓` → resume LIVE mode (P2)
- No keyboard conflicts with existing bindings

#### Marker-Wise Filtering (lines 324–348)

```javascript
passesMarkerFilter(entry) {
  if (this._activeMarkers.length === 0) return true;
  // Tests entry.message against active breakpoint regexes
}
```

**F12 note:** This pattern is useful for "Filter to all [CODE]" action in error context cards.

---

### 1.4 error-intel.js — ErrorIntelligence Class

**File:** `src/frontend/js/error-intel.js` (51 lines)

#### Class: `ErrorIntelligence` (lines 5–51)

Minimal class that shows dismissible error alert cards. **Not the error code decoder** — this is the smart alert system.

| Method | Lines | Signature | F12 Impact |
|--------|-------|-----------|------------|
| `constructor(autoDetector)` | 6–12 | Wires to `autoDetector.onErrorDetected` callback | Will also wire to error decoder |
| `handleError(exec, error)` | 15–17 | Checks dismissed set, shows alert | **P3** — Extend with frequency tracking |
| `showAlert(exec, latestError)` | 20–45 | Builds HTML alert with count, codes, skip info | **P3** — Add trend badges, node mapping |
| `dismiss(errorCode)` | 47–50 | Adds to dismissed set, hides alert | None |

**Key data flow:**
```
AutoDetector.processLog() → onErrorDetected(exec, error) → ErrorIntelligence.handleError()
```

The `error` object has: `{ code, message, timestamp, node }` (created in auto-detect.js:112).

**F12 P3 enhancement plan:**
1. Add occurrence counting per error code
2. Add sliding window rate calculation (errors/minute)
3. Add trend computation (↑ rising, ↓ falling, → stable)
4. Add node-to-error mapping (which nodes produce which errors)
5. Connect to error decoder for rich descriptions

**Note on line 38:** `showAlert` uses `innerHTML` directly:
```javascript
this.alertElement.innerHTML = `
  <span class="error-icon">✕</span>
  <span class="error-summary">${summary}</span>
  ...
`;
```
The `summary` variable is **not escaped** — it contains concatenated error codes and node names from log messages. This is a **pre-existing XSS risk** if log messages contain HTML. F12 should fix this.

---

### 1.5 auto-detect.js — AutoDetector (Error Code Extraction)

**File:** `src/frontend/js/auto-detect.js` (~250 lines)

#### Error Code Regex (line 110)

```javascript
const errorCodeMatch = msg.match(/\b(MLV_\w+|FLT_\w+|SPARK_\w+)\b/);
const errorCode = errorCodeMatch ? errorCodeMatch[1] : 'UNKNOWN_ERROR';
```

**This is the existing error code detection pattern.** It matches three prefixes:
- `MLV_*` — MaterializedLakeView errors (primary)
- `FLT_*` — FabricLiveTable errors
- `SPARK_*` — Spark session errors

F12's error decoder will reuse and extend this regex:
```javascript
// F12 three-layer detection:
// Layer 1: Known code (exists in error-codes.json) → solid underline
// Layer 2: Pattern match (MLV_*|FLT_*|SPARK_*) but NOT in JSON → dashed underline
// Layer 3: No match → no decoration
```

#### Error Object Shape (line 112)

```javascript
exec.errors.push({
  code: errorCode,         // 'MLV_SPARK_SESSION_ACQUISITION_FAILED' or 'UNKNOWN_ERROR'
  message: msg.substring(0, 200),
  timestamp: entry.timestamp,
  node: this.inferNodeFromContext(msg)
});
```

F12's error decoder will enrich this with data from `error-codes.json`.

#### Telemetry Error Codes (line 157)

```javascript
errorCode: event.attributes.ErrorCode,
```

SSR telemetry events also carry error codes in `attributes.ErrorCode`. The error decoder should handle both log-embedded codes and telemetry attribute codes.

---

### 1.6 anomaly.js — AnomalyDetector

**File:** `src/frontend/js/anomaly.js` (~120 lines)

Detects patterns: slow polling, retry storms, slow nodes, timeout risks.

**F12 overlap:** The retry storm detection (lines 38–45) tracks error frequency:
```javascript
if ((entry.level || '').toLowerCase() === 'error') {
  const errorKey = msg.substring(0, 80);
  if (!this.retryCounts[errorKey]) this.retryCounts[errorKey] = { count: 0, firstSeen: ts };
  this.retryCounts[errorKey].count++;
}
```

F12's frequency trend system should either:
- (A) Extend AnomalyDetector's data, or
- (B) Maintain its own frequency tracker (cleaner)

**Recommendation:** Option (B) — F12's frequency tracking is per-error-CODE (from error-codes.json), while anomaly's is per-message-prefix. Different granularity, separate state.

---

### 1.7 main.js — Application Orchestrator

**File:** `src/frontend/js/main.js` (1100+ lines)

#### Class: `EdogLogViewer` (lines 94–1075)

| Method/Section | Lines | F12 Impact |
|----------------|-------|------------|
| `constructor()` | 95–165 | Instantiates all modules. **F12 adds**: ErrorDecoder instance, ErrorTimeline instance |
| `init()` | 167–245 | App initialization. **F12 adds**: load error-codes.json, init error decoder |
| `bindEventListeners()` | 299–454 | All event bindings. **F12 modifies**: export button (P1), pause button (P2), keyboard handler (P2) |
| `handleKeydown(e)` | 456–490 | Keyboard shortcuts. **F12 adds**: `End` → resume, `Ctrl+↓` → resume |
| `handleWebSocketMessage(type, data)` | 492–512 | Processes incoming logs/telemetry. **F12 adds**: error occurrence counting |
| `handleWebSocketBatch(logs, telemetry)` | 515–543 | Batch processing. Same as above |
| `togglePause()` | 681–694 | Current pause implementation. **F12 enhances**: LIVE/PAUSED badge, buffered count |
| `resumeAutoScroll()` | 708–717 | Current resume. **F12 enhances**: Clear buffered count, restore LIVE badge |
| `showResumeButton()` | 719–722 | Shows scroll FAB. **F12 enhances**: May integrate with PAUSED badge |
| `exportLogs()` | 1014–1041 | Current export (JSON-only). **F12 replaces**: format selector, filtered export, toast |
| `jumpToNextError()` | 1043–1074 | Navigates to next error row. **F12 may enhance**: use error decoder data |

#### Current `exportLogs()` Implementation (lines 1014–1041)

```javascript
exportLogs = () => {
  const dataToExport = {
    exportedAt: new Date().toISOString(),
    logs: this.state.filteredLogs.length > 0 ? this.state.filteredLogs : this.state.logs,
    telemetry: telemetryArr,
    stats: this.state.stats,
    filters: { searchText, activeLevels, correlationFilter }
  };
  const blob = new Blob([JSON.stringify(dataToExport, null, 2)], { type: 'application/json' });
  // ... download link
}
```

**F12 P1 changes:**
1. Add format selector (JSON / CSV / Text)
2. Always export filtered entries only (currently has fallback to all)
3. Add success toast with count
4. CSV format: flatten log entries to columns
5. Text format: formatted human-readable lines

#### Current `togglePause()` (lines 681–694)

```javascript
togglePause = () => {
  this.state.paused = !this.state.paused;
  const btn = document.getElementById('pause-btn');
  btn.textContent = this.state.paused ? '▶ Resume' : 'Pause';
  btn.classList.toggle('paused', this.state.paused);
  if (!this.state.paused) {
    this.state.autoScroll = true;
    this.hideResumeButton();
    this.filter.applyFilters();
    this.renderer.scrollToBottom();
  }
}
```

**F12 P2 changes:**
1. Replace simple text with LIVE/PAUSED badge widget
2. Track buffered count while paused
3. Show pulsing green `● LIVE` when live
4. Show amber `⏸ PAUSED · N new` when paused
5. Unify `autoScroll` and `paused` into stream state machine

#### Current Keyboard Handler (lines 456–490)

```javascript
handleKeydown = (e) => {
  if (e.target.tagName === 'INPUT' || ...) return;
  switch (e.code) {
    case 'Escape': // close detail or clear filters
    case 'KeyK':   // Ctrl+K → command palette
    case 'KeyL':   // Ctrl+L → clear filters
    case 'Space':  // toggle pause
  }
}
```

**F12 P2 additions:**
```javascript
case 'End':       // resume LIVE
case 'ArrowDown': // Ctrl+↓ → resume LIVE
```

---

### 1.8 filters.js — FilterManager

**File:** `src/frontend/js/filters.js` (~210 lines)

| Method | Lines | F12 Impact |
|--------|-------|------------|
| `setSearch(text)` | 15–22 | Debounced (300ms) search. **P1** — search text drives highlight engine |
| `toggleLevel(level)` | 24–38 | None |
| `setCorrelationFilter(id)` | 40–44 | None |
| `applyPreset(presetName)` | 135–169 | None |
| `clearAll()` | 181–210+ | None |
| `applyFilters()` | 77–80 | Calls `renderer.rerenderAllLogs()` + `rerenderTelemetry()` |

**F12 note:** `setSearch` is the entry point for search text. It sets `state.searchText` after 300ms debounce, then calls `applyFilters()`. The highlight engine reads `state.searchText` during `_populateRow` to decide what to highlight.

---

### 1.9 detail-panel.js — Detail Panel

**File:** `src/frontend/js/detail-panel.js` (~200 lines)

| Method | Lines | F12 Impact |
|--------|-------|------------|
| `showLogDetail(panel, entry)` | 32–113 | Builds detail HTML with `escapeHtml`. **P0** — Add error code decoration in detail panel message |
| `showTelemetryDetail(panel, event)` | 116–180 | Similar. **P0** — Add error code from `attributes.ErrorCode` |

**Line 68 — Message in detail panel:**
```javascript
<div class="detail-message">${this.escapeHtml(entry.message || 'No message')}</div>
```

F12 should replace this with error-code-decorated HTML (same highlight engine used for log rows, but expanded/non-truncated).

---

### 1.10 CSS Files

#### logs.css (277 lines)

| Selector | Lines | F12 Impact |
|----------|-------|------------|
| `.log-row` | 52–65 | Base row style. F12 adds `.log-row.has-error-code` modifier |
| `.log-row.error-row` | 67–70 | Red left border + tint. No change |
| `.log-row:hover` | 89–91 | Hover highlight. No change |
| `.log-message` | 182–190 | Flex: 1, nowrap, ellipsis. **F12** — may need `overflow: hidden` to clip highlight spans |
| `.error-code-hint` | 271–276 | **Pre-existing CSS for error code decoration!** Dashed underline, error color, cursor: help |

**Pre-existing `.error-code-hint` CSS (lines 271–276):**
```css
.error-code-hint {
  text-decoration: underline dashed;
  text-decoration-color: var(--level-error);
  text-underline-offset: 2px;
  cursor: help;
}
```

This means someone already anticipated error code highlighting. F12 extends this with:
- `.error-code-known` — solid underline (known codes)
- `.error-code-unknown` — dashed underline (pattern-matched but not in registry)
- `.error-code-badge` — inline accent-colored badge after the code text

#### logs-enhancements.css (400+ lines)

All selectors prefixed with `le-`. Contains:
- Breakpoint bar styles (lines 9–206)
- Gutter/star styles (lines 208–252)
- Breakpoint hit marker (lines 253–266)
- Flash animation (lines 268–277)
- Cluster summary (not shown in excerpt)

F12 will add a new CSS file (`css/error-intel.css`) or extend `logs.css` with error intelligence styles.

#### variables.css (166 lines)

**Design tokens relevant to F12:**
```css
/* Light theme */
--level-error: #e5453b;           /* Error code underline color */
--level-warning: #e5940c;         /* Warning highlights */
--accent: #6d5cff;                /* Error badge accent */
--accent-dim: rgba(109,92,255,0.07); /* Badge background */
--row-error-tint: rgba(229,69,59,0.04);  /* Error row bg */

/* Dark theme */
--level-error: #ff6b6b;
--accent: #8577ff;
--accent-dim: rgba(133,119,255,0.10);
--row-error-tint: rgba(255,107,107,0.06);
```

**New tokens F12 will need:**
```css
--highlight-search: rgba(255, 213, 79, 0.35);  /* Search match yellow */
--highlight-error: rgba(229, 69, 59, 0.15);    /* Error code subtle bg */
--stream-live: #18a058;                         /* Green LIVE dot */
--stream-paused: #e5940c;                       /* Amber PAUSED dot */
```

---

### 1.11 build-html.py — Build Pipeline

**File:** `scripts/build-html.py` (184 lines)

Single-file builder that assembles CSS, vendor JS, and app JS into `src/edog-logs.html` using placeholder replacement.

**Current module order (lines 68–104):**
```python
JS_MODULES = [
    "js/mock-data.js",
    "js/state.js",
    ...
    "js/error-intel.js",     # ← existing, line 81
    ...
    "js/main.js",            # ← last
]
```

**F12 build pipeline changes:**
1. **New JS module:** `js/error-decoder.js` — must be added after `state.js` and before `main.js`
2. **New JS module:** `js/error-timeline.js` — after `error-decoder.js`
3. **New CSS module:** `css/error-intel.css` (if separate from `logs.css`)
4. **Embed error-codes.json:** Add a `<script>` tag or JSON block in the HTML shell containing the error codes database. Two approaches:
   - (A) Add `/* __ERROR_CODES_JSON__ */` placeholder in `index.html`, replace in `build-html.py`
   - (B) Generate a JS module (`js/error-codes-data.js`) that exports the data as `window.ERROR_CODES_DB = {...}`

**Recommendation:** Option (B) — simpler, no new placeholder needed. The build pipeline:
1. `scripts/generate-error-codes.py` reads `ErrorRegistry.cs` → produces `src/frontend/js/error-codes-data.js`
2. `build-html.py` includes it in `JS_MODULES` (before `error-decoder.js`)

---

### 1.12 Implications for F12

**Summary of all files F12 will touch:**

| File | Changes | Risk |
|------|---------|------|
| `renderer.js` | `_populateRow` — innerHTML transition for `.log-message`, `_onContainerClick` — error badge clicks, `_onScroll` — PAUSED trigger, `flush` — buffered count | HIGH — core rendering |
| `state.js` | Add errorCodesDB, errorOccurrences, streamMode, bufferedCount, errorTimeline, errorFrequency | LOW — additive |
| `logs-enhancements.js` | Replace `detectClusters` with global algorithm, extend `_errorSignature` to use error codes, update cluster summary rendering | MEDIUM |
| `error-intel.js` | Extend with frequency tracking, trend computation, node mapping, connect to decoder | MEDIUM |
| `auto-detect.js` | No changes — its error code regex is already correct | NONE |
| `main.js` | `exportLogs()` replacement, `handleKeydown` additions, `togglePause` enhancement, constructor new modules | MEDIUM |
| `filters.js` | No direct changes | NONE |
| `detail-panel.js` | Error code decoration in `showLogDetail` message area | LOW |
| `logs.css` | New error code, highlight, stream badge, timeline CSS | LOW |
| `variables.css` | Add highlight/stream design tokens | LOW |
| `build-html.py` | Add new JS modules to build order | LOW |

**New files F12 will create:**

| File | Purpose |
|------|---------|
| `scripts/generate-error-codes.py` | Parse ErrorRegistry.cs → JSON |
| `src/frontend/js/error-codes-data.js` | Generated: `window.ERROR_CODES_DB = {...}` |
| `src/frontend/js/error-decoder.js` | Runtime: pattern matching, 3-layer detection, context cards |
| `src/frontend/js/error-timeline.js` | Error timeline chart |
| `src/frontend/css/error-intel.css` | Error intelligence styles (optional — may go in logs.css) |

---

## §2 — ErrorRegistry.cs Analysis

### 2.1 Presence in This Repository

**ErrorRegistry.cs does NOT exist in the edog-studio repository.**

Search results:
- `glob **/*.cs` found 22 `.cs` files, all under `src/backend/DevMode/` — these are EDOG Studio's own C# interceptors (EdogLogServer, EdogLogInterceptor, etc.), not FLT source code.
- `grep -i "ErrorRegistry"` found references only in:
  - `docs/specs/features/F12-error-intelligence/spec.md` (the spec itself)
  - `hivemind/agents/prompts.py` (Vex agent prompt: "Error codes: ErrorRegistry.cs, error -> retry policy mapping")
  - `docs/specs/design-spec-v2.md` (design spec)
  - `docs/hivemind-brainstorm-raw.md` (planning)

**Conclusion:** ErrorRegistry.cs lives in the FLT repository (`workload-fabriclivetable`), not in edog-studio. The build pipeline must either:
1. Accept a path to ErrorRegistry.cs as input argument, or
2. Accept a pre-generated error-codes.json file, or
3. Ship a curated error-codes.json with known codes (updated periodically)

### 2.2 Error Code Format (Inferred from Codebase)

From the existing codebase, we can infer the error code format:

**1. Error code prefix patterns** (from `auto-detect.js:110`):
```javascript
/\b(MLV_\w+|FLT_\w+|SPARK_\w+)\b/
```

Three prefixes:
- `MLV_` — MaterializedLakeView errors (primary)
- `FLT_` — FabricLiveTable errors
- `SPARK_` — Spark session errors

**2. Known error code examples** (from spec and logs):
- `MLV_SPARK_SESSION_ACQUISITION_FAILED`
- Pattern: `PREFIX_SUBSYSTEM_DESCRIPTION` with underscores

**3. Error classification** (from spec §3):
- `USER ERROR` — caused by user configuration
- `SYSTEM ERROR` — internal system failure

**4. ErrorRegistry.cs likely structure** (inferred from Vex agent prompt and spec):

Based on typical .NET error registry patterns and the spec's mention of "message templates, categories":

```csharp
// Likely structure in workload-fabriclivetable repo:
public static class ErrorRegistry
{
    public static readonly ErrorDefinition MLV_SPARK_SESSION_ACQUISITION_FAILED = new(
        code: "MLV_SPARK_SESSION_ACQUISITION_FAILED",
        description: "Failed to acquire a Spark session for the materialized view refresh",
        category: ErrorCategory.System,
        suggestedFix: "Check Spark pool availability and capacity limits",
        retryable: true
    );
    
    // ... more error definitions
}
```

Alternative pattern (dictionary-based):
```csharp
public static readonly Dictionary<string, ErrorInfo> Errors = new()
{
    ["MLV_SPARK_SESSION_ACQUISITION_FAILED"] = new ErrorInfo(
        "Failed to acquire Spark session",
        ErrorCategory.System,
        "Check Spark pool availability"
    ),
    // ...
};
```

### 2.3 Proposed error-codes.json Schema

```json
{
  "$schema": "https://json-schema.org/draft-07/schema#",
  "version": "1.0",
  "generatedAt": "2026-04-17T00:00:00Z",
  "source": "ErrorRegistry.cs",
  "codes": {
    "MLV_SPARK_SESSION_ACQUISITION_FAILED": {
      "title": "Spark Session Acquisition Failed",
      "description": "Failed to acquire a Spark session for the materialized view refresh. The Spark pool may be at capacity or unavailable.",
      "category": "SYSTEM",
      "severity": "error",
      "suggestedFix": "Check Spark pool availability and capacity limits. Verify the workspace has sufficient CU allocation.",
      "retryable": true,
      "runbookUrl": null,
      "relatedCodes": ["MLV_SPARK_SESSION_TIMEOUT", "SPARK_POOL_EXHAUSTED"]
    }
  }
}
```

**Schema fields:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `title` | string | yes | Human-readable short title |
| `description` | string | yes | Full description |
| `category` | `"USER"\|"SYSTEM"` | yes | Classification |
| `severity` | `"error"\|"warning"\|"info"` | yes | Severity level |
| `suggestedFix` | string | yes | Actionable fix suggestion |
| `retryable` | boolean | no | Whether the operation is worth retrying |
| `runbookUrl` | string\|null | no | Link to troubleshooting guide |
| `relatedCodes` | string[] | no | Related error codes |

### 2.4 Parser Strategy

Since ErrorRegistry.cs is not in this repo, the parser (`generate-error-codes.py`) should:

1. **Accept flexible input:**
   ```bash
   python scripts/generate-error-codes.py --input /path/to/ErrorRegistry.cs
   python scripts/generate-error-codes.py --input /path/to/errors.json  # pre-formatted
   python scripts/generate-error-codes.py --manual  # interactive entry
   ```

2. **C# parser approach:**
   - Regex-based (not a full C# parser)
   - Extract field assignments: `code:`, `description:`, `category:`, `suggestedFix:`
   - Handle both `new ErrorDefinition(...)` and dictionary initialization patterns
   - Fail loudly on parse errors (don't silently skip codes)

3. **Fallback: curated JSON file:**
   - Ship a `data/error-codes-curated.json` with manually documented codes
   - Parser merges curated data with parsed data (curated wins on conflicts)
   - This ensures F12 works even without access to FLT repo

4. **Output:** `src/frontend/js/error-codes-data.js`:
   ```javascript
   // AUTO-GENERATED — Do not edit manually
   // Source: ErrorRegistry.cs (parsed 2026-04-17)
   window.ERROR_CODES_DB = {
     "MLV_SPARK_SESSION_ACQUISITION_FAILED": { ... },
     // ...
   };
   ```

### 2.5 Implications for F12

1. **The parser must be flexible** — ErrorRegistry.cs format may change, and access to FLT repo isn't guaranteed at build time.
2. **Ship a curated baseline** — Include known error codes manually documented from team knowledge. The parser augments but doesn't replace this.
3. **Three-layer detection** handles the gap gracefully:
   - Known codes (in JSON) → full decoration
   - Pattern-matched codes (MLV_*/FLT_*/SPARK_*) not in JSON → dashed underline + "?" badge
   - No match → no decoration
4. **The `error-codes-data.js` approach** (generated JS file with `window.ERROR_CODES_DB`) integrates cleanly with the existing `build-html.py` pipeline — just add it to `JS_MODULES`.
5. **Error code pattern from auto-detect.js** (`/\b(MLV_\w+|FLT_\w+|SPARK_\w+)\b/`) is already battle-tested and should be reused in the decoder.

---

## §3 — Industry Research

### 3.1 Datadog Log Explorer

**Error Highlighting:**
- Automatic facet extraction from structured log fields (error.kind, error.message, error.stack)
- Error logs have red left-border and red background tint (similar to our `.error-row`)
- Error fields are clickable → auto-filter to that error type
- No inline error code decoration within log messages (relies on structured fields)

**Log Stream / Live Tail:**
- "Live Tail" mode: separate view from Log Explorer
- Shows logs streaming in real-time with auto-scroll
- Explicit pause button freezes the stream
- "New logs" counter badge appears when paused
- Scrolling up does NOT auto-pause — only the pause button pauses
- Resume: click play button or scroll to bottom

**Error Analytics:**
- Log Analytics view with time-series charts
- Error rate over time as line/bar chart
- Group-by error type with faceted counts
- Pattern detection: "Similar errors grouped" feature
- Trend indicators on error patterns (spike detection)

**Search Highlighting:**
- Search terms highlighted in yellow within matching log lines
- Regex search support
- Multi-term search with AND/OR operators
- Highlight visible in both list view and expanded detail

**Export:**
- CSV export of current view
- Configurable columns
- Time range respected
- "Share" → generates permalink with current filters

**Patterns to adopt:**
- ✅ Red left-border for errors (already have this)
- ✅ Clickable error fields → auto-filter
- ✅ "New logs" counter badge when paused
- ⚠️ DO NOT separate Live Tail from main view (keep integrated)
- ✅ Yellow highlight for search terms

### 3.2 Grafana Loki + Explore

**Error Highlighting:**
- Log level coloring (error = red, warn = yellow)
- Detected fields panel on right side shows extracted labels
- No inline error code decoration
- "Detected fields" auto-extracts key-value pairs from unstructured logs

**Log Stream / Live Mode:**
- "Live" toggle button in query bar
- When live: auto-scroll, logs appear at bottom
- Clicking "Pause" or scrolling up pauses the stream
- **Key UX:** Scrolling up = auto-pause (same as our spec)
- Badge shows "X new logs" when paused
- Click badge or press "Resume" → snap to bottom

**Error Analytics:**
- Built-in metrics queries (rate of errors over time)
- Flame graph for distributed tracing
- No built-in error clustering in log view

**Search Highlighting:**
- LogQL search terms highlighted in result
- `|= "error"` filter highlights the matching substring
- Regex support via `|~ "pattern"`
- Highlighting happens server-side in response metadata

**Export:**
- "Inspect" panel shows raw JSON
- Can copy individual log lines
- Export to CSV via "Download as CSV" button
- Respects current query/filter

**Patterns to adopt:**
- ✅ Scroll-up = auto-pause (already in spec)
- ✅ "X new logs" badge when paused
- ✅ Search term highlighting
- ✅ "Detected fields" concept → could apply to error code detection

### 3.3 Seq (Datalust)

**Error Highlighting:**
- Structured event rendering: properties are color-coded
- Exception rendering with collapsible stack traces
- `@Level = 'Error'` events have red background
- "Message template" extraction — same template = same group

**Log Stream / Tail:**
- "Tail" mode with pulsing green indicator
- Auto-pauses when user scrolls up
- Shows "X events arrived" banner
- Click banner → resume to latest
- Smooth transition between paused and live

**Error Analytics:**
- "Signals" feature: pattern detection across log events
- Occurrence counting per message template
- First/last occurrence timestamps
- Trend graph (sparkline) per signal/pattern

**Search Highlighting:**
- Full-text search with highlighted matches
- Property value highlighting
- Regex support
- Highlight persists in expanded event detail

**Export:**
- JSON, CSV, CLEF (Compact Log Event Format)
- Export filtered/visible only
- Copy single event as JSON

**Patterns to adopt:**
- ✅ Message template grouping → maps to our error signature
- ✅ Pulsing green indicator for LIVE mode
- ✅ "X events arrived" banner on pause
- ✅ First/last occurrence timestamps
- ✅ Sparkline trend per pattern
- ✅ CLEF-like format option (we'll do JSON/CSV/Text)

### 3.4 Chrome DevTools Console

**Error Highlighting:**
- Error messages in red text
- Warning in yellow
- Error stack traces collapsible
- Error count badge on Console tab icon
- "Similar errors grouped" with occurrence count

**Log Stream / Pause:**
- No explicit pause/live mode
- Console never auto-scrolls if user has scrolled up (implicit pause)
- "Scroll to bottom" arrow appears when not at bottom
- New messages continue appearing in buffer regardless

**Error Analytics:**
- Error count in Console tab badge
- "Errors" filter button with count
- No timeline chart or trend analysis
- Grouped similar messages with "× N" count badge

**Search Highlighting:**
- Search bar highlights ALL matching substrings in yellow
- Regex toggle button
- Case-sensitive toggle
- Shows "N of M results" with prev/next navigation
- Matches highlighted even in collapsed sections

**Export:**
- Right-click → "Save as..."
- Copy individual message
- "Store as global variable" for objects
- No format selector

**Patterns to adopt:**
- ✅ Error count badge on tab icon
- ✅ "× N" count for grouped similar errors
- ✅ Search prev/next navigation (stretch goal)
- ✅ Implicit pause on scroll-up (already in spec)

### 3.5 Azure Monitor / Application Insights

**Error Highlighting:**
- "Failures" blade: dedicated error analysis view
- Exception events highlighted with red severity badge
- Dependency failures with orange badge
- Error codes shown as facets in sidebar

**Log Stream:**
- No real-time streaming in standard Log Analytics
- "Live Metrics" view for real-time:
  - Auto-scrolling telemetry stream
  - Pause button freezes the view
  - Counter shows events/sec
  - No scroll-up auto-pause

**Error Analytics:**
- "Smart Detection" — automatic anomaly detection on error rates
- Time-series chart of exceptions by type
- Exception drill-down: type → occurrence timeline → individual events
- "Impact analysis" shows affected users/operations
- Trend indicators (arrows) on exception types

**Search Highlighting:**
- KQL query results highlighted
- No inline substring highlighting in log text
- Field value highlighting in result grid

**Export:**
- "Export to CSV" button
- "Export to Power BI" (M query)
- JSON export via API
- Filtered results only

**Patterns to adopt:**
- ✅ Dedicated error analysis blade concept → our Error Timeline
- ✅ Exception type → occurrence timeline → individual events drill-down
- ✅ Trend indicators (arrows) on exception types
- ✅ Impact analysis (affected nodes) → our node mapping

### 3.6 Comparison Matrix

| Feature | Datadog | Loki | Seq | Chrome | Azure Mon | **F12 Plan** |
|---------|---------|------|-----|--------|-----------|--------------|
| Error code inline decoration | ✗ | ✗ | ✗ | ✗ | ✗ | **✓ Unique** |
| Error context card on hover | ✗ | ✗ | Partial | ✗ | ✗ | **✓ Unique** |
| Search term highlighting | ✓ | ✓ | ✓ | ✓ | Partial | ✓ |
| Scroll-up auto-pause | ✗ | ✓ | ✓ | ✓ (implicit) | ✗ | ✓ |
| LIVE badge | ✗ | ✓ | ✓ (pulsing) | ✗ | ✗ | ✓ (pulsing) |
| Buffered count badge | ✓ | ✓ | ✓ | ✗ | ✗ | ✓ |
| Error timeline chart | ✓ | Via metrics | Sparklines | ✗ | ✓ | ✓ |
| Error clustering (global) | Patterns | ✗ | Signals | Grouped | Smart Detect | ✓ |
| Frequency trends | ✗ | ✗ | ✓ | ✗ | ✓ | ✓ |
| Multi-format export | CSV | CSV | JSON/CSV/CLEF | ✗ | CSV/PBI/JSON | JSON/CSV/Text |
| Filtered export | ✓ | ✓ | ✓ | ✗ | ✓ | ✓ |

### 3.7 Patterns to Adopt

**1. Scroll-up auto-pause (from Loki, Seq, Chrome):**
- Already in spec and partially implemented (`_onScroll` detects scroll-up)
- Add: visual state transition, buffered count badge

**2. Pulsing LIVE indicator (from Seq):**
- Green pulsing dot when streaming
- Amber static dot when paused
- Clean, minimal — not a distracting animation

**3. "X new" badge (from Datadog, Loki, Seq):**
- Show count of new entries since pause
- Click badge → resume + scroll to bottom
- Counter increments in real-time

**4. Yellow search highlights (from all tools):**
- Universal pattern — yellow/gold background on matching substrings
- Use `<mark>` tag for semantic correctness
- Coexist with error code decoration (error code wins on overlap)

**5. Sparkline trends (from Seq):**
- Per-pattern mini trend visualization
- ↑↓→ direction indicators sufficient for MVP (sparklines are V2)

**6. Error-type-to-timeline drill-down (from Azure Monitor):**
- Click error code → timeline filters to show only that code
- Click timeline bar → filter to that time window
- Two-way navigation between timeline and error codes

**7. Export with format selector (from Seq, Azure):**
- Dropdown/radio for JSON/CSV/Text
- Always filtered-only
- Toast notification on success

### 3.8 Implications for F12

**F12's unique differentiator:** No production tool decorates error codes inline within log messages with hover cards. This is a genuinely novel feature that combines IDE-style intellisense with log viewing.

**What we adopt from industry:**
- Scroll-up auto-pause + LIVE/PAUSED badge (Loki/Seq pattern)
- Yellow search highlighting (universal pattern)
- Buffered count badge (Datadog/Loki pattern)
- Multi-format filtered export (Seq pattern)
- Error frequency trends with ↑↓→ (Azure/Seq pattern)

**What we skip (V2+):**
- Sparkline charts per error pattern (Seq)
- KQL/query language (Azure)
- Server-side search highlighting (Loki)
- AI-powered anomaly detection on error rates (Azure Smart Detection)

---

## §4 — innerHTML Security Audit

### 4.1 Current textContent Usage Map

Every place in `renderer.js` that sets text on log row elements:

| Line | Element | Method | Code |
|------|---------|--------|------|
| 383 | `row._time` | `textContent` | `row._time.textContent = this._formatTimeFast(entry.timestamp);` |
| 386 | `row._level` | `textContent` | `row._level.textContent = this._levelLetters[levelLower] \|\| 'I';` |
| 391 | `row._component` | `textContent` | `row._component.textContent = component;` |
| **397** | **`row._message`** | **`textContent`** | **`row._message.textContent = msg.length > 500 ? msg.substring(0, 500) + '\u2026' : msg;`** |

**Only line 397 needs to change for F12.** Time, level, and component remain `textContent` (no highlights needed there).

Additional `textContent` usage in renderer.js (non-log-row, safe to keep):
| Line | Context | Safe? |
|------|---------|-------|
| 657 | `visibleCountEl.textContent` | ✓ Display only |
| 658 | `totalCountEl.textContent` | ✓ Display only |
| 665 | `countEl.textContent` | ✓ Display only |
| 677–679 | Stats elements | ✓ Display only |

### 4.2 Current Escaping Infrastructure

**`Renderer.escapeHtml(text)`** (renderer.js:649–652):

```javascript
escapeHtml = (text) => {
  if (!text) return '';
  return text.replace(/&/g, '&amp;')
             .replace(/</g, '&lt;')
             .replace(/>/g, '&gt;')
             .replace(/"/g, '&quot;');
}
```

**Analysis:**
- Handles the 4 critical HTML entities: `&`, `<`, `>`, `"`
- Missing: single quote (`'` → `&#39;`) — not critical for our use case since we don't use single-quoted attributes
- Missing: backtick (`` ` ``) — not an HTML issue but relevant for template literal injection (not applicable here)
- **Performance:** String `.replace()` chain — fast for short strings, adequate for log messages truncated to 500 chars

**Where `escapeHtml` is already used:**
- Telemetry card rendering (renderer.js:476–498) — `this.escapeHtml(resultCode)`, `this.escapeHtml(correlationId)`, etc.
- Detail panel (detail-panel.js) — `this.escapeHtml(entry.message)`

**Where `escapeHtml` is NOT used but should be (pre-existing issues):**
- `error-intel.js:38` — `showAlert` builds HTML from `summary` string containing error codes and node names extracted from log messages. These are **not escaped**. If a log message contained `<script>alert(1)</script>` in the error code position, it would execute.

### 4.3 Places Already Using innerHTML Safely

Several places in the codebase already use `innerHTML` with proper escaping:

| File | Lines | What | Escaping |
|------|-------|------|----------|
| `renderer.js` | 496–507 | Telemetry cards | `escapeHtml()` on all user data |
| `detail-panel.js` | 43–86 | Log detail panel | `escapeHtml()` on all fields |
| `detail-panel.js` | 129–180 | Telemetry detail | `escapeHtml()` on all fields |
| `logs-enhancements.js` | 375, 564, 674, 776 | Various UI builders | Mostly `textContent`, some `innerHTML` |
| `error-intel.js` | 38–44 | Error alert | **UNESCAPED** ← F12 should fix |

### 4.4 The Transition: textContent → innerHTML for Log Messages

**What changes:**

Currently (renderer.js:397):
```javascript
row._message.textContent = msg.length > 500 ? msg.substring(0, 500) + '\u2026' : msg;
```

After F12 (renderer.js:397 replacement):
```javascript
const truncated = msg.length > 500 ? msg.substring(0, 500) + '\u2026' : msg;
row._message.innerHTML = this._highlightMessage(truncated, entry);
```

**`_highlightMessage` pipeline:**
```javascript
_highlightMessage(rawMsg, entry) {
  // Step 1: HTML-escape the ENTIRE message
  let safe = this.escapeHtml(rawMsg);
  
  // Step 2: Apply error code decoration (highest priority)
  safe = this._decorateErrorCodes(safe, entry);
  
  // Step 3: Apply search highlighting (lower priority, skip inside decorations)
  if (this.state.searchText) {
    safe = this._highlightSearchTerms(safe, this.state.searchText);
  }
  
  return safe;
}
```

**The key security guarantee:** The message is ALWAYS escaped first (Step 1), and then only known-safe HTML tags are **inserted** into the escaped string. User-controlled content never bypasses escaping.

### 4.5 Allowed HTML Whitelist

F12's innerHTML will only produce these tags:

| Tag | Attributes | Purpose | Example |
|-----|-----------|---------|---------|
| `<mark>` | `class="search-highlight"` | Search match highlighting | `<mark class="search-highlight">matched</mark>` |
| `<span>` | `class="error-code-known"`, `class="error-code-unknown"`, `class="error-code-badge"`, `data-code="..."` | Error code decoration | `<span class="error-code-known" data-code="MLV_SPARK_...">MLV_SPARK_...</span>` |

**Explicitly disallowed:**
- No `<a>` tags (all links go in the popover card, not inline)
- No `<img>`, `<iframe>`, `<script>`, `<style>` tags
- No `onclick`, `onerror`, or any event handler attributes
- No `style` attributes
- No `href`, `src`, or any URL-bearing attributes

### 4.6 Escaping Pipeline Design

```
User log message (untrusted)
        │
        ▼
┌─────────────────────────┐
│  1. Truncate to 500 ch  │  ← Same as current behavior
└────────────┬────────────┘
             │
             ▼
┌─────────────────────────┐
│  2. escapeHtml()        │  ← & < > " all escaped
│     (entire message)    │     No user HTML survives
└────────────┬────────────┘
             │
             ▼  Now working with SAFE escaped string
┌─────────────────────────┐
│  3. Error code regex    │  ← /\b(MLV_\w+|FLT_\w+|SPARK_\w+)\b/
│     on escaped string   │     Codes contain only [A-Z0-9_] — safe
└────────────┬────────────┘
             │
             ▼
┌─────────────────────────┐
│  4. Replace code text   │  ← Replace "MLV_FOO" with
│     with <span> wrapper │     <span class="error-code-known"
│                         │      data-code="MLV_FOO">MLV_FOO</span>
└────────────┬────────────┘
             │
             ▼
┌─────────────────────────┐
│  5. Search highlight    │  ← Replace matched substrings with
│     (skip inside <span  │     <mark class="search-highlight">...</mark>
│      tags from step 4)  │     Skip regions inside existing tags
└────────────┬────────────┘
             │
             ▼
┌─────────────────────────┐
│  6. Set innerHTML       │  ← Only safe tags present
│     on row._message     │
└─────────────────────────┘
```

**Why this is safe:**

1. **Step 2 escapes everything.** After this step, `<script>` becomes `&lt;script&gt;`. No user HTML can execute.
2. **Steps 3–5 only insert known-safe tags.** The regex patterns match alphanumeric codes (no HTML metacharacters). The replacement strings are hardcoded template strings with class attributes — no user data in attributes (the `data-code` attribute value is the error code itself, which is `[A-Z0-9_]+` — guaranteed safe).
3. **Step 5 skips inside tags.** The search highlighter must not highlight inside existing `<span>` tags from step 4. Implementation: use a simple state machine that tracks whether we're inside a `<` and `>`.

### 4.7 Performance Analysis: innerHTML vs textContent at Scale

**Benchmark context:**
- Virtual scroll renders ~80 rows per frame (viewport + overscan)
- Render throttle: 100ms
- Worst case: filter change triggers full rerender of all visible rows

**textContent performance (current):**
- No HTML parsing — direct text node update
- ~0.01ms per row assignment
- Total for 80 rows: ~0.8ms

**innerHTML performance (F12):**
- Browser must parse HTML string → create DOM nodes
- ~0.05–0.1ms per row for simple HTML (2-3 inline tags)
- Total for 80 rows: ~4–8ms
- Still well within 16.6ms frame budget

**Mitigation strategies:**

1. **Cache highlight results per seq.** If the same row (same `seq`) is re-rendered (just repositioned), skip re-computing highlights:
   ```javascript
   if (row._seq === seq && row._highlightVersion === this._highlightVersion) {
     // Just reposition, don't recompute innerHTML
     return;
   }
   ```

2. **Lazy highlighting.** Only compute highlights for rows that are actually new in the viewport. Existing rows that just shift position keep their current HTML.

3. **Pre-compute error code positions.** When a log entry is first added to the ring buffer, scan for error codes and cache the positions. Then `_highlightMessage` just wraps at cached positions instead of re-running the regex.

4. **Batch innerHTML assignments.** Instead of setting `innerHTML` 80 times, collect all HTML strings and set them in a single RAF callback. (Note: this is already the case since `_renderVirtualScroll` runs inside RAF.)

**Estimated overhead:**
- Additional CPU per render: ~3–7ms (from ~0.8ms to ~4–8ms)
- Still leaves ~8ms for other work within the 16.6ms frame budget
- No perceived lag at 100ms throttle

**Edge case: 50K rows in ring buffer:**
- Virtual scroll means only ~80 rows are ever in DOM
- Ring buffer size doesn't affect innerHTML performance
- Filter rebuilds may be slow but that's O(N) `passesFilter` calls, not DOM work

### 4.8 XSS Attack Vectors and Mitigations

**Vector 1: Malicious log message**
```
Attack: Log message contains <script>alert('xss')</script>
Step 2: escapeHtml → &lt;script&gt;alert('xss')&lt;/script&gt;
Result: ✅ SAFE — rendered as literal text
```

**Vector 2: Error code lookalike**
```
Attack: Log message contains MLV_<img src=x onerror=alert(1)>
Step 2: escapeHtml → MLV_&lt;img src=x onerror=alert(1)&gt;
Step 3: Error code regex → /\b(MLV_\w+)\b/ matches "MLV_" but stops at &lt; (not \w)
Result: ✅ SAFE — only "MLV_" would be wrapped if it continued with word chars
```

**Vector 3: Breaking out of data-code attribute**
```
Attack: Error code is MLV_FOO" onclick="alert(1)
Step 2: escapeHtml → MLV_FOO&quot; onclick=&quot;alert(1)
Step 3: Regex /\b(MLV_\w+)\b/ matches "MLV_FOO" (stops at &)
Step 4: data-code="MLV_FOO" — clean, &quot; is outside the match
Result: ✅ SAFE
```

**Vector 4: Search term injection**
```
Attack: User types <img src=x onerror=alert(1)> in search box
Step 5: Search highlight escapes the search term itself before regex matching
Implementation: search term must be regex-escaped AND HTML-escaped
Result: ✅ SAFE — IF search term is properly escaped (see implementation note)
```

**Implementation note for Step 5 (search highlight):**
```javascript
_highlightSearchTerms(safeHtml, searchText) {
  // Must escape the search term for regex special chars
  const escaped = searchText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // DO NOT use the raw searchText — it could contain HTML
  // Match against the already-escaped HTML, so < in search = &lt; in text
  const regex = new RegExp('(' + escaped + ')', 'gi');
  
  // Skip inside existing HTML tags
  return safeHtml.replace(
    /(<[^>]+>)|([^<]+)/g,
    (match, tag, text) => {
      if (tag) return tag; // Preserve tags untouched
      return text.replace(regex, '<mark class="search-highlight">$1</mark>');
    }
  );
}
```

**Vector 5: Search term that looks like HTML entity**
```
Attack: User searches for "&lt;" hoping to match literal "<" in messages
Behavior: Search operates on the escaped string, so "&lt;" would match
          the escaped form, which is the correct behavior.
Result: ✅ CORRECT — searching for "<" should match "<" in the message,
        and since the message is already escaped, this works.
```

Actually — **correction**: The search text from the input is plain text (e.g., `<`), but the escaped HTML has `&lt;`. We need to escape the search term to HTML before matching:

```javascript
_highlightSearchTerms(safeHtml, searchText) {
  // First, HTML-escape the search term so it matches the escaped content
  const htmlSearchText = this.escapeHtml(searchText);
  const escaped = htmlSearchText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Now match against escaped HTML
  // ...
}
```

This ensures searching for `<script>` matches the literal text `<script>` in log messages (which appears as `&lt;script&gt;` in the escaped HTML).

### 4.9 Implications for F12

**Security requirements:**
1. **All log message text MUST be HTML-escaped before any tag insertion** — this is the non-negotiable security guarantee
2. **Only `<mark>` and `<span>` with specific class/data attributes** — no other tags
3. **No event handler attributes** — all interactivity via event delegation on container
4. **Search terms must be HTML-escaped before regex matching** — to correctly match escaped content
5. **Error code patterns are alphanumeric (`[A-Z0-9_]+`)** — inherently safe for use in `data-code` attribute values

**Performance requirements:**
1. **Target: <1ms per row for highlight computation** — achievable with regex on 500-char strings
2. **Cache highlight results per seq** — avoid recomputation on scroll repositioning
3. **Total render overhead: <8ms for 80 visible rows** — leaves headroom in 16.6ms frame budget

**Pre-existing XSS fix needed:**
- `error-intel.js:38` — `showAlert` uses unescaped `summary` in innerHTML. F12 should fix this while we're in the innerHTML security space.

**Implementation order:**
1. Add highlight pipeline to `_populateRow` (isolated change)
2. Add error code decoration (reuses same pipeline)
3. Add search highlighting (same pipeline, lower priority)
4. Fix pre-existing `error-intel.js` XSS issue
5. Verify with malicious test data (log messages containing HTML)

---

## Appendix A: Quick Reference — Key Line Numbers

| What | File | Lines |
|------|------|-------|
| RowPool._createRowTemplate | renderer.js | 18–53 |
| Renderer._populateRow | renderer.js | 376–419 |
| **row._message.textContent (THE LINE)** | **renderer.js** | **397** |
| Renderer._onScroll (auto-pause detection) | renderer.js | 184–203 |
| Renderer.flush (paused skip) | renderer.js | 223–263 |
| Renderer.escapeHtml | renderer.js | 649–652 |
| Renderer._onContainerClick (event delegation) | renderer.js | 154–182 |
| Renderer.passesFilter | renderer.js | 528–602 |
| Renderer._renderVirtualScroll | renderer.js | 267–363 |
| RingBuffer class | state.js | 8–63 |
| FilterIndex class | state.js | 67–121 |
| LogViewerState class | state.js | 125–223 |
| LogViewerState.autoScroll | state.js | 135 |
| LogViewerState.paused | state.js | 136 |
| LogViewerState.searchText | state.js | 131 |
| LogsEnhancements.detectClusters | logs-enhancements.js | 255–299 |
| LogsEnhancements._injectGutterColumn | logs-enhancements.js | 492–555 |
| LogsEnhancements._errorSignature | logs-enhancements.js | 1002–1007 |
| LogsEnhancements._bindKeyboard | logs-enhancements.js | 895–922 |
| ErrorIntelligence class | error-intel.js | 5–51 |
| ErrorIntelligence.showAlert (XSS risk) | error-intel.js | 20–45 |
| AutoDetector error code regex | auto-detect.js | 110 |
| AutoDetector error object shape | auto-detect.js | 112 |
| EdogLogViewer.exportLogs | main.js | 1014–1041 |
| EdogLogViewer.togglePause | main.js | 681–694 |
| EdogLogViewer.handleKeydown | main.js | 456–490 |
| EdogLogViewer.bindEventListeners | main.js | 299–454 |
| FilterManager.setSearch | filters.js | 15–22 |
| FilterManager.applyFilters | filters.js | 77–80 |
| DetailPanel.showLogDetail (message render) | detail-panel.js | 32–113 |
| .error-code-hint CSS | logs.css | 271–276 |
| .log-message CSS | logs.css | 182–190 |
| Design tokens (error/accent) | variables.css | 79–108 |
| build-html.py JS_MODULES | build-html.py | 68–104 |
| build-html.py build() | build-html.py | 127–184 |

## Appendix B: Error Code Pattern Summary

| Pattern | Source | Usage |
|---------|--------|-------|
| `/\b(MLV_\w+\|FLT_\w+\|SPARK_\w+)\b/` | auto-detect.js:110 | Error extraction from log messages |
| `event.attributes.ErrorCode` | auto-detect.js:157 | Error codes from SSR telemetry |
| `.error-code-hint` CSS class | logs.css:271 | Pre-existing error code styling |
| Error object: `{ code, message, timestamp, node }` | auto-detect.js:112 | Error data shape in AutoDetector |

## Appendix C: State Properties F12 Will Add

```javascript
// === Error Decoder (P0) ===
state.errorCodesDB = {};           // Loaded from embedded JSON at startup
state.errorOccurrences = new Map(); // code → { count, firstSeen, lastSeen, nodes: Set }

// === Stream Control (P2) ===
state.streamMode = 'LIVE';         // 'LIVE' | 'PAUSED'
state.bufferedCount = 0;           // Logs received while paused (increments in addLog when paused)
state.pauseReason = null;          // 'scroll' | 'manual' | 'hover' | null

// === Error Analytics (P3) ===
state.errorTimeline = [];          // Array of { startTime, endTime, counts: { error, warning } }
state.globalClusters = [];         // Global signature-based clusters
state.errorFrequency = new Map();  // code → { rate: number, trend: '↑'|'↓'|'→', window: [] }
```

## Appendix D: Files Touched Summary

```
MODIFIED:
  src/frontend/js/renderer.js        — _populateRow innerHTML, _onContainerClick, _onScroll, flush
  src/frontend/js/state.js            — New state properties
  src/frontend/js/logs-enhancements.js — Global clustering algorithm
  src/frontend/js/error-intel.js      — Frequency tracking, trend, node mapping, XSS fix
  src/frontend/js/main.js             — exportLogs, togglePause, keyboard, constructor
  src/frontend/js/detail-panel.js     — Error code decoration in detail view
  src/frontend/css/logs.css           — Error code, highlight, stream badge styles
  src/frontend/css/variables.css      — New design tokens
  scripts/build-html.py               — Add new JS/CSS modules

NEW:
  scripts/generate-error-codes.py     — ErrorRegistry.cs → JSON parser
  data/error-codes-curated.json       — Manually curated error codes baseline
  src/frontend/js/error-codes-data.js — Generated: window.ERROR_CODES_DB
  src/frontend/js/error-decoder.js    — Runtime decoder: pattern match, 3-layer detection, context cards
  src/frontend/js/error-timeline.js   — Error timeline chart component
```

---

*End of Phase 0 Foundation Research. This document is the canonical reference for all F12 component specs (P1), architecture decisions (P2), state matrices (P3), and implementation (P5).*
