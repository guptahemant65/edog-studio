# C07-Enhanced Error Clustering — Component Deep Spec

> **Component ID:** C07
> **Feature:** F12 — Error Intelligence & Log Experience
> **Owner Agent:** Pixel (JS/CSS) + Sana (data model review)
> **Priority:** P3 — Error Analytics
> **Status:** Draft
> **Last Updated:** 2025-07-22
> **Spec Version:** 1.0.0

---

## Table of Contents

1. [Overview](#1-overview)
2. [Data Model](#2-data-model)
3. [Scenarios](#3-scenarios)
4. [Integration Points](#4-integration-points)
5. [Performance](#5-performance)
6. [Implementation Notes](#6-implementation-notes)

---

## 1. Overview

### 1.1 Purpose

C07 transforms the existing consecutive-only error clustering in `logs-enhancements.js`
into a **global signature-based** grouping system that works across the entire ring buffer.
It adds frequency trend computation, error-to-node mapping, downstream impact tracking,
and an upgraded cluster summary panel. This component bridges raw error detection (C02)
and the error analytics UI (C06 timeline).

### 1.2 Problem with Current Implementation

The existing `detectClusters()` (logs-enhancements.js:255-299) groups only **consecutive**
error entries sharing the same `_errorSignature`. Non-error entries break the cluster:

```
Current:  [A, A, A, B, A, A] -> Cluster{A,3}, skip B, Cluster{A,2}   (2 clusters)
C07 goal: [A, A, A, B, A, A] -> Cluster{A,5}                         (1 cluster, global)
```

Additionally, the current `_errorSignature` (logs-enhancements.js:1002-1007) only matches
`Exception`/`Error` class names or truncated message prefixes. It does not leverage FLT
error codes (`MLV_*`, `FLT_*`, `SPARK_*`), producing coarser grouping than possible.

### 1.3 Scope

| Responsibility | Description |
|---|---|
| **Global clustering** | Group errors by signature across the full 50K-entry ring buffer |
| **Enhanced signatures** | Use FLT error codes as primary signature when present |
| **Frequency trends** | Sliding-window rate comparison: ↑ increasing, ↓ decreasing, → stable |
| **Node mapping** | Track which DAG nodes produce each error signature |
| **Downstream impact** | Surface skipped nodes per cluster from `exec.skippedNodes` |
| **Cluster summary UI** | Upgraded panel with trend badges, node pills, expand-to-entries |
| **Incremental updates** | Update cluster state on new log arrival without full recalculation |
| **Cross-links** | "View in DAG" navigation when DAG tab is available |

### 1.4 Out of Scope

- Error code decoding / context card rendering (C02 — Error Decoder)
- Timeline chart rendering (C06 — Error Timeline)
- Log row highlighting / innerHTML transition (C03 — Highlight Engine)
- Search, export, stream control (C04, C05)

### 1.5 Files Modified

| File | What Changes |
|---|---|
| `src/frontend/js/error-intel.js` | Add `ClusterEngine` class: global clustering, frequency tracker, trend computation, node mapping |
| `src/frontend/js/logs-enhancements.js` | Replace `detectClusters()` with call to ClusterEngine, upgrade `_renderClusterSummary()`, extend `_errorSignature()` |

### 1.6 Dependencies

```
C07-EnhancedClustering
├── DEPENDS ON
│   ├── state.js RingBuffer           — source of all log entries (50K ring buffer)
│   ├── state.js FilterIndex          — filtered entry access
│   ├── auto-detect.js AutoDetector   — error object shape { code, message, timestamp, node }
│   ├── C02 Error Decoder (optional)  — enriched error code data for display
│   └── logs-enhancements.js          — host for cluster summary DOM, gutter injection
├── DEPENDED ON BY
│   ├── C06 Error Timeline            — consumes cluster time distributions
│   ├── C02 Error Decoder             — reads occurrence counts for context card
│   └── main.js                       — triggers refreshClusters on new logs
└── PEER (event-based)
    └── DAG tab (if available)        — "View in DAG" cross-link navigation
```

---

## 2. Data Model

### 2.1 GlobalCluster Record

Each unique error signature maps to exactly one GlobalCluster. Stored in `ClusterEngine._clusters` (a `Map<string, GlobalCluster>`).

```javascript
/**
 * @typedef {object} GlobalCluster
 * @property {string}   signature  — Canonical key (error code or normalized message prefix)
 * @property {string}   code       — FLT error code if detected, otherwise null
 * @property {string}   label      — Human-readable display label (truncated message or code title)
 * @property {number}   count      — Total occurrences across entire buffer
 * @property {string}   firstSeen  — ISO timestamp of earliest occurrence
 * @property {string}   lastSeen   — ISO timestamp of most recent occurrence
 * @property {Set<string>} nodes   — Set of DAG node names that produced this error
 * @property {string}   trend      — '↑' | '↓' | '→' — frequency direction
 * @property {number[]} window     — Circular array of per-second counts for sliding window
 * @property {number}   windowHead — Current write position in circular window array
 * @property {object[]} entries    — Array of matching log entry references (capped at 500)
 * @property {boolean}  expanded   — UI expand/collapse state
 * @property {string[]} skippedNodes — Downstream nodes skipped due to this error
 */
```

### 2.2 FrequencyWindow Record

Per-signature sliding window for trend computation. Embedded in each GlobalCluster.

```javascript
/**
 * Sliding window: 120 one-second buckets (covers 2 minutes).
 * Trend compares [0..59] (previous 60s) vs [60..119] (recent 60s).
 *
 * @property {number[]} window     — Fixed-size array, length 120, each element = count in that second
 * @property {number}   windowHead — Index of the current second (wraps at 120)
 * @property {number}   lastTick   — Unix timestamp (seconds) of last recorded tick
 */
```

### 2.3 State Properties Added

```javascript
// Added to shared state object (state.js):
state.globalClusters = new Map();    // signature -> GlobalCluster
state.clustersSorted = [];           // GlobalCluster[] sorted by count desc (cache)
state.clustersVersion = 0;           // Incremented on any cluster mutation (cheap invalidation)
```

---

## 3. Scenarios

### S01 — Global Signature-Based Clustering

**ID:** C07-S01
**Priority:** P3-Critical (core capability)
**Description:** Group all error-level log entries across the full ring buffer by their
computed signature, regardless of position or interleaving with non-error entries.

**Source:** `src/frontend/js/error-intel.js` (new `ClusterEngine` class)
**Modifies:** `src/frontend/js/logs-enhancements.js:255-299` (`detectClusters`)

#### Technical Mechanism

```javascript
class ClusterEngine {
  constructor() {
    /** @type {Map<string, GlobalCluster>} */
    this._clusters = new Map();
    this._entryCap = 500; // max entries stored per cluster
  }

  /**
   * Full rebuild from ring buffer. Called on init or when buffer wraps.
   * @param {RingBuffer} buffer
   */
  rebuildFromBuffer(buffer) {
    this._clusters.clear();

    for (let i = 0; i < buffer.count; i++) {
      const entry = buffer.getByIndex(i);
      if (!entry) continue;
      // Process ALL levels, not just 'error' — enables warning clustering too
      if (!this._isClusterableLevel(entry.level)) continue;
      this._ingestEntry(entry);
    }

    this._recomputeAllTrends();
  }

  /**
   * Incremental: process a single new entry as it arrives.
   * @param {object} entry — log entry from addLog
   */
  ingestEntry(entry) {
    if (!this._isClusterableLevel(entry.level)) return;
    this._ingestEntry(entry);
  }

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
    }

    cluster.count++;
    cluster.lastSeen = entry.timestamp;

    // Node tracking
    const nodeName = entry._node || entry.node ||
      (entry._errorContext && entry._errorContext.node) || null;
    if (nodeName) cluster.nodes.add(nodeName);

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
}
```

**Replacement of `detectClusters` in logs-enhancements.js:**

```javascript
// logs-enhancements.js — detectClusters replacement
detectClusters(entries) {
  // Delegate to ClusterEngine for global grouping
  if (this._clusterEngine) {
    this._clusterEngine.rebuildFromBuffer(this._state.logBuffer);
    this._errorClusters = this._clusterEngine.getSortedClusters();
  } else {
    this._errorClusters = [];
  }
  this._renderClusterSummary();
  return this._errorClusters;
}
```

#### Edge Cases

| Case | Behavior |
|---|---|
| Empty buffer | `_clusters` stays empty, summary hidden |
| Buffer wraps (50K exceeded) | Full `rebuildFromBuffer` triggered — evicted entries reduce counts |
| Entry has no message | Signature falls back to `'EMPTY_MESSAGE'` |
| Entry has no timestamp | `firstSeen`/`lastSeen` use `'--:--:--'` placeholder |
| Cluster with 1 entry | Still created but not displayed (threshold: count >= 2) |
| Unicode/special chars in message | Signature normalization strips non-alphanumeric (except underscores) |

#### Revert Mechanism

Restore the original consecutive-only `detectClusters` from `logs-enhancements.js:255-299`.
The `ClusterEngine` class lives in `error-intel.js` and can be deleted without affecting
any other subsystem. Set `this._clusterEngine = null` in `LogsEnhancements` constructor
to revert to the old algorithm.

---

### S02 — Enhanced Error Signature

**ID:** C07-S02
**Priority:** P3-Critical
**Description:** Extend the error signature function to use FLT error codes (`MLV_*`,
`FLT_*`, `SPARK_*`) as the primary grouping key when present, falling back to the
existing Exception/Error class name extraction.

**Source:** `src/frontend/js/logs-enhancements.js:1002-1007` (`_errorSignature`)
**Source:** `src/frontend/js/error-intel.js` (new `ClusterEngine._computeSignature`)

#### Technical Mechanism

```javascript
// ClusterEngine._computeSignature — replaces _errorSignature
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
```

The existing `_errorSignature` in `logs-enhancements.js:1002-1007` is preserved as a
private method but the `ClusterEngine._computeSignature` is the canonical implementation
used for all new clustering.

#### Edge Cases

| Case | Behavior |
|---|---|
| Multiple error codes in one message | First match wins (leftmost in message) |
| Error code in non-error level | Clustered if level is error/fatal/critical |
| `UNKNOWN_ERROR` code from auto-detect | Falls through to Layer 2 or 3 |
| Very long message (>80 chars) | Truncated before normalization |
| Message is only whitespace | Returns `'EMPTY_MESSAGE'` |

#### Revert Mechanism

Replace `ClusterEngine._computeSignature` call with direct call to existing
`LogsEnhancements._errorSignature`. The signature function is self-contained.

---

### S03 — Frequency Trend Computation

**ID:** C07-S03
**Priority:** P3-High
**Description:** Compute per-cluster frequency trends using a 120-second sliding window.
Compare the rate in the recent 60 seconds vs the previous 60 seconds to determine
trend direction: ↑ (increasing >20%), ↓ (decreasing >20%), → (stable).

**Source:** `src/frontend/js/error-intel.js` (`ClusterEngine._tickWindow`, `_computeTrend`)

#### Technical Mechanism

```javascript
/**
 * Record one occurrence in the cluster's sliding window.
 * @param {GlobalCluster} cluster
 * @param {string} timestamp — ISO timestamp of the entry
 */
_tickWindow(cluster, timestamp) {
  const nowSec = Math.floor(Date.parse(timestamp) / 1000) || Math.floor(Date.now() / 1000);

  if (cluster.lastTick === 0) {
    cluster.lastTick = nowSec;
    cluster.windowHead = 0;
    cluster.window[0] = 1;
    return;
  }

  const elapsed = nowSec - cluster.lastTick;

  if (elapsed > 0) {
    // Advance head, zero-fill skipped seconds (cap to window size)
    const steps = Math.min(elapsed, 120);
    for (let s = 0; s < steps; s++) {
      cluster.windowHead = (cluster.windowHead + 1) % 120;
      cluster.window[cluster.windowHead] = 0;
    }
    cluster.lastTick = nowSec;
  }

  // Increment current bucket
  cluster.window[cluster.windowHead]++;
}

/**
 * Compare recent 60s vs previous 60s.
 * @param {GlobalCluster} cluster
 * @returns {'↑' | '↓' | '→'}
 */
_computeTrend(cluster) {
  let recent = 0;   // windowHead-59 .. windowHead  (most recent 60s)
  let previous = 0; // windowHead-119 .. windowHead-60 (previous 60s)

  for (let i = 0; i < 60; i++) {
    const recentIdx = ((cluster.windowHead - i) % 120 + 120) % 120;
    recent += cluster.window[recentIdx];

    const prevIdx = ((cluster.windowHead - 60 - i) % 120 + 120) % 120;
    previous += cluster.window[prevIdx];
  }

  // Avoid division by zero: if previous is 0 and recent > 0, that's increasing
  if (previous === 0 && recent === 0) return '→';
  if (previous === 0 && recent > 0) return '↑';
  if (recent === 0 && previous > 0) return '↓';

  const ratio = recent / previous;
  if (ratio > 1.2) return '↑';  // >20% increase
  if (ratio < 0.8) return '↓';  // >20% decrease
  return '→';                    // stable (within ±20%)
}

/**
 * Recompute trends for all clusters. Called after full rebuild.
 */
_recomputeAllTrends() {
  for (const cluster of this._clusters.values()) {
    cluster.trend = this._computeTrend(cluster);
  }
}
```

**Trend recomputation schedule:**

| Trigger | Action |
|---|---|
| `ingestEntry()` called | `_tickWindow` + `_computeTrend` on that one cluster |
| `rebuildFromBuffer()` called | `_recomputeAllTrends()` after full scan |
| Timer (every 5 seconds) | `_recomputeAllTrends()` to catch time-based decay |

The 5-second timer ensures trends update even when no new logs arrive (a cluster's
recent window empties as time passes, changing ↑ to → or ↓).

#### Edge Cases

| Case | Behavior |
|---|---|
| All errors in the last 10 seconds, none before | `previous=0`, `recent>0` → ↑ |
| Errors stopped 90 seconds ago | Both windows near zero → → |
| Perfectly steady 1 error/sec | `recent ≈ previous` → → |
| Burst then silence | First: ↑, then after 60s: ↓, then → |
| Clock skew in timestamps | Uses `Date.now()` fallback if parse fails |
| Buffer rebuild after long idle | Window filled from historical timestamps; trend reflects historical rate |

#### Revert Mechanism

Set `cluster.trend = '→'` for all clusters (disable computation). Remove the 5-second
timer. The trend field is purely display — no downstream logic depends on its value.

---

### S04 — Error-to-Node Mapping

**ID:** C07-S04
**Priority:** P3-High
**Description:** Extract the originating DAG node name from each error's context and
maintain a per-cluster `nodes: Set<string>` mapping. Display affected nodes in the
cluster summary panel.

**Source:** `src/frontend/js/error-intel.js` (`ClusterEngine._ingestEntry` — node extraction)
**Source:** `src/frontend/js/error-intel.js:24-33` (existing `latestError.node` usage)

#### Technical Mechanism

Node name extraction (in `_ingestEntry`):

```javascript
// Priority order for node name extraction:
// 1. error._errorContext.node  — set by AutoDetector.inferNodeFromContext()
// 2. entry._node               — set by some telemetry paths
// 3. entry.node                — legacy field
// 4. Parse from message:       — regex: /node ['"]([^'"]+)['"]/i
const nodeName =
  (entry._errorContext && entry._errorContext.node) ||
  entry._node ||
  entry.node ||
  this._parseNodeFromMessage(entry.message) ||
  null;

if (nodeName) cluster.nodes.add(nodeName);
```

```javascript
_parseNodeFromMessage(msg) {
  if (!msg) return null;
  const m = msg.match(/node\s+['"]([^'"]+)['"]/i);
  return m ? m[1] : null;
}
```

**Downstream skip tracking:**

When `exec.skippedNodes` is available (populated by AutoDetector), it is associated
with the cluster of the triggering error:

```javascript
// In ErrorIntelligence.handleError, after ClusterEngine.ingestEntry:
if (exec.skippedNodes && exec.skippedNodes.length > 0) {
  const sig = this._clusterEngine._computeSignature(error);
  const cluster = this._clusterEngine.getCluster(sig);
  if (cluster) {
    // Merge skipped nodes (dedup)
    const existing = new Set(cluster.skippedNodes);
    for (const n of exec.skippedNodes) existing.add(n);
    cluster.skippedNodes = [...existing];
  }
}
```

#### Edge Cases

| Case | Behavior |
|---|---|
| No node context available | `cluster.nodes` stays empty; UI shows "—" |
| Same error from multiple nodes | All node names collected in Set |
| Node name contains special chars | Stored as-is; HTML-escaped at render time |
| `exec.skippedNodes` is a number (not array) | Existing `showAlert` already handles `skippedCount = exec.skippedNodes \|\| 0`; enhanced version converts to array context if array, count if number |
| Node removed from DAG after error | Node name persists in cluster until rebuild |

#### Revert Mechanism

Remove node extraction logic from `_ingestEntry`. Set `cluster.nodes = new Set()` and
`cluster.skippedNodes = []`. Node columns in cluster summary render as empty.

---

### S05 — Trend Badge Rendering

**ID:** C07-S05
**Priority:** P3-Medium
**Description:** Render frequency trend indicators (↑ ↓ →) as color-coded badges on
each cluster pill in the summary panel.

**Source:** `src/frontend/js/logs-enhancements.js:765-815` (`_renderClusterSummary`)

#### Technical Mechanism

```javascript
// Inside _renderClusterSummary, for each cluster pill:
const trendBadge = document.createElement('span');
trendBadge.className = 'le-cluster-trend';
trendBadge.textContent = cluster.trend; // '↑', '↓', or '→'

switch (cluster.trend) {
  case '↑':
    trendBadge.classList.add('le-trend-rising');
    trendBadge.title = 'Increasing — error rate rising >20% vs previous 60s';
    break;
  case '↓':
    trendBadge.classList.add('le-trend-falling');
    trendBadge.title = 'Decreasing — error rate falling >20% vs previous 60s';
    break;
  default:
    trendBadge.classList.add('le-trend-stable');
    trendBadge.title = 'Stable — error rate within ±20% vs previous 60s';
}

pill.appendChild(trendBadge);
```

**CSS (added to `logs.css`):**

```css
.le-cluster-trend {
  display: inline-block;
  font-size: 0.75rem;
  font-weight: 600;
  width: 1.2em;
  text-align: center;
  margin-left: 4px;
  border-radius: 2px;
  padding: 0 2px;
}
.le-trend-rising  { color: var(--color-error);   } /* red */
.le-trend-falling { color: var(--color-success); } /* green */
.le-trend-stable  { color: var(--color-muted);   } /* gray */
```

#### Edge Cases

| Case | Behavior |
|---|---|
| Trend not yet computed (first entry) | Default `'→'` renders as gray stable badge |
| Cluster has count=1 | Trend is always `'→'` (insufficient data) |
| `--color-error` / `--color-success` not defined | Fallback: `#ef4444` / `#22c55e` / `#6b7280` |

#### Revert Mechanism

Remove `trendBadge` creation block from `_renderClusterSummary`. Remove the three CSS
classes. Cluster pills render as before (count + label + chevron).

---

### S06 — Cluster Summary Panel Upgrade

**ID:** C07-S06
**Priority:** P3-High
**Description:** Replace the simple pill-list cluster summary with an enhanced panel
showing per-cluster rows with: count, error code, first/last seen, trend badge, affected
nodes, and an expand action to view all matching entries.

**Source:** `src/frontend/js/logs-enhancements.js:471-482` (`_buildClusterSummaryDOM`)
**Source:** `src/frontend/js/logs-enhancements.js:765-815` (`_renderClusterSummary`)

#### Technical Mechanism

```javascript
_renderClusterSummary() {
  const summary = document.getElementById('le-cluster-summary');
  if (!summary) return;

  const clusters = this._clusterEngine
    ? this._clusterEngine.getSortedClusters()
    : this._errorClusters;

  if (clusters.length === 0) {
    summary.style.display = 'none';
    return;
  }

  summary.style.display = '';
  summary.innerHTML = '';

  // Header
  const header = document.createElement('div');
  header.className = 'le-cluster-header';
  header.textContent = clusters.length + ' error pattern'
    + (clusters.length > 1 ? 's' : '') + ' detected';
  summary.appendChild(header);

  // Cluster rows
  clusters.forEach(cluster => {
    const row = document.createElement('div');
    row.className = 'le-cluster-row' + (cluster.expanded ? ' expanded' : '');

    // Count badge
    const count = document.createElement('span');
    count.className = 'le-cluster-count';
    count.textContent = cluster.count + '\u00d7';

    // Error code / label
    const label = document.createElement('span');
    label.className = 'le-cluster-text';
    label.textContent = cluster.code || (
      cluster.label.length > 40
        ? cluster.label.substring(0, 40) + '\u2026'
        : cluster.label
    );
    label.title = cluster.label;

    // Trend badge (S05)
    const trend = this._createTrendBadge(cluster);

    // Time range
    const time = document.createElement('span');
    time.className = 'le-cluster-time';
    time.textContent = this._formatTimeShort(cluster.firstSeen)
      + ' \u2013 ' + this._formatTimeShort(cluster.lastSeen);

    // Node pills
    const nodesContainer = document.createElement('span');
    nodesContainer.className = 'le-cluster-nodes';
    if (cluster.nodes.size > 0) {
      for (const nodeName of cluster.nodes) {
        const nodePill = document.createElement('span');
        nodePill.className = 'le-cluster-node-pill';
        nodePill.textContent = nodeName;
        nodePill.title = 'Error occurred in node: ' + nodeName;

        // "View in DAG" cross-link
        nodePill.addEventListener('click', (e) => {
          e.stopPropagation();
          this._navigateToDAGNode(nodeName);
        });

        nodesContainer.appendChild(nodePill);
      }
    }

    // Skipped nodes indicator
    if (cluster.skippedNodes && cluster.skippedNodes.length > 0) {
      const skip = document.createElement('span');
      skip.className = 'le-cluster-skipped';
      skip.textContent = 'Skipped: ' + cluster.skippedNodes.join(', ');
      skip.title = 'Downstream nodes skipped due to this error';
      nodesContainer.appendChild(skip);
    }

    // Expand chevron
    const chevron = document.createElement('span');
    chevron.className = 'le-cluster-chevron' + (cluster.expanded ? ' expanded' : '');
    chevron.textContent = '\u25B8'; // ▸

    // Assemble row
    row.appendChild(count);
    row.appendChild(label);
    row.appendChild(trend);
    row.appendChild(time);
    row.appendChild(nodesContainer);
    row.appendChild(chevron);

    // Click handler: expand/collapse
    row.addEventListener('click', () => {
      cluster.expanded = !cluster.expanded;
      this._renderClusterSummary();
      if (cluster.expanded && cluster.entries[0] && cluster.entries[0].seq !== undefined) {
        this._scrollToSeq(cluster.entries[0].seq);
      }
    });

    summary.appendChild(row);

    // Expanded: show matching entries
    if (cluster.expanded) {
      const entryList = document.createElement('div');
      entryList.className = 'le-cluster-entries';

      const displayCount = Math.min(cluster.entries.length, 50);
      for (let i = 0; i < displayCount; i++) {
        const e = cluster.entries[i];
        const entryRow = document.createElement('div');
        entryRow.className = 'le-cluster-entry-row';
        entryRow.textContent = this._formatTimeShort(e.timestamp)
          + ' ' + (e.message || '').substring(0, 120);
        entryRow.addEventListener('click', (ev) => {
          ev.stopPropagation();
          if (e.seq !== undefined) this._scrollToSeq(e.seq);
        });
        entryList.appendChild(entryRow);
      }

      if (cluster.entries.length > 50) {
        const more = document.createElement('div');
        more.className = 'le-cluster-more';
        more.textContent = '+ ' + (cluster.entries.length - 50) + ' more entries';
        entryList.appendChild(more);
      }

      summary.appendChild(entryList);
    }
  });
}
```

**"View in DAG" navigation:**

```javascript
_navigateToDAGNode(nodeName) {
  // Check if DAG tab is available
  const dagTab = document.querySelector('[data-tab="dag"]');
  if (!dagTab) return; // DAG tab not present — no-op

  // Switch to DAG tab
  dagTab.click();

  // Dispatch custom event for DAG to highlight the node
  window.dispatchEvent(new CustomEvent('edog:navigate-to-node', {
    detail: { nodeName }
  }));
}
```

#### Edge Cases

| Case | Behavior |
|---|---|
| >20 clusters | Show first 10 with "Show N more" expander |
| Cluster has 0 nodes | Node column renders as "—" |
| Cluster expanded with 500+ entries | Cap displayed entries at 50, show "+N more" |
| Node name very long (>30 chars) | Truncate with ellipsis in node pill |
| DAG tab not in current view | `_navigateToDAGNode` is a no-op (no error) |
| `_formatTimeShort` receives null | Returns `'--:--:--'` (existing behavior) |
| Click on entry row in expanded cluster | Scrolls to that entry in log view |

#### Revert Mechanism

Restore the original `_renderClusterSummary` from `logs-enhancements.js:765-815` which
renders simple pill elements with count + label + chevron. Remove `_navigateToDAGNode`,
`_createTrendBadge`, and expanded entry list rendering.

---

### S07 — Cluster Expand (Filtered View)

**ID:** C07-S07
**Priority:** P3-Medium
**Description:** When a cluster row is clicked and expanded, show all matching log entries
as a filtered sub-list. Clicking an entry row scrolls the main log view to that entry.

**Source:** `src/frontend/js/logs-enhancements.js` (`_renderClusterSummary` — expanded section)
**Related:** `src/frontend/js/logs-enhancements.js:806-812` (existing click + scroll-to)

#### Technical Mechanism

Covered in S06 expanded section. Key details:

1. **Entry cap:** Maximum 50 entries shown in expanded view (of up to 500 stored).
2. **Scroll to entry:** Uses existing `_scrollToSeq(seq)` method from LogsEnhancements.
3. **Entry row format:** `HH:MM:SS <message-preview-120-chars>`
4. **"+N more" indicator** when entries exceed display cap.
5. **Re-render on collapse** removes the entry list DOM.

#### Edge Cases

| Case | Behavior |
|---|---|
| Entry's `seq` is no longer in ring buffer (evicted) | `_scrollToSeq` finds nearest available |
| Expand while log stream is LIVE | New entries may arrive but expanded list is static until re-render |
| Multiple clusters expanded | Each renders its own entry list; summary panel may become tall |

#### Revert Mechanism

Remove the expanded entry list rendering block from `_renderClusterSummary`. Cluster
pills revert to toggle + jump-to-first behavior only.

---

### S08 — Incremental Cluster Updates

**ID:** C07-S08
**Priority:** P3-High
**Description:** As new log entries arrive via `addLog`, update cluster counts, trends,
and node sets incrementally without scanning the full buffer.

**Source:** `src/frontend/js/error-intel.js` (`ClusterEngine.ingestEntry`)
**Source:** `src/frontend/js/logs-enhancements.js:1056-1066` (`refreshClusters`)

#### Technical Mechanism

```javascript
// Integration point: called from main.js addLog path or ErrorIntelligence.handleError
//
// Flow:
//   main.js addLog() -> state.logBuffer.push(entry)
//                     -> clusterEngine.ingestEntry(entry)     // O(1)
//                     -> if (clustersVersion % 50 === 0)      // throttle
//                          logsEnhancements._renderClusterSummary()

/**
 * Incremental update — O(1) per entry.
 */
ingestEntry(entry) {
  if (!this._isClusterableLevel(entry.level)) return;

  this._ingestEntry(entry); // creates or updates cluster

  // Bump version for change detection
  this._version++;
}

/**
 * Handle ring buffer wrap — entries evicted from the tail are no longer valid.
 * Full rebuild required when buffer wraps.
 */
onBufferWrap() {
  this.rebuildFromBuffer(this._buffer);
}
```

**Render throttling:**

The cluster summary DOM is expensive to rebuild on every log entry. Rendering is throttled:

```javascript
// In the log ingestion path:
clusterEngine.ingestEntry(entry);

if (clusterEngine.version % 50 === 0 || isErrorLevel) {
  // Re-render every 50 entries, or immediately on error entries
  requestAnimationFrame(() => {
    logsEnhancements._renderClusterSummary();
  });
}
```

**Buffer wrap detection:**

```javascript
// In state.js RingBuffer.push(), when head wraps:
if (this._count >= this._capacity) {
  // Oldest entry is being evicted
  this._onEvict && this._onEvict(this._buffer[this._head]);
}
```

The ClusterEngine registers an `_onEvict` callback. When the first eviction occurs after
a wrap, it sets a dirty flag. On the next `ingestEntry`, if dirty, it triggers a full
rebuild (amortized cost).

#### Edge Cases

| Case | Behavior |
|---|---|
| 1000 entries/second arrival rate | Render throttled to every 50 entries (20 renders/sec max) |
| Buffer wrap while cluster expanded | Expanded cluster may lose entries; re-render resets |
| Error entry arrives while summary hidden | Cluster state updated; summary shown on next render |
| `requestAnimationFrame` not available | Fallback to `setTimeout(fn, 0)` |

#### Revert Mechanism

Replace incremental `ingestEntry` call with periodic `refreshClusters()` (current behavior).
The existing `refreshClusters` at `logs-enhancements.js:1056-1066` does a full scan.

---

### S09 — Integration with C02 (Error Decoder)

**ID:** C07-S09
**Priority:** P3-Medium
**Description:** Bidirectional data flow between the Error Decoder (C02) and Enhanced
Clustering (C07). The decoder provides enriched error code metadata; clustering provides
occurrence counts and trend data back.

**Source:** `src/frontend/js/error-intel.js` (ClusterEngine API surface)

#### Technical Mechanism

**C02 → C07 (Decoder feeds Clustering):**

The Error Decoder resolves error codes from `error-codes.json`. When it decorates a
log row with a known code, the ClusterEngine's `_computeLabel` can use the human-readable
title:

```javascript
_computeLabel(entry) {
  const code = this._extractErrorCode(entry);
  if (code && window.ERROR_CODES_DB && window.ERROR_CODES_DB[code]) {
    return window.ERROR_CODES_DB[code].title || code;
  }
  // Fallback: same as existing _clusterLabel
  const msg = entry.message || '';
  const colonIdx = msg.indexOf(':');
  if (colonIdx > 0 && colonIdx < 60) return msg.substring(0, colonIdx);
  return msg.substring(0, 50);
}
```

**C07 → C02 (Clustering feeds Decoder):**

The Error Decoder's context card shows "N occurrences in this session" and trend.
It queries ClusterEngine:

```javascript
// In error-decoder.js context card rendering:
const cluster = clusterEngine.getClusterByCode(errorCode);
if (cluster) {
  occurrenceCount = cluster.count;
  trendDirection = cluster.trend;
  affectedNodes = [...cluster.nodes];
}
```

**API surface on ClusterEngine:**

```javascript
/** Get cluster by error code. O(1) via secondary index. */
getClusterByCode(code) {
  return this._codeIndex.get(code) || null;
}

/** Get cluster by full signature. O(1). */
getCluster(signature) {
  return this._clusters.get(signature) || null;
}

/** Get all clusters sorted by count descending. */
getSortedClusters() {
  return [...this._clusters.values()]
    .filter(c => c.count >= 2)  // minimum display threshold
    .sort((a, b) => b.count - a.count);
}

/** Current version counter (for change detection). */
get version() { return this._version; }
```

#### Edge Cases

| Case | Behavior |
|---|---|
| `ERROR_CODES_DB` not yet loaded | `_computeLabel` falls back to message prefix |
| Error code not in registry | Label shows raw code string; no enrichment |
| Multiple clusters share same code | `_codeIndex` maps to the first; additional clusters use full signature |
| Decoder context card opened before any clustering | `getClusterByCode` returns null; card shows "—" for count |

#### Revert Mechanism

Remove `getClusterByCode` calls from error-decoder.js. Context card falls back to its
own occurrence counter (separate `errorOccurrences` map in state).

---

### S10 — Integration with C06 (Error Timeline)

**ID:** C07-S10
**Priority:** P3-Low
**Description:** The Error Timeline (C06) can consume cluster data to show per-signature
time distributions. When hovering a timeline bar, clusters matching that time window
are highlighted in the summary panel.

**Source:** `src/frontend/js/error-intel.js` (ClusterEngine time-based queries)

#### Technical Mechanism

```javascript
/**
 * Get clusters that have entries within a time range.
 * Used by C06 Timeline for bar-hover highlights.
 * @param {number} startMs — start of time window (epoch ms)
 * @param {number} endMs   — end of time window (epoch ms)
 * @returns {GlobalCluster[]}
 */
getClustersInTimeRange(startMs, endMs) {
  const results = [];
  for (const cluster of this._clusters.values()) {
    const first = Date.parse(cluster.firstSeen);
    const last = Date.parse(cluster.lastSeen);
    // Cluster overlaps if it started before the window ends
    // and ended after the window starts
    if (first <= endMs && last >= startMs) {
      results.push(cluster);
    }
  }
  return results;
}
```

The Timeline (C06) calls this on bar hover and emits a highlight event:

```javascript
// C06 dispatches:
window.dispatchEvent(new CustomEvent('edog:timeline-hover', {
  detail: { startMs, endMs, clusterSignatures: clusters.map(c => c.signature) }
}));

// C07 listens in _renderClusterSummary or via a separate handler:
window.addEventListener('edog:timeline-hover', (e) => {
  const { clusterSignatures } = e.detail;
  // Add .le-cluster-row--highlighted class to matching rows
});
```

#### Edge Cases

| Case | Behavior |
|---|---|
| Timeline not mounted (C06 not initialized) | No events dispatched; C07 is unaffected |
| Time range covers entire session | All clusters returned |
| Cluster with entries but `firstSeen`/`lastSeen` unparseable | Excluded from results |

#### Revert Mechanism

Remove `getClustersInTimeRange` method and the `edog:timeline-hover` event listener.
Timeline and clustering operate independently (no cross-highlighting).

---

## 4. Integration Points

### 4.1 Data Flow Diagram

```
                             ┌──────────────────┐
                             │   auto-detect.js  │
                             │ AutoDetector      │
                             └────────┬──────────┘
                                      │ onErrorDetected(exec, error)
                                      ▼
┌──────────────────┐          ┌──────────────────┐         ┌──────────────────┐
│    state.js      │          │  error-intel.js   │         │  error-decoder.js│
│    RingBuffer    │─ entry ─▶│  ErrorIntelligence│◀─ code ─│  (C02)           │
│    (50K buffer)  │          │  + ClusterEngine  │─ count ─▶│  context card   │
└──────────────────┘          └────────┬──────────┘         └──────────────────┘
                                      │ getSortedClusters()
                                      ▼
                             ┌──────────────────┐
                             │ logs-enhance.js   │
                             │ _renderCluster    │
                             │   Summary()       │
                             └────────┬──────────┘
                                      │ getClustersInTimeRange()
                                      ▼
                             ┌──────────────────┐
                             │ error-timeline.js │
                             │ (C06)             │
                             └──────────────────┘
```

### 4.2 Event Bus

| Event | Producer | Consumer | Payload |
|---|---|---|---|
| `edog:navigate-to-node` | C07 (node pill click) | DAG tab | `{ nodeName: string }` |
| `edog:timeline-hover` | C06 (bar hover) | C07 (cluster highlight) | `{ startMs, endMs, clusterSignatures }` |
| `edog:cluster-updated` | C07 (ingestEntry) | C02 (context card refresh) | `{ signature, count, trend }` |

### 4.3 Initialization Order

```
1. state.js               — RingBuffer created
2. error-intel.js          — ErrorIntelligence + ClusterEngine constructed
3. logs-enhancements.js    — LogsEnhancements.init() wires ClusterEngine reference
4. error-decoder.js (C02)  — Decoder reads ClusterEngine for counts
5. error-timeline.js (C06) — Timeline reads ClusterEngine for time ranges
```

---

## 5. Performance

### 5.1 Targets

| Operation | Budget | Mechanism |
|---|---|---|
| `ingestEntry` (incremental) | < 0.05ms | Map.get + Map.set, Set.add — all O(1) |
| `rebuildFromBuffer` (50K entries) | < 100ms | Single pass, no sorting during scan |
| `getSortedClusters` | < 5ms | Array.from + sort on ~100 clusters max |
| `_renderClusterSummary` | < 16ms | DOM creation for ~10-20 cluster rows |
| `_computeTrend` (one cluster) | < 0.01ms | 120-iteration loop over number array |
| `_recomputeAllTrends` (100 clusters) | < 1ms | 100 x 0.01ms |
| Memory: ClusterEngine for 50K entries | < 5MB | Entries stored by reference, not copy |

### 5.2 Design Decisions for Performance

1. **`Map<string, GlobalCluster>` for O(1) signature lookup** — The current `Array.find`
   in `toggleCluster` is O(n). The new Map-based structure ensures O(1) for all
   cluster lookups by signature.

2. **Secondary `_codeIndex: Map<string, GlobalCluster>`** for O(1) lookup by error code.
   Maintained alongside `_clusters`.

3. **Entry cap (500 per cluster)** — Prevents unbounded memory growth when one error
   type dominates. The `count` field is always accurate; only `entries[]` is capped.

4. **Render throttling** — Summary DOM rebuild is throttled to every 50 entries or
   on error-level entries, whichever comes first. Uses `requestAnimationFrame` to
   avoid layout thrashing.

5. **Lazy sort** — `getSortedClusters` is called only when rendering, not on every
   ingest. The `_version` counter enables consumers to cache and check freshness.

6. **Circular window array** — Fixed 120-element `number[]` for trend computation.
   No allocation after initialization. No GC pressure.

7. **Amortized rebuild on buffer wrap** — Full rebuild happens once per buffer cycle
   (every 50K entries), not per eviction.

### 5.3 Memory Budget

| Structure | Per-Cluster Cost | At 100 Clusters |
|---|---|---|
| `GlobalCluster` fields | ~200 bytes | 20 KB |
| `nodes: Set` (avg 3 nodes) | ~150 bytes | 15 KB |
| `window: number[120]` | ~960 bytes | 96 KB |
| `entries: object[]` (refs, max 500) | ~4 KB | 400 KB |
| **Total** | ~5.3 KB | **~530 KB** |

Well within the 5MB budget even at extreme cluster counts.

---

## 6. Implementation Notes

### 6.1 File Changes Summary

**`src/frontend/js/error-intel.js`** — Major expansion:

| Change | Lines (approx) |
|---|---|
| Add `ClusterEngine` class (new) | +250 lines |
| Add frequency tracking to `ErrorIntelligence.handleError` | +15 lines |
| Add skipped-node tracking | +10 lines |
| Fix XSS in `showAlert` (escape summary string) | ~5 lines changed |

**`src/frontend/js/logs-enhancements.js`** — Surgical modifications:

| Change | Lines Affected |
|---|---|
| `constructor`: add `_clusterEngine` reference | Line ~50 |
| `detectClusters`: delegate to ClusterEngine | Lines 255-299 (replace body) |
| `_errorSignature`: preserved but unused by new path | Lines 1002-1007 (no change) |
| `_renderClusterSummary`: full replacement | Lines 765-815 (replace body, expand) |
| `refreshClusters`: delegate to ClusterEngine | Lines 1056-1066 (replace body) |
| `_navigateToDAGNode`: new method | +15 lines |
| `_createTrendBadge`: new method | +20 lines |

### 6.2 Backward Compatibility

The `ClusterEngine` is injected via the `LogsEnhancements` constructor or a setter:

```javascript
// In main.js initialization:
const clusterEngine = new ClusterEngine();
logsEnhancements.setClusterEngine(clusterEngine);
```

If `_clusterEngine` is null, `detectClusters` falls back to the existing consecutive
algorithm. This ensures the feature can be toggled off without code changes.

### 6.3 XSS Fix (Pre-existing)

`error-intel.js:38` uses unescaped `summary` in `innerHTML`. Fix during this component:

```javascript
// Before (UNSAFE):
this.alertElement.innerHTML = `<span class="error-summary">${summary}</span>`;

// After (SAFE):
const summarySpan = document.createElement('span');
summarySpan.className = 'error-summary';
summarySpan.textContent = summary; // textContent auto-escapes
```

### 6.4 CSS Classes Added

| Class | Purpose |
|---|---|
| `.le-cluster-header` | Summary panel header text |
| `.le-cluster-row` | Per-cluster row container (replaces `.le-cluster-pill`) |
| `.le-cluster-row.expanded` | Expanded row visual state |
| `.le-cluster-row--highlighted` | Timeline-hover highlight |
| `.le-cluster-trend` | Trend badge base |
| `.le-trend-rising` | ↑ red trend |
| `.le-trend-falling` | ↓ green trend |
| `.le-trend-stable` | → gray trend |
| `.le-cluster-time` | Time range display |
| `.le-cluster-nodes` | Node pills container |
| `.le-cluster-node-pill` | Individual node name pill |
| `.le-cluster-skipped` | Skipped nodes indicator |
| `.le-cluster-entries` | Expanded entry list container |
| `.le-cluster-entry-row` | Individual entry in expanded view |
| `.le-cluster-more` | "+N more" overflow indicator |

### 6.5 Testing Strategy

| Test | What | How |
|---|---|---|
| Global grouping | Interleaved errors produce single cluster | Feed `[A, B, A, C, A]` → assert 1 cluster for A with count=3 |
| Signature priority | Error code beats message prefix | Feed entry with `MLV_SPARK_SESSION_ACQUISITION_FAILED` → signature = code |
| Trend computation | Rising rate → ↑ | Feed 10 entries in last 30s, 2 in previous 30s → assert ↑ |
| Trend stable | Steady rate → → | Feed 10 entries in each 60s window → assert → |
| Node mapping | Multi-node error | Feed 3 entries from nodes A, B, A → assert `nodes = {A, B}` |
| Entry cap | 500 entries max stored | Feed 600 entries → assert `entries.length === 500`, `count === 600` |
| Buffer wrap | Rebuild accuracy | Fill 50K buffer, wrap, verify clusters reflect only live entries |
| Incremental ingest | O(1) per entry | Time 10K sequential ingests < 500ms total |
| Render throttle | No excessive DOM rebuilds | Assert `_renderClusterSummary` called < 250 times for 10K entries |
| XSS fix | No HTML injection in alert | Feed entry with `<script>` in message → assert escaped in DOM |
