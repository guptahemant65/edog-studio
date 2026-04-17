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

class LogViewerState {
  constructor() {
    this.logBuffer = new RingBuffer(10000);
    this.filterIndex = new FilterIndex();
    this.telemetryBuffer = new RingBuffer(5000);
    this.activeLevels = new Set(['Message', 'Warning', 'Error']);
    this.searchText = '';
    this.correlationFilter = null;
    this.excludedComponents = new Set();
    this.activePreset = 'flt';
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
    this.timeRangeSeconds = 0;
    this.stats = {
      totalLogs: 0, verbose: 0, message: 0, warning: 0, error: 0,
      totalEvents: 0, succeeded: 0, failed: 0
    };

    this.pendingTelemetry = [];
    this.newLogsSinceRender = 0;

    // W0.1 — Tab state
    this.activeTab = localStorage.getItem('edog-active-tab') || 'logs';

    // W0.2 — Endpoint filter
    this.endpointFilter = '';
    this.knownEndpoints = new Set();

    // Component filter
    this.componentFilter = '';
    this.knownComponents = new Set();

    // W0.3 — RAID / IterationId filter
    this.raidFilter = '';
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
