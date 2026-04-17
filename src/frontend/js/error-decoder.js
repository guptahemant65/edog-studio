/**
 * ErrorDecoder — L1 Error Intelligence: error code detection, lookup, and occurrence tracking.
 *
 * Responsibilities:
 *   - Detect error codes in log message text via 3-layer cascade
 *   - Look up codes in the curated error-codes database
 *   - Track per-code occurrence counts (accurate with ring buffer eviction)
 *   - Provide structured card content for popover rendering (no DOM)
 *
 * Consumed by:
 *   - Renderer._populateRow (L2) for highlight ranges
 *   - ErrorIntelligence (L5) for clustering
 *   - C03 Highlight Engine for decorateMessage
 *
 * Data source: window.ERROR_CODES_DB (set by L0 error-codes-data.js)
 */
class ErrorDecoder {
  /**
   * @param {Object} codesDb — the error codes database object (window.ERROR_CODES_DB)
   */
  constructor(codesDb) {
    // Database: indexed for O(1) lookup
    this._db = {};
    this._codeSet = new Set();

    // Pre-compiled regex for error code detection (reused every call).
    // Matches: MLV_, FLT_, SPARK_, GTS_ prefixed codes plus generic ERROR_/ERR_ patterns.
    // Word boundaries prevent false positives inside longer identifiers.
    this._codePattern = /\b(MLV_[A-Z][A-Z0-9_]*|FLT_[A-Z][A-Z0-9_]*|SPARK_[A-Z][A-Z0-9_]*|GTS_[A-Z][A-Z0-9_]*|ERROR_[A-Z][A-Z0-9_]*|ERR_[A-Z][A-Z0-9_]*)\b/g;

    // Occurrence tracking: code → { count, firstSeen, lastSeen }
    this._occurrences = new Map();

    // Per-sequence code counts for precise eviction
    this._seqCodeCounts = new Map();

    this._init(codesDb);
  }

  // --- Initialization ---

  _init(codesDb) {
    if (codesDb && typeof codesDb === 'object' && !Array.isArray(codesDb)) {
      this._db = codesDb;
      this._codeSet = new Set(Object.keys(codesDb));
    } else if (codesDb !== undefined && codesDb !== null) {
      console.warn('ErrorDecoder: codesDb is not a valid object, running in degraded mode');
    }
  }

  // --- Public API ---

  /**
   * Scan text for error codes using the 3-layer detection cascade.
   *
   * Layer 1 (known): code exists in codesDb → full card data available
   * Layer 2 (unknown): matches regex pattern but NOT in codesDb → reduced card
   * Layer 3 (pass-through): no regex match → no decoration
   *
   * @param {string} text — raw log message text (pre-escape)
   * @returns {Array<{code: string, start: number, end: number, known: boolean, data: Object|null}>}
   *   Sorted ascending by start. Non-overlapping. Bounds-safe.
   */
  matchErrorCodes(text) {
    if (!text || typeof text !== 'string') return [];

    const results = [];
    this._codePattern.lastIndex = 0;

    let match;
    while ((match = this._codePattern.exec(text)) !== null) {
      const code = match[1];
      const isKnown = this._codeSet.has(code);
      results.push({
        code,
        start: match.index,
        end: match.index + match[0].length,
        known: isKnown,
        data: isKnown ? this._db[code] : null
      });
    }

    return results;
  }

  /**
   * Look up a single error code in the database.
   *
   * @param {string} code — error code string (e.g. 'MLV_SPARK_SESSION_FAILED')
   * @returns {Object|null} — full ErrorCodeEntry from the DB, or null if not found
   */
  getCodeInfo(code) {
    if (!code || typeof code !== 'string') return null;
    const entry = this._db[code];
    return entry || null;
  }

  /**
   * Record an occurrence of an error code at a given sequence number.
   *
   * @param {string} code — the error code
   * @param {number} seq — ring buffer sequence number
   */
  trackOccurrence(code, seq) {
    if (!code || typeof code !== 'string') return;

    const now = Date.now();
    let entry = this._occurrences.get(code);
    if (!entry) {
      entry = { count: 0, firstSeen: now, lastSeen: now };
      this._occurrences.set(code, entry);
    }
    entry.count++;
    entry.lastSeen = now;

    // Track per-sequence counts for precise eviction
    if (typeof seq === 'number') {
      let seqCounts = this._seqCodeCounts.get(seq);
      if (!seqCounts) {
        seqCounts = new Map();
        this._seqCodeCounts.set(seq, seqCounts);
      }
      seqCounts.set(code, (seqCounts.get(code) || 0) + 1);
    }
  }

  /**
   * Decrement occurrence counts when a sequence is evicted from the ring buffer.
   *
   * @param {number} seq — the evicted sequence number
   */
  evictOccurrences(seq) {
    const seqCounts = this._seqCodeCounts.get(seq);
    if (!seqCounts) return;

    for (const [code, count] of seqCounts) {
      const entry = this._occurrences.get(code);
      if (entry) {
        entry.count = Math.max(0, entry.count - count);
        if (entry.count === 0) {
          this._occurrences.delete(code);
        }
      }
    }
    this._seqCodeCounts.delete(seq);
  }

  /**
   * Get the current occurrence count for an error code.
   *
   * @param {string} code — error code string
   * @returns {number}
   */
  getOccurrenceCount(code) {
    const entry = this._occurrences.get(code);
    return entry ? entry.count : 0;
  }

  /**
   * Build structured card content for popover rendering.
   * Returns a plain data object — NO HTML strings, NO DOM elements.
   *
   * @param {string} code — error code string
   * @returns {Object} — structured card data
   */
  createCardContent(code) {
    const info = this.getCodeInfo(code);
    const occEntry = this._occurrences.get(code);
    const count = occEntry ? occEntry.count : 0;
    const isKnown = info !== null;

    const card = {
      code,
      isKnown,
      occurrenceCount: count,
      firstSeen: occEntry ? occEntry.firstSeen : null,
      lastSeen: occEntry ? occEntry.lastSeen : null
    };

    if (isKnown) {
      card.title = info.title || '';
      card.description = info.description || '';
      card.category = info.category || null;
      card.severity = info.severity || null;
      card.suggestedFix = info.suggestedFix || '';
      card.retryable = info.retryable === true;
      card.runbookUrl = info.runbookUrl || null;
      card.relatedCodes = Array.isArray(info.relatedCodes) ? info.relatedCodes.slice() : [];
    } else {
      card.title = 'Unknown error code';
      card.description = 'Pattern-matched error code not found in the error registry.';
      card.category = null;
      card.severity = null;
      card.suggestedFix = '';
      card.retryable = false;
      card.runbookUrl = null;
      card.relatedCodes = [];
    }

    return card;
  }

  /**
   * Get the top N error codes ranked by occurrence count (descending).
   *
   * @param {number} n — how many to return
   * @returns {Array<{code: string, count: number, firstSeen: number, lastSeen: number}>}
   */
  getTopCodes(n) {
    if (!n || n <= 0) return [];

    const entries = [];
    for (const [code, entry] of this._occurrences) {
      entries.push({
        code,
        count: entry.count,
        firstSeen: entry.firstSeen,
        lastSeen: entry.lastSeen
      });
    }

    entries.sort((a, b) => b.count - a.count);
    return entries.slice(0, n);
  }

  /**
   * Get the full occurrence data map. Returns the internal map directly
   * (read-only by convention — JS is single-threaded, no mutation risk).
   *
   * @returns {Map<string, {count: number, firstSeen: number, lastSeen: number}>}
   */
  getOccurrenceData() {
    return this._occurrences;
  }

  /**
   * Clear all occurrence tracking state. Does not affect the database.
   */
  reset() {
    this._occurrences.clear();
    this._seqCodeCounts.clear();
  }

  /**
   * Check whether the database has been loaded (non-empty).
   *
   * @returns {boolean}
   */
  get hasDatabase() {
    return this._codeSet.size > 0;
  }

  /**
   * Get the number of known codes in the database.
   *
   * @returns {number}
   */
  get databaseSize() {
    return this._codeSet.size;
  }
}
