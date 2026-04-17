# C02 — Error Decoder Runtime: Component Deep Spec

> **Component:** ErrorDecoder (Runtime Error Code Matching & Context Cards)
> **Feature:** F12 — Error Intelligence & Log Experience
> **File:** `src/frontend/js/error-decoder.js` (new)
> **Owner:** Pixel (JS/CSS)
> **Complexity:** HIGH
> **Depends On:** C01 Build Pipeline (`error-codes-data.js` / `window.ERROR_CODES_DB`)
> **Consumed By:** C03 Highlight Engine, C07 Enhanced Clustering, `detail-panel.js`
> **Priority:** P0 (core foundation — blocks C03 and C07)
> **Status:** P1 — DRAFT
> **Last Updated:** 2025-07-20

---

## Table of Contents

1. [Overview](#1-overview)
2. [Class Design & API Surface](#2-class-design--api-surface)
3. [Data Model](#3-data-model)
4. [Scenarios](#4-scenarios)
   - [S01 — Initialization & Database Loading](#s01--initialization--database-loading)
   - [S02 — 3-Layer Error Code Detection](#s02--3-layer-error-code-detection)
   - [S03 — Pattern Matching in Log Text](#s03--pattern-matching-in-log-text)
   - [S04 — Occurrence Tracking](#s04--occurrence-tracking)
   - [S05 — Popover Card Rendering](#s05--popover-card-rendering)
   - [S06 — Card Content & Layout](#s06--card-content--layout)
   - [S07 — Card Actions](#s07--card-actions)
   - [S08 — Card Dismiss Behavior](#s08--card-dismiss-behavior)
   - [S09 — Integration with C03 Highlight Engine](#s09--integration-with-c03-highlight-engine)
   - [S10 — Integration with C07 Enhanced Clustering](#s10--integration-with-c07-enhanced-clustering)
   - [S11 — Detail Panel Decoration](#s11--detail-panel-decoration)
   - [S12 — Performance & Scalability](#s12--performance--scalability)
   - [S13 — Keyboard Accessibility](#s13--keyboard-accessibility)
   - [S14 — Mobile & Responsive Positioning](#s14--mobile--responsive-positioning)
5. [State Machine](#5-state-machine)
6. [Security](#6-security)
7. [CSS Specification](#7-css-specification)
8. [Error Handling](#8-error-handling)
9. [Implementation Notes](#9-implementation-notes)

---

## 1. Overview

### 1.1 Purpose

ErrorDecoder is the runtime engine that loads the error-codes database, scans log messages for error codes using 3-layer detection (known → pattern-matched unknown → pass-through), tracks occurrence counts per code, renders popover context cards on hover/click, and provides structured highlight range data to C03 (Highlight Engine) and occurrence data to C07 (Enhanced Clustering).

This is the single most important new JavaScript module in F12. Every other error intelligence feature reads data from ErrorDecoder or consumes its output.

### 1.2 Component Boundaries

**ErrorDecoder owns:**
- Loading and indexing `window.ERROR_CODES_DB` at startup
- The `matchErrorCodes(text)` scanning API — returns structured match results
- The `getErrorInfo(code)` lookup API — returns enriched error metadata
- Per-code occurrence counting (`errorOccurrences` Map)
- Popover card DOM creation, positioning, content rendering, and lifecycle
- Click/hover delegation for error code spans in log rows
- "Filter to all [CODE]", "Copy error details", "View in detail panel" card actions

**ErrorDecoder does NOT own:**
- Generating the error-codes database — owned by C01 Build Pipeline
- Injecting `<span>` tags into log message HTML — owned by C03 Highlight Engine (ErrorDecoder provides ranges; C03 wraps them)
- The global cluster algorithm — owned by C07 (ErrorDecoder feeds data)
- The `_populateRow` method or innerHTML transition — owned by C03 Highlight Engine
- Search highlighting — owned by C03 Highlight Engine
- The detail panel DOM — owned by `detail-panel.js` (ErrorDecoder provides a decoration helper)

### 1.3 Relationship to Other Components

| Direction | Component | Channel | Data |
|-----------|-----------|---------|------|
| C01 → C02 | Build Pipeline → ErrorDecoder | `window.ERROR_CODES_DB` global | JSON object of all known error codes |
| C02 → C03 | ErrorDecoder → Highlight Engine | `matchErrorCodes(text)` return value | Array of `{ start, end, code, layer }` match ranges |
| C02 → C07 | ErrorDecoder → Enhanced Clustering | `getOccurrenceData()` | Map of code → `{ count, firstSeen, lastSeen, nodes }` |
| C02 → detail-panel | ErrorDecoder → Detail Panel | `decorateMessage(escapedHtml, entry)` | HTML string with error code `<span>` wrappers |
| Renderer → C02 | Container click delegation | `handleCodeClick(codeElement, row)` | Triggers popover card |
| State → C02 | `state.logBuffer` eviction | `decrementOccurrence(code)` | Adjusts count when ring buffer wraps |

### 1.4 Source Code References

| What | File | Lines | Notes |
|------|------|-------|-------|
| Error code regex (reuse) | `auto-detect.js` | 110 | `/\b(MLV_\w+\|FLT_\w+\|SPARK_\w+)\b/` |
| Error object shape | `auto-detect.js` | 112 | `{ code, message, timestamp, node }` |
| Existing ErrorIntelligence class | `error-intel.js` | 5–51 | Alert rendering; C02 is separate, complementary |
| Pre-existing `.error-code-hint` CSS | `logs.css` | 271–276 | Dashed underline styling — extend, do not remove |
| `escapeHtml()` utility | `renderer.js` | 649–652 | HTML escaping function reused by ErrorDecoder |
| `_onContainerClick` delegation | `renderer.js` | 154–182 | Insertion point for error code click handling |
| `_populateRow` (THE LINE) | `renderer.js` | 397 | `row._message.textContent` — C03 changes this to innerHTML |
| `RingBuffer.push` return (seq) | `state.js` | 19–25 | Sequence number for tracking |
| `LogViewerState` properties | `state.js` | 125–223 | Where `errorCodesDB` and `errorOccurrences` live |
| Proposed `error-codes.json` schema | `research/p0-foundation.md` | §2.3 | JSON schema definition |
| innerHTML escaping pipeline | `research/p0-foundation.md` | §4.6 | 6-step escape-first pipeline |

---

## 2. Class Design & API Surface

### 2.1 Constructor

```javascript
class ErrorDecoder {
  /**
   * @param {LogViewerState} state — shared state object
   * @param {Renderer} renderer — renderer instance (for escapeHtml, container ref)
   */
  constructor(state, renderer) {
    this.state = state;
    this.renderer = renderer;

    // Database: loaded from window.ERROR_CODES_DB
    this._db = {};                    // code → ErrorInfo object
    this._codeSet = new Set();        // Set of known code strings (fast lookup)

    // Detection regex (compiled once, reused)
    this._codePattern = /\b(MLV_\w+|FLT_\w+|SPARK_\w+)\b/g;

    // Occurrence tracking
    this._occurrences = new Map();    // code → { count, firstSeq, lastSeq, firstSeen, lastSeen, nodes: Set }

    // Popover state
    this._activeCard = null;          // Currently open card DOM element
    this._activeCode = null;          // Code string of active card
    this._pinned = false;             // Whether card is pinned (clicked vs hovered)

    // Hover debounce
    this._hoverTimer = null;
    this._hoverDelay = 300;           // ms before showing card on hover

    // Match cache: seq → MatchResult[]
    this._matchCache = new Map();
    this._matchCacheMaxSize = 2000;   // LRU eviction threshold

    this._init();
  }
}
```

### 2.2 Public API

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `matchErrorCodes(text)` | `(text: string) → MatchResult[]` | Array of match ranges | Core detection: scans text, returns all error code positions with layer classification. Called by C03 on every row render. |
| `getErrorInfo(code)` | `(code: string) → ErrorInfo \| null` | Error metadata or null | Lookup a single code in the database. Returns full metadata for known codes, partial metadata for pattern-matched unknown codes. |
| `getOccurrenceCount(code)` | `(code: string) → number` | Count | Returns current occurrence count for a code. Used by popover card and C07. |
| `getOccurrenceData()` | `() → Map<string, OccurrenceEntry>` | Full occurrence map | Returns the full occurrence map. Used by C07 for clustering. |
| `recordOccurrence(code, seq, timestamp, node)` | `(code, seq, timestamp, node?) → void` | void | Increments occurrence counter. Called during log ingestion. |
| `evictOccurrence(code, seq)` | `(code, seq) → void` | void | Decrements counter when ring buffer evicts an entry. |
| `handleCodeHover(spanEl, row)` | `(spanEl: HTMLElement, row: HTMLElement) → void` | void | Shows popover card after hover delay. Called from event delegation. |
| `handleCodeClick(spanEl, row)` | `(spanEl: HTMLElement, row: HTMLElement) → void` | void | Pins popover card open. Called from event delegation. |
| `dismissCard()` | `() → void` | void | Removes the active popover card. |
| `decorateMessage(escapedHtml, entry)` | `(escapedHtml: string, entry: LogEntry) → string` | Decorated HTML string | Wraps error codes in the escaped HTML with `<span>` tags. Used by C03 and detail panel. |
| `destroy()` | `() → void` | void | Cleanup: remove card, clear caches, detach listeners. |

### 2.3 Type Definitions

```javascript
/**
 * @typedef {Object} MatchResult
 * @property {number} start    — start index in the text string
 * @property {number} end      — end index (exclusive) in the text string
 * @property {string} code     — the matched error code string
 * @property {'known'|'unknown'|'pass'} layer — detection layer
 */

/**
 * @typedef {Object} ErrorInfo
 * @property {string} code         — e.g. 'MLV_SPARK_SESSION_ACQUISITION_FAILED'
 * @property {string} title        — human-readable short title
 * @property {string} description  — full description
 * @property {'USER'|'SYSTEM'} category — classification
 * @property {'error'|'warning'|'info'} severity
 * @property {string} suggestedFix — actionable fix text
 * @property {boolean} retryable   — whether retry may help
 * @property {string|null} runbookUrl — link to TSG
 * @property {string[]} relatedCodes — related error codes
 * @property {boolean} isKnown     — true if from DB, false if pattern-matched unknown
 */

/**
 * @typedef {Object} OccurrenceEntry
 * @property {number} count       — current occurrence count
 * @property {number} firstSeq    — seq of first occurrence
 * @property {number} lastSeq     — seq of most recent occurrence
 * @property {string} firstSeen   — ISO timestamp of first occurrence
 * @property {string} lastSeen    — ISO timestamp of most recent occurrence
 * @property {Set<string>} nodes  — set of node names where this code appeared
 */
```

---

## 3. Data Model

### 3.1 Error Codes Database (from C01)

The database is loaded from `window.ERROR_CODES_DB`, which is embedded in the HTML by `build-html.py`. The format matches the schema in P0 research §2.3:

```json
{
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
```

### 3.2 State Properties (added to `LogViewerState`)

```javascript
// In state.js constructor:
this.errorCodesDB = {};               // Populated by ErrorDecoder._init()
this.errorOccurrences = new Map();    // Managed by ErrorDecoder
```

### 3.3 Match Cache Entry

```javascript
// _matchCache: Map<number, MatchResult[]>
// Key: seq (ring buffer sequence number)
// Value: array of MatchResult from matchErrorCodes()
// Purpose: avoid re-running regex on same log entry during scroll repositioning
```

---

## 4. Scenarios

---

### S01 — Initialization & Database Loading

**ID:** `C02-S01`
**One-liner:** Load error-codes DB from embedded global, build fast-lookup index.

**Description:**
On construction, ErrorDecoder reads `window.ERROR_CODES_DB` (set by the generated `error-codes-data.js` file, embedded in the single HTML output by `build-html.py`). It copies the data into `this._db` and builds a `Set` of all known code strings (`this._codeSet`) for O(1) membership testing during 3-layer detection. If the global is missing or empty, ErrorDecoder operates in degraded mode — pattern-matched codes all become "unknown" layer, and context cards show a "No error database loaded" message instead of full metadata. This graceful degradation ensures the feature never crashes, even when error-codes-data.js is absent (e.g., in development builds).

**Technical Mechanism:**

```javascript
_init() {
  // Load database
  const raw = window.ERROR_CODES_DB;
  if (raw && typeof raw === 'object') {
    this._db = raw;
    this._codeSet = new Set(Object.keys(raw));
    this.state.errorCodesDB = raw;
  }
  // If missing: _db = {}, _codeSet = empty Set → all codes are "unknown" layer
}
```

**Source Code Path:** `src/frontend/js/error-decoder.js` — constructor + `_init()` method
**Build wiring:** `scripts/build-html.py` — `error-codes-data.js` must appear in `JS_MODULES` before `error-decoder.js`

**Edge Cases:**
- `window.ERROR_CODES_DB` is `undefined` → degraded mode, no crash
- `window.ERROR_CODES_DB` is malformed (not an object) → treat as empty, log warning to console
- `window.ERROR_CODES_DB` has 0 codes → valid but empty; all matches are "unknown" layer
- Database has codes with lowercase letters → `_codeSet` lookup is case-sensitive; codes in log messages are uppercase `[A-Z0-9_]+` per the regex, so lowercase DB entries would never match. Implementation should normalize DB keys to uppercase on load.
- Very large database (1000+ codes) → `Set.has()` is O(1), no performance concern

**Interactions:** C01 Build Pipeline must set `window.ERROR_CODES_DB` before ErrorDecoder constructor runs. Build order in `build-html.py` must place `error-codes-data.js` before `error-decoder.js`.

**Revert/Undo:** Remove `error-codes-data.js` from `build-html.py` JS_MODULES → ErrorDecoder runs in degraded mode. No other changes needed.

**Priority:** P0

---

### S02 — 3-Layer Error Code Detection

**ID:** `C02-S02`
**One-liner:** Classify every error code match as known, unknown, or pass-through using 3-layer cascade.

**Description:**
When `matchErrorCodes(text)` is called, it runs the compiled regex (`/\b(MLV_\w+|FLT_\w+|SPARK_\w+)\b/g`) against the input text to find all error code candidates. Each match is then classified into one of three layers: **Known** (code exists in `_codeSet`) — gets solid underline + accent badge; **Unknown** (matches the prefix pattern but is NOT in the database) — gets dashed underline + "?" badge; **Pass-through** (no regex match) — no decoration. The method returns an array of `MatchResult` objects sorted by start index, which C03 Highlight Engine consumes to wrap the text with appropriate `<span>` tags.

**Technical Mechanism:**

```javascript
matchErrorCodes(text) {
  if (!text || text.length === 0) return [];

  const results = [];
  this._codePattern.lastIndex = 0; // reset stateful regex

  let match;
  while ((match = this._codePattern.exec(text)) !== null) {
    const code = match[1];
    const layer = this._codeSet.has(code) ? 'known' : 'unknown';
    results.push({
      start: match.index,
      end: match.index + match[0].length,
      code: code,
      layer: layer
    });
  }

  return results; // sorted by start index (regex guarantees left-to-right)
}
```

**Source Code Path:** `src/frontend/js/error-decoder.js` — `matchErrorCodes()` method

**Edge Cases:**
- Text contains no error codes → returns `[]`
- Text contains multiple error codes (e.g., `"MLV_FOO then FLT_BAR"`) → returns 2 results
- Text contains the same code twice → returns 2 separate match results (same code, different positions)
- Code at start of string → `\b` word boundary matches at position 0
- Code at end of string → `\b` matches at end
- Code embedded in a longer word (e.g., `"XMLV_FOO"`) → `\b` prevents match because `X` is a word character; however `"(MLV_FOO)"` → matches because `(` is non-word
- Truncated code at 500-char boundary (e.g., `"MLV_SPARK_SESSI"` cut off) → regex matches `MLV_SPARK_SESSI` as a valid `MLV_\w+` pattern — this is correct behavior (it's still a pattern-matched code)
- Regex `g` flag — **CRITICAL:** `lastIndex` must be reset to 0 before each call because the regex is stateful when using the `g` flag. Failure to reset causes alternating empty results.

**Interactions:**
- C03 Highlight Engine calls `matchErrorCodes()` during `_populateRow` → must return within <0.2ms for 500-char strings
- Result array is consumed by C03's `_decorateErrorCodes(escapedHtml, entry)` to wrap matched ranges with `<span>` tags
- The regex is the same as `auto-detect.js:110` but with the `g` flag for global matching

**Revert/Undo:** If detection is wrong, the regex can be updated in one place (`this._codePattern`). No downstream code changes needed.

**Priority:** P0

---

### S03 — Pattern Matching in Log Text (Efficient Regex)

**ID:** `C02-S03`
**One-liner:** Find error codes in log message text efficiently using pre-compiled regex with word boundaries.

**Description:**
The pattern matching strategy uses a single pre-compiled regex with the `g` flag for global matching. The regex `/\b(MLV_\w+|FLT_\w+|SPARK_\w+)\b/g` is compiled once in the constructor and reused for every call. Word boundaries (`\b`) prevent false positives inside longer identifiers. The `\w+` suffix matches any combination of letters, digits, and underscores — covering all known FLT error code formats (e.g., `MLV_SPARK_SESSION_ACQUISITION_FAILED`, `FLT_EXECUTION_TIMEOUT`, `SPARK_POOL_EXHAUSTED`). The regex operates on the raw (pre-escape) text for correctness, but the resulting match ranges are then mapped onto the HTML-escaped string by C03.

**Technical Mechanism:**

```javascript
// Compiled once in constructor:
this._codePattern = /\b(MLV_\w+|FLT_\w+|SPARK_\w+)\b/g;

// Usage in matchErrorCodes():
// 1. Reset lastIndex (regex is stateful with g flag)
// 2. Exec loop to collect all matches
// 3. Return array of { start, end, code, layer }

// IMPORTANT: matchErrorCodes operates on RAW text (before escapeHtml).
// C03 must map these raw-text ranges to escaped-HTML positions.
// Because error codes contain only [A-Z0-9_] characters, they are
// invariant under HTML escaping (none of those chars are escaped).
// So raw-text offsets === escaped-text offsets for the error code itself.
// BUT: offsets relative to the start of the string may shift if earlier
// text contains & < > " characters that expand under escaping.
//
// Solution: C03 runs regex on the ESCAPED string (safe because error
// code chars don't change under escaping), or C03 re-runs matchErrorCodes
// on the escaped string. See S09 for details.
```

**Source Code Path:** `src/frontend/js/error-decoder.js` — constructor (`_codePattern`), `matchErrorCodes()` method

**Edge Cases:**
- Log message is empty string → returns `[]` immediately (fast path)
- Log message is 500 chars (max after truncation) → regex completes in <0.1ms
- Log message contains 20+ error codes (unlikely but possible in batch error dumps) → all are matched; C03 wraps them all
- Error code contains only the prefix (e.g., `"MLV_"`) → `\w+` requires at least one word char after underscore; `"MLV_"` alone does NOT match (correct — it's not a valid code)
- Numeric-only suffix (e.g., `"MLV_1234"`) → matches; `\w` includes digits
- Mixed case (e.g., `"mlv_spark_error"`) → does NOT match; regex is case-sensitive by design. Error codes are always uppercase in FLT logs.

**Interactions:** C03 Highlight Engine is the primary consumer. The regex must stay in sync with `auto-detect.js:110` — if new prefixes are added there, they must also be added to ErrorDecoder's pattern.

**Revert/Undo:** Change the regex string. No other code changes required.

**Priority:** P0

---

### S04 — Occurrence Tracking

**ID:** `C02-S04`
**One-liner:** Maintain per-code occurrence counts that stay accurate as the ring buffer wraps.

**Description:**
ErrorDecoder maintains a `Map<string, OccurrenceEntry>` tracking how many times each error code has appeared in the current log buffer. When a new log entry is added to the ring buffer, the caller (or an integration hook) calls `recordOccurrence(code, seq, timestamp, node)` for each error code found in the message. When the ring buffer wraps and evicts old entries, `evictOccurrence(code, seq)` decrements the counter. This ensures the "N occurrences in this session" count shown on popover cards is always accurate relative to the current buffer window — not an ever-growing total. The occurrence map also tracks first-seen/last-seen timestamps and a set of node names, which feed into C07 Enhanced Clustering.

**Technical Mechanism:**

```javascript
recordOccurrence(code, seq, timestamp, node) {
  let entry = this._occurrences.get(code);
  if (!entry) {
    entry = {
      count: 0,
      firstSeq: seq,
      lastSeq: seq,
      firstSeen: timestamp,
      lastSeen: timestamp,
      nodes: new Set()
    };
    this._occurrences.set(code, entry);
  }
  entry.count++;
  entry.lastSeq = seq;
  entry.lastSeen = timestamp;
  if (node) entry.nodes.add(node);
}

evictOccurrence(code, seq) {
  const entry = this._occurrences.get(code);
  if (!entry) return;
  entry.count = Math.max(0, entry.count - 1);
  if (entry.count === 0) {
    this._occurrences.delete(code);
  }
  // Note: firstSeq/firstSeen become stale after eviction but that's acceptable.
  // Precise first-seen tracking would require scanning the buffer — too expensive.
}

getOccurrenceCount(code) {
  const entry = this._occurrences.get(code);
  return entry ? entry.count : 0;
}

getOccurrenceData() {
  return this._occurrences;
}
```

**Integration with Ring Buffer Eviction:**

The ring buffer (`state.js:RingBuffer`) does not currently emit eviction events. Two integration strategies:

**Strategy A — Scan on push (preferred):** When `RingBuffer.push()` overwrites an old slot, the evicted entry's error codes must be decremented. Hook into `state.addLog()`:

```javascript
// In main.js or ErrorDecoder._hookLogIngestion():
const origAddLog = state.addLog.bind(state);
state.addLog = (entry) => {
  // Check if push will evict
  if (state.logBuffer.count >= state.logBuffer.capacity) {
    const evictedSeq = state.logBuffer.oldestSeq;
    const evicted = state.logBuffer.getBySeq(evictedSeq);
    if (evicted) {
      const codes = this.matchErrorCodes(evicted.message || '');
      for (const m of codes) {
        this.evictOccurrence(m.code, evictedSeq);
      }
    }
  }

  // Record new occurrences
  const result = origAddLog(entry);
  const codes = this.matchErrorCodes(entry.message || '');
  for (const m of codes) {
    this.recordOccurrence(m.code, state.logBuffer.newestSeq, entry.timestamp,
      entry._inferredNode || null);
  }
  return result;
};
```

**Strategy B — Periodic reconciliation:** Every N seconds, walk the buffer and rebuild counts. Simpler but less accurate between reconciliations.

**Recommendation:** Strategy A — it's precise and the per-entry cost is negligible (one regex exec per log entry).

**Source Code Path:** `src/frontend/js/error-decoder.js` — `recordOccurrence()`, `evictOccurrence()`, `getOccurrenceCount()`, `_hookLogIngestion()`

**Edge Cases:**
- Same code in one log message appears twice (e.g., `"MLV_FOO retry MLV_FOO"`) → `recordOccurrence` called twice for same seq, count increments by 2. On eviction, decrement by 2. Must track code count per seq, not just per code.
  - **Fix:** Use a `_seqCodeCounts` Map (`seq → Map<code, count>`) to track how many times each code appears in each seq. On eviction, decrement by the stored count.

```javascript
// Enhanced eviction tracking:
this._seqCodeCounts = new Map(); // seq → Map<code, count>

// In recordOccurrence:
if (!this._seqCodeCounts.has(seq)) {
  this._seqCodeCounts.set(seq, new Map());
}
const seqCounts = this._seqCodeCounts.get(seq);
seqCounts.set(code, (seqCounts.get(code) || 0) + 1);

// In _hookLogIngestion eviction:
const evictedSeq = state.logBuffer.oldestSeq;
const seqCounts = this._seqCodeCounts.get(evictedSeq);
if (seqCounts) {
  for (const [code, count] of seqCounts) {
    const entry = this._occurrences.get(code);
    if (entry) {
      entry.count = Math.max(0, entry.count - count);
      if (entry.count === 0) this._occurrences.delete(code);
    }
  }
  this._seqCodeCounts.delete(evictedSeq);
}
```

- Ring buffer wraps multiple times before a render → multiple evictions are processed correctly as long as the hook runs before every push
- `_seqCodeCounts` grows to 50K entries (one per ring buffer slot) → ~50K Map entries × ~2 codes average = ~100K string keys. Acceptable memory (~2MB).
- `_seqCodeCounts` must evict entries for sequences that are no longer in the buffer → cleaned up in the eviction hook

**Interactions:**
- Popover card reads `getOccurrenceCount(code)` to display live count
- C07 reads `getOccurrenceData()` for clustering frequency data
- Ring buffer eviction must be hooked — if not hooked, counts grow monotonically (incorrect but non-fatal)

**Revert/Undo:** Unhook `state.addLog` wrapper → occurrence tracking stops, counts freeze at last value. Cards show stale count.

**Priority:** P0

---

### S05 — Popover Card Rendering

**ID:** `C02-S05`
**One-liner:** Render a positioned popover card (not tooltip) anchored to the error code span, with rich content.

**Description:**
When a user hovers over (300ms debounce) or clicks on a decorated error code span, ErrorDecoder creates a popover card element and positions it relative to the triggering span. The card is a `div.error-card` appended to the log scroll container (not the row itself, to avoid clipping). Positioning logic checks viewport bounds: if there's room below the row, the card opens below; otherwise above. The card is at most 360px wide and auto-height. Only one card can be open at a time — showing a new card dismisses the previous. Hover-triggered cards dismiss on mouse-leave (with 150ms grace period for moving to the card itself). Click-triggered cards are "pinned" and require explicit dismiss (click elsewhere, Escape key, or the card's close button).

**Technical Mechanism:**

```javascript
_showCard(code, anchorEl, pinned = false) {
  this.dismissCard(); // remove any existing card

  const info = this.getErrorInfo(code);
  const count = this.getOccurrenceCount(code);

  const card = document.createElement('div');
  card.className = 'error-card';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', `Error details: ${this.renderer.escapeHtml(code)}`);
  card.setAttribute('tabindex', '-1');
  card.innerHTML = this._buildCardHTML(code, info, count);

  // Position relative to anchor
  const scrollContainer = this.renderer.scrollContainer; // .log-scroll element
  scrollContainer.appendChild(card);
  this._positionCard(card, anchorEl, scrollContainer);

  this._activeCard = card;
  this._activeCode = code;
  this._pinned = pinned;

  // Bind card-internal event handlers (delegation)
  card.addEventListener('click', this._onCardClick);

  if (pinned) {
    card.focus(); // move focus for keyboard accessibility
  }
}

_positionCard(card, anchor, container) {
  const anchorRect = anchor.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();

  // Prefer below the row
  const spaceBelow = containerRect.bottom - anchorRect.bottom;
  const spaceAbove = anchorRect.top - containerRect.top;
  const cardHeight = Math.min(card.offsetHeight, 400); // max height cap

  let top, left;

  if (spaceBelow >= cardHeight + 8 || spaceBelow >= spaceAbove) {
    // Position below
    top = anchorRect.bottom - containerRect.top + container.scrollTop + 4;
    card.classList.add('error-card--below');
    card.classList.remove('error-card--above');
  } else {
    // Position above
    top = anchorRect.top - containerRect.top + container.scrollTop - cardHeight - 4;
    card.classList.add('error-card--above');
    card.classList.remove('error-card--below');
  }

  // Horizontal: align left edge with anchor, clamp to container bounds
  left = anchorRect.left - containerRect.left;
  const maxLeft = containerRect.width - 360 - 8; // card width - padding
  left = Math.max(8, Math.min(left, maxLeft));

  card.style.position = 'absolute';
  card.style.top = `${top}px`;
  card.style.left = `${left}px`;
}
```

**Source Code Path:** `src/frontend/js/error-decoder.js` — `_showCard()`, `_positionCard()`, `handleCodeHover()`, `handleCodeClick()`

**Edge Cases:**
- Anchor span has been recycled by virtual scroll (row is no longer in DOM) → check `anchorEl.isConnected` before positioning; dismiss card if anchor is gone
- Scroll container is very short (< 200px) → card may overflow; add `max-height: 300px; overflow-y: auto` to the card
- Card extends beyond viewport right edge → `maxLeft` clamping handles this
- Card extends beyond viewport bottom → above-positioning fallback handles this
- Both above and below have insufficient space → prefer whichever has more space, add scroll to card body
- User scrolls while card is open → card position becomes stale. **Solution:** listen for `scroll` on the container and either dismiss the unpinned card or reposition the pinned card
- Multiple rapid hovers → `_hoverTimer` debounce prevents flicker; each new hover clears the previous timer

**Interactions:**
- Virtual scroll row recycling (RowPool) may invalidate the anchor element at any time
- C05 Log Stream Controller: if stream resumes while card is pinned, the card should remain but may need repositioning as new rows push content

**Revert/Undo:** `dismissCard()` removes the card DOM element and resets all state. No persistent side effects.

**Priority:** P0

---

### S06 — Card Content & Layout

**ID:** `C02-S06`
**One-liner:** Structured card showing title, description, classification, fix, count, node, and action buttons.

**Description:**
The error context card contains a structured layout divided into header (code + title + close button), body (description, classification badge, suggested fix, occurrence count, node context), and footer (action buttons). For known codes, all fields are populated from the database. For unknown (pattern-matched) codes, the card shows a reduced layout: the code string, a "Unknown error code" message, the occurrence count, and only the "Filter" and "Copy" actions. The card uses the project's design tokens and follows the established popover patterns from the design bible. No emoji — only Unicode symbols (✕ for close, ◆ for classification badge).

**Technical Mechanism:**

```javascript
_buildCardHTML(code, info, count) {
  const esc = (t) => this.renderer.escapeHtml(t);

  if (!info || !info.isKnown) {
    // Unknown code — reduced card
    return `
      <div class="error-card-header">
        <span class="error-card-code">${esc(code)}</span>
        <button class="error-card-close" data-action="dismiss" aria-label="Close">✕</button>
      </div>
      <div class="error-card-body">
        <p class="error-card-unknown-msg">
          Pattern-matched error code not found in the error registry.
        </p>
        <div class="error-card-meta">
          <span class="error-card-count">${count} occurrence${count !== 1 ? 's' : ''} in buffer</span>
        </div>
      </div>
      <div class="error-card-actions">
        <button class="error-card-action" data-action="filter" data-code="${esc(code)}">Filter to all ${esc(code)}</button>
        <button class="error-card-action" data-action="copy" data-code="${esc(code)}">Copy error details</button>
      </div>
    `;
  }

  // Known code — full card
  const categoryClass = info.category === 'USER' ? 'error-card-cat--user' : 'error-card-cat--system';
  const categoryLabel = info.category === 'USER' ? 'USER ERROR' : 'SYSTEM ERROR';

  let nodeHTML = '';
  const occData = this._occurrences.get(code);
  if (occData && occData.nodes.size > 0) {
    const nodeList = [...occData.nodes].map(n => esc(n)).join(', ');
    nodeHTML = `<div class="error-card-nodes">Occurred in: ${nodeList}</div>`;
  }

  let runbookHTML = '';
  if (info.runbookUrl) {
    runbookHTML = `<a class="error-card-runbook" href="${esc(info.runbookUrl)}" target="_blank" rel="noopener">View runbook &#8594;</a>`;
  }

  return `
    <div class="error-card-header">
      <div class="error-card-title-row">
        <span class="error-card-code">${esc(code)}</span>
        <span class="error-card-cat ${categoryClass}">◆ ${categoryLabel}</span>
      </div>
      <button class="error-card-close" data-action="dismiss" aria-label="Close">✕</button>
    </div>
    <div class="error-card-body">
      <h4 class="error-card-title">${esc(info.title)}</h4>
      <p class="error-card-desc">${esc(info.description)}</p>
      <div class="error-card-fix">
        <strong>Suggested fix:</strong> ${esc(info.suggestedFix)}
      </div>
      <div class="error-card-meta">
        <span class="error-card-count">${count} occurrence${count !== 1 ? 's' : ''} in buffer</span>
        ${info.retryable ? '<span class="error-card-retryable">Retryable</span>' : ''}
      </div>
      ${nodeHTML}
      ${runbookHTML}
    </div>
    <div class="error-card-actions">
      <button class="error-card-action" data-action="filter" data-code="${esc(code)}">Filter to all ${esc(code)}</button>
      <button class="error-card-action" data-action="copy" data-code="${esc(code)}">Copy error details</button>
      <button class="error-card-action" data-action="detail" data-code="${esc(code)}">View in detail panel</button>
    </div>
  `;
}
```

**Source Code Path:** `src/frontend/js/error-decoder.js` — `_buildCardHTML()`

**Edge Cases:**
- `info.description` is very long (500+ chars) → CSS `max-height` with overflow-y scroll on `.error-card-body`
- `info.suggestedFix` is empty string → show "No fix suggestion available"
- `info.runbookUrl` contains special characters → `esc()` handles `"` and `&`; URL-encoding is the C01 pipeline's responsibility
- `occData.nodes` set has 10+ nodes → comma-separated list may wrap; CSS handles wrapping with `word-break: break-word`
- Count is 0 (code matched but no occurrences tracked yet — race condition during initialization) → show "0 occurrences" which is correct; will update on next render
- All text is escaped via `this.renderer.escapeHtml()` before insertion — **no XSS vectors** even if error database contains malicious strings (defense in depth)

**Interactions:** None — this is a pure rendering method. Reads from `_db`, `_occurrences`, and `renderer.escapeHtml`.

**Revert/Undo:** Card is ephemeral DOM. `dismissCard()` removes it.

**Priority:** P0

---

### S07 — Card Actions

**ID:** `C02-S07`
**One-liner:** Three action buttons that filter, copy, or navigate to error details.

**Description:**
The card footer contains three action buttons: **"Filter to all [CODE]"** sets the search text to the exact error code string, triggering the existing filter pipeline to show only log entries containing that code. **"Copy error details"** writes a formatted text block to the clipboard (code, title, description, fix, count). **"View in detail panel"** opens the detail panel for the log entry that triggered the card. All actions dismiss the card after execution. Actions are handled via event delegation on the card element using `data-action` attributes.

**Technical Mechanism:**

```javascript
_onCardClick = (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;

  const action = btn.dataset.action;
  const code = btn.dataset.code;

  switch (action) {
    case 'dismiss':
      this.dismissCard();
      break;

    case 'filter':
      // Set search text to the error code → triggers FilterManager.setSearch
      this._filterToCode(code);
      this.dismissCard();
      break;

    case 'copy':
      this._copyErrorDetails(code);
      this.dismissCard();
      break;

    case 'detail':
      this._openInDetailPanel(code);
      this.dismissCard();
      break;
  }
}

_filterToCode(code) {
  // Find the search input and set its value
  const searchInput = document.getElementById('search-input');
  if (searchInput) {
    searchInput.value = code;
    searchInput.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

async _copyErrorDetails(code) {
  const info = this.getErrorInfo(code);
  const count = this.getOccurrenceCount(code);
  const lines = [
    `Error Code: ${code}`,
    info?.title ? `Title: ${info.title}` : '',
    info?.description ? `Description: ${info.description}` : '',
    info?.category ? `Classification: ${info.category}` : '',
    info?.suggestedFix ? `Suggested Fix: ${info.suggestedFix}` : '',
    `Occurrences: ${count}`,
  ].filter(Boolean).join('\n');

  try {
    await navigator.clipboard.writeText(lines);
  } catch {
    // Fallback: select-and-copy via textarea
    const ta = document.createElement('textarea');
    ta.value = lines;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  }
}

_openInDetailPanel(code) {
  // Find the most recent log entry with this code and open detail panel
  const buffer = this.state.logBuffer;
  // Walk from newest to oldest to find most recent occurrence
  for (let i = buffer.newestSeq; i >= buffer.oldestSeq; i--) {
    const entry = buffer.getBySeq(i);
    if (entry && entry.message && entry.message.includes(code)) {
      // Trigger detail panel via the viewer's showDetail
      if (window.edogViewer && window.edogViewer.showLogDetail) {
        window.edogViewer.showLogDetail(entry);
      }
      return;
    }
  }
}
```

**Source Code Path:** `src/frontend/js/error-decoder.js` — `_onCardClick()`, `_filterToCode()`, `_copyErrorDetails()`, `_openInDetailPanel()`

**Edge Cases:**
- `navigator.clipboard.writeText` fails (non-HTTPS context, permission denied) → textarea fallback
- `_openInDetailPanel` walks entire buffer (50K entries) → worst case if code doesn't exist. **Mitigation:** limit walk to 5000 entries from newest, or use `_occurrences.get(code).lastSeq` to jump directly to the most recent occurrence:

```javascript
_openInDetailPanel(code) {
  const occ = this._occurrences.get(code);
  if (occ) {
    const entry = this.state.logBuffer.getBySeq(occ.lastSeq);
    if (entry && window.edogViewer?.showLogDetail) {
      window.edogViewer.showLogDetail(entry);
      return;
    }
  }
  // Fallback: linear scan (slow path, should rarely execute)
}
```

- Search input element not found → no-op (graceful degradation)
- `window.edogViewer` not yet initialized → no-op
- Clipboard API not available at all (very old browser) → both paths fail silently; user sees no feedback. Consider showing a toast "Failed to copy" (future enhancement).

**Interactions:**
- "Filter" action triggers `FilterManager.setSearch()` → rebuilds `FilterIndex` → triggers re-render
- "Detail" action triggers `EdogLogViewer.showLogDetail()` → opens detail panel
- All actions dismiss the card

**Revert/Undo:** Each action has its own undo path (clear search, close detail panel). The card dismiss is not undoable.

**Priority:** P0

---

### S08 — Card Dismiss Behavior

**ID:** `C02-S08`
**One-liner:** Dismiss popover card on click-outside, Escape key, scroll, or mouse-leave (if not pinned).

**Description:**
The card has two modes: **hover mode** (triggered by hover, dismissed on mouse-leave with 150ms grace period) and **pinned mode** (triggered by click, requires explicit dismiss). In both modes, pressing Escape dismisses the card. Clicking outside the card (anywhere in the document) dismisses a pinned card. Scrolling the log container dismisses a hover-mode card immediately and repositions a pinned card (or dismisses if the anchor row has been recycled). Only one card exists at a time — opening a new card always dismisses the previous one first.

**Technical Mechanism:**

```javascript
handleCodeHover(spanEl, row) {
  if (this._pinned) return; // don't replace a pinned card with hover

  clearTimeout(this._hoverTimer);
  this._hoverTimer = setTimeout(() => {
    const code = spanEl.dataset.code;
    if (code && spanEl.isConnected) {
      this._showCard(code, spanEl, false); // pinned=false
    }
  }, this._hoverDelay);
}

handleCodeClick(spanEl, row) {
  const code = spanEl.dataset.code;
  if (code) {
    this._showCard(code, spanEl, true); // pinned=true
  }
}

// Mouse-leave from both the code span and the card itself
_setupHoverDismiss() {
  // Managed via mouseleave on the anchor + card with grace period
  // Implementation: track mouse position; if mouse leaves both
  // anchor and card for >150ms, dismiss.
}

// Document-level listeners (bound once in constructor, removed in destroy)
_onDocumentClick = (e) => {
  if (!this._activeCard) return;
  if (!this._pinned) return; // hover cards dismissed by mouseleave
  if (this._activeCard.contains(e.target)) return; // click inside card
  // Check if click is on another error code span
  const codeSpan = e.target.closest('[data-code]');
  if (codeSpan) return; // will be handled by handleCodeClick
  this.dismissCard();
}

_onDocumentKeydown = (e) => {
  if (e.key === 'Escape' && this._activeCard) {
    e.stopPropagation();
    this.dismissCard();
    // Return focus to the triggering element if possible
  }
}

_onContainerScroll = () => {
  if (!this._activeCard) return;
  if (!this._pinned) {
    this.dismissCard(); // dismiss hover cards immediately on scroll
  }
  // Pinned cards: check if anchor is still visible, reposition or dismiss
}

dismissCard() {
  if (this._activeCard) {
    this._activeCard.remove();
    this._activeCard = null;
    this._activeCode = null;
    this._pinned = false;
  }
  clearTimeout(this._hoverTimer);
}
```

**Source Code Path:** `src/frontend/js/error-decoder.js` — `handleCodeHover()`, `handleCodeClick()`, `_onDocumentClick()`, `_onDocumentKeydown()`, `_onContainerScroll()`, `dismissCard()`

**Edge Cases:**
- Click on a different error code while one card is pinned → `handleCodeClick` calls `_showCard` which calls `dismissCard` first → seamless transition
- Escape key when card is not focused (focus is on search input) → `_onDocumentKeydown` fires on `document`, catches it. Use `stopPropagation` to prevent other Escape handlers (e.g., modal close) from firing.
- `_onDocumentKeydown` must not interfere with other Escape handlers when no card is active
- Card is open but user clicks inside the card's action button → `_onCardClick` handles action, then dismisses. `_onDocumentClick` sees the click is inside the card and returns early.
- Mouse moves from code span directly into the card → must NOT dismiss. Implementation: start grace timer on span mouseleave, cancel it on card mouseenter.

**Interactions:**
- `_onDocumentKeydown` must coordinate with `LogsEnhancements._bindKeyboard()` (logs-enhancements.js:895) — ErrorDecoder's Escape handler should check `this._activeCard` before consuming the event
- `_onContainerScroll` is on the `.log-scroll` element, same element used by `Renderer._onScroll` — multiple scroll listeners are fine

**Revert/Undo:** `dismissCard()` is the universal cleanup. `destroy()` calls `dismissCard()` and removes document-level listeners.

**Priority:** P0

---

### S09 — Integration with C03 Highlight Engine

**ID:** `C02-S09`
**One-liner:** ErrorDecoder provides match data; C03 wraps matched ranges with `<span>` tags in escaped HTML.

**Description:**
C03 Highlight Engine owns the `_populateRow` modification and the `_highlightMessage(rawMsg, entry)` pipeline (see P0 research §4.4–4.6). ErrorDecoder's role is to provide the `decorateMessage(escapedHtml, entry)` method that C03 calls after HTML-escaping. This method runs the regex on the escaped HTML (safe because error code characters `[A-Z0-9_]` are invariant under HTML escaping), finds all code positions, and wraps them with `<span class="error-code-known" data-code="CODE">CODE</span>` or `<span class="error-code-unknown" data-code="CODE">CODE<span class="error-code-badge">?</span></span>`. C03 calls this method BEFORE applying search highlights, ensuring error code decorations have higher visual priority.

**Technical Mechanism:**

```javascript
decorateMessage(escapedHtml, entry) {
  if (!escapedHtml) return escapedHtml;

  // Run regex on escaped HTML — safe because error code chars don't change under escaping
  this._codePattern.lastIndex = 0;
  let result = '';
  let lastIndex = 0;
  let match;

  while ((match = this._codePattern.exec(escapedHtml)) !== null) {
    const code = match[1];
    const isKnown = this._codeSet.has(code);

    // Append text before this match
    result += escapedHtml.substring(lastIndex, match.index);

    // Wrap the code in a span
    if (isKnown) {
      result += `<span class="error-code-known" data-code="${code}">${code}</span>`;
    } else {
      result += `<span class="error-code-unknown" data-code="${code}">${code}<span class="error-code-badge">?</span></span>`;
    }

    lastIndex = match.index + match[0].length;
  }

  // Append remaining text after last match
  result += escapedHtml.substring(lastIndex);

  return result;
}
```

**C03 calls this in `_highlightMessage`:**

```javascript
// In C03 (renderer.js modified _highlightMessage):
_highlightMessage(rawMsg, entry) {
  let safe = this.escapeHtml(rawMsg);

  // Step 1: Error code decoration (ErrorDecoder)
  if (this._errorDecoder) {
    safe = this._errorDecoder.decorateMessage(safe, entry);
  }

  // Step 2: Search highlighting (skip inside existing <span> tags)
  if (this.state.searchText) {
    safe = this._highlightSearchTerms(safe, this.state.searchText);
  }

  return safe;
}
```

**Source Code Path:** `src/frontend/js/error-decoder.js` — `decorateMessage()`; `src/frontend/js/renderer.js` — `_highlightMessage()` (modified by C03)

**Edge Cases:**
- Error code spans partially overlap with HTML entity (e.g., `MLV_&amp;FOO`) → impossible because error codes are `[A-Z0-9_]+` only; `&` is not in that set. The regex won't match across entity boundaries.
- Two error codes adjacent with no space (e.g., `MLV_FOOMLV_BAR`) → `\b` prevents this from matching as two codes because there's no word boundary between `O` and `M`. They would match as a single `MLV_FOOMLV_BAR`. This is correct behavior — it's a single token.
- No error codes in message → regex finds nothing, function returns input unchanged (fast path: `result` accumulates the entire string)
- Very many matches (20+) → string concatenation may be slow. Consider using `escapedHtml.replace()` with a callback for better performance:

```javascript
// Alternative: single replace call (faster for many matches)
decorateMessage(escapedHtml, entry) {
  if (!escapedHtml) return escapedHtml;
  return escapedHtml.replace(this._codePattern, (fullMatch, code) => {
    if (this._codeSet.has(code)) {
      return `<span class="error-code-known" data-code="${code}">${code}</span>`;
    }
    return `<span class="error-code-unknown" data-code="${code}">${code}<span class="error-code-badge">?</span></span>`;
  });
}
```

This `.replace()` approach is cleaner and faster. **Use this as the primary implementation.**

**Interactions:**
- C03 must call `decorateMessage` BEFORE `_highlightSearchTerms` — error codes take visual priority
- C03's search highlighter must skip regions inside `<span>` tags (from error decoration) — implementation: a state machine that tracks `<` and `>` to avoid inserting `<mark>` inside existing tags
- `data-code` attribute value is always `[A-Z0-9_]+` — inherently safe, no escaping needed for attribute context

**Revert/Undo:** Remove the `if (this._errorDecoder)` block in `_highlightMessage` → error code decoration disappears, search highlighting still works.

**Priority:** P0

---

### S10 — Integration with C07 Enhanced Clustering

**ID:** `C02-S10`
**One-liner:** ErrorDecoder feeds per-code occurrence metadata to C07 for global error clustering.

**Description:**
C07 Enhanced Clustering (modification of `logs-enhancements.js`'s `detectClusters`) needs to know which error codes are active, how often each has occurred, when they first/last appeared, and in which nodes. ErrorDecoder exposes `getOccurrenceData()` which returns the full `_occurrences` Map. C07 reads this to build global clusters: grouping log entries by error code signature (rather than just consecutive message similarity), computing frequency rates, and generating trend badges (↑↓→). ErrorDecoder does not call C07 — C07 pulls data when it runs its clustering pass.

**Technical Mechanism:**

```javascript
// C07 calls:
const occurrenceMap = errorDecoder.getOccurrenceData();
for (const [code, data] of occurrenceMap) {
  // data: { count, firstSeq, lastSeq, firstSeen, lastSeen, nodes }
  // Build or update cluster for this code
}
```

**Source Code Path:**
- `src/frontend/js/error-decoder.js` — `getOccurrenceData()`
- `src/frontend/js/logs-enhancements.js` — `detectClusters()` (modified by C07)
- `src/frontend/js/error-intel.js` — frequency tracking (extended by C07)

**Edge Cases:**
- `_occurrences` is empty (no error codes found yet) → C07 gets empty Map, produces no clusters
- C07 reads occurrence data while ErrorDecoder is updating it (mid-push) → JavaScript is single-threaded; this cannot happen
- C07 modifies the returned Map → `getOccurrenceData()` returns the internal Map directly (no copy). If C07 must not mutate, document that it should treat the return value as read-only. A defensive copy is unnecessary given single-threaded execution.

**Interactions:**
- C07 depends on ErrorDecoder being initialized first (constructor order in `main.js`)
- C07's clustering interval should not trigger more than once per second to avoid reading stale mid-update data

**Revert/Undo:** If C07 is not implemented, `getOccurrenceData()` simply isn't called. No impact on ErrorDecoder.

**Priority:** P3 (C07 is P3; this integration point ships with P0 ErrorDecoder but isn't consumed until P3)

---

### S11 — Detail Panel Decoration

**ID:** `C02-S11`
**One-liner:** Decorate error codes in the detail panel's full message view with clickable spans.

**Description:**
When the detail panel opens for a log entry (`detail-panel.js:showLogDetail`), the full (untruncated) message is displayed. ErrorDecoder provides a decoration helper that the detail panel calls to wrap error codes with clickable spans — identical to the log row decoration but on the full message. The detail panel's existing `escapeHtml(entry.message)` call is extended to also pass through `errorDecoder.decorateMessage()`. Clicking an error code in the detail panel opens the same popover card.

**Technical Mechanism:**

```javascript
// In detail-panel.js showLogDetail() — line ~68:
// BEFORE:
// <div class="detail-message">${this.escapeHtml(entry.message || 'No message')}</div>

// AFTER:
const escapedMsg = this.escapeHtml(entry.message || 'No message');
const decoratedMsg = this._errorDecoder
  ? this._errorDecoder.decorateMessage(escapedMsg, entry)
  : escapedMsg;
// Then use decoratedMsg in the template
```

**Source Code Path:**
- `src/frontend/js/detail-panel.js` — `showLogDetail()` line ~68
- `src/frontend/js/error-decoder.js` — `decorateMessage()` (same method used by C03)

**Edge Cases:**
- Detail panel shows the FULL message (no 500-char truncation) → regex may find codes beyond the 500-char boundary that weren't visible in the log row
- Detail panel message is very long (10KB+) → regex performance on long strings is still <1ms for typical messages. Only one message is decorated (not 80 rows).
- `_errorDecoder` reference not set on detail panel → graceful fallback to undecorated HTML

**Interactions:**
- Detail panel click events must delegate to ErrorDecoder's `handleCodeClick` for popover cards
- Popover card from detail panel must position relative to the detail panel container, not the log scroll container

**Revert/Undo:** Remove the `decorateMessage` call → detail panel shows plain escaped text.

**Priority:** P0

---

### S12 — Performance & Scalability

**ID:** `C02-S12`
**One-liner:** Meet <0.5ms per row regex scan target across 50K buffer with caching.

**Description:**
ErrorDecoder's performance-critical path is `decorateMessage()`, called by C03 for every visible row on every render (~80 rows per frame at 100ms throttle). The regex scan on a 500-char truncated message completes in <0.05ms. The total decoration (regex + string replacement) is <0.2ms per row. Combined with HTML escaping and search highlighting by C03, the full `_highlightMessage` pipeline stays within the <1ms per row target established in P0 research §4.7. For occurrence tracking, the `recordOccurrence` method is O(1) per call. The match cache avoids recomputation when virtual scroll repositions rows without data changes.

**Technical Mechanism:**

```javascript
// Match cache: avoids recomputation for scrolled-but-unchanged rows
// Key: seq (ring buffer sequence number)
// Invalidated when: search text changes (version bump)

this._matchCache = new Map();
this._matchCacheVersion = 0;

// In decorateMessage, optionally cache:
decorateMessageCached(escapedHtml, entry, seq) {
  const cacheKey = `${seq}:${this._matchCacheVersion}`;
  if (this._matchCache.has(cacheKey)) {
    return this._matchCache.get(cacheKey);
  }

  const result = this.decorateMessage(escapedHtml, entry);
  this._matchCache.set(cacheKey, result);

  // LRU eviction: keep cache under 2000 entries
  if (this._matchCache.size > this._matchCacheMaxSize) {
    const firstKey = this._matchCache.keys().next().value;
    this._matchCache.delete(firstKey);
  }

  return result;
}

// Invalidate cache when search text changes:
invalidateCache() {
  this._matchCacheVersion++;
  this._matchCache.clear();
}
```

**Performance Targets:**

| Operation | Target | Notes |
|-----------|--------|-------|
| `matchErrorCodes()` on 500-char string | <0.1ms | Compiled regex, no allocation for empty results |
| `decorateMessage()` per row | <0.2ms | Regex + string replace |
| `recordOccurrence()` per log entry | <0.01ms | Map.get + set |
| `evictOccurrence()` per eviction | <0.01ms | Map.get + decrement |
| Full `_highlightMessage()` pipeline (C03) | <1ms per row | escapeHtml + decorateMessage + searchHighlight |
| 80-row render cycle total | <8ms | Well within 16.6ms frame budget |
| Match cache lookup | <0.01ms | Map.has + Map.get |
| Cache memory (2000 entries) | <500KB | Short HTML strings |

**Lazy vs Eager Scanning:**
- **Eager:** Scan every log entry for error codes on ingestion (in `_hookLogIngestion`). Pro: occurrence counts always accurate. Con: CPU cost on high-volume streams (1000+ logs/min).
- **Lazy:** Only scan when a row becomes visible in the viewport. Pro: minimal CPU for off-screen rows. Con: occurrence counts may be inaccurate until all rows have been scrolled into view.
- **Recommendation: Eager for occurrence tracking, cached for rendering.** The regex is cheap (<0.1ms per message). At 1000 logs/min, that's ~1.6ms/second of CPU — negligible. Occurrence counts must be accurate for the popover card and C07 clustering.

**Source Code Path:** `src/frontend/js/error-decoder.js` — `decorateMessageCached()`, `invalidateCache()`, `_matchCache`

**Edge Cases:**
- Cache grows beyond `_matchCacheMaxSize` → LRU eviction (delete oldest entry). The Map iteration order is insertion order in JavaScript.
- Cache holds stale HTML after search text changes → `invalidateCache()` clears the cache and bumps version
- Very high log volume (10,000 logs/min) → 10K regex execs/min = ~167/sec × 0.1ms = ~17ms/sec. Acceptable.
- 50K entries in ring buffer → only ~80 are rendered. Buffer size does not affect render performance.

**Interactions:**
- C03 should call `decorateMessageCached()` (with seq) instead of `decorateMessage()` for cache benefits
- `FilterManager.applyFilters()` should call `errorDecoder.invalidateCache()` when search text changes

**Revert/Undo:** Disable caching by always calling `decorateMessage()` directly — correctness is preserved, performance may regress.

**Priority:** P0

---

### S13 — Keyboard Accessibility

**ID:** `C02-S13`
**One-liner:** Card supports focus trapping, Escape dismiss, and Tab navigation through actions.

**Description:**
When a card is pinned (opened via click), focus moves to the card element (`tabindex="-1"` + `card.focus()`). Tab cycles through the action buttons and the close button within the card. Shift+Tab reverses. Escape dismisses the card and returns focus to the triggering error code span (if still in the DOM). Screen readers see the card as `role="dialog"` with `aria-label` set to the error code. Action buttons have descriptive text. The classification badge and occurrence count are readable by screen readers. When the card is dismissed, focus returns to the element that was focused before the card opened.

**Technical Mechanism:**

```javascript
_showCard(code, anchorEl, pinned = false) {
  this._previousFocus = document.activeElement; // save focus origin
  // ... create and position card ...

  if (pinned) {
    // Focus trap: find all focusable elements within card
    requestAnimationFrame(() => {
      card.focus();
    });
  }
}

_onCardKeydown = (e) => {
  if (e.key === 'Escape') {
    this.dismissCard();
    // Restore focus
    if (this._previousFocus && this._previousFocus.isConnected) {
      this._previousFocus.focus();
    }
    return;
  }

  if (e.key === 'Tab') {
    // Simple focus trap within the card
    const focusable = this._activeCard.querySelectorAll('button, a[href], [tabindex]');
    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }
}

dismissCard() {
  if (this._activeCard) {
    this._activeCard.removeEventListener('keydown', this._onCardKeydown);
    this._activeCard.remove();
    this._activeCard = null;
    this._activeCode = null;
    this._pinned = false;
  }
  clearTimeout(this._hoverTimer);
}
```

**Source Code Path:** `src/frontend/js/error-decoder.js` — `_showCard()`, `_onCardKeydown()`, `dismissCard()`

**Edge Cases:**
- `_previousFocus` element has been removed from DOM (virtual scroll recycled the row) → `isConnected` check prevents error; focus falls to document body
- Card has no focusable elements (malformed HTML) → `focusable` is empty; Tab does nothing
- Multiple cards opened in rapid succession via keyboard → each `_showCard` calls `dismissCard` first, so only one card exists

**Interactions:**
- `LogsEnhancements._bindKeyboard` (logs-enhancements.js:895) uses keyboard events for breakpoint navigation. ErrorDecoder's Escape handler on the card has higher specificity because it's on the card element (not document-level). The document-level `_onDocumentKeydown` only fires if the card doesn't capture it.
- Screen reader aria attributes must be set: `role="dialog"`, `aria-label`, `aria-describedby` (optional, for description text)

**Revert/Undo:** Remove keyboard listeners → card loses keyboard support but still works with mouse.

**Priority:** P1

---

### S14 — Mobile & Responsive Positioning

**ID:** `C02-S14`
**One-liner:** Card adapts to narrow viewports by centering horizontally and adjusting width.

**Description:**
On viewports narrower than 480px, the card switches to a nearly-full-width layout (width: calc(100% - 16px), centered) instead of anchoring to the code span. On viewports between 480px and 768px, the card width reduces from 360px to 300px. The positioning logic clamps the card to the visible area of the scroll container. If the container is too short to show the card above or below, the card overlays the row with a semi-transparent backdrop. Touch targets for action buttons are at least 44x44px on mobile.

**Technical Mechanism:**

```javascript
_positionCard(card, anchor, container) {
  const viewportWidth = container.clientWidth;

  if (viewportWidth < 480) {
    // Mobile: center horizontally
    card.style.width = 'calc(100% - 16px)';
    card.style.left = '8px';
    card.classList.add('error-card--mobile');
  } else if (viewportWidth < 768) {
    card.style.width = '300px';
  } else {
    card.style.width = '360px';
  }

  // ... vertical positioning (same as S05) ...
}
```

**CSS additions (in `logs.css` or `error-intel.css`):**

```css
.error-card--mobile .error-card-action {
  min-height: 44px;
  padding: var(--space-3);
}
```

**Source Code Path:** `src/frontend/js/error-decoder.js` — `_positionCard()` responsive branches

**Edge Cases:**
- Container resizes while card is open (e.g., sidebar toggle) → card may overflow. Dismiss unpinned card on resize; reposition pinned card.
- Touch events: `touchstart` on error code should behave like click (pin card), not hover. Mobile has no hover.
- Card taller than viewport → `max-height` with overflow scroll
- Landscape mobile (very short but wide) → vertical space constrained; card may need to appear as a bottom sheet (future enhancement, not MVP)

**Interactions:** The responsive breakpoints should match the design system's breakpoints if defined in `variables.css`.

**Revert/Undo:** Remove responsive branches → card uses fixed 360px width on all viewports.

**Priority:** P2

---

## 5. State Machine

### Card Lifecycle States

```
                    ┌──────────┐
                    │  CLOSED  │ ← initial state
                    └────┬─────┘
                         │
           ┌─────────────┼─────────────┐
           │ hover (300ms delay)       │ click
           ▼                           ▼
    ┌──────────────┐           ┌──────────────┐
    │  HOVER_OPEN  │           │ PINNED_OPEN  │
    │  (unpinned)  │           │  (pinned)    │
    └──────┬───────┘           └──────┬───────┘
           │                          │
    dismiss triggers:          dismiss triggers:
    - mouseleave (150ms)       - Escape key
    - scroll                   - click outside
    - new hover/click          - close button
    - Escape key               - action button
           │                   - new click on different code
           ▼                          ▼
    ┌──────────┐               ┌──────────┐
    │  CLOSED  │               │  CLOSED  │
    └──────────┘               └──────────┘

Transition: HOVER_OPEN → PINNED_OPEN
  Trigger: click on the same code span while hover card is showing
```

### Occurrence Tracking States

```
             ┌──────────┐
             │  EMPTY   │  ← no occurrences for this code
             └────┬─────┘
                  │ recordOccurrence()
                  ▼
             ┌──────────┐
             │ TRACKING  │  ← count > 0
             └────┬─────┘
                  │ evictOccurrence() until count === 0
                  ▼
             ┌──────────┐
             │  EMPTY   │  ← entry removed from Map
             └──────────┘
```

---

## 6. Security

### 6.1 Non-Negotiable Rules (from P0 Research §4)

1. **All log message text MUST be HTML-escaped before any tag insertion.** ErrorDecoder's `decorateMessage()` operates on already-escaped HTML. It does not escape — that's C03's responsibility.
2. **Only `<span>` tags with specific class and `data-code` attributes** are inserted by `decorateMessage()`.
3. **`data-code` values are always `[A-Z0-9_]+`** — inherently safe for attribute context. No additional escaping needed.
4. **No event handler attributes** (`onclick`, `onerror`, etc.) — all interactivity via event delegation.
5. **Card content uses `escapeHtml()`** on every database value before insertion (defense in depth — even if the DB is trusted).
6. **`_buildCardHTML()` escapes all interpolated values** including `code`, `info.title`, `info.description`, `info.suggestedFix`, node names.
7. **Runbook URLs** are escaped with `escapeHtml()` and placed in `href` attributes. The `target="_blank" rel="noopener"` prevents tabnapping.

### 6.2 Attack Surface

| Vector | Mitigation |
|--------|------------|
| Malicious log message containing HTML | Escaped by C03 before `decorateMessage()` is called |
| Malicious error code like `MLV_<script>` | Regex requires `\w+` (word chars only) — `<` doesn't match |
| Malicious DB values (title/description with HTML) | `_buildCardHTML` escapes all values via `escapeHtml()` |
| Malicious runbook URL (`javascript:alert(1)`) | `escapeHtml()` escapes `"` → prevents attribute breakout. CSP blocks `javascript:` URIs if CSP headers are set. |
| Clipboard injection | `navigator.clipboard.writeText()` writes plain text only |

---

## 7. CSS Specification

### 7.1 New Classes

All classes go in `src/frontend/css/logs.css` (or a new `error-intel.css` if file becomes too large).

```css
/* === Error Code Decoration (inline in log row) === */

.error-code-known {
  text-decoration: underline solid;
  text-decoration-color: var(--accent);
  text-underline-offset: 2px;
  cursor: pointer;
  border-radius: 2px;
  padding: 0 2px;
  margin: 0 -2px;
  transition: background var(--transition-fast);
}

.error-code-known:hover {
  background: var(--accent-dim);
}

.error-code-unknown {
  text-decoration: underline dashed;
  text-decoration-color: var(--level-error);
  text-underline-offset: 2px;
  cursor: help;
}

.error-code-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  margin-left: 2px;
  border-radius: 50%;
  background: var(--accent);
  color: var(--text-on-accent);
  font-size: 9px;
  font-weight: 700;
  vertical-align: middle;
  line-height: 1;
}

/* === Error Context Card (popover) === */

.error-card {
  position: absolute;
  z-index: 100;
  width: 360px;
  max-height: 400px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: 0 4px 24px rgba(0,0,0,0.12);
  font-family: var(--font-sans);
  font-size: var(--text-sm);
  overflow: hidden;
  outline: none;
}

.error-card--above {
  /* Subtle upward arrow indicator via pseudo-element if desired */
}

.error-card-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  padding: var(--space-3);
  border-bottom: 1px solid var(--border);
  background: var(--surface-2);
}

.error-card-title-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.error-card-code {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  font-weight: 600;
  color: var(--level-error);
  word-break: break-all;
}

.error-card-cat {
  font-size: 10px;
  font-weight: 600;
  padding: 2px 6px;
  border-radius: var(--radius-sm);
  letter-spacing: 0.3px;
  white-space: nowrap;
}

.error-card-cat--user {
  background: var(--level-warning-tint);
  color: var(--level-warning);
}

.error-card-cat--system {
  background: var(--level-error-tint);
  color: var(--level-error);
}

.error-card-close {
  background: none;
  border: none;
  cursor: pointer;
  color: var(--text-muted);
  font-size: 14px;
  padding: var(--space-1);
  line-height: 1;
  border-radius: var(--radius-sm);
  flex-shrink: 0;
}

.error-card-close:hover {
  background: var(--surface-3);
  color: var(--text);
}

.error-card-body {
  padding: var(--space-3);
  overflow-y: auto;
  max-height: 240px;
}

.error-card-title {
  margin: 0 0 var(--space-2) 0;
  font-size: var(--text-md);
  font-weight: 600;
  color: var(--text);
}

.error-card-desc {
  margin: 0 0 var(--space-2) 0;
  color: var(--text-muted);
  line-height: 1.5;
}

.error-card-fix {
  margin: 0 0 var(--space-2) 0;
  padding: var(--space-2);
  background: var(--accent-dim);
  border-radius: var(--radius-sm);
  color: var(--text);
  line-height: 1.5;
}

.error-card-meta {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin-top: var(--space-2);
  font-size: var(--text-xs);
  color: var(--text-dim);
}

.error-card-count {
  font-family: var(--font-mono);
}

.error-card-retryable {
  padding: 1px 6px;
  background: rgba(24, 160, 88, 0.1);
  color: #18a058;
  border-radius: var(--radius-sm);
  font-weight: 500;
}

.error-card-nodes {
  margin-top: var(--space-2);
  font-size: var(--text-xs);
  color: var(--text-dim);
  word-break: break-word;
}

.error-card-runbook {
  display: inline-block;
  margin-top: var(--space-2);
  color: var(--accent);
  font-size: var(--text-xs);
  text-decoration: none;
}

.error-card-runbook:hover {
  text-decoration: underline;
}

.error-card-unknown-msg {
  color: var(--text-dim);
  font-style: italic;
  margin: 0 0 var(--space-2);
}

.error-card-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
  padding: var(--space-2) var(--space-3);
  border-top: 1px solid var(--border);
  background: var(--surface);
}

.error-card-action {
  background: none;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: var(--space-1) var(--space-2);
  font-size: var(--text-xs);
  color: var(--text-muted);
  cursor: pointer;
  transition: all var(--transition-fast);
  white-space: nowrap;
}

.error-card-action:hover {
  background: var(--surface-2);
  color: var(--text);
  border-color: var(--accent);
}

.error-card-action:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
```

### 7.2 Relationship to Existing `.error-code-hint`

The existing `.error-code-hint` class (logs.css:271–276) uses dashed underline and `cursor: help`. ErrorDecoder introduces two new classes that replace this:
- `.error-code-known` — solid underline + pointer cursor (clickable)
- `.error-code-unknown` — dashed underline + help cursor (same as `.error-code-hint`)

The `.error-code-hint` class should be **kept** for backward compatibility but is no longer applied by new code. It may be deprecated in a future cleanup pass.

---

## 8. Error Handling

| Condition | Behavior | User Impact |
|-----------|----------|-------------|
| `window.ERROR_CODES_DB` missing | Degraded mode: all codes are "unknown" layer | Dashed underlines, no full metadata in cards |
| `window.ERROR_CODES_DB` malformed | Treated as empty; `console.warn` logged | Same as missing |
| `escapeHtml` not available on renderer | Fatal — throw during construction | Feature fails to initialize; error logged |
| Card positioning fails (no scroll container) | Card not shown; `console.warn` logged | Code spans visible, no popover |
| `navigator.clipboard` unavailable | Textarea fallback for copy | Copy still works |
| `window.edogViewer` not set | "View in detail panel" no-ops | Action button does nothing |
| Regex throws (should never happen with valid pattern) | Catch in `matchErrorCodes`, return `[]` | No codes decorated in that message |
| Ring buffer `getBySeq` returns null (evicted during card render) | Check for null, show "Entry no longer in buffer" | Card shows partial info |

---

## 9. Implementation Notes

### 9.1 File Structure

```
src/frontend/js/error-decoder.js
├── class ErrorDecoder
│   ├── constructor(state, renderer)
│   ├── _init()
│   ├── matchErrorCodes(text) → MatchResult[]
│   ├── getErrorInfo(code) → ErrorInfo | null
│   ├── getOccurrenceCount(code) → number
│   ├── getOccurrenceData() → Map
│   ├── recordOccurrence(code, seq, timestamp, node)
│   ├── evictOccurrence(code, seq)
│   ├── decorateMessage(escapedHtml, entry) → string
│   ├── decorateMessageCached(escapedHtml, entry, seq) → string
│   ├── invalidateCache()
│   ├── handleCodeHover(spanEl, row)
│   ├── handleCodeClick(spanEl, row)
│   ├── dismissCard()
│   ├── destroy()
│   ├── _showCard(code, anchorEl, pinned)
│   ├── _positionCard(card, anchor, container)
│   ├── _buildCardHTML(code, info, count) → string
│   ├── _onCardClick(e)
│   ├── _onCardKeydown(e)
│   ├── _onDocumentClick(e)
│   ├── _onDocumentKeydown(e)
│   ├── _onContainerScroll()
│   ├── _filterToCode(code)
│   ├── _copyErrorDetails(code)
│   ├── _openInDetailPanel(code)
│   ├── _hookLogIngestion()
│   └── _setupHoverDismiss()
```

### 9.2 Integration Checklist (for implementation agent)

1. **`build-html.py`:** Add `error-codes-data.js` to `JS_MODULES` BEFORE `error-decoder.js`
2. **`main.js` constructor:** Instantiate `ErrorDecoder` after `Renderer` and `LogViewerState`:
   ```javascript
   this.errorDecoder = new ErrorDecoder(this.state, this.renderer);
   ```
3. **`renderer.js` `_onContainerClick`:** Add click delegation for `.error-code-known` and `.error-code-unknown` spans (before the component click check at line ~170)
4. **`renderer.js` `_onContainerClick`:** Add hover delegation via `mouseover`/`mouseout` on the container (or add separate listener)
5. **`detail-panel.js`:** Wire `_errorDecoder` reference and call `decorateMessage()` in `showLogDetail()`
6. **`state.js`:** Add `errorCodesDB` and `errorOccurrences` properties to `LogViewerState` constructor
7. **`logs.css`:** Add all CSS from §7.1
8. **C03 `_highlightMessage`:** Call `errorDecoder.decorateMessage()` in the highlight pipeline

### 9.3 Testing Strategy

| Test | What | How |
|------|------|-----|
| Unit: `matchErrorCodes` | Returns correct matches for known/unknown/pass-through | Pass test strings with each code type |
| Unit: `getErrorInfo` | Returns full info for known, partial for unknown, null for no-match | Assert against test DB |
| Unit: `decorateMessage` | Wraps codes with correct `<span>` classes | Compare output HTML |
| Unit: `recordOccurrence` / `evictOccurrence` | Counts are accurate after add/remove cycles | Assert counts |
| Unit: `_buildCardHTML` | Produces valid HTML with all escaped values | Check for XSS patterns |
| Integration: card position | Card stays within container bounds | DOM position assertions |
| Integration: click delegation | Clicking code span opens card | Simulate click event |
| Integration: filter action | "Filter to all [CODE]" sets search input | Check input.value |
| Integration: cache | Same seq returns cached result | Call twice, verify single regex exec |
| Security: XSS in message | `<script>` in log message doesn't execute | Check escaped output |
| Security: XSS in DB | Malicious DB values are escaped in card | Inject test DB with HTML |
| Performance: 80 rows | Full render cycle < 8ms | Performance.now() timing |
| A11y: keyboard | Tab cycles through card buttons, Escape dismisses | Keyboard event simulation |

### 9.4 Build Order Dependencies

```
C01 (generate-error-codes.py)  →  error-codes-data.js (generated)
                                        ↓
                                  error-decoder.js (C02, this file)
                                        ↓
                               renderer.js modifications (C03)
                                        ↓
                            logs-enhancements.js modifications (C07)
```

C02 can be implemented and tested independently of C03 by calling `decorateMessage()` directly in unit tests. C03 integration is a separate implementation step.
