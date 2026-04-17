# F12 Error Intelligence & Log Experience — Architecture

> **Feature:** F12 · **Status:** Architecture Complete
> **Authors:** Sana (architecture), Pixel (frontend), Vex (build pipeline)
> **Inputs:** spec.md, research/p0-foundation.md, components/C01–C07
> **Target:** 40–60KB — senior engineer can implement without questions

---

## Table of Contents

1. [Data Model](#1-data-model)
2. [Module Dependency Graph](#2-module-dependency-graph)
3. [Highlight Engine Design (Keystone)](#3-highlight-engine-design-keystone)
4. [Stream Controller Design](#4-stream-controller-design)
5. [Error Analytics Pipeline](#5-error-analytics-pipeline)
6. [Build Pipeline Integration](#6-build-pipeline-integration)
7. [Performance Targets](#7-performance-targets)
8. [Security Model](#8-security-model)
9. [Error Handling](#9-error-handling)
10. [Implementation Order](#10-implementation-order)

---

## §1 — Data Model

All interfaces are written in TypeScript notation for documentation clarity. The runtime is vanilla JavaScript (ADR-002).

### 1.1 Error Codes Database (`error-codes.json`)

**Canonical schema (from C01 §S04, JSON Schema draft-07):**

```typescript
/** Top-level schema for the curated error codes file */
interface ErrorCodesFile {
  $schema: string;                         // "https://json-schema.org/draft-07/schema#"
  version: string;                         // Pattern: /^\d+\.\d+$/  e.g. "1.0"
  generatedAt: string | null;             // ISO 8601 timestamp, null for curated
  source: string;                          // Human-readable description
  codes: Record<string, ErrorCodeEntry>;   // Key pattern: /^(MLV|FLT|SPARK)_[A-Z][A-Z0-9_]+$/
}

/** Single error code entry */
interface ErrorCodeEntry {
  title: string;              // Human-readable short title (min 1 char)
  description: string;        // Full description (min 1 char)
  category: 'USER' | 'SYSTEM';
  severity: 'error' | 'warning' | 'info';
  suggestedFix: string;       // Actionable fix text (min 1 char)
  retryable?: boolean;        // Whether retry may help (optional)
  runbookUrl?: string | null;  // Link to troubleshooting guide (optional)
  relatedCodes?: string[];    // Related error code keys (optional)
}
```

**Runtime shape:** Flat dict on `window.ERROR_CODES_DB` (no metadata wrapper). Access: `window.ERROR_CODES_DB["MLV_SPARK_SESSION_FAILED"]`. Falls back to `{}` if missing.

**Validation rules (C01 §S04):** Code format `/^(MLV|FLT|SPARK)_[A-Z][A-Z0-9_]+$/`. Required: `title`, `description`, `category`, `severity`, `suggestedFix` (all non-empty). Enums: `category ∈ {USER, SYSTEM}`, `severity ∈ {error, warning, info}`. `relatedCodes` cross-refs must exist (warning unless `--strict`).

### 1.2 Highlight Range Format

**Canonical format (from C03 §2):**

```typescript
/**
 * A highlight range describes a span of decorated text within a log message.
 * Positions are character indices in the RAW (pre-escape) message string.
 */
interface HighlightRange {
  start: number;                // Inclusive start index in raw text
  end: number;                  // Exclusive end index in raw text
  className: 'search-hit' | 'error-code-known' | 'error-code-unknown';
  data?: {
    code?: string;              // Error code string, ONLY [A-Z0-9_]+ characters
  };
}
```

**Contract rules:**
- Sorted ascending by `start`
- Non-overlapping after priority resolution
- Bounds-safe: `0 <= start < end <= rawText.length`
- `className` restricted to exact whitelist (security invariant)
- `data.code` safe for `data-*` attributes (regex-verified `[A-Z0-9_]+` only)

**Priority order (highest first, from C03 §5):**

| Priority | className | Rationale |
|----------|-----------|-----------|
| 1 | `error-code-known` | Semantic meaning + interactive popover |
| 2 | `error-code-unknown` | Pattern-matched, still semantically relevant |
| 3 | `search-hit` | Visual convenience only |

Higher-priority highlights claim their ranges first. Lower-priority highlights that overlap are clipped or discarded.

### 1.3 Stream Controller State

**State shape (from C05 §1–2, mixin on `LogViewerState`):**

```typescript
/** Stream control properties added to LogViewerState */
interface StreamState {
  streamMode: 'LIVE' | 'PAUSED';
  bufferedCount: number;                      // Logs received while PAUSED
  pauseReason: 'scroll' | 'manual' | 'hover' | null;
  hoverFreezeEnabled: boolean;                // User-configurable, persisted in localStorage

  // Backward-compat shims (getter/setters delegating to streamMode):
  autoScroll: boolean;                        // get: streamMode === 'LIVE'
  paused: boolean;                            // get: streamMode === 'PAUSED'
}
```

**State transition table:**

| From | Event | To | pauseReason | bufferedCount |
|------|-------|----|-------------|---------------|
| LIVE | scroll-up (>68px from bottom) | PAUSED | `'scroll'` | resets to 0 |
| LIVE | Space key | PAUSED | `'manual'` | resets to 0 |
| LIVE | mouseenter (if hoverFreezeEnabled) | PAUSED | `'hover'` | resets to 0 |
| PAUSED | End key | LIVE | `null` | resets to 0 |
| PAUSED | Ctrl+↓ / Cmd+↓ | LIVE | `null` | resets to 0 |
| PAUSED | Badge click | LIVE | `null` | resets to 0 |
| PAUSED | FAB click | LIVE | `null` | resets to 0 |
| PAUSED | Space key | LIVE | `null` | resets to 0 |
| PAUSED(hover) | mouseleave | LIVE | `null` | resets to 0 |
| PAUSED(hover) | scroll-up | PAUSED | upgrades to `'scroll'` | unchanged |
| PAUSED(hover) | Space key | PAUSED | upgrades to `'manual'` | unchanged |

**Critical rule:** Only `pauseReason === 'hover'` auto-resumes on `mouseleave`. Scroll and manual pauses are sticky.

### 1.4 Timeline Bucket Format

**Bucket data structure (from C06 §7):**

```typescript
/** A single time bucket in the error timeline chart */
interface TimelineBucket {
  startMs: number;    // Inclusive start time (Unix ms)
  endMs: number;      // Exclusive end time (Unix ms)
  error: number;      // Count of error-level logs
  warning: number;    // Count of warning-level logs
  message: number;    // Count of info/message-level logs
  verbose: number;    // Count of verbose-level logs (not rendered as segment)
  total: number;      // Sum of all counts
}

/** Timeline instance state */
interface TimelineState {
  buckets: TimelineBucket[];       // 30–60 buckets
  bucketCount: number;             // Clamped to [30, 60]
  bucketDuration: number;          // ms per bucket
  timeOrigin: number;              // Earliest timestamp (ms)
  selectedIndex: number;           // -1 = no selection, else bucket index
}

/** Global state addition for timeline filtering */
interface TimelineFilter {
  startMs: number;
  endMs: number;
}
// state.timelineFilter: TimelineFilter | null
```

### 1.5 Cluster Data Structure

**Global cluster format (from C07 §6):**

```typescript
/** A global error cluster aggregating all occurrences of a signature */
interface GlobalCluster {
  signature: string;              // Canonical key (error code or normalized prefix)
  code: string | null;            // FLT error code if detected, else null
  label: string;                  // Human-readable display label
  count: number;                  // Total occurrences (always accurate)
  firstSeen: string;              // ISO timestamp of earliest occurrence
  lastSeen: string;               // ISO timestamp of most recent occurrence
  nodes: Set<string>;             // DAG node names that produced this error
  trend: '↑' | '↓' | '→';        // Frequency direction (120s sliding window)
  window: number[];               // 120-element circular array (per-second counts)
  windowHead: number;             // Current write position in circular array
  lastTick: number;               // Unix timestamp (seconds) of last tick
  entries: object[];              // Log entry references (capped at 500)
  expanded: boolean;              // UI expand/collapse state
  skippedNodes: string[];         // Downstream nodes skipped due to this error
}
```

**Index structures:**

```typescript
/** ClusterEngine internal indices */
interface ClusterIndices {
  _clusters: Map<string, GlobalCluster>;      // Primary: signature → cluster
  _codeIndex: Map<string, GlobalCluster>;     // Secondary: error code → cluster
  _version: number;                           // Change detection counter
}
```

### 1.6 Error Decoder Occurrence Map

**Occurrence tracking (from C02 §4):**

```typescript
/** Tracks per-error-code occurrences across the ring buffer */
interface OccurrenceEntry {
  count: number;           // Current occurrences in buffer (decremented on eviction)
  firstSeq: number;        // Sequence number of first occurrence
  lastSeq: number;         // Sequence number of most recent occurrence
  firstSeen: string;       // ISO timestamp of first
  lastSeen: string;        // ISO timestamp of most recent
  nodes: Set<string>;      // Set of node names where code appeared
}

/** Per-sequence tracking for precise eviction */
// Map<seq: number, Map<code: string, count: number>>
// Used to know exactly which codes to decrement when a seq is evicted
```

**ErrorDecoder match result (from C02 §7):**

```typescript
/** Result of scanning a log message for error codes */
interface MatchResult {
  start: number;                    // Start index in text
  end: number;                      // End index (exclusive)
  code: string;                     // Error code string
  layer: 'known' | 'unknown';      // Classification (3rd layer "pass-through" is implicit)
}

/** Full error info for context card rendering */
interface ErrorInfo {
  code: string;
  title: string;
  description: string;
  category: 'USER' | 'SYSTEM';
  severity: 'error' | 'warning' | 'info';
  suggestedFix: string;
  retryable: boolean;
  runbookUrl: string | null;
  relatedCodes: string[];
  isKnown: boolean;                 // true if from DB, false if pattern-matched
}
```

### 1.7 Log Entry Shape (Existing)

```typescript
/** Existing log entry from RingBuffer (state.js) */
interface LogEntry {
  timestamp: string;                // ISO 8601
  level: 'Error' | 'Warning' | 'Message' | 'Verbose';
  component: string;                // e.g., "SparkClient", "DagExecution"
  message: string;                  // Raw log message (untrusted)
  correlationId?: string;
  rootActivityId?: string;
  customData?: object | string | null;
  _inferredNode?: string;           // Extracted by ErrorIntelligence
  _tsMs?: number;                   // F12 addition: cached Date.parse() result
}
```

---

## §2 — Module Dependency Graph

### 2.1 Module Map

```
BUILD TIME:
  ErrorRegistry.cs ──► generate-error-codes.py ──► error-codes-data.js ──► build-html.py ──► index.html
  error-codes-curated.json ──┘                     (GENERATED, gitignored)    (inlined)

RUNTIME DEPENDENCY GRAPH:
  error-codes-data.js ──► window.ERROR_CODES_DB
                                │
                                ▼
                          ErrorDecoder (C02)
                                │ matchErrorCodes(), decorateMessage()
                                ▼
  RowPool ◄──── Renderer._populateRow ◄──── applyHighlights() [pure fn] (C03)
                     │
     ┌───────────────┼──────────────────┐
     ▼               ▼                  ▼
  StreamCtrl    ErrorTimeline     ClusterEngine
    (C05)         (C06)              (C07)
     │               │                  │
     │    state.timelineFilter    getClusterByCode()
     ▼               ▼                  ▼
  state.streamMode  passesFilter    ErrorIntelligence (existing)
  state.bufferedCount

  ExportManager (C04) ──► FilterIndex + RingBuffer (read-only)
```

### 2.2 Initialization Order

Initialization must respect these dependencies. All initialization happens in `main.js init()`.

```
1. state.js        — LogViewerState, RingBuffer, FilterIndex (existing)
2. error-codes-data.js — sets window.ERROR_CODES_DB (already inlined via build)
3. ErrorDecoder    — reads window.ERROR_CODES_DB, stores ref to state
4. Renderer        — receives state, ErrorDecoder injected as dependency
5. HighlightEngine — pure functions, no init needed (called by Renderer)
6. StreamController — mixin methods on Renderer, reads/writes state
7. ErrorTimeline   — receives state, mounts into DOM
8. ClusterEngine   — standalone, wired into LogsEnhancements
9. ExportManager   — reads state (FilterIndex, RingBuffer), no init deps
```

**Code flow in `main.js`:**

```javascript
init() {
  // 1. State (existing)
  this.state = new LogViewerState(10000);

  // 2. Error codes DB (already set by inlined script)
  this.state.errorCodesDB = window.ERROR_CODES_DB || {};

  // 3. Error decoder
  this.errorDecoder = new ErrorDecoder(this.state);

  // 4. Renderer (modified to accept errorDecoder)
  this.renderer = new Renderer(this.state);
  this.renderer._errorDecoder = this.errorDecoder;

  // 5–6. HighlightEngine is pure functions, StreamController is Renderer mixin
  this.renderer.initVirtualScroll();

  // 7. Error timeline
  this.errorTimeline = new ErrorTimeline(this.state);
  this.errorTimeline.mount(document.getElementById('timeline-container'));

  // 8. Cluster engine (wired through LogsEnhancements)
  this.clusterEngine = new ClusterEngine();
  this.logsEnhancements.setClusterEngine(this.clusterEngine);

  // 9. Export manager inherits from existing exportLogs()
}
```

### 2.3 Communication Patterns

F12 uses **no custom event bus**. Three communication patterns:

1. **Direct method calls:** `Renderer._populateRow()` → `ErrorDecoder.decorateMessage()` → `applyHighlights()`. Synchronous, inline.

2. **Shared state via `LogViewerState`:** `StreamController` writes `streamMode`/`bufferedCount`. `ErrorTimeline` writes `timelineFilter`. `Renderer.passesFilter()` reads `timelineFilter`. `flush()` reads `streamMode`.

3. **DOM event delegation:** Single `click`/`mouseover` handler on `scrollContainer` (existing pattern). F12 adds checks for `.error-code-known`/`.error-code-unknown` clicks → `ErrorDecoder.handleCodeClick()`.

4. **Custom DOM events (minimal):** `edog:navigate-to-node` (C07 node click → DAG tab), `edog:cluster-updated` (C07 ingest → render throttle).

### 2.4 Data Flow: Log Entry Lifecycle

```
INGESTION (per WebSocket batch):
  1. state.addLog(entry)  →  RingBuffer.push → seq;  if PAUSED: bufferedCount++
  2. errorDecoder.matchErrorCodes(msg)  →  recordOccurrence(code, seq, ts, node)
  3. clusterEngine.ingestEntry(entry)  →  signature → Map update → tickWindow → trend
  4. errorTimeline.updateIncremental([entry])  →  bucket[idx][level]++

RENDER (throttled 100ms):
  5. renderer.flush()
     ├─ filterIndex.updateIncremental()
     ├─ if PAUSED: _updateStreamBadge(); return  (skip DOM render)
     └─ if LIVE: _renderVirtualScroll()
         └─ for each visible row (i=0..79):
  6.        _populateRow(row, entry, seq, idx)
              ├─ highlights = _computeHighlights(truncated, entry)
              │   ├─ errorDecoder.matchErrorCodes(rawText) → error code ranges
              │   └─ search term matching → search-hit ranges
              ├─ if highlights.length === 0: textContent = truncated  [fast path]
              └─ else: innerHTML = applyHighlights(truncated, highlights, renderer)
  7. _updateStreamBadge()
  8. errorTimeline._renderBars()
  9. clusterEngine → renderClusterSummary() (throttled: every 50 entries)
```

---

## §3 — Highlight Engine Design (Keystone)

The highlight engine is the most security-critical and performance-sensitive component of F12. It transitions `_populateRow` from safe `textContent` to carefully controlled `innerHTML`.

### 3.1 The innerHTML Transition Plan

**Current code (renderer.js:395–397):**

```javascript
// Zero innerHTML — textContent only
const msg = entry.message || '';
row._message.textContent = msg.length > 500 ? msg.substring(0, 500) + '\u2026' : msg;
```

**New code:**

```javascript
const msg = entry.message || '';
const truncated = msg.length > 500 ? msg.substring(0, 500) + '\u2026' : msg;
const highlights = this._computeHighlights(truncated, entry);

if (highlights.length === 0) {
  // FAST PATH: no highlights active → stay with safe textContent
  // This is the common case when no search is active and message has no error codes
  row._message.textContent = truncated;
} else {
  // HIGHLIGHT PATH: use innerHTML with strict escaping pipeline
  row._message.innerHTML = applyHighlights(truncated, highlights, this);
}

row._highlightVersion = this._highlightVersion;
```

**Design decisions (from C03 §4, P0 §4.6):**

1. **Fast path preserves `textContent`:** When no search is active AND no error codes exist in the message, the row uses `textContent` — zero overhead, zero risk. This is the majority case.

2. **Truncation before pipeline:** The 500-char truncation happens on raw text *before* escaping. Highlight positions are computed against this same truncated string, ensuring positional consistency.

3. **`applyHighlights` is a pure function:** Takes raw text, highlight ranges, and renderer context. Returns safe HTML string. No side effects, no DOM mutations, no state reads.

4. **Only `row._message` changes:** Time, level, and component fields remain `textContent` (no F12 modification). The innerHTML transition is surgically scoped.

### 3.2 Six-Step Escaping Pipeline

This is the **definitive security-critical pipeline** from C03 §3. Every step is mandatory.

```
Step 1: GET RAW TEXT
  rawText = (entry.message || '').substring(0, 500)  // untrusted WebSocket input

Step 2: HTML-ESCAPE ALL TEXT (security gate — non-negotiable)
  escaped = escapeHtml(rawText)
  // & → &amp;  < → &lt;  > → &gt;  " → &quot;  ' → &#39;
  // After this step, NO user HTML can execute. All text is inert.

Step 3: COMPUTE HIGHLIGHTS ON RAW TEXT
  highlights = _computeHighlights(rawText, entry)
  // Sources: errorDecoder.matchErrorCodes(rawText), search indexOf loop
  // CRITICAL: raw text positions, not escaped positions
  // Output: sorted, non-overlapping after resolveOverlaps()

Step 4: BUILD OFFSET MAP & INSERT TAGS
  offsetMap = buildOffsetMap(rawText)    // raw position → escaped position
  // Insert tags right-to-left (preserves earlier positions):
  for (i = highlights.length - 1; i >= 0; i--):
    eStart = offsetMap[h.start]; eEnd = offsetMap[h.end]
    html = html[0..eStart] + openTag + html[eStart..eEnd] + closeTag + html[eEnd..]

Step 5: ASSIGN innerHTML
  row._message.innerHTML = html
  // Safe: all user text escaped in Step 2, tags are hardcoded strings

Step 6: EVENT HANDLING VIA DELEGATION
  // Single handler on scrollContainer (existing pattern, extended)
  // Check e.target for .error-code-known/.error-code-unknown → ErrorDecoder
  // NO per-row listeners. NO onclick attributes.
```

**escapeHtml implementation (5 entities — adds `'` → `&#39;` for F12):**

```javascript
escapeHtml(text) {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')    // Must be first (prevents double-escape)
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');   // NEW for F12
}
```

### 3.3 Offset Map Algorithm

Maps raw text positions to escaped text positions (because `<` → `&lt;` changes 1 char to 4).

```javascript
function buildOffsetMap(rawText) {
  const map = new Array(rawText.length + 1);
  let escapedIdx = 0;
  for (let i = 0; i < rawText.length; i++) {
    map[i] = escapedIdx;
    const ch = rawText.charCodeAt(i);
    switch (ch) {
      case 38:  escapedIdx += 5; break;  // & → &amp;
      case 60:  escapedIdx += 4; break;  // < → &lt;
      case 62:  escapedIdx += 4; break;  // > → &gt;
      case 34:  escapedIdx += 6; break;  // " → &quot;
      case 39:  escapedIdx += 5; break;  // ' → &#39;
      default:  escapedIdx += 1;
    }
  }
  map[rawText.length] = escapedIdx;  // end sentinel
  return map;
}
```

Performance: O(n), <0.01ms for 500-char messages.

### 3.4 Overlap Resolution Algorithm

Higher-priority highlights claim ranges first. Lower-priority highlights are clipped around claimed regions.

```javascript
/**
 * Resolve overlapping highlights by priority.
 * Input: unsorted, potentially overlapping highlights.
 * Output: sorted, non-overlapping highlights.
 */
function resolveOverlaps(highlights) {
  // Sort by priority DESC, then start ASC
  const PRIORITY = { 'error-code-known': 0, 'error-code-unknown': 1, 'search-hit': 2 };
  highlights.sort((a, b) => {
    const pd = PRIORITY[a.className] - PRIORITY[b.className];
    return pd !== 0 ? pd : a.start - b.start;
  });

  const occupied = [];  // [start, end) intervals already claimed
  const result = [];

  for (const h of highlights) {
    let s = h.start, e = h.end;

    // Clip against all occupied ranges
    for (const [os, oe] of occupied) {
      if (s < oe && e > os) {
        // Overlap detected
        if (s >= os && e <= oe) {
          // Fully inside occupied → discard
          s = e;
          break;
        }
        if (s < os && e > os) {
          e = os;  // Clip right edge
        }
        if (s < oe && e > oe) {
          s = oe;  // Clip left edge
        }
      }
    }

    if (s < e) {
      result.push({ ...h, start: s, end: e });
      occupied.push([s, e]);
    }
  }

  // Sort result by start position for tag insertion
  result.sort((a, b) => a.start - b.start);
  return result;
}
```

**Example (from C03 §5):**

```
Message: "Failed: MLV_SPARK_SESSION_ACQUISITION_FAILED in node Refresh"
Search:  "failed"

Raw highlights (before resolution):
  [0,6)   search-hit   "Failed"
  [8,47)  error-code-known  "MLV_SPARK_SESSION_ACQUISITION_FAILED"
  [51,57) search-hit   "FAILED" (inside error code text — NOPE, it's outside)

After resolution:
  [0,6)   search-hit   ✓ kept (no overlap)
  [8,47)  error-code-known  ✓ kept (highest priority)
  // If "FAILED" overlapped the error code range, it would be discarded.
  // In this case [51,57) doesn't overlap [8,47), so it's kept.
```

### 3.5 Performance Budget per Row

**Source: C03 §6, P0 §4.7**

| Operation | Cost per row | Cost for 80 rows | % of frame budget (16.6ms) |
|-----------|-------------|-------------------|---------------------------|
| `textContent` (current baseline) | ~0.01ms | ~0.8ms | 4.8% |
| Fast path (no highlights, stay `textContent`) | ~0.01ms | ~0.8ms | 4.8% |
| `escapeHtml` (500-char string) | ~0.01ms | ~0.8ms | 4.8% |
| `matchErrorCodes` regex scan | ~0.02ms | ~1.6ms | 9.6% |
| Search term indexOf loop | ~0.01ms | ~0.8ms | 4.8% |
| `buildOffsetMap` | ~0.01ms | ~0.8ms | 4.8% |
| `resolveOverlaps` | ~0.005ms | ~0.4ms | 2.4% |
| Tag insertion (right-to-left) | ~0.01ms | ~0.8ms | 4.8% |
| `innerHTML` assignment | ~0.04ms | ~3.2ms | 19.3% |
| **Total with highlights** | **~0.10ms** | **~8.4ms** | **50.6%** |
| **Remaining frame budget** | — | **~8.2ms** | **49.4%** |

**Justification:** Measured baseline from P0 §4.7: `textContent` assignment costs ~0.01ms per row. The `innerHTML` path adds ~0.09ms overhead per row (regex, escaping, offset mapping, tag insertion, innerHTML parse). At 80 visible rows, total is ~8.4ms, well within the 16.6ms frame budget. The 100ms render throttle means we only render at 10fps max, providing additional headroom.

**Mitigations built into the design:**

1. **Fast-path skip (dominant optimization):** When no search active AND message contains no error codes, `textContent` is used. Based on real FLT logs, ~60-80% of messages contain no error codes, so the fast path dominates.

2. **Seq-based skip:** If a row already displays the correct entry AND `_highlightVersion` hasn't changed, skip `_populateRow` entirely (only update `translateY` position).

3. **Pre-compiled regex:** `_codePattern = /\b(MLV_\w+|FLT_\w+|SPARK_\w+)\b/g` compiled once at ErrorDecoder construction, reused across all calls. `lastIndex` reset before each `exec` loop.

### 3.6 Cache Invalidation with DOM Recycling

**Problem:** RowPool recycles DOM elements. When a row is repositioned during scroll, `_populateRow` is called with a new entry. The row may still contain innerHTML from its previous entry.

**Solution:** Full replacement on every `_populateRow` call. This is automatic cache invalidation — no stale highlights survive recycling.

```javascript
// In _renderVirtualScroll, check for skip optimization:
if (row._seq === seq && row._highlightVersion === this._highlightVersion) {
  // Same entry, same highlight state → skip repopulation
  row.style.transform = `translateY(${i * this.ROW_HEIGHT}px)`;
  continue;
}

// Otherwise: full _populateRow (replaces all content)
this._populateRow(row, entry, seq, i);
```

**`_highlightVersion` increment triggers:**

| Event | Increments `_highlightVersion`? | Why |
|-------|------|-----|
| `state.searchText` changes | Yes | All visible rows need search highlights recomputed |
| `state.errorCodesDB` loads | Yes | Error code known/unknown classification may change |
| New log entry added | No | Only affects new rows; existing visible rows unchanged |
| Filter change | No | `rerenderAllLogs()` already releases all rows and re-renders |

### 3.7 Search Highlight and Error Code Coexistence

Error code highlights and search highlights coexist in the same row. The priority resolution in §3.4 ensures no overlapping tags. The rendering produces valid, non-nested HTML:

```html
<!-- Error code takes priority; search highlights fill gaps -->
<span class="log-message">
  Normal text
  <mark class="search-hit">error</mark>
  in
  <span class="error-code-known" data-code="MLV_SPARK_SESSION_FAILED">
    MLV_SPARK_SESSION_FAILED
  </span>
  at line 42
</span>
```

**Tag construction (from C03 §8, `buildOpenTag`):**

```javascript
function buildOpenTag(highlight) {
  if (highlight.className === 'search-hit') {
    return '<mark class="search-hit">';
  }
  // Error code span
  let tag = '<span class="' + highlight.className + '"';
  if (highlight.data && highlight.data.code) {
    // data.code is regex-verified [A-Z0-9_]+ — safe for attribute value
    tag += ' data-code="' + highlight.data.code + '"';
  }
  tag += '>';
  return tag;
}
```

**Allowed HTML whitelist (from C03 §10, §8):**

| Tag | Allowed Attributes | Purpose |
|-----|-------------------|---------|
| `<mark>` | `class="search-hit"` | Search match highlighting |
| `<span>` | `class="error-code-known"`, `data-code="[A-Z0-9_]+"` | Known error code |
| `<span>` | `class="error-code-unknown"`, `data-code="[A-Z0-9_]+"` | Unknown error code |

No other tags, attributes, or combinations are ever produced.

---

## §4 — Stream Controller Design

### 4.1 State Machine

```
          ┌──────┐  scroll-up / Space / mouseenter
 ┌────────│ LIVE │──────────────────────────────────┐
 │        └──────┘                                  ▼
 │                                            ┌──────────┐
 │  End / Ctrl+↓ / Badge click / FAB click /  │  PAUSED  │
 │  Space toggle / mouseleave(hover only)     └──────────┘
 └──────────────────────────────────────────────────┘
```

**Three pause reasons:**

| pauseReason | Trigger | hover-leave resumes? | Rationale |
|-------------|---------|----------------------|-----------|
| `'scroll'` | Scrolled >68px from bottom | NO | Inspecting old logs |
| `'manual'` | Space key | NO | Explicit intent |
| `'hover'` | mouseenter (if enabled) | YES | Temporary freeze |

**Pause reason upgrade:** If paused with `hover` and user scrolls up → upgrades to `scroll`. Space key → upgrades to `manual`. Prevents auto-resume on mouseleave.

### 4.2 Core Transition Methods

These are implemented as mixin methods on the `Renderer` class (from C05 §1):

```javascript
_transitionToPaused(reason) {
  if (this.state.streamMode === 'PAUSED') return;  // Idempotent guard
  this.state.streamMode = 'PAUSED';
  this.state.pauseReason = reason;
  this.state.bufferedCount = 0;
  this._updateStreamBadge();
  if (window.edogViewer) window.edogViewer.showResumeButton();
}

_transitionToLive() {
  if (this.state.streamMode === 'LIVE') return;  // Idempotent guard
  this.state.streamMode = 'LIVE';
  this.state.pauseReason = null;
  this.state.bufferedCount = 0;
  this._updateStreamBadge();
  if (window.edogViewer) window.edogViewer.hideResumeButton();
  this._scrollPinUntil = Date.now() + 80;  // Suppress re-trigger for 80ms
  this.flush();
  this.scrollToBottom(this.scrollContainer);
}
```

### 4.3 Scroll Event Detection

**Modified `_onScroll` handler (from C05 §3):**

```javascript
_onScroll = () => {
  if (this.state.streamMode === 'LIVE' && Date.now() > this._scrollPinUntil) {
    const c = this.scrollContainer;
    const isAtBottom = c.scrollTop + c.clientHeight >= c.scrollHeight - this.ROW_HEIGHT * 2;
    if (!isAtBottom) {
      this._transitionToPaused('scroll');
    }
  }
  if (this.state.streamMode === 'LIVE') return; // Suppress scroll-driven renders in LIVE
  if (!this.renderScheduled) {
    this.renderScheduled = true;
    requestAnimationFrame(() => this.flush());
  }
}
```

**68px threshold:** `ROW_HEIGHT * 2 = 68px` — allows 2-row jitter tolerance.
**80ms pin guard:** After programmatic `scrollTop`, ignore scroll events for 80ms to prevent re-trigger.

### 4.4 Buffered Count Tracking

Tracked in `state.addLog()` — the single ingestion point:

```javascript
addLog(entry) {
  this.logBuffer.push(entry);
  this.newLogsSinceRender++;
  if (this.streamMode === 'PAUSED') this.bufferedCount++;
  // ... existing stats tracking ...
}
```

Badge updates in `flush()` — even while paused, `flush()` calls `_updateStreamBadge()` to show the live counter, then returns without DOM rendering.

### 4.5 Badge Rendering

**HTML:** `<span id="stream-badge" class="stream-badge" data-mode="live" role="status" aria-live="polite">` containing `.stream-dot`, `.stream-label`, `.stream-count`.

**LIVE visual:** Pulsing green dot (8px, `var(--stream-live)`), "LIVE" label, count hidden, `cursor: default`.
**PAUSED visual:** Static amber dot (`var(--stream-paused)`), "PAUSED" label, " · N new" count visible, `cursor: pointer`, click-to-resume.

```javascript
_updateStreamBadge() {
  const badge = document.getElementById('stream-badge');
  if (!badge) return;
  const isLive = this.state.streamMode === 'LIVE';
  badge.dataset.mode = isLive ? 'live' : 'paused';
  badge.querySelector('.stream-label').textContent = isLive ? 'LIVE' : 'PAUSED';
  const countEl = badge.querySelector('.stream-count');
  countEl.hidden = isLive;
  if (!isLive) countEl.textContent = ' \u00B7 ' + this.state.bufferedCount.toLocaleString() + ' new';
}
```

**CSS tokens:** `--stream-live: #18a058` (light) / `#36d475` (dark). `--stream-paused: #e5940c` (light) / `#f5a623` (dark).

### 4.6 Auto-Scroll FAB Integration

The existing `#resume-scroll-btn` FAB wires through `_transitionToLive()`:

```javascript
resumeAutoScroll() { this.renderer._transitionToLive(); }
```

**Backward-compat shims:** `state.autoScroll` → getter returns `streamMode === 'LIVE'`. `state.paused` → getter returns `streamMode === 'PAUSED'`. Setters are no-ops.

### 4.7 Hover-Freeze

Hover-freeze is configurable (`localStorage` key `edog-hover-freeze`) and off by default.

```javascript
_onHoverEnter = () => {
  if (!this.state.hoverFreezeEnabled || this.state.streamMode !== 'LIVE') return;
  this._transitionToPaused('hover');
}
_onHoverLeave = () => {
  if (!this.state.hoverFreezeEnabled || this.state.pauseReason !== 'hover') return;
  this._transitionToLive();
}
```

In `_onScroll`, if hover-paused and user scrolls up: `this.state.pauseReason = 'scroll'` (upgrade).

---

## §5 — Error Analytics Pipeline

### 5.1 Error Timeline: Time Bucketing Algorithm

**Full rebuild algorithm (from C06 §2):**

```javascript
_rebuildBuckets() {
  const rb = this.state.logBuffer;
  if (rb.count === 0) { this.buckets = []; return; }

  // 1. Get time range from ring buffer
  const oldest = rb.getBySeq(rb.oldestSeq);
  const newest = rb.getBySeq(rb.newestSeq);
  const t0 = new Date(oldest.timestamp).getTime();
  const t1 = new Date(newest.timestamp).getTime();
  const span = Math.max(t1 - t0, 1000);  // Floor 1s to avoid division by zero

  // 2. Compute bucket count: ~1 bucket/sec, clamped [30, 60]
  const rawCount = Math.round(span / 1000);
  this.bucketCount = Math.min(60, Math.max(30, rawCount));
  this.bucketDuration = span / this.bucketCount;
  this.timeOrigin = t0;

  // 3. Initialize bucket array
  this.buckets = new Array(this.bucketCount);
  for (let i = 0; i < this.bucketCount; i++) {
    this.buckets[i] = {
      startMs: t0 + i * this.bucketDuration,
      endMs: t0 + (i + 1) * this.bucketDuration,
      error: 0, warning: 0, message: 0, verbose: 0, total: 0
    };
  }

  // 4. Single pass through ring buffer: O(N)
  rb.forEach((entry) => {
    const ts = entry._tsMs || new Date(entry.timestamp).getTime();
    if (isNaN(ts)) return;
    const idx = Math.min(
      Math.floor((ts - t0) / this.bucketDuration),
      this.bucketCount - 1
    );
    const b = this.buckets[idx];
    const level = (entry.level || 'message').toLowerCase();
    if (b[level] !== undefined) b[level]++;
    b.total++;
  });
}
```

**Incremental update algorithm (from C06 §3):**

```javascript
updateIncremental(newEntries) {
  if (!this.buckets.length) {
    this._rebuildBuckets();
    this._renderBars();
    return;
  }

  let needsRebuild = false;
  for (const entry of newEntries) {
    const ts = entry._tsMs || new Date(entry.timestamp).getTime();
    if (isNaN(ts)) continue;

    // If timestamp exceeds last bucket → full rebuild needed
    if (ts >= this.buckets[this.bucketCount - 1].endMs) {
      needsRebuild = true;
      break;
    }

    const idx = this._bucketIndexFor(ts);
    if (idx < 0 || idx >= this.bucketCount) {
      needsRebuild = true;
      break;
    }

    const b = this.buckets[idx];
    const level = (entry.level || 'message').toLowerCase();
    if (b[level] !== undefined) b[level]++;
    b.total++;
  }

  if (needsRebuild) this._rebuildBuckets();
  this._renderBars();
}
```

**Key design principle (from C06 §9):** The timeline shows ALL logs (unfiltered ground truth), regardless of active level/search/component filters. It reads from `RingBuffer` directly, NOT from `FilterIndex`. This gives users a frequency overview independent of their current filter state.

**Pre-computation optimization:** Cache `entry._tsMs = new Date(entry.timestamp).getTime()` once during `state.addLog()` to avoid repeated `Date` parsing across timeline, clustering, and frequency calculations.

### 5.2 Clustering: Global Signature Map

**Signature extraction algorithm (from C07 §3, priority-based):**

```javascript
_computeSignature(entry) {
  const msg = entry.message || '';

  // Layer 1 (strongest): FLT error code
  const codeMatch = msg.match(/\b(MLV_\w+|FLT_\w+|SPARK_\w+)\b/);
  if (codeMatch) return codeMatch[1];

  // Layer 2: Exception/Error class name
  const exMatch = msg.match(/^(\w+Exception|\w+Error)\b/);
  if (exMatch) return exMatch[1];

  // Layer 3: Normalized message prefix (80 chars max)
  let normalized = msg.substring(0, 80);
  normalized = normalized
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '{uuid}')
    .replace(/\b[0-9a-f]{8,}\b/gi, '{hex}')
    .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[.\d]*Z?\b/g, '{ts}')
    .replace(/\b\d{5,}\b/g, '{num}');

  return normalized || 'EMPTY_MESSAGE';
}
```

**Ingestion (O(1) per entry, from C07 §4):**

```javascript
ingestEntry(entry) {
  if (!this._isClusterableLevel(entry.level)) return;

  const sig = this._computeSignature(entry);
  let cluster = this._clusters.get(sig);

  if (!cluster) {
    cluster = {
      signature: sig,
      code: this._extractErrorCode(entry),
      label: this._computeLabel(entry),
      count: 0,
      firstSeen: entry.timestamp,
      lastSeen: entry.timestamp,
      nodes: new Set(),
      trend: '→',
      window: new Array(120).fill(0),
      windowHead: 0,
      lastTick: 0,
      entries: [],
      expanded: false,
      skippedNodes: []
    };
    this._clusters.set(sig, cluster);
    if (cluster.code) this._codeIndex.set(cluster.code, cluster);
  }

  cluster.count++;
  cluster.lastSeen = entry.timestamp;
  if (cluster.entries.length < 500) cluster.entries.push(entry);

  const nodeName = entry._inferredNode || entry._node || entry.node ||
                   this._parseNodeFromMessage(entry.message);
  if (nodeName) cluster.nodes.add(nodeName);

  this._tickWindow(cluster, entry.timestamp);
  cluster.trend = this._computeTrend(cluster);
  this._version++;
}
```

**Frequency trend computation (from C07 §4):**

```javascript
_computeTrend(cluster) {
  let recent = 0;    // Last 60 seconds
  let previous = 0;  // Previous 60 seconds

  for (let i = 0; i < 60; i++) {
    const recentIdx = ((cluster.windowHead - i) % 120 + 120) % 120;
    recent += cluster.window[recentIdx];

    const prevIdx = ((cluster.windowHead - 60 - i) % 120 + 120) % 120;
    previous += cluster.window[prevIdx];
  }

  if (previous === 0 && recent === 0) return '→';
  if (previous === 0 && recent > 0)   return '↑';
  if (recent === 0 && previous > 0)   return '↓';

  const ratio = recent / previous;
  if (ratio > 1.2) return '↑';  // >20% increase
  if (ratio < 0.8) return '↓';  // >20% decrease
  return '→';                    // Stable (±20%)
}
```

**Trend badge semantics:**

| Badge | Meaning | Threshold | Color |
|-------|---------|-----------|-------|
| ↑ | Rising | >20% increase in last 60s vs prior 60s | `var(--level-error)` red |
| ↓ | Falling | >20% decrease in last 60s vs prior 60s | `var(--status-succeeded)` green |
| → | Stable | Within ±20% | `var(--text-muted)` gray |

### 5.3 Error-to-Node Mapping

Node extraction follows a priority chain (from C07 §5, C02 §6):

```javascript
const nodeName =
  (entry._errorContext && entry._errorContext.node) ||  // From autoDetector
  entry._inferredNode ||                                 // From ErrorIntelligence
  entry._node ||                                         // Direct property
  entry.node ||                                          // Direct property
  _parseNodeFromMessage(entry.message) ||                // Regex fallback
  null;

// Regex fallback:
_parseNodeFromMessage(msg) {
  if (!msg) return null;
  const m = msg.match(/node\s+['"]([^'"]+)['"]/i);
  return m ? m[1] : null;
}
```

### 5.4 Shared Data Between Analytics Components

```
  RingBuffer (source of truth)
       │
       ├──► ErrorTimeline (C06)  — reads all logs, writes state.timelineFilter
       ├──► ClusterEngine (C07)  — reads error logs, writes global clusters
       └──► ErrorDecoder  (C02)  — reads all logs, writes occurrence map
                                    C02 reads from C07 via getClusterByCode()
                                    C06 could read from C07 for bar highlights (V2)
```

No circular dependencies. Data flows: RingBuffer → analytics → state → renderer.

---

## §6 — Build Pipeline Integration

### 6.1 Pipeline Flow

```
ErrorRegistry.cs (optional) ──┐
                               ├──► generate-error-codes.py ──► error-codes-data.js ──► build-html.py ──► index.html
error-codes-curated.json ─────┘    (merge: parsed wins)         (window.ERROR_CODES_DB)   (inlined)
```

### 6.2 Parser Design (from C01 §S01–S02)

Two regex patterns handle the two ErrorRegistry.cs code styles:

**Pattern 1: Field-Init Pattern**
```python
FIELD_INIT_RE = re.compile(
    r'public\s+static\s+readonly\s+ErrorDefinition\s+(\w+)\s*=\s*new\s*\((.*?)\);',
    re.DOTALL
)
NAMED_ARG_RE = re.compile(
    r'(\w+)\s*:\s*("(?:[^"\\]|\\.)*"|ErrorCategory\.\w+|true|false|null)',
    re.DOTALL
)
```

**Pattern 2: Dictionary-Init Pattern**
```python
DICT_INIT_RE = re.compile(
    r'\["(\w+)"\]\s*=\s*new\s+ErrorInfo\s*\((.*?)\)',
    re.DOTALL
)
```

**Merge strategy:** Parsed codes from C# override curated codes on conflict. Curated JSON is the committed fallback for dev builds without FLT repo access.

### 6.3 Makefile Targets (from C01 §S09)

```makefile
# Default target (curated-only, no FLT repo needed)
generate-error-codes:
	$(PYTHON) scripts/generate-error-codes.py

# CI target (strict validation)
generate-error-codes-ci:
	$(PYTHON) scripts/generate-error-codes.py --strict

# Modified build target: generate error codes before building HTML
build: generate-error-codes
	$(PYTHON) scripts/build-html.py
```

### 6.4 Developer Workflow for Updating Codes

```
1. Edit src/data/error-codes-curated.json
   - Add/modify error code entries manually
   - Commit the curated file (it's version-controlled)

2. Run: make build
   - generate-error-codes.py reads curated JSON
   - Writes error-codes-data.js (gitignored)
   - build-html.py inlines it into index.html

3. (CI only) Run: make generate-error-codes-ci
   - With --input pointing to ErrorRegistry.cs
   - Parses C# → merges over curated → validates strictly
   - Exit code 0 = pass, 1 = validation failure
```

### 6.5 File Layout

```
edog-studio/
├── scripts/
│   └── generate-error-codes.py          # NEW — build script
├── src/
│   ├── data/
│   │   └── error-codes-curated.json     # NEW — committed, version-controlled
│   └── frontend/
│       └── js/
│           └── error-codes-data.js      # GENERATED — gitignored
├── .gitignore                           # Add: src/frontend/js/error-codes-data.js
└── Makefile                             # Modified: add generate-error-codes targets
```

### 6.6 Exit Codes (from C01 §S08)

| Code | Meaning | Action |
|------|---------|--------|
| 0 | Success | Continue build |
| 1 | Validation failed (schema errors) | Fix curated JSON or C# source |
| 2 | IO error (file not found, permissions) | Check paths |
| 3 | Parse error (file produced zero results) | Check `--error-class` flag |
| 4 | Internal error (uncaught exception) | Report bug |

### 6.7 Missing File Graceful Degradation

If `error-codes-data.js` is missing:
- `build-html.py` prints WARNING and injects a comment stub
- `window.ERROR_CODES_DB` is `undefined` at runtime
- `ErrorDecoder._init()` handles gracefully: `this._db = window.ERROR_CODES_DB || {}`
- All error codes classified as `unknown` layer (dashed underline, "?" badge)
- No crash, no broken UI — just reduced functionality

---

## §7 — Performance Targets

### 7.1 Highlight Engine

| Metric | Target | Justification |
|--------|--------|---------------|
| `escapeHtml` per row | <0.01ms | 4 regex replaces on ≤500 chars. Measured in P0 §4.7. |
| `matchErrorCodes` per row | <0.1ms | Pre-compiled regex, global flag, ≤500 char input. |
| `buildOffsetMap` per row | <0.01ms | Single O(n) pass, array allocation. |
| `resolveOverlaps` per call | <0.01ms | Typical: 0–3 highlights, O(h²) is negligible. |
| `applyHighlights` total per row | <0.12ms | Sum of above + substring operations. |
| `innerHTML` assignment per row | <0.04ms | Browser HTML parser on <600 bytes. |
| **Total per row (highlight path)** | **<0.12ms** | Measured: P0 §4.7 benchmarks. |
| **80 visible rows** | **<10ms** | 80 × 0.12ms = 9.6ms. Within 16.6ms frame. |
| **Fast path (no highlights)** | **<0.01ms/row** | Same as `textContent` baseline. |

**Render throttle:** 100ms (10fps max). Real budget is 100ms, not 16.6ms. The 16.6ms target is for scroll smoothness during manual scroll while paused.

### 7.2 Stream Controller

| Metric | Target | Justification |
|--------|--------|---------------|
| Scroll handler execution | <0.1ms | One `streamMode` read + one `Date.now()` + one `isAtBottom` calc. All O(1). |
| `_transitionToPaused` | <0.1ms | 3 state writes + 1 DOM update (`_updateStreamBadge`). |
| `_transitionToLive` | <1ms | State writes + badge update + `flush()` + `scrollToBottom()`. `flush` may do filter index update. |
| Badge counter update | <0.05ms | 3 DOM property writes (dataset, textContent, hidden). |
| Badge rendering (CSS transition) | 0ms JS | Pure CSS transition: opacity 0.2s, transform 0.2s. |

**Scroll handler runs at display refresh rate** (60–144Hz). The `{ passive: true }` flag ensures no compositor delay. The handler body is O(1) — no DOM reads that trigger layout thrashing (only `scrollTop`, `clientHeight`, `scrollHeight` which are cached by the browser after the first read).

### 7.3 Error Timeline

| Metric | Target | Justification |
|--------|--------|---------------|
| Full rebuild (`_rebuildBuckets`, 50K entries) | <16ms | Single O(N) pass. Pre-cached `entry._tsMs` avoids Date parsing. Measured: ~3–10ms on mid-range 2020 i5. |
| Incremental update (10–100 entries) | <0.1ms | Direct bucket index computation O(K). |
| Bar render (`_renderBars`, 60 bars) | <0.1ms | 60 columns × 3 `style.height` writes = 180 DOM property writes. No layout reflow (height changes trigger composite only within CSS grid). |
| Total per-frame (incremental) | <0.2ms | Incremental update + bar render. |

**Full rebuild frequency:** Only when new log timestamp exceeds last bucket's `endMs`. In steady-state streaming, this happens approximately once per `bucketDuration` (typically 1–60 seconds).

### 7.4 Clustering

| Metric | Target | Justification |
|--------|--------|---------------|
| `ingestEntry` (per entry) | <0.05ms | `Map.get/set`, `Set.add`, array push — all O(1). |
| `_computeSignature` (per entry) | <0.02ms | 1–3 regex tests on message prefix. |
| `_tickWindow` + `_computeTrend` | <0.02ms | 120-iteration loop over number array. |
| `rebuildFromBuffer` (50K entries) | <100ms | Single O(N) pass, no sort during scan. |
| `getSortedClusters` (~100 clusters) | <5ms | `Array.from(Map.values())` + sort. |
| `_renderClusterSummary` (10–20 rows) | <16ms | DOM creation, throttled every 50 entries. |
| `_recomputeAllTrends` (100 clusters) | <1ms | 100 × 120-iteration loops. |

**Memory budget (from C07 §9):**

| Structure | Max Size | Memory |
|-----------|----------|--------|
| `_clusters` Map (100 clusters) | 100 entries | ~50KB (cluster objects) |
| Cluster entries (500 cap × 100) | 50K refs | ~2MB (object references, not copies) |
| Sliding window arrays (120 × 100) | 12K numbers | ~96KB |
| `_codeIndex` secondary index | 100 entries | ~10KB |
| **Total clustering overhead** | | **~2.2MB** |

### 7.5 Export Manager

| Metric | Target | Justification |
|--------|--------|---------------|
| CSV generation (50K entries) | <500ms | String array join, O(N). No DOM involvement. |
| JSON generation (50K entries) | <1s | `JSON.stringify` with pretty-print. |
| Text generation (50K entries) | <300ms | Template literals, simplest format. |
| Blob creation | <100ms | Browser-native, single string input. |

No Web Worker needed — these are single-pass string operations.

### 7.6 Total F12 Memory Budget

| Component | Memory | Notes |
|-----------|--------|-------|
| `window.ERROR_CODES_DB` (500 codes) | ~200KB | Inlined JSON data |
| ErrorDecoder match cache (2000 entries) | ~500KB | LRU, short HTML strings |
| ErrorDecoder `_codeSet` | ~50KB | Set of code strings |
| ErrorDecoder `_occurrences` | ~100KB | Map with OccurrenceEntry objects |
| ErrorDecoder `_seqCodeCounts` | ~5MB | Nested Maps for 50K seqs (worst case) |
| ClusterEngine (100 clusters) | ~2.2MB | See §7.4 |
| ErrorTimeline (60 buckets) | ~5KB | Fixed-size bucket array |
| StreamController state | ~100B | 3 primitives |
| **Total F12 overhead** | **~8MB** | Added to existing ~15MB baseline |

**Justification:** `_seqCodeCounts` is the dominant cost (5MB worst case: every one of 50K entries contains error codes). In practice, ~10-20% of entries contain error codes, bringing actual usage to ~1MB. The total 8MB worst-case overhead is acceptable for a developer tool running on modern machines.

---

## §8 — Security Model

### 8.1 innerHTML Escaping Pipeline (Definitive Spec)

**Security invariant (non-negotiable, from C03 §10):**

> All user-controlled text is HTML-escaped (Step 2 of §3.2) BEFORE any tag insertion (Step 4). Tag insertion only adds hardcoded strings with regex-validated attribute values. The order is NEVER reversed.

**Five-entity escaping function:**

```javascript
escapeHtml(text) {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')    // Must be first (prevents double-escape)
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');   // NEW for F12 — prevents single-quote attr breakout
}
```

**Note:** The existing `escapeHtml` (renderer.js:649–652) escapes 4 entities. F12 adds `'` → `&#39;` as the 5th. This is required because F12 introduces `data-code` attributes in double quotes; while single-quote escaping isn't strictly necessary for double-quoted attributes, defense-in-depth demands it.

### 8.2 XSS Prevention: Every Vector and Its Mitigation

**Source: P0 §4, C03 §10**

| # | Vector | Attack Input | After Step 2 (escape) | After Step 4 (tags) | innerHTML Result | Status |
|---|--------|-------------|----------------------|---------------------|-----------------|--------|
| 1 | Script tag in log | `<script>alert(1)</script>` | `&lt;script&gt;alert(1)&lt;/script&gt;` | No highlights match | Literal text | SAFE |
| 2 | Error code lookalike | `MLV_<img src=x onerror=alert(1)>` | `MLV_&lt;img src=x...&gt;` | Regex `/MLV_\w+/` stops at `&` (not `\w`) | No injection | SAFE |
| 3 | Attribute breakout | `MLV_FOO" onclick="alert(1)` | `MLV_FOO&quot; onclick=&quot;alert(1)` | Regex matches `MLV_FOO` only (stops at `&`) | `data-code="MLV_FOO"` is clean | SAFE |
| 4 | Search term HTML | User searches `<img src=x>` | Search term escaped before matching | `<mark>` wraps escaped text | `<mark>&lt;img...&gt;</mark>` | SAFE |
| 5 | ReDoS via search | `aaaa(a+)+$` | N/A | Search uses literal `indexOf`, NOT regex | No regex compilation | SAFE |
| 6 | Unicode homograph | `MLV_ᏚPARK` (Cherokee Ꮪ) | Passes through | `\w` may match; code not in DB | `error-code-unknown` — no XSS | SAFE |
| 7 | Entity smuggling | Log contains `&lt;script&gt;` | `&amp;lt;script&amp;gt;` | Displays as `&lt;script&gt;` | Double-escaped, never executes | SAFE |
| 8 | Null byte | `MLV_FOO\x00<script>` | `MLV_FOO\x00&lt;script&gt;` | Regex stops at `\x00` | Null benign in innerHTML | SAFE |

### 8.3 Pre-Existing Bug Fix in error-intel.js

**File:** `error-intel.js:38` (current code)

```javascript
showAlert(exec, latestError) {
  // ...
  let summary = `${errorCount} error${errorCount > 1 ? 's' : ''} detected`;
  if (uniqueCodes.length === 1) {
    summary += ` — ${uniqueCodes[0]}`;                    // ← NOT ESCAPED
    if (latestError.node) summary += ` in node '${latestError.node}'`;  // ← NOT ESCAPED
  }
  // ...
  this.alertElement.innerHTML = `
    <span class="error-icon">✕</span>
    <span class="error-summary">${summary}</span>         <!-- XSS HERE -->
  `;
}
```

**Risk:** If `uniqueCodes[0]` or `latestError.node` contains `<`, the unescaped value is injected into innerHTML. Error codes themselves are typically safe (`[A-Z0-9_]+`), but node names come from user-controlled log messages.

**Fix (required as part of F12, from P0 §4):**

```javascript
showAlert(exec, latestError) {
  // ... build summary using textContent or escape all interpolated values ...
  const escCode = this._escapeHtml(uniqueCodes[0]);
  const escNode = latestError.node ? this._escapeHtml(latestError.node) : '';
  // ... use escCode, escNode in HTML template ...
}

// Add escapeHtml as a static method or import from renderer
_escapeHtml(text) {
  if (!text) return '';
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;')
             .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
             .replace(/'/g, '&#39;');
}
```

### 8.4 Security Checklist

| Item | Status | Notes |
|------|--------|-------|
| All user text HTML-escaped before tag insertion | REQUIRED | Step 2 of pipeline, non-negotiable |
| Only `<mark>` and `<span>` tags produced | HARDCODED | No user control over tag type |
| No event handler attributes (`onclick`, `onerror`) | HARDCODED | Event delegation only |
| No style attributes | HARDCODED | Only `class` and `data-code` |
| No URL attributes (`href`, `src`, `action`) | HARDCODED | No links in highlight tags |
| Search term HTML-escaped before matching | REQUIRED | Prevents regex injection |
| Error code `data-code` values are `[A-Z0-9_]+` only | BY DESIGN | Regex enforces character set |
| `escapeHtml` replaces `&` first | REQUIRED | Prevents double-encoding bugs |
| Pre-existing `error-intel.js` XSS fixed | REQUIRED | Part of F12 implementation |

---

## §9 — Error Handling

### 9.1 Error Codes Database Missing or Corrupt

| Scenario | Detection | Behavior | User Impact |
|----------|-----------|----------|-------------|
| `error-codes-data.js` not generated | `window.ERROR_CODES_DB` is `undefined` | `ErrorDecoder._init()` sets `_db = {}`, `_codeSet = empty Set` | All error codes classified as `unknown` (dashed underline, "?" badge). No context card metadata. |
| Curated JSON has invalid JSON syntax | `generate-error-codes.py` exits with code 1 | Build fails with clear error message | Developer sees build failure. Fix JSON syntax. |
| Curated JSON has schema violations | Validation step catches, prints errors to stderr | With `--strict`: exit 1. Without: warnings printed, valid entries still emitted. | CI catches strict violations. Dev builds are lenient. |
| `error-codes-data.js` contains zero entries | Valid: `window.ERROR_CODES_DB = {}` | `_codeSet` is empty. All codes are `unknown`. | Same as "missing" — degraded but functional. |
| Generated JS has `</script>` in a value | Post-processing escapes: `</script` → `<\/script` | Prevents premature script tag closure in HTML | No impact — handled at build time. |

### 9.2 Invalid Highlight Ranges

| Scenario | Detection | Behavior |
|----------|-----------|----------|
| `start >= end` | `resolveOverlaps` discards zero/negative-length ranges | Range silently dropped |
| `start < 0` | Bounds check in `_computeHighlights` | Clamped to 0 |
| `end > rawText.length` | Bounds check | Clamped to `rawText.length` |
| Overlapping ranges | `resolveOverlaps` clips lower-priority ranges | Higher priority wins, lower clipped |
| `className` not in whitelist | `buildOpenTag` ignores unknown classes | No tag generated for that range |
| `data.code` contains non-`[A-Z0-9_]` chars | Regex match guarantees `\w+` | Impossible by construction |

### 9.3 Timeline Has No Data

| Scenario | Detection | Behavior | Visual |
|----------|-----------|----------|--------|
| No logs received yet | `buckets.length === 0` | Show empty state | "Timeline will appear as logs arrive" |
| All logs evicted (buffer wrapped) | `buckets.every(b => b.total === 0)` | Show empty state | Same message |
| All logs are same timestamp | `span` clamps to 1000ms | Single bucket absorbs all | One tall bar |
| Unparseable timestamps | `isNaN(ts)` check | Entry skipped | Slightly lower counts |
| Timeline filter active but no matches | `FilterIndex` is empty | Log list shows "No matching entries" | Timeline bar stays highlighted |

### 9.4 Graceful Degradation Strategy

**Core principle: F12 features fail independently and NEVER crash the log viewer.**

| Layer | Component | On Failure |
|-------|-----------|------------|
| 0 | Log Viewer Core (renderer, state) | MUST NEVER FAIL. F12 code wrapped in try/catch. |
| 1 | Error Decoder (C02) | All codes show as plain text. Other F12 features work. |
| 2 | Highlight Engine (C03) | Fall back to `textContent`. Stream, timeline, export work. |
| 3 | Stream Controller (C05) | Auto-scroll unchanged. No badge, no count. Logs still flow. |
| 4 | Error Timeline (C06) | Timeline container hidden. Everything else works. |
| 5 | Cluster Engine (C07) | Cluster panel shows "No clusters". Everything else works. |
| 6 | Export Manager (C04) | Error toast: "Export failed". All other features unaffected. |

**Implementation pattern:**

```javascript
// In _populateRow (critical path):
try {
  const highlights = this._computeHighlights(truncated, entry);
  if (highlights.length > 0) {
    row._message.innerHTML = applyHighlights(truncated, highlights, this);
  } else {
    row._message.textContent = truncated;
  }
} catch (err) {
  // FALLBACK: safe textContent, log error, continue rendering
  console.error('[F12] Highlight failed for seq', seq, err);
  row._message.textContent = truncated;
}
```

```javascript
// In handleWebSocketBatch (ingestion path):
try {
  this.errorDecoder.recordOccurrence(code, seq, entry.timestamp, node);
} catch (err) {
  console.error('[F12] Occurrence tracking failed:', err);
  // Continue — log is already in buffer, rendering works
}

try {
  this.clusterEngine.ingestEntry(entry);
} catch (err) {
  console.error('[F12] Cluster ingest failed:', err);
}

try {
  this.errorTimeline.updateIncremental(newEntries);
} catch (err) {
  console.error('[F12] Timeline update failed:', err);
}
```

---

## §10 — Implementation Order

### 10.1 Layer Dependency Graph

```
  L0 ─────► L1 ─────► L2 ─────┬──► L3 (Stream Controller)
  build      decoder   highlight│
  pipeline              engine  ├──► L4 (Error Timeline)
                                │
                                ├──► L5 (Enhanced Clustering)
                                │
                                ├──► L6 (Export + Keyboard)
                                │
                                └──► L7 (CSS for all components)
                                         │
                                         ▼
                                     L8 (build-html.py wiring)
                                         │
                                         ▼
                                     L9 (Build + Integration Test)
```

### 10.2 Layer Definitions

| Layer | Component | New/Modify | File(s) | Depends On | Agent |
|-------|-----------|------------|---------|------------|-------|
| **L0** | Build Pipeline (C01) | New | `scripts/generate-error-codes.py`, `src/data/error-codes-curated.json` | None | Vex |
| **L1** | Error Decoder (C02) | New | `src/frontend/js/error-decoder.js` | L0 (needs `window.ERROR_CODES_DB`) | Pixel |
| **L2** | Highlight Engine (C03) | Modify | `renderer.js` (`_populateRow`, `_onContainerClick`, `escapeHtml`) | L1 (needs `ErrorDecoder.matchErrorCodes()`) | Pixel |
| **L3** | Stream Controller (C05) | Modify | `renderer.js` (`_onScroll`, `flush`), `main.js` (`togglePause`, `handleKeydown`), `state.js` | L2 (shares `_populateRow` code path) | Pixel |
| **L4** | Error Timeline (C06) | New | `src/frontend/js/error-timeline.js` | L2 (timeline filter integrates with `passesFilter`) | Pixel |
| **L5** | Enhanced Clustering (C07) | Modify | `error-intel.js`, `logs-enhancements.js` | L2 (needs highlight rendering for cluster display) | Pixel |
| **L6** | Export + Keyboard (C04) | Modify | `main.js` (`exportLogs`, `handleKeydown`) | L2 (reads FilterIndex) | Pixel |
| **L7** | CSS | Modify | `logs.css`, `variables.css` | L2–L6 (styles for all components) | Pixel |
| **L8** | Build Wiring | Modify | `build-html.py`, `Makefile`, `.gitignore` | L0–L7 (all source files must exist) | Vex |
| **L9** | Verification | Test | All files | L8 (full build must pass) | Sentinel |

### 10.3 Parallelization Opportunities

```
SEQUENTIAL: L0 → L1 → L2 (strict dependency chain)

PARALLEL after L2:
  ┌── L3 (Stream Controller)  — modifies renderer.js, main.js
  ├── L4 (Error Timeline)     — new file, touches renderer.js passesFilter
  ├── L5 (Enhanced Clustering) — modifies error-intel.js, logs-enhancements.js
  └── L6 (Export + Keyboard)  — modifies main.js exportLogs, handleKeydown

CAUTION: L3 and L6 both modify main.js. If parallelized, use separate
functions to minimize merge conflicts. L3 touches togglePause/handleKeydown;
L6 touches exportLogs/handleKeydown. The handleKeydown overlap requires
coordination (L3 adds End/Ctrl+↓, L6 adds Ctrl+Shift+E).

L7 (CSS) can start after L2 for highlight styles, but must wait for
L3–L6 to finalize DOM structures for badge/timeline/cluster/export styles.

L8 (Build Wiring) after all source files are written.
L9 (Verification) after L8.
```

### 10.4 Integration Test Strategy

**Per-layer verification:**

| Layer | Verification |
|-------|-------------|
| L0 | `python scripts/generate-error-codes.py --dry-run` exits 0. Output JS is valid. |
| L1 | Unit test: `ErrorDecoder.matchErrorCodes("MLV_FOO bar FLT_BAZ")` returns 2 matches. |
| L2 | Visual test: log row with `MLV_SPARK_SESSION_FAILED` shows solid underline. Search "spark" shows yellow highlight. Both coexist. |
| L3 | Scroll up → badge shows "PAUSED · N new". Press End → snaps to bottom, badge shows "LIVE". |
| L4 | Timeline shows bars after 50+ logs arrive. Click bar → logs filtered to time range. |
| L5 | Multiple `MLV_SPARK_SESSION_FAILED` logs → single cluster with count, trend badge. |
| L6 | Ctrl+Shift+E → format dropdown. Export CSV → file downloads with correct count. |
| L7 | Visual: all tokens from `variables.css`. Light and dark theme correct. |
| L8 | `make build` succeeds. Single HTML file contains error codes data. |
| L9 | `make lint && make test && make build` — all pass. Manual smoke test with real FLT logs. |

**Cross-layer integration tests (L9):**

1. **Highlight + Decoder + Scroll:** While paused, scroll through highlighted rows. Error code spans are clickable. Context card shows correct occurrence count.
2. **Timeline + Filter + Cluster:** Click timeline bar → logs filtered → cluster panel updates to show only clusters in that time range.
3. **Stream + Buffer + Resume:** Pause → wait for 100+ logs → badge shows count → resume → all buffered logs visible → timeline includes them.
4. **Export + Filter:** Apply error-only filter → export CSV → file contains only error entries → count matches badge.
5. **Security:** Inject `<script>alert(1)</script>` as log message → verify no execution in any component (highlight, card, cluster, timeline tooltip, export).

### 10.5 Estimated Effort

| Layer | Estimated Lines | Complexity | Duration |
|-------|----------------|------------|----------|
| L0 | ~400 Python | Medium | 1 session |
| L1 | ~500 JS | High (3-layer detection, cache, card) | 2 sessions |
| L2 | ~200 JS (modify renderer.js) | Critical (security, performance) | 2 sessions |
| L3 | ~150 JS (modify renderer.js, main.js) | Medium | 1 session |
| L4 | ~500 JS (new file) | Medium | 1 session |
| L5 | ~250 JS (modify existing) | Medium | 1 session |
| L6 | ~150 JS (modify main.js) | Low | 1 session |
| L7 | ~200 CSS | Low | 1 session |
| L8 | ~20 lines (build config) | Low | 0.5 session |
| L9 | — | — | 1 session |
| **Total** | **~2,370 lines** | | **~10.5 sessions** |

---

## Appendix A — Glossary

| Term | Definition |
|------|-----------|
| **RingBuffer** | Fixed-capacity (10K) circular buffer in `state.js`. Source of truth for log data. |
| **FilterIndex** | Pre-sorted array of sequence numbers passing current filters. Drives virtual scroll. |
| **RowPool** | DOM element recycling pool (80 elements). Rows acquired/released as viewport scrolls. |
| **seq** | Monotonic sequence number from `RingBuffer.push()`. Unique entry ID. |
| **Highlight range** | `{start, end, className, data?}` — a decorated span within a log message. |
| **Offset map** | Array mapping raw text positions → escaped HTML positions. |
| **Signature** | Canonical cluster key: error code > exception type > normalized prefix. |
| **Bucket** | Time interval in error timeline (30–60 buckets span buffer's time range). |
| **Fast path** | `_populateRow` path with no highlights — uses `textContent` for zero overhead. |

## Appendix B — Decision Log

| Decision | Rationale | Alternative Considered | Source |
|----------|-----------|----------------------|--------|
| Pure function `applyHighlights` instead of class | Testable, no side effects, cacheable | HighlightEngine class with state | C03 §1 |
| Offset map for position mapping | O(n) precompute, O(1) lookup per highlight | Regex replace on escaped HTML (error-prone) | C03 §4 |
| Error codes > search in priority | Error codes carry semantic meaning + interactivity | Equal priority with splitting | C03 §5, spec §3 |
| Mixin on Renderer for StreamController | Shares scroll handler, avoids cross-object calls | Separate StreamController class | C05 §1 |
| 3 pause reasons instead of boolean | Enables hover-freeze without disrupting manual pause | Single paused boolean | C05 §2 |
| Timeline reads RingBuffer, not FilterIndex | Shows ground truth regardless of active filters | Filter-aware timeline | C06 §9 |
| Global signature map instead of consecutive clustering | Groups all occurrences across buffer, not just adjacent | Keep existing consecutive algorithm | C07 §7 |
| Curated JSON as committed fallback | Dev builds work without FLT repo access | Require FLT repo always | C01 §S05 |
| `'` → `&#39;` added to escapeHtml | Defense-in-depth for F12's data attributes | Only escape 4 entities | P0 §4 |
| 120-element circular window for trends | Fixed memory, O(1) update, 2-minute history | Variable-length array | C07 §4 |

---

*End of F12 Architecture Document*
