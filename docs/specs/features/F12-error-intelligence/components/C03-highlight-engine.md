# C03 — Highlight Engine

> **Component:** C03 — Highlight Engine
> **Feature:** F12 — Error Intelligence & Log Experience
> **Phase:** P1
> **Owner:** Pixel
> **Modifies:** `src/frontend/js/renderer.js` — `_populateRow` method (line 397)
> **Depends on:** C02 (Error Decoder Runtime) for error code ranges
> **Priority:** CRITICAL — this is the keystone security-sensitive component

---

## 1. Purpose

Generic engine that applies highlight ranges (search matches, error code decorations) to log message text. Converts the single `textContent` assignment on `row._message` (renderer.js:397) to a controlled `innerHTML` pipeline with mandatory HTML escaping. All user-controlled text is escaped before any markup is inserted.

---

## 2. Highlight Array Format

### 2.1 Data Structure — `HighlightRange`

```javascript
/**
 * @typedef {Object} HighlightRange
 * @property {number} start     — Inclusive start index in the RAW (pre-escape) message string
 * @property {number} end       — Exclusive end index in the RAW message string
 * @property {string} className — CSS class to apply: 'search-hit', 'error-code-known', 'error-code-unknown'
 * @property {Object} [data]    — Optional metadata attached as data-* attributes
 * @property {string} [data.code] — Error code string (for error-code-* classes)
 */
```

### 2.2 Contract

| Rule | Description |
|------|-------------|
| Sorted | Array MUST be sorted by `start` ascending |
| Non-overlapping | After priority resolution (§3), ranges MUST NOT overlap |
| Bounds-safe | `0 <= start < end <= rawText.length` |
| className restricted | Only values from the allowed set (§10) |
| data-* safe | `data.code` contains only `[A-Z0-9_]+` characters (enforced by regex match) |

### 2.3 Example

```javascript
// Message: "Failed: MLV_SPARK_SESSION_ACQUISITION_FAILED in node Refresh"
// Search: "failed"
[
  { start: 0,  end: 6,  className: 'search-hit' },                          // "Failed"
  { start: 8,  end: 47, className: 'error-code-known', data: { code: 'MLV_SPARK_SESSION_ACQUISITION_FAILED' } },
  { start: 51, end: 57, className: 'search-hit' },                          // (would overlap — removed by §3)
]
```

After priority resolution the second `search-hit` at 51–57 is removed because "FAILED" at positions 41–47 is inside the error-code range. The search match for "failed" at 0–6 survives because it does not overlap with any error-code range.

---

## 3. Priority Resolution

**ID:** C03-PRIO-001
**Description:** When a search-match range overlaps with an error-code range, the error-code range wins. The overlapping search-match is either clipped or removed entirely.

### 3.1 Priority Order (highest first)

| Priority | className | Rationale |
|----------|-----------|-----------|
| 1 | `error-code-known` | Carries semantic meaning + interactive popover |
| 2 | `error-code-unknown` | Pattern-matched, still semantically relevant |
| 3 | `search-hit` | Visual convenience only |

### 3.2 Resolution Algorithm

```
function resolveOverlaps(highlights):
    sort highlights by (priority DESC, start ASC)
    occupied = []  // list of [start, end) intervals already claimed

    for each highlight h in priority order:
        clipped = clipToAvailable(h, occupied)
        if clipped is not empty:
            add clipped to result
            add clipped interval to occupied

    sort result by start ASC
    return result
```

**Pseudocode — `clipToAvailable`:**
```
function clipToAvailable(range, occupied):
    for each [os, oe) in occupied:
        if range overlaps [os, oe):
            // Case 1: range fully inside occupied → discard
            if range.start >= os AND range.end <= oe:
                return null
            // Case 2: range straddles left edge → clip start
            if range.start < os AND range.end > os:
                range.end = os
            // Case 3: range straddles right edge → clip end
            if range.start < oe AND range.end > oe:
                range.start = oe
    if range.start >= range.end:
        return null
    return range
```

### 3.3 Edge Cases

| ID | Case | Expected Behavior |
|----|------|-------------------|
| C03-PRIO-E01 | Search match fully inside error code span | Search match discarded |
| C03-PRIO-E02 | Search match partially overlaps error code start | Search match clipped to end before error code start |
| C03-PRIO-E03 | Search match partially overlaps error code end | Search match clipped to start after error code end |
| C03-PRIO-E04 | Two error codes adjacent (no gap) | Both preserved, no conflict |
| C03-PRIO-E05 | Zero-length range after clipping | Discarded (start >= end) |

### 3.4 Source Code Path

- **File:** `renderer.js` — new method `_resolveHighlightOverlaps(highlights)`
- **Called from:** `applyHighlights()` before tag insertion (§5, step 3–4)

### 3.5 Revert Mechanism

Remove the `_resolveHighlightOverlaps` call; pass raw highlights directly. Search hits and error codes will render but may visually overlap (double-highlighted text). No data loss, no crash.

---

## 4. innerHTML Transition

**ID:** C03-HTML-001
**Description:** The single line in `_populateRow` that sets message text changes from `textContent` to `innerHTML`.

### 4.1 Current Code (renderer.js:395–397)

```javascript
// Message (truncated via textContent — no HTML parsing)
const msg = entry.message || '';
row._message.textContent = msg.length > 500 ? msg.substring(0, 500) + '\u2026' : msg;
```

### 4.2 New Code

```javascript
// Message — highlight pipeline (controlled innerHTML with mandatory escaping)
const msg = entry.message || '';
const truncated = msg.length > 500 ? msg.substring(0, 500) + '\u2026' : msg;
const highlights = this._computeHighlights(truncated, entry);
if (highlights.length === 0) {
  row._message.textContent = truncated;  // Fast path: no highlights, stay safe
} else {
  row._message.innerHTML = applyHighlights(row._message, truncated, highlights, this);
}
```

### 4.3 Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| Fast path stays `textContent` | When no search is active and no error codes are present, skip innerHTML entirely. Zero overhead for the common case. |
| Truncation happens on raw text BEFORE escaping | Ensures highlight positions calculated on the same string that gets escaped. Truncation at 500 chars matches current behavior. |
| `applyHighlights` is a pure function | Takes element (for recycling check), raw text, highlights array, renderer context. Returns safe HTML string. No side effects. |

### 4.4 Lines That Change

| Line | Before | After |
|------|--------|-------|
| renderer.js:397 | `row._message.textContent = ...` | `row._message.innerHTML = applyHighlights(...)` or `textContent` (fast path) |

No other `textContent` lines change. Time, level, component remain `textContent`.

### 4.5 Source Code Path

- **File:** `renderer.js` — `_populateRow` method, line 397
- **New methods added to Renderer:** `_computeHighlights(rawText, entry)`, static/module-level `applyHighlights(element, rawText, highlights, renderer)`

### 4.6 Revert Mechanism

Replace the new block with the original single line: `row._message.textContent = truncated;`. All highlighting disappears; log viewer returns to pre-F12 behavior. No data loss.

---

## 5. Escaping Pipeline (6-Step)

**ID:** C03-ESC-001
**Description:** The mandatory 6-step pipeline that converts untrusted log text + highlight ranges into safe innerHTML. This is the security core of C03.

### Step 1 — Get raw log message text

```javascript
const msg = entry.message || '';
const rawText = msg.length > 500 ? msg.substring(0, 500) + '\u2026' : msg;
```

- Source: `entry.message` from RingBuffer (untrusted — may contain any character)
- Truncation preserves current 500-char limit
- Highlight ranges are computed against this truncated string

### Step 2 — HTML-escape ALL text

```javascript
const escaped = renderer.escapeHtml(rawText);
```

Escaping rules (renderer.js:649–652 + F12 addition):

| Character | Entity | Why |
|-----------|--------|-----|
| `&` | `&amp;` | Prevents entity injection |
| `<` | `&lt;` | Prevents tag injection |
| `>` | `&gt;` | Prevents tag closing injection |
| `"` | `&quot;` | Prevents attribute breakout |
| `'` | `&#39;` | **NEW** — prevents attribute breakout in single-quoted contexts |

**F12 enhancement:** Add single-quote escaping to `escapeHtml`:
```javascript
escapeHtml = (text) => {
  if (!text) return '';
  return text.replace(/&/g, '&amp;')
             .replace(/</g, '&lt;')
             .replace(/>/g, '&gt;')
             .replace(/"/g, '&quot;')
             .replace(/'/g, '&#39;');
}
```

**After this step, no user-controlled HTML can execute.** The escaped string is inert text.

### Step 3 — Compute highlight ranges on the raw text

```javascript
const highlights = _computeHighlights(rawText, entry);
// Returns: HighlightRange[] sorted, overlap-resolved
```

Highlight computation runs against the **raw** (pre-escape) text so that character positions correspond to the original message. This is critical because HTML escaping changes string length (`<` becomes `&lt;` — 1 char becomes 4).

**Sources of highlights:**
1. **Error codes** — regex `/\b(MLV_\w+|FLT_\w+|SPARK_\w+)\b/g` on `rawText`. Lookup each match in `state.errorCodesDB` to classify as `error-code-known` or `error-code-unknown`.
2. **Search matches** — case-insensitive `indexOf` loop for `state.searchText` on `rawText`.
3. **Future: regex breakpoint matches** — from LogsEnhancements breakpoint patterns.

Priority resolution (§3) runs after all sources contribute ranges.

### Step 4 — Insert `<mark>` / `<span>` tags at computed positions in the escaped text

```javascript
const html = _insertHighlightTags(escaped, rawText, highlights);
```

**Position mapping:** Because escaping changes string length, we need a mapping from raw-text positions to escaped-text positions.

```
function buildOffsetMap(rawText):
    map = []  // map[rawIdx] = escapedIdx
    escapedIdx = 0
    for rawIdx = 0 to rawText.length - 1:
        map[rawIdx] = escapedIdx
        ch = rawText[rawIdx]
        escapedIdx += escapeLength(ch)
    map[rawText.length] = escapedIdx  // end sentinel
    return map

escapeLength(ch):
    '&' → 5 (&amp;)
    '<' → 4 (&lt;)
    '>' → 4 (&gt;)
    '"' → 6 (&quot;)
    "'" → 5 (&#39;)
    else → 1
```

Then for each highlight `{start, end, className, data}`:
```
escapedStart = offsetMap[start]
escapedEnd   = offsetMap[end]
openTag  = '<mark class="search-hit">'         // or <span class="..." data-code="...">
closeTag = '</mark>'                            // or </span>
```

Tags are inserted at the mapped positions in the escaped string, working right-to-left (so earlier insertions don't shift later positions).

### Step 5 — Set innerHTML

```javascript
row._message.innerHTML = html;
```

**Safe because:** All text content was escaped in Step 2. The only unescaped content is the `<mark>` and `<span>` tags we inserted in Step 4, which contain only hardcoded class names and validated `data-code` values.

### Step 6 — Attach event listeners for interactive highlights

Event listeners are NOT attached per-row. Instead, the existing event delegation on `scrollContainer` (renderer.js:144) handles clicks:

```javascript
// In _onContainerClick (renderer.js:154–182), add before component click check:
if (e.target.classList.contains('error-code-known') ||
    e.target.classList.contains('error-code-unknown')) {
  e.stopPropagation();
  const code = e.target.dataset.code;
  if (code && window.edogViewer && window.edogViewer.errorDecoder) {
    window.edogViewer.errorDecoder.showContextCard(e.target, code);
  }
  return;
}
```

This fits the existing delegation pattern (single click handler for entire container). No per-row listener allocation.

### 5.1 Edge Cases

| ID | Case | Behavior |
|----|------|----------|
| C03-ESC-E01 | Message is empty string | `escapeHtml('')` returns `''`. No highlights. Fast path (`textContent = ''`). |
| C03-ESC-E02 | Message is `null` / `undefined` | Coerced to `''` by `entry.message \|\| ''`. Same as E01. |
| C03-ESC-E03 | Message contains only HTML entities (`&lt;&gt;&amp;`) | Escaped to `&amp;lt;&amp;gt;&amp;amp;`. Displayed as literal `&lt;&gt;&amp;`. |
| C03-ESC-E04 | Message is exactly 500 chars | No truncation, no ellipsis. Normal highlight pipeline. |
| C03-ESC-E05 | Message is 501+ chars | Truncated to 500 + `\u2026`. Highlights beyond position 500 are discarded. |
| C03-ESC-E06 | Error code straddles truncation boundary | Regex won't match a partial code (word boundary `\b` requires full match). No highlight for partial code. |

### 5.2 Source Code Path

- **File:** `renderer.js` — new methods: `_computeHighlights`, `_insertHighlightTags`, `_buildOffsetMap`
- **File:** `renderer.js` — modified: `_populateRow` (line 397), `_onContainerClick` (after line 169), `escapeHtml` (add `'` escaping)

### 5.3 Revert Mechanism

Revert `_populateRow` line 397 to `row._message.textContent = truncated;`. Remove the three new methods. Remove the click delegation addition. The `escapeHtml` single-quote addition is safe to keep (backward compatible).

---

## 6. XSS Prevention — Attack Vector Analysis

**ID:** C03-XSS-001
**Description:** Exhaustive catalog of XSS attack vectors and how the pipeline blocks each.

### 6.1 Vector: Malicious script tag in log message

```
Input:   <script>alert('xss')</script>
Step 2:  &lt;script&gt;alert(&#39;xss&#39;)&lt;/script&gt;
Step 4:  No highlight ranges match (no error code, no search term)
Step 5:  innerHTML = "&lt;script&gt;alert(&#39;xss&#39;)&lt;/script&gt;"
Result:  SAFE — rendered as literal text "<script>alert('xss')</script>"
```

### 6.2 Vector: Error code lookalike with embedded HTML

```
Input:   MLV_<img src=x onerror=alert(1)>_EXPLOIT
Step 2:  MLV_&lt;img src=x onerror=alert(1)&gt;_EXPLOIT
Step 3:  Regex /\b(MLV_\w+)\b/ — \w stops at & (not a word char)
         No match found (MLV_ alone has no word chars after underscore before &)
Step 5:  innerHTML = "MLV_&lt;img src=x onerror=alert(1)&gt;_EXPLOIT"
Result:  SAFE — no tag injection, no code decoration
```

### 6.3 Vector: Attribute breakout via error code

```
Input:   MLV_FOO" onclick="alert(1)
Step 2:  MLV_FOO&quot; onclick=&quot;alert(1)
Step 3:  Regex matches "MLV_FOO" (stops at & which is not \w)
Step 4:  <span class="error-code-known" data-code="MLV_FOO">MLV_FOO</span>
         The &quot; is OUTSIDE the matched code — it's in the surrounding escaped text
Result:  SAFE — data-code contains only the regex-matched [A-Z0-9_]+ value
```

### 6.4 Vector: Search term containing HTML

```
Input:   User searches for: <img src=x onerror=alert(1)>
Step 3:  Search term is HTML-escaped before matching:
         htmlSearchText = "&lt;img src=x onerror=alert(1)&gt;"
         This is then regex-escaped for safe use in RegExp constructor
Step 4:  Match runs against escaped HTML — finds "&lt;img..." if present
         Wraps in <mark class="search-hit">&lt;img src=x onerror=alert(1)&gt;</mark>
Result:  SAFE — search term is escaped, only <mark> tag added
```

### 6.5 Vector: Search term that is a regex attack (ReDoS)

```
Input:   User searches for: aaaaaaa(a+)+$
Defense: Search term is treated as literal text, NOT as regex.
         Special regex chars are escaped: /[.*+?^${}()|[\]\\]/g → '\\$&'
         The string becomes a safe literal pattern in RegExp.
Result:  SAFE — no catastrophic backtracking possible
```

### 6.6 Vector: Unicode homograph in error code

```
Input:   MLV_ᏚPARK (Ꮪ = Cherokee letter, looks like S)
Step 3:  Regex /\b(MLV_\w+)\b/ — \w includes Unicode word chars in JS
         May match "MLV_Ꮪpark" — but the code won't be in errorCodesDB
Step 4:  Classified as error-code-unknown (dashed underline)
         data-code="MLV_Ꮪpark" — Cherokee letter is not an HTML metachar
Result:  SAFE — visual mismatch is cosmetic only, no security impact
```

### 6.7 Vector: Entity smuggling (`&amp;lt;`)

```
Input:   Log contains literal text: &lt;script&gt;
Step 2:  escapeHtml("&lt;script&gt;") → "&amp;lt;script&amp;gt;"
Step 5:  Displays as literal "&lt;script&gt;" — double-escaped is ugly but safe
Result:  SAFE — worst case is visual artifact, never execution
```

### 6.8 Vector: Null bytes / control characters

```
Input:   MLV_FOO\x00<script>alert(1)</script>
Step 2:  escapeHtml does not strip null bytes, but < and > are still escaped
         "MLV_FOO\x00&lt;script&gt;alert(1)&lt;/script&gt;"
Step 3:  Regex stops at \x00 (not \w) — matches "MLV_FOO" cleanly
Result:  SAFE — null byte is benign in innerHTML context
```

### 6.9 Invariant Summary

**The security model rests on a single invariant:**

> All user-controlled text is HTML-escaped (Step 2) BEFORE any tag insertion (Step 4). Tag insertion only adds hardcoded strings with validated attribute values. The order is NEVER reversed.

If this invariant holds, innerHTML is safe. If it is violated (e.g., a future developer inserts tags before escaping), XSS is possible. The code MUST include a comment block documenting this invariant at the top of `applyHighlights`.

---

## 7. Performance Analysis

**ID:** C03-PERF-001
**Description:** innerHTML vs textContent performance at virtual scroll scale.

### 7.1 Benchmark Parameters

| Parameter | Value | Source |
|-----------|-------|--------|
| Visible rows per render | ~80 | `MAX_VISIBLE = 80` (renderer.js:94) |
| Render throttle | 100ms | `renderThrottleMs = 100` (renderer.js:97) |
| Frame budget | 16.6ms | 60fps target |
| Message max length | 500 chars | Truncation (renderer.js:397) |
| Ring buffer capacity | 10,000–50,000 | Virtual scroll — only ~80 in DOM |

### 7.2 Cost Comparison

| Operation | Cost per row | Cost for 80 rows | % of frame budget |
|-----------|-------------|-------------------|-------------------|
| `textContent` assignment (current) | ~0.01ms | ~0.8ms | 4.8% |
| `innerHTML` with 0 highlights (fast path) | ~0.01ms | ~0.8ms | 4.8% |
| `innerHTML` with 1–3 `<span>` tags | ~0.05–0.1ms | ~4–8ms | 24–48% |
| Highlight computation (regex + resolution) | ~0.02ms | ~1.6ms | 9.6% |
| **Total with highlights** | **~0.07–0.12ms** | **~5.6–9.6ms** | **34–58%** |

Source: P0 §4.7 — measured <8ms for 80 rows with simple tag insertion.

### 7.3 Mitigation: Fast-Path Skip

```javascript
// In _populateRow, BEFORE computing highlights:
if (!this.state.searchText && !this._hasErrorCodeCache(entry)) {
  row._message.textContent = truncated;
  return; // Fast path — no innerHTML overhead
}
```

When no search is active and the entry has no error codes, we skip the entire pipeline. This is the common case during normal log streaming.

### 7.4 Mitigation: Seq-Based Cache

```javascript
// Skip re-highlight if row already shows this entry's highlights
if (row._seq === seq && row._highlightVersion === this._highlightVersion) {
  return; // Row is already correctly highlighted for this entry
}
```

`_highlightVersion` increments when `state.searchText` changes or error codes DB updates. This prevents recomputing highlights for rows that just shift position during scroll.

### 7.5 Mitigation: Pre-Computed Error Code Positions

When a log entry is first added to the ring buffer, run the error code regex once and cache matched positions:

```javascript
// In state.addLog or at first access:
entry._errorCodeRanges = null; // lazy — computed on first _populateRow
```

First `_populateRow` call computes and caches. Subsequent renders reuse cached ranges. Only search highlights are recomputed (they change with `state.searchText`).

### 7.6 Worst Case: Full Rerender

When filters change, `rerenderAllLogs()` releases all rows and re-renders ~80 visible rows. All highlights are recomputed. Expected time: ~10ms for highlight computation + ~8ms for innerHTML = ~18ms. Exceeds single frame budget but:
- Occurs only on user-initiated filter change (not continuous)
- Throttled at 100ms — user won't notice a single 18ms frame
- No perceived jank

### 7.7 Edge Case: Very Long Messages (>10K chars)

Messages are truncated to 500 chars BEFORE the pipeline runs. The 500-char limit is the performance guardrail. Without it, regex on 10K+ strings could take >1ms per row.

**If truncation limit is ever raised:** Regex cost scales linearly. At 2000 chars: ~0.08ms per row. At 10K chars: ~0.4ms per row (32ms for 80 rows — exceeds budget). Recommendation: never raise above 2000 without profiling.

---

## 8. Highlight Sources

**ID:** C03-SRC-001
**Description:** All current and planned sources that produce HighlightRange arrays.

### 8.1 Search Text (`state.searchText`)

| Property | Value |
|----------|-------|
| Source | `FilterManager.setSearch()` → `state.searchText` |
| Matching | Case-insensitive literal substring match |
| className | `search-hit` |
| data | None |
| Multiple matches | Yes — all non-overlapping occurrences in truncated message |
| Priority | 3 (lowest) |

**Implementation:**
```javascript
function computeSearchHighlights(rawText, searchText) {
  if (!searchText) return [];
  const ranges = [];
  const lower = rawText.toLowerCase();
  const searchLower = searchText.toLowerCase();
  let pos = 0;
  while ((pos = lower.indexOf(searchLower, pos)) !== -1) {
    ranges.push({ start: pos, end: pos + searchText.length, className: 'search-hit' });
    pos += searchText.length; // non-overlapping
  }
  return ranges;
}
```

### 8.2 Error Codes (from ErrorDecoder — C02)

| Property | Value |
|----------|-------|
| Source | Regex `/\b(MLV_\w+\|FLT_\w+\|SPARK_\w+)\b/g` on raw message |
| Matching | Global regex with word boundaries |
| className | `error-code-known` if code exists in `state.errorCodesDB`, else `error-code-unknown` |
| data | `{ code: 'MLV_...' }` |
| Multiple matches | Yes — a message can contain multiple error codes |
| Priority | 1 (known) or 2 (unknown) — both higher than search |

**Implementation:**
```javascript
function computeErrorCodeHighlights(rawText, errorCodesDB) {
  const ranges = [];
  const regex = /\b(MLV_\w+|FLT_\w+|SPARK_\w+)\b/g;
  let match;
  while ((match = regex.exec(rawText)) !== null) {
    const code = match[1];
    const isKnown = errorCodesDB && errorCodesDB[code];
    ranges.push({
      start: match.index,
      end: match.index + code.length,
      className: isKnown ? 'error-code-known' : 'error-code-unknown',
      data: { code }
    });
  }
  return ranges;
}
```

### 8.3 Future: Regex Breakpoint Matches

| Property | Value |
|----------|-------|
| Source | `LogsEnhancements._breakpoints` patterns |
| className | TBD — `breakpoint-hit` or similar |
| Priority | Between error codes and search (priority 2.5) |
| Status | NOT in F12 scope — architecture supports it |

The highlight array format is extensible. Any future feature that needs to mark substrings in log messages can produce `HighlightRange` objects and feed them into the same pipeline.

---

## 9. API Design — `applyHighlights`

**ID:** C03-API-001
**Description:** The public-facing function that converts raw text + highlight ranges into safe HTML.

### 9.1 Signature

```javascript
/**
 * Converts raw log text and highlight ranges into safe innerHTML.
 *
 * SECURITY INVARIANT: rawText is HTML-escaped FIRST. Only hardcoded
 * <mark> and <span> tags are inserted. User content NEVER bypasses escaping.
 *
 * @param {HTMLElement} element — The row._message element (for cache checks)
 * @param {string} rawText — The truncated, unescaped message string
 * @param {HighlightRange[]} highlights — Sorted, overlap-resolved ranges
 * @param {Renderer} renderer — Renderer instance (for escapeHtml access)
 * @returns {string} Safe HTML string ready for innerHTML assignment
 */
function applyHighlights(element, rawText, highlights, renderer) {
  // 1. Escape ALL text
  const escaped = renderer.escapeHtml(rawText);

  // 2. If no highlights, return escaped text directly
  if (!highlights || highlights.length === 0) return escaped;

  // 3. Build raw→escaped offset map
  const offsetMap = buildOffsetMap(rawText);

  // 4. Insert tags at mapped positions (right-to-left)
  let html = escaped;
  for (let i = highlights.length - 1; i >= 0; i--) {
    const h = highlights[i];
    const eStart = offsetMap[h.start];
    const eEnd = offsetMap[h.end];
    const openTag = buildOpenTag(h);
    const closeTag = h.className === 'search-hit' ? '</mark>' : '</span>';
    html = html.substring(0, eStart) + openTag + html.substring(eStart, eEnd) + closeTag + html.substring(eEnd);
  }

  return html;
}
```

### 9.2 Helper — `buildOpenTag`

```javascript
function buildOpenTag(highlight) {
  if (highlight.className === 'search-hit') {
    return '<mark class="search-hit">';
  }
  let tag = '<span class="' + highlight.className + '"';
  if (highlight.data && highlight.data.code) {
    // data.code is guaranteed [A-Z0-9_]+ by regex match — safe for attribute
    tag += ' data-code="' + highlight.data.code + '"';
  }
  tag += '>';
  return tag;
}
```

### 9.3 Helper — `buildOffsetMap`

```javascript
function buildOffsetMap(rawText) {
  const map = new Array(rawText.length + 1);
  let escapedIdx = 0;
  for (let i = 0; i < rawText.length; i++) {
    map[i] = escapedIdx;
    const ch = rawText.charCodeAt(i);
    if (ch === 38) escapedIdx += 5;       // & → &amp;
    else if (ch === 60) escapedIdx += 4;  // < → &lt;
    else if (ch === 62) escapedIdx += 4;  // > → &gt;
    else if (ch === 34) escapedIdx += 6;  // " → &quot;
    else if (ch === 39) escapedIdx += 5;  // ' → &#39;
    else escapedIdx += 1;
  }
  map[rawText.length] = escapedIdx;
  return map;
}
```

### 9.4 Purity

`applyHighlights` is a **pure function**: same inputs always produce the same output. No DOM mutations, no state reads (except through passed `renderer`), no side effects. This makes it testable in isolation without a DOM.

### 9.5 Interactions

| Component | Interaction |
|-----------|-------------|
| C02 (Error Decoder) | Provides error code ranges via `computeErrorCodeHighlights` |
| `state.searchText` | Provides search text for `computeSearchHighlights` |
| `_populateRow` | Calls `_computeHighlights` which merges sources, resolves overlaps, then calls `applyHighlights` |
| `LogsEnhancements._injectGutterColumn` | Wraps `_populateRow` — highlight runs INSIDE the base population, before gutter wrapping adds its decorations. No conflict. |
| `detail-panel.js` | Can reuse `applyHighlights` for the detail panel message (without truncation limit). |

---

## 10. CSS Classes

**ID:** C03-CSS-001
**Description:** CSS classes applied by highlight tags and their visual treatment.

### 10.1 Class Definitions

#### `.search-hit`

```css
.search-hit {
  background: var(--highlight-search, rgba(255, 213, 79, 0.35));
  border-radius: 2px;
  padding: 0 1px;
  /* No text-decoration — yellow background is sufficient */
}
```

- **Tag:** `<mark class="search-hit">`
- **Semantic:** HTML `<mark>` is the correct element for search result highlighting
- **Visual:** Yellow semi-transparent background, matching industry standard (Datadog, Loki, Seq, Chrome DevTools)
- **Dark theme:** `--highlight-search` token switches to a deeper amber in dark mode

#### `.error-code-known`

```css
.error-code-known {
  text-decoration: underline solid var(--accent, #6d5cff);
  text-underline-offset: 2px;
  text-decoration-thickness: 2px;
  cursor: pointer;
  border-radius: 2px;
  transition: background 0.15s ease;
}

.error-code-known:hover {
  background: var(--accent-dim, rgba(109, 92, 255, 0.07));
}
```

- **Tag:** `<span class="error-code-known" data-code="MLV_...">`
- **Visual:** Solid accent-colored underline. Hover reveals subtle accent background.
- **Interactive:** Click opens error context card (C02) via event delegation

#### `.error-code-unknown`

```css
.error-code-unknown {
  text-decoration: underline dashed var(--level-error, #e5453b);
  text-underline-offset: 2px;
  text-decoration-thickness: 1px;
  cursor: help;
  border-radius: 2px;
  transition: background 0.15s ease;
}

.error-code-unknown:hover {
  background: var(--row-error-tint, rgba(229, 69, 59, 0.04));
}
```

- **Tag:** `<span class="error-code-unknown" data-code="MLV_...">`
- **Visual:** Dashed error-colored underline (thinner than known). `cursor: help` indicates informational.
- **Interactive:** Click still opens context card (C02) but with "Unknown code" state
- **Note:** Extends the pre-existing `.error-code-hint` pattern (logs.css:271–276) with F12's three-layer approach

### 10.2 Design Token Requirements

These tokens MUST be added to `variables.css`:

```css
:root {
  --highlight-search: rgba(255, 213, 79, 0.35);
  --highlight-error: rgba(229, 69, 59, 0.15);
}

@media (prefers-color-scheme: dark) {
  :root {
    --highlight-search: rgba(255, 183, 77, 0.25);
    --highlight-error: rgba(255, 107, 107, 0.12);
  }
}
```

Tokens `--accent`, `--accent-dim`, `--level-error`, `--row-error-tint` already exist in `variables.css`.

### 10.3 Interaction with Existing CSS

| Existing Class | Conflict? | Resolution |
|----------------|-----------|------------|
| `.error-code-hint` (logs.css:271) | Yes — superseded by `.error-code-unknown` | F12 replaces `.error-code-hint` usage. Keep class for backward compat. |
| `.log-message` (logs.css:182) | No | `overflow: hidden; text-overflow: ellipsis` still works with inline `<mark>`/`<span>` children |
| `.error-row` (logs.css:67) | No | Row-level tint coexists with inline highlights |

---

## 11. DOM Recycling Compatibility

**ID:** C03-RECYCLE-001
**Description:** Highlights must be reapplied when the RowPool recycles a row for a different log entry.

### 11.1 Problem

The RowPool recycles DOM elements. When a row scrolls out of the viewport, it's released to the pool. When a new row is needed, an existing element is acquired and repopulated via `_populateRow`. The new entry's highlights must overwrite the previous entry's highlights.

### 11.2 Mechanism

`_populateRow` already handles recycling correctly because it fully replaces the message content on every call:
- **Current:** `row._message.textContent = truncated;` — replaces all text
- **F12:** `row._message.innerHTML = html;` — replaces all HTML

Both are full replacements. No stale highlights can survive a `_populateRow` call.

### 11.3 Cache Invalidation

The seq-based cache (§7.4) uses `row._seq` to detect same-entry repopulation:

```javascript
if (row._seq === seq && row._highlightVersion === this._highlightVersion) {
  // Same entry, same highlight state — skip repopulation
  row.style.transform = 'translateY(' + (i * this.ROW_HEIGHT) + 'px)';
  continue; // in _renderVirtualScroll
}
```

This check already exists in `_renderVirtualScroll` (renderer.js:330–333). F12 adds the `_highlightVersion` check to also invalidate when search text changes.

### 11.4 When `_highlightVersion` Increments

| Event | Increments? | Why |
|-------|-------------|-----|
| `state.searchText` changes | Yes | All visible rows need search highlights recomputed |
| `state.errorCodesDB` loads | Yes | Error code known/unknown classification may change |
| New log entry added | No | Only affects new rows, not existing visible rows |
| Filter change | No | `rerenderAllLogs()` already releases all rows and re-renders |

### 11.5 `releaseAll()` Cleanup

When `rowPool.releaseAll()` is called (on filter change), all rows are released. No special highlight cleanup needed — `_populateRow` will fully repopulate when rows are reacquired.

### 11.6 Source Code Path

- **File:** `renderer.js` — `_renderVirtualScroll` (line 330 condition), new `this._highlightVersion` property in constructor

### 11.7 Revert Mechanism

Remove `_highlightVersion` checks. Cache optimization disappears; every scroll triggers full repopulation. Functionally correct, just slower.

---

## 12. Edge Cases — Comprehensive

### 12.1 Empty Text

**ID:** C03-EDGE-001

| Scenario | Input | Expected |
|----------|-------|----------|
| `entry.message` is `''` | rawText = `''` | `textContent = ''` (fast path). No highlights. |
| `entry.message` is `null` | rawText = `''` (coerced) | Same as empty string. |
| `entry.message` is `undefined` | rawText = `''` (coerced) | Same as empty string. |
| `entry.message` is whitespace only | rawText = `'   '` | Escaped (no-op for spaces). Search may match. No error codes. |

### 12.2 Very Long Messages (>10K chars)

**ID:** C03-EDGE-002

| Scenario | Input | Expected |
|----------|-------|----------|
| 10K char message | Truncated to 500 + `\u2026` | Highlight pipeline runs on 501-char string. Performant. |
| Error code at position 498–536 | Code straddles truncation | Truncated text has partial code `MLV_SPARK_SES...`. Regex `\b...\b` won't match (no word boundary at `\u2026`). No highlight. |
| 500 char message that is ALL one error code | `MLV_` + 496 chars of `A` | Regex matches full code. Single highlight span covers entire message. Works. |

### 12.3 Overlapping Highlights

**ID:** C03-EDGE-003

| Scenario | Input | Expected |
|----------|-------|----------|
| Search "MLV" inside error code `MLV_SPARK_...` | Two ranges overlap | Priority resolution: error code wins. "MLV" search hit discarded. |
| Two error codes with no gap | `MLV_AMLV_B` | Regex matches `MLV_AMLV_B` as single code (no boundary between). One highlight, not two. |
| Two error codes separated by space | `MLV_A MLV_B` | Two separate highlight ranges. No overlap. Both rendered. |
| Search matches inside `<mark>` tag text from prior highlight | N/A — tags inserted at Step 4 | Cannot happen. Highlights are computed on raw text (Step 3), not on HTML with tags. |

### 12.4 Highlights at String Boundaries

**ID:** C03-EDGE-004

| Scenario | Input | Expected |
|----------|-------|----------|
| Error code at position 0 | `MLV_FOO rest of message` | Highlight starts at 0. `offsetMap[0] = 0`. Tag inserted at start. |
| Error code at end of string | `message MLV_FOO` | Highlight ends at `rawText.length`. `offsetMap[rawText.length]` is end sentinel. Works. |
| Error code IS the entire string | `MLV_FOO` | Single highlight covers entire message. `<span class="error-code-known" data-code="MLV_FOO">MLV_FOO</span>` |
| Search match at position 0, length 1 | Search `"F"`, message `"Foo"` | `<mark class="search-hit">F</mark>oo` |

### 12.5 Unicode Text

**ID:** C03-EDGE-005

| Scenario | Input | Expected |
|----------|-------|----------|
| CJK characters in message | `"エラー MLV_FOO 失敗"` | CJK chars are single code points (BMP). `escapeHtml` passes them through. Offset map: 1 char = 1 position. Highlight positions correct. |
| Emoji (surrogate pairs) | `"⚠️ MLV_FOO"` | JS string indices count UTF-16 code units. Surrogate pair = 2 indices. Offset map works on code-unit indices (same as `substring`). Correct. |
| Combining characters | `"e\u0301rror MLV_FOO"` | `é` is 2 code units (`e` + combining accent). `substring` and regex both work on code units. Positions consistent. |
| Right-to-left text | `"خطأ MLV_FOO"` | Arabic chars are BMP. Direction is a rendering concern, not a string-position concern. Highlights apply correctly. |

### 12.6 HTML Entities in Log Messages

**ID:** C03-EDGE-006

| Scenario | Input | Expected |
|----------|-------|----------|
| Log contains `&amp;` literally | rawText = `"foo &amp; bar"` | After escapeHtml: `"foo &amp;amp; bar"`. Displays as `"foo &amp; bar"`. Double-escaped — ugly but safe. |
| Log contains `<` literally | rawText = `"a < b"` | After escapeHtml: `"a &lt; b"`. Displays as `"a < b"`. Correct. |
| Log contains `&lt;` literally (pre-escaped) | rawText = `"a &lt; b"` | After escapeHtml: `"a &amp;lt; b"`. Displays as `"a &lt; b"`. Not ideal but safe. |
| Log contains `&#x3C;` numeric entity | rawText = `"&#x3C;script&#x3E;"` | After escapeHtml: `"&amp;#x3C;script&amp;#x3E;"`. Displays as `"&#x3C;script&#x3E;"`. Safe. |

---

## 13. Interaction with Other Components

### 13.1 C02 — Error Decoder Runtime

| Direction | What |
|-----------|------|
| C02 → C03 | C02 provides `computeErrorCodeHighlights(rawText, errorCodesDB)` |
| C03 → C02 | On error code click (event delegation), C03 calls `errorDecoder.showContextCard(element, code)` |
| Coupling | Loose — C03 only needs the highlight ranges array and the CSS class names. C02 handles all popover/card logic independently. |

### 13.2 C05 — Log Stream Controller

| Direction | What |
|-----------|------|
| C05 → C03 | When stream resumes from PAUSED, new rows are rendered. `_populateRow` runs the highlight pipeline on each. No special interaction needed. |
| C03 → C05 | None |

### 13.3 LogsEnhancements — Gutter Injection

| Direction | What |
|-----------|------|
| LE wraps `_populateRow` | LogsEnhancements._injectGutterColumn wraps `_populateRow` to add gutter, bookmark star, breakpoint marker AFTER base population. |
| C03 modifies `_populateRow` internals | The innerHTML change is INSIDE `_populateRow`, not a wrapper. The gutter injection wrapper calls `origPopulate(row, entry, seq, filteredIdx)` first (which now sets innerHTML), then adds gutter elements. No conflict — gutter elements are siblings of `row._message`, not children. |

### 13.4 Detail Panel

| Direction | What |
|-----------|------|
| detail-panel.js reuses C03 | The detail panel message (`detail-panel.js:68`) can call `applyHighlights(element, fullMessage, highlights, renderer)` with the FULL (non-truncated) message. The same pipeline applies. |

### 13.5 Search (FilterManager)

| Direction | What |
|-----------|------|
| FilterManager → state.searchText → C03 | When `setSearch()` updates `state.searchText`, `applyFilters()` triggers `rerenderAllLogs()`, which re-runs `_populateRow` on all visible rows. The highlight pipeline picks up the new search text automatically. |
| `_highlightVersion` increment | When `state.searchText` changes, `_highlightVersion` increments to invalidate cached highlight HTML on visible rows. |

---

## 14. Allowed HTML Whitelist

Tags that the highlight engine is permitted to insert into innerHTML:

| Tag | Allowed Attributes | Purpose |
|-----|-------------------|---------|
| `<mark>` | `class="search-hit"` | Search match highlighting |
| `<span>` | `class="error-code-known"`, `data-code="[A-Z0-9_]+"` | Known error code decoration |
| `<span>` | `class="error-code-unknown"`, `data-code="[A-Z0-9_]+"` | Unknown error code decoration |

**Explicitly prohibited in highlight engine output:**

| Forbidden | Why |
|-----------|-----|
| `<a>` | Links go in popover cards, not inline |
| `<img>`, `<iframe>`, `<object>` | Media embedding = XSS vector |
| `<script>`, `<style>` | Code execution / style injection |
| `onclick`, `onerror`, any `on*` | Event handlers must use delegation |
| `style="..."` | Inline styles bypass design system |
| `href`, `src`, `action` | URL attributes = XSS vector |

---

## 15. `_computeHighlights` — Merging All Sources

**ID:** C03-MERGE-001
**Description:** Internal method that collects highlights from all sources and produces the final resolved array.

```javascript
_computeHighlights(rawText, entry) {
  const highlights = [];

  // Source 1: Error codes (priority 1–2)
  if (this.state.errorCodesDB !== undefined) {
    const errorRanges = computeErrorCodeHighlights(rawText, this.state.errorCodesDB);
    highlights.push(...errorRanges);
  }

  // Source 2: Search matches (priority 3)
  if (this.state.searchText) {
    const searchRanges = computeSearchHighlights(rawText, this.state.searchText);
    highlights.push(...searchRanges);
  }

  // Future: Source 3 — regex breakpoint matches
  // Future: Source 4 — anomaly-detected patterns

  // Resolve overlaps (error codes win over search)
  return this._resolveHighlightOverlaps(highlights);
}
```

---

## 16. Testing Strategy

### 16.1 Unit Tests (Pure Functions)

| Test | Input | Expected Output |
|------|-------|-----------------|
| `escapeHtml` — all 5 entities | `'&<>"\'` | `'&amp;&lt;&gt;&quot;&#39;'` |
| `buildOffsetMap` — plain text | `'hello'` | `[0,1,2,3,4,5]` |
| `buildOffsetMap` — with entities | `'a<b'` | `[0,1,5,6]` (< expands to 4 chars) |
| `applyHighlights` — no highlights | `'hello', []` | `'hello'` |
| `applyHighlights` — single search hit | `'foo bar', [{start:4,end:7,className:'search-hit'}]` | `'foo <mark class="search-hit">bar</mark>'` |
| `applyHighlights` — error code | `'MLV_FOO', [{start:0,end:7,className:'error-code-known',data:{code:'MLV_FOO'}}]` | `'<span class="error-code-known" data-code="MLV_FOO">MLV_FOO</span>'` |
| `applyHighlights` — entity in text | `'a<b', [{start:0,end:3,className:'search-hit'}]` | `'<mark class="search-hit">a&lt;b</mark>'` |
| `resolveOverlaps` — search inside error | `[{start:0,end:10,className:'error-code-known'},{start:2,end:5,className:'search-hit'}]` | `[{start:0,end:10,className:'error-code-known'}]` — search discarded |
| `resolveOverlaps` — no overlap | Two non-overlapping ranges | Both preserved |
| `computeSearchHighlights` — multiple matches | `'foo foo foo', 'foo'` | 3 ranges: [0,3], [4,7], [8,11] |
| `computeErrorCodeHighlights` — known code | `'err MLV_FOO ok', {MLV_FOO:{...}}` | `[{start:4,end:11,className:'error-code-known',data:{code:'MLV_FOO'}}]` |
| `computeErrorCodeHighlights` — unknown code | `'err MLV_BAR ok', {}` | `[{start:4,end:11,className:'error-code-unknown',data:{code:'MLV_BAR'}}]` |

### 16.2 Security Tests

| Test | Input | Must NOT Contain in Output |
|------|-------|-----------------------------|
| Script tag in message | `'<script>alert(1)</script>'` | `<script>` (must be `&lt;script&gt;`) |
| Event handler in message | `'<img onerror=alert(1)>'` | `onerror` as attribute |
| HTML in search term | Search for `'<b>'` | `<b>` as a tag (must be `&lt;b&gt;`) |
| Quote breakout in code | `'MLV_FOO" onclick="alert(1)'` | `onclick` as attribute |

### 16.3 Integration Tests

| Test | What | Verify |
|------|------|--------|
| Row recycle | Populate row with error code, release, repopulate with plain message | No stale `<span>` tags remain |
| Search + error code coexist | Message with error code, search active | Both highlight types visible, error code not split by search mark |
| Filter change | Change search text while rows visible | All visible rows update to new highlights |
| Fast path | No search active, no error codes in message | `textContent` used (verify via `row._message.childNodes.length === 1` and node is TextNode) |

---

## 17. Pre-Existing Fix: `error-intel.js` XSS

**ID:** C03-FIX-001
**Priority:** P0 — fix during F12 implementation
**Description:** `error-intel.js:38` (`showAlert`) uses unescaped `summary` in `innerHTML`. The `summary` variable contains error codes and node names from log messages, which are user-controlled.

**Current (vulnerable):**
```javascript
this.alertElement.innerHTML = `
  <span class="error-icon">\u2715</span>
  <span class="error-summary">${summary}</span>
  ...
`;
```

**Fix:**
```javascript
this.alertElement.innerHTML = `
  <span class="error-icon">\u2715</span>
  <span class="error-summary">${this.escapeHtml(summary)}</span>
  ...
`;
```

Where `this.escapeHtml` is imported from Renderer or duplicated as a static utility.

---

## 18. Implementation Checklist

| # | Task | File | Lines | Priority |
|---|------|------|-------|----------|
| 1 | Add `'` escaping to `escapeHtml` | renderer.js | 649–652 | P0 |
| 2 | Add `buildOffsetMap` function | renderer.js | new | P1 |
| 3 | Add `applyHighlights` function | renderer.js | new | P1 |
| 4 | Add `computeSearchHighlights` function | renderer.js | new | P1 |
| 5 | Add `computeErrorCodeHighlights` function | renderer.js | new | P1 |
| 6 | Add `_resolveHighlightOverlaps` method | renderer.js | new | P1 |
| 7 | Add `_computeHighlights` method | renderer.js | new | P1 |
| 8 | Modify `_populateRow` — innerHTML transition | renderer.js | 395–397 | P1 |
| 9 | Add error code click delegation | renderer.js | 169 | P1 |
| 10 | Add `_highlightVersion` to constructor | renderer.js | 90–121 | P1 |
| 11 | Add CSS classes to `logs.css` | logs.css | append | P1 |
| 12 | Add design tokens to `variables.css` | variables.css | append | P1 |
| 13 | Fix `error-intel.js` XSS | error-intel.js | 38 | P0 |
| 14 | Unit tests for pure functions | tests/ | new | P1 |
| 15 | Security tests with malicious input | tests/ | new | P1 |

---

*This component spec is the canonical reference for all Highlight Engine implementation work. The security invariant in §5 is non-negotiable: all text escaping happens BEFORE any tag insertion. Violating this order creates XSS vulnerabilities.*
