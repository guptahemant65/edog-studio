/**
 * ClusterEngine — Global signature-based error clustering with frequency
 * trends and error-to-node mapping (C07 Enhanced Clustering).
 *
 * Maintains a Map<string, GlobalCluster> updated incrementally as new
 * log entries arrive. Provides sorted cluster lists, trend data, and
 * node hotspot queries for the cluster summary UI.
 */
class ClusterEngine {
  constructor() {
    /** @type {Map<string, GlobalCluster>} */
    this._clusters = new Map();
    /** @type {Map<string, GlobalCluster>} secondary index: error code -> cluster */
    this._codeIndex = new Map();
    this._entryCap = 500;
    this._version = 0;
    this._dirty = false;
    this._buffer = null;
  }

  // --- Public API ---

  /**
   * Full rebuild from ring buffer. Called on init or when buffer wraps.
   * @param {object} buffer — RingBuffer with .count and .getByIndex(i)
   */
  rebuildFromBuffer(buffer) {
    this._buffer = buffer;
    this._clusters.clear();
    this._codeIndex.clear();

    for (let i = 0; i < buffer.count; i++) {
      const entry = buffer.getByIndex(i);
      if (!entry) continue;
      if (!this._isClusterableLevel(entry.level)) continue;
      this._ingestEntry(entry);
    }

    this._recomputeAllTrends();
    this._version++;
    this._dirty = false;
  }

  /**
   * Incremental: process a single new entry as it arrives.
   * @param {object} entry — log entry from addLog
   */
  ingestEntry(entry) {
    if (this._dirty) {
      if (this._buffer) {
        this.rebuildFromBuffer(this._buffer);
        return;
      }
      this._dirty = false;
    }
    if (!this._isClusterableLevel(entry.level)) return;
    this._ingestEntry(entry);

    const sig = this._computeSignature(entry);
    const cluster = this._clusters.get(sig);
    if (cluster) cluster.trend = this._computeTrend(cluster);

    this._version++;
  }

  /**
   * Called when ring buffer evicts old entries.
   * Marks state dirty so next ingestEntry triggers a full rebuild.
   */
  onBufferWrap() {
    this._dirty = true;
  }

  /** Get cluster by full signature. O(1). */
  getCluster(signature) {
    return this._clusters.get(signature) || null;
  }

  /** Get cluster by error code. O(1) via secondary index. */
  getClusterByCode(code) {
    return this._codeIndex.get(code) || null;
  }

  /**
   * Alias consumed by ErrorIntelligence public API.
   * @param {string} sig
   * @returns {GlobalCluster|null}
   */
  getClusterBySignature(sig) {
    return this._clusters.get(sig) || null;
  }

  /** Get all clusters sorted by count descending (min count 2). */
  getSortedClusters() {
    return [...this._clusters.values()]
      .filter(c => c.count >= 2)
      .sort((a, b) => b.count - a.count);
  }

  /** Current version counter (for change detection). */
  get version() { return this._version; }

  /**
   * Frequency trend for a specific signature.
   * @param {string} signature
   * @returns {'increasing'|'decreasing'|'stable'}
   */
  getFrequencyTrend(signature) {
    const cluster = this._clusters.get(signature);
    if (!cluster) return 'stable';
    const arrow = this._computeTrend(cluster);
    if (arrow === '\u2191') return 'increasing';
    if (arrow === '\u2193') return 'decreasing';
    return 'stable';
  }

  /**
   * Node map for a specific signature.
   * @param {string} signature
   * @returns {Map<string, number>} nodeName -> count
   */
  getNodeMap(signature) {
    const cluster = this._clusters.get(signature);
    if (!cluster) return new Map();
    return cluster._nodeCountMap || new Map();
  }

  /**
   * Top N nodes by total error count across all clusters.
   * @param {number} n
   * @returns {Array<{node: string, count: number}>}
   */
  getHotNodes(n) {
    const totals = new Map();
    for (const cluster of this._clusters.values()) {
      if (cluster._nodeCountMap) {
        for (const [node, cnt] of cluster._nodeCountMap) {
          totals.set(node, (totals.get(node) || 0) + cnt);
        }
      }
    }
    return [...totals.entries()]
      .map(([node, count]) => ({ node, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, n || 5);
  }

  /**
   * Recompute all trends. Called periodically (timer) and after rebuild.
   */
  _recomputeAllTrends() {
    for (const cluster of this._clusters.values()) {
      cluster.trend = this._computeTrend(cluster);
    }
  }

  // --- Private ---

  /** @private */
  _ingestEntry(entry) {
    const sig = this._computeSignature(entry);
    let cluster = this._clusters.get(sig);

    if (!cluster) {
      cluster = {
        signature: sig,
        code: this._extractErrorCode(entry),
        label: this._computeLabel(entry),
        count: 0,
        firstSeen: entry.timestamp || null,
        lastSeen: entry.timestamp || null,
        nodes: new Set(),
        trend: '\u2192',       // →
        trendBadge: '\u2192',  // →
        window: new Array(120).fill(0),
        windowHead: 0,
        lastTick: 0,
        entries: [],
        expanded: false,
        skippedNodes: [],
        _nodeCountMap: new Map()
      };
      this._clusters.set(sig, cluster);

      if (cluster.code) {
        this._codeIndex.set(cluster.code, cluster);
      }
    }

    cluster.count++;
    cluster.lastSeen = entry.timestamp || cluster.lastSeen;

    // Node tracking
    const nodeName =
      (entry._errorContext && entry._errorContext.node) ||
      entry._node ||
      entry.node ||
      this._parseNodeFromMessage(entry.message) ||
      null;

    if (nodeName) {
      cluster.nodes.add(nodeName);
      cluster._nodeCountMap.set(
        nodeName,
        (cluster._nodeCountMap.get(nodeName) || 0) + 1
      );
    }

    // Entry reference (capped)
    if (cluster.entries.length < this._entryCap) {
      cluster.entries.push(entry);
    }

    // Update sliding window
    this._tickWindow(cluster, entry.timestamp);
  }

  _isClusterableLevel(level) {
    const l = (level || '').toLowerCase();
    return l === 'error' || l === 'fatal' || l === 'critical';
  }

  /**
   * Compute a canonical signature for clustering.
   * Priority: FLT error code > Exception class name > normalized prefix.
   */
  _computeSignature(entry) {
    const msg = entry.message || '';

    // Layer 1: FLT error code (strongest signal)
    const codeMatch = msg.match(/\b(MLV_\w+|FLT_\w+|SPARK_\w+)\b/);
    if (codeMatch) return codeMatch[1];

    // Layer 2: Exception/Error class name
    const exMatch = msg.match(/^(\w+Exception|\w+Error)\b/);
    if (exMatch) return exMatch[1];

    // Layer 3: Normalized message prefix (strip UUIDs, hex, timestamps)
    return msg
      .substring(0, 80)
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '{uuid}')
      .replace(/\b[0-9a-f]{8,}\b/gi, '{hex}')
      .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[.\d]*Z?\b/g, '{ts}')
      .replace(/\b\d{5,}\b/g, '{num}')
      .trim() || 'EMPTY_MESSAGE';
  }

  /** Extract FLT error code from message if present. */
  _extractErrorCode(entry) {
    const msg = entry.message || '';
    const m = msg.match(/\b(MLV_\w+|FLT_\w+|SPARK_\w+)\b/);
    return m ? m[1] : null;
  }

  /** Human-readable label — uses ERROR_CODES_DB if available. */
  _computeLabel(entry) {
    const code = this._extractErrorCode(entry);
    if (code && typeof window !== 'undefined'
        && window.ERROR_CODES_DB && window.ERROR_CODES_DB[code]) {
      return window.ERROR_CODES_DB[code].title || code;
    }
    const msg = entry.message || '';
    const colonIdx = msg.indexOf(':');
    if (colonIdx > 0 && colonIdx < 60) return msg.substring(0, colonIdx);
    return msg.substring(0, 50);
  }

  /** Parse DAG node name from message text as a last resort. */
  _parseNodeFromMessage(msg) {
    if (!msg) return null;
    const m = msg.match(/node\s+['"]([^'"]+)['"]/i);
    return m ? m[1] : null;
  }

  /**
   * Record one occurrence in the cluster's sliding window.
   * @param {GlobalCluster} cluster
   * @param {string} timestamp
   */
  _tickWindow(cluster, timestamp) {
    const nowSec = Math.floor(Date.parse(timestamp) / 1000)
      || Math.floor(Date.now() / 1000);

    if (cluster.lastTick === 0) {
      cluster.lastTick = nowSec;
      cluster.windowHead = 0;
      cluster.window[0] = 1;
      return;
    }

    const elapsed = nowSec - cluster.lastTick;

    if (elapsed > 0) {
      const steps = Math.min(elapsed, 120);
      for (let s = 0; s < steps; s++) {
        cluster.windowHead = (cluster.windowHead + 1) % 120;
        cluster.window[cluster.windowHead] = 0;
      }
      cluster.lastTick = nowSec;
    }

    cluster.window[cluster.windowHead]++;
  }

  /**
   * Compare recent 60s vs previous 60s.
   * @param {GlobalCluster} cluster
   * @returns {string} '↑' | '↓' | '→'
   */
  _computeTrend(cluster) {
    let recent = 0;
    let previous = 0;

    for (let i = 0; i < 60; i++) {
      const recentIdx = ((cluster.windowHead - i) % 120 + 120) % 120;
      recent += cluster.window[recentIdx];

      const prevIdx = ((cluster.windowHead - 60 - i) % 120 + 120) % 120;
      previous += cluster.window[prevIdx];
    }

    if (previous === 0 && recent === 0) return '\u2192';
    if (previous === 0 && recent > 0) return '\u2191';
    if (recent === 0 && previous > 0) return '\u2193';

    const ratio = recent / previous;
    if (ratio > 1.2) return '\u2191';
    if (ratio < 0.8) return '\u2193';
    return '\u2192';
  }
}


/**
 * ErrorIntelligence — Automatically detects, groups, and surfaces errors.
 * Shows dismissible alert cards when errors are found.
 * Enhanced with ClusterEngine for global clustering, frequency trends,
 * and error-to-node mapping (C07).
 */
class ErrorIntelligence {
  constructor(autoDetector) {
    this.autoDetector = autoDetector;
    this.alertElement = document.getElementById('error-alert');
    this.dismissed = new Set(); // dismissed error codes
    this.onJumpToError = null; // callback to scroll to error log

    /** @type {ClusterEngine} */
    this._clusterEngine = new ClusterEngine();

    autoDetector.onErrorDetected = (exec, error) => this.handleError(exec, error);
  }

  handleError = (exec, error) => {
    if (this.dismissed.has(error.code)) return;
    this.showAlert(exec, error);

    // Track skipped nodes on the responsible cluster
    if (exec.skippedNodes && Array.isArray(exec.skippedNodes)
        && exec.skippedNodes.length > 0) {
      const sig = this._clusterEngine._computeSignature(error);
      const cluster = this._clusterEngine.getCluster(sig);
      if (cluster) {
        const existing = new Set(cluster.skippedNodes);
        for (const n of exec.skippedNodes) existing.add(n);
        cluster.skippedNodes = [...existing];
      }
    }
  }

  showAlert = (exec, latestError) => {
    if (!this.alertElement) return;

    const errorCount = exec.errors.length;
    const uniqueCodes = [...new Set(exec.errors.map(e => e.code))];
    const skippedCount = exec.skippedNodes || 0;

    let summary = errorCount + ' error' + (errorCount > 1 ? 's' : '') + ' detected';
    if (uniqueCodes.length === 1) {
      summary += ' \u2014 ' + uniqueCodes[0];
      if (latestError.node) summary += " in node '" + latestError.node + "'";
    } else {
      summary += ' (' + uniqueCodes.join(', ') + ')';
    }
    if (skippedCount > 0) {
      summary += '. ' + skippedCount + ' downstream node'
        + (skippedCount > 1 ? 's' : '') + ' skipped.';
    }

    // Build alert DOM safely — no innerHTML with user data
    this.alertElement.textContent = '';

    const icon = document.createElement('span');
    icon.className = 'error-icon';
    icon.textContent = '\u2715';

    const summaryEl = document.createElement('span');
    summaryEl.className = 'error-summary';
    summaryEl.textContent = summary;

    const action = document.createElement('span');
    action.className = 'error-action';
    action.textContent = 'Jump to error \u2192';
    action.addEventListener('click', () => {
      if (window.edogViewer) window.edogViewer.jumpToNextError();
    });

    const dismiss = document.createElement('span');
    dismiss.className = 'error-dismiss';
    dismiss.title = 'Dismiss';
    dismiss.textContent = '\u2715';
    dismiss.addEventListener('click', () => {
      this.alertElement.classList.remove('active');
    });

    this.alertElement.appendChild(icon);
    this.alertElement.appendChild(summaryEl);
    this.alertElement.appendChild(action);
    this.alertElement.appendChild(dismiss);
    this.alertElement.classList.add('active');
  }

  dismiss = (errorCode) => {
    this.dismissed.add(errorCode);
    if (this.alertElement) this.alertElement.classList.remove('active');
  }

  // --- Cluster public API (delegates to ClusterEngine) ---

  /**
   * Process a log entry into clusters incrementally.
   * @param {object} entry
   */
  addToCluster(entry) {
    this._clusterEngine.ingestEntry(entry);
  }

  /**
   * Returns sorted array of clusters (most frequent first).
   * @returns {GlobalCluster[]}
   */
  getClusters() {
    return this._clusterEngine.getSortedClusters();
  }

  /**
   * Get a specific cluster by signature.
   * @param {string} sig
   * @returns {GlobalCluster|null}
   */
  getClusterBySignature(sig) {
    return this._clusterEngine.getClusterBySignature(sig);
  }

  /**
   * Frequency trend for a given signature.
   * @param {string} signature
   * @returns {'increasing'|'decreasing'|'stable'}
   */
  getFrequencyTrend(signature) {
    return this._clusterEngine.getFrequencyTrend(signature);
  }

  /**
   * Node map for a signature: Map<nodeName, count>.
   * @param {string} signature
   * @returns {Map<string, number>}
   */
  getNodeMap(signature) {
    return this._clusterEngine.getNodeMap(signature);
  }

  /**
   * Top N nodes by error count across all clusters.
   * @param {number} n
   * @returns {Array<{node: string, count: number}>}
   */
  getHotNodes(n) {
    return this._clusterEngine.getHotNodes(n);
  }

  /** @returns {ClusterEngine} */
  get clusterEngine() {
    return this._clusterEngine;
  }
}
