/**
 * EDOG Real-Time Log Viewer - State Management
 * V2: Ring buffer storage + precomputed filter index for virtual scroll
 */

// ===== RING BUFFER =====

class RingBuffer {
  constructor(capacity) {
    this.capacity = capacity;
    this.buffer = new Array(capacity);
    this.head = 0;
    this.count = 0;
    this.totalPushed = 0;
  }

  get length() { return this.count; }

  push(item) {
    this.buffer[this.head] = item;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
    this.totalPushed++;
    return this.totalPushed - 1;
  }

  pushBatch(items) {
    const firstSeq = this.totalPushed;
    for (let i = 0; i < items.length; i++) {
      this.buffer[this.head] = items[i];
      this.head = (this.head + 1) % this.capacity;
      if (this.count < this.capacity) this.count++;
      this.totalPushed++;
    }
    return [firstSeq, this.totalPushed - 1];
  }

  getBySeq(seq) {
    const oldestSeq = this.totalPushed - this.count;
    if (seq < oldestSeq || seq >= this.totalPushed) return undefined;
    const offset = seq - oldestSeq;
    const idx = (this.head - this.count + offset + this.capacity) % this.capacity;
    return this.buffer[idx];
  }

  // Returns the i-th live entry by logical position: 0 is the oldest
  // currently-retained entry, count-1 is the newest. Mirrors forEach's
  // index semantics so cluster/logs code can iterate without callbacks.
  getByIndex(i) {
    if (i < 0 || i >= this.count) return undefined;
    const idx = (this.head - this.count + i + this.capacity) % this.capacity;
    return this.buffer[idx];
  }

  get oldestSeq() { return this.totalPushed - this.count; }
  get newestSeq() { return this.totalPushed - 1; }

  forEach(fn) {
    const oldest = this.totalPushed - this.count;
    for (let i = 0; i < this.count; i++) {
      const idx = (this.head - this.count + i + this.capacity) % this.capacity;
      fn(this.buffer[idx], oldest + i);
    }
  }

  clear() {
    this.head = 0;
    this.count = 0;
    this.totalPushed = 0;
    this.buffer = new Array(this.capacity);
  }
}

// ===== FILTER INDEX =====

class FilterIndex {
  constructor() {
    this.indices = [];
    this.lastCheckedSeq = -1;
  }

  rebuild(ringBuffer, filterFn) {
    this.indices = [];
    ringBuffer.forEach((item, seq) => {
      if (filterFn(item)) {
        this.indices.push(seq);
      }
    });
    this.lastCheckedSeq = ringBuffer.count > 0 ? ringBuffer.newestSeq : -1;
  }

  updateIncremental(ringBuffer, filterFn) {
    const start = this.lastCheckedSeq + 1;
    const end = ringBuffer.newestSeq;
    if (start > end || ringBuffer.count === 0) return 0;

    let added = 0;
    for (let seq = start; seq <= end; seq++) {
      const item = ringBuffer.getBySeq(seq);
      if (item && filterFn(item)) {
        this.indices.push(seq);
        added++;
      }
    }
    this.lastCheckedSeq = end;

    // Prune evicted indices
    const oldestValid = ringBuffer.oldestSeq;
    if (this.indices.length > 0 && this.indices[0] < oldestValid) {
      let lo = 0, hi = this.indices.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (this.indices[mid] < oldestValid) lo = mid + 1;
        else hi = mid;
      }
      if (lo > 0) this.indices = this.indices.slice(lo);
    }

    return added;
  }

  get length() { return this.indices.length; }

  seqAt(pos) { return this.indices[pos]; }

  clear() {
    this.indices = [];
    this.lastCheckedSeq = -1;
  }
}

// ===== STATE MANAGEMENT =====

/**
 * FilterSetView — Set-shaped view over a studioState filters array.
 *
 * PR-B: studioState stores activeLevels/excludedComponents as plain arrays
 * (shallowEqual can't see into Sets). Downstream code still uses Set semantics
 * (.has/.add/.delete/.clear/.size). This view bridges the two without
 * duplicating storage. Every mutating call routes through window.studioSetFilter
 * so the URL/localStorage stay in sync and subscribers fire.
 *
 * Read paths are O(n) on a tiny array (≤4 for levels, dozens for excluded
 * components). For larger collections this should grow a cached Set
 * invalidated on store change.
 */
function _ssFiltersGet(tab, key, fallback) {
  if (!window.studioState) return fallback;
  var f = window.studioState.get().filters;
  if (!f || !f[tab]) return fallback;
  var v = f[tab][key];
  return v === undefined ? fallback : v;
}

function _ssFiltersSet(tab, partial) {
  if (window.studioSetFilter) window.studioSetFilter(tab, partial);
}

class FilterSetView {
  constructor(tab, key, defaultArr) {
    this._tab = tab;
    this._key = key;
    this._default = defaultArr;
  }
  _read() {
    return _ssFiltersGet(this._tab, this._key, this._default);
  }
  has(v) { return this._read().indexOf(v) !== -1; }
  get size() { return this._read().length; }
  forEach(fn) { this._read().forEach(fn); }
  values() { return this._read().slice().values(); }
  keys() { return this.values(); }
  entries() {
    var arr = this._read();
    return arr.map(function (v) { return [v, v]; }).values();
  }
  [Symbol.iterator]() { return this.values(); }
  add(v) {
    var arr = this._read();
    if (arr.indexOf(v) !== -1) return this;
    var next = arr.concat([v]);
    var patch = {}; patch[this._key] = next;
    _ssFiltersSet(this._tab, patch);
    return this;
  }
  delete(v) {
    var arr = this._read();
    var i = arr.indexOf(v);
    if (i === -1) return false;
    var next = arr.slice(0, i).concat(arr.slice(i + 1));
    var patch = {}; patch[this._key] = next;
    _ssFiltersSet(this._tab, patch);
    return true;
  }
  clear() {
    var arr = this._read();
    if (arr.length === 0) return;
    var patch = {}; patch[this._key] = [];
    _ssFiltersSet(this._tab, patch);
  }
}

class LogViewerState {
  constructor() {
    this.logBuffer = new RingBuffer(10000);
    this.filterIndex = new FilterIndex();
    this.telemetryBuffer = new RingBuffer(5000);
    // PR-B: filter fields below are now getter/setter proxies onto
    // window.studioState.filters.logs (see _installLogsFilterProxies()).
    // Local fallbacks (_*Fallback) are seeded so isolated unit tests
    // that bypass studio-state.js still see sensible values.
    this._installLogsFilterProxies();
    // F12 Stream Controller — unified state machine (replaces autoScroll + paused)
    this.streamMode = 'LIVE';          // 'LIVE' | 'PAUSED'
    this.bufferedCount = 0;            // logs received while PAUSED
    this.pauseReason = null;           // 'scroll' | 'manual' | 'hover' | null
    this.hoverFreezeEnabled = localStorage.getItem('edog-hover-freeze') !== 'false';

    // Backward-compat shims (keep existing code working)
    Object.defineProperty(this, 'autoScroll', {
      get: () => this.streamMode === 'LIVE',
      set: (v) => {
        if (v && this.streamMode === 'PAUSED') {
          this.streamMode = 'LIVE';
          this.pauseReason = null;
          this.bufferedCount = 0;
        }
        if (!v && this.streamMode === 'LIVE') {
          this.streamMode = 'PAUSED';
        }
      }
    });
    Object.defineProperty(this, 'paused', {
      get: () => this.streamMode === 'PAUSED',
      set: (v) => {
        if (v && this.streamMode === 'LIVE') this.streamMode = 'PAUSED';
        if (!v && this.streamMode === 'PAUSED') {
          this.streamMode = 'LIVE';
          this.pauseReason = null;
          this.bufferedCount = 0;
        }
      }
    });
    this.stats = {
      totalLogs: 0, verbose: 0, message: 0, warning: 0, error: 0,
      totalEvents: 0, succeeded: 0, failed: 0
    };

    this.pendingTelemetry = [];
    this.newLogsSinceRender = 0;

    // W0.1 — Tab state
    // PR-A: activeTab now lives in window.studioState. We keep the
    // LogViewerState.activeTab API for back-compat (callers may still
    // read/write it) by proxying through the singleton. If studioState
    // hasn't loaded yet (e.g. in isolated unit tests), fall back to a
    // local field seeded from the old localStorage key. localStorage
    // throws in private mode, so guard it.
    try {
      this._activeTabFallback = localStorage.getItem('edog-active-tab') || 'logs';
    } catch (_e) {
      this._activeTabFallback = 'logs';
    }
    Object.defineProperty(this, 'activeTab', {
      get: () => (window.studioState ? window.studioState.get().activeTab : this._activeTabFallback),
      set: (v) => {
        if (window.studioState) window.studioState.set({ activeTab: v });
        else this._activeTabFallback = v;
      },
      configurable: true,
      enumerable: true,
    });

    // W0.2 — Endpoint filter (filter value lives in studioState; metadata stays local)
    this.knownEndpoints = new Set();

    // Component filter (filter value lives in studioState; metadata stays local)
    this.knownComponents = new Set();

    // W0.3 — RAID / IterationId filter (filter value lives in studioState)
    this.knownIterationIds = new Map();
    this.recentExecutions = [];

    // Backward compat: expose .logs as getter returning array view
    Object.defineProperty(this, 'logs', {
      get: () => {
        const arr = [];
        this.logBuffer.forEach(item => arr.push(item));
        return arr;
      }
    });

    // Backward compat: filteredLogs as getter from filter index
    Object.defineProperty(this, 'filteredLogs', {
      get: () => {
        const arr = [];
        for (let i = 0; i < this.filterIndex.length; i++) {
          const item = this.logBuffer.getBySeq(this.filterIndex.seqAt(i));
          if (item) arr.push(item);
        }
        return arr;
      },
      set: () => {}
    });

    // Backward compat: expose .telemetry with array-like API
    // RingBuffer has .push() and .forEach(), but callers also use .filter()
    Object.defineProperty(this, 'telemetry', {
      get: () => {
        const rb = this.telemetryBuffer;
        return {
          push: (item) => rb.push(item),
          forEach: (fn) => rb.forEach((item) => fn(item)),
          filter: (fn) => {
            const arr = [];
            rb.forEach((item) => { if (fn(item)) arr.push(item); });
            return arr;
          },
          get length() { return rb.length; }
        };
      }
    });
  }

  /**
   * PR-B — install getter/setter proxies for every logs-tab filter field.
   * Reads pull from window.studioState.filters.logs (URL/localStorage-hydrated).
   * Writes route through window.studioSetFilter so the URL/LS stay in sync and
   * the store fires its single subscriber for re-render. Each property has a
   * local fallback for the (rare) case where studio-state.js wasn't loaded
   * before this class was instantiated — happens in isolated unit tests only.
   *
   * activeLevels and excludedComponents return Set-shaped views (FilterSetView)
   * because downstream code (renderer.js, filters.js) uses .has/.add/.delete/.clear.
   * Stored as arrays in studioState so shallowEqual works.
   */
  _installLogsFilterProxies() {
    // Local fallbacks for unit-test environments without studio-state.js.
    this._filterFallbacks = {
      q: '',
      corr: null,
      preset: 'flt',
      since: 0,
      ep: '',
      comp: '',
      raid: '',
      levels: ['Verbose', 'Message', 'Warning', 'Error'],
      excl: [],
    };

    const ssGet = (key) => {
      if (window.studioState) {
        const f = window.studioState.get().filters;
        if (f && f.logs && Object.prototype.hasOwnProperty.call(f.logs, key)) {
          return f.logs[key];
        }
      }
      return this._filterFallbacks[key];
    };

    const ssSet = (key, value) => {
      if (window.studioSetFilter) {
        const patch = {}; patch[key] = value;
        window.studioSetFilter('logs', patch);
      } else {
        this._filterFallbacks[key] = value;
      }
    };

    const scalar = (prop, key) => {
      Object.defineProperty(this, prop, {
        get: () => ssGet(key),
        set: (v) => ssSet(key, v),
        configurable: true,
        enumerable: true,
      });
    };

    scalar('searchText', 'q');
    scalar('correlationFilter', 'corr');
    scalar('activePreset', 'preset');
    scalar('timeRangeSeconds', 'since');
    scalar('endpointFilter', 'ep');
    scalar('componentFilter', 'comp');
    scalar('raidFilter', 'raid');

    // Set-shaped views over the underlying arrays. Cached so identity-equality
    // checks against state.activeLevels stay stable across reads.
    const levelsView = new FilterSetView('logs', 'levels', this._filterFallbacks.levels);
    const exclView   = new FilterSetView('logs', 'excl',   this._filterFallbacks.excl);

    Object.defineProperty(this, 'activeLevels', {
      get: () => levelsView,
      set: (v) => {
        // Accept either Set or Array. Normalize to array for studioState.
        const arr = Array.isArray(v) ? v.slice() : Array.from(v || []);
        ssSet('levels', arr);
      },
      configurable: true,
      enumerable: true,
    });

    Object.defineProperty(this, 'excludedComponents', {
      get: () => exclView,
      set: (v) => {
        const arr = Array.isArray(v) ? v.slice() : Array.from(v || []);
        ssSet('excl', arr);
      },
      configurable: true,
      enumerable: true,
    });
  }

  addLog = (entry) => {
    this.logBuffer.push(entry);
    this.newLogsSinceRender++;

    // F12: track logs arriving while paused
    if (this.streamMode === 'PAUSED') {
      this.bufferedCount++;
    }

    this.stats.totalLogs++;
    const level = entry.level?.toLowerCase();
    if (level && this.stats[level] !== undefined) {
      this.stats[level]++;
    }
  }

  addTelemetry = (event) => {
    this.telemetryBuffer.push(event);
    this.pendingTelemetry.push(event);

    this.stats.totalEvents++;
    const status = event.activityStatus?.toLowerCase();
    if (status === 'succeeded') this.stats.succeeded++;
    else if (status === 'failed') this.stats.failed++;
  }
}
