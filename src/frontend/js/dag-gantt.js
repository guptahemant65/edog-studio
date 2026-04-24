/**
 * DagGantt — Horizontal timeline visualization of DAG execution.
 *
 * Renders per-node bars on a shared time axis. Supports:
 * - Live streaming (bars grow in real-time)
 * - Historical replay
 * - Cross-highlighting with graph
 */
/* global document, setInterval, clearInterval, Date */
/* exported DagGantt */
var DagGantt = (function() {
  'use strict';

  function DagGantt(container) {
    this._container = container;
    this._bars = new Map();
    this._startTime = null;
    this._endTime = null;
    this._liveTimer = null;

    // Callbacks
    this.onNodeSelected = null;
    this.onNodeHovered = null;
    this.onNodeUnhovered = null;
  }

  /**
   * Initialize gantt for an execution. Creates rows for all nodes.
   * @param {Array} nodes - Array of { id, name } objects
   * @param {number} startTime - Execution start time (epoch ms)
   */
  DagGantt.prototype.renderExecution = function(nodes, startTime) {
    this.destroy();
    this._startTime = startTime || Date.now();
    this._endTime = null;
    this._container.innerHTML = '';

    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      var nodeId = node.id || node.nodeId;
      var name = node.name || nodeId;

      var row = document.createElement('div');
      row.className = 'gantt-row';
      row.setAttribute('data-node-id', nodeId);

      var label = document.createElement('div');
      label.className = 'gantt-label';
      label.textContent = name;
      label.title = name;

      var track = document.createElement('div');
      track.className = 'gantt-track';

      var bar = document.createElement('div');
      bar.className = 'gantt-bar';
      bar.style.left = '0%';
      bar.style.width = '0%';
      track.appendChild(bar);

      row.appendChild(label);
      row.appendChild(track);
      this._container.appendChild(row);

      var self = this;
      (function(nId) {
        row.addEventListener('click', function() {
          if (self.onNodeSelected) self.onNodeSelected(nId);
        });
        row.addEventListener('mouseenter', function() {
          if (self.onNodeHovered) self.onNodeHovered(nId);
        });
        row.addEventListener('mouseleave', function() {
          if (self.onNodeUnhovered) self.onNodeUnhovered();
        });
      })(nodeId);

      this._bars.set(nodeId, {
        el: row,
        barEl: bar,
        status: 'pending',
        startedAt: null,
        endedAt: null
      });
    }
  };

  /**
   * Update a node's bar state.
   * @param {string} nodeId
   * @param {{ status: string, startedAt: number|null, endedAt: number|null }} state
   */
  DagGantt.prototype.updateBar = function(nodeId, state) {
    var entry = this._bars.get(nodeId);
    if (!entry) return;

    entry.status = state.status;
    entry.startedAt = state.startedAt;
    entry.endedAt = state.endedAt;

    // Update bar CSS class
    entry.barEl.className = 'gantt-bar';
    if (state.status) entry.barEl.classList.add(state.status);

    this._recalcBars();

    // Start live timer if any node is running and timer not started
    if (state.status === 'running' && !this._liveTimer) {
      this._startLiveTimer();
    }

    // Check if all are terminal — stop live timer
    var allDone = true;
    var iter = this._bars.values();
    var next = iter.next();
    while (!next.done) {
      var s = next.value.status;
      if (s === 'running' || s === 'pending') { allDone = false; break; }
      next = iter.next();
    }
    if (allDone && this._liveTimer) {
      this._stopLiveTimer();
    }
  };

  /**
   * Highlight a gantt row for cross-highlighting.
   * @param {string} nodeId
   */
  DagGantt.prototype.highlightNode = function(nodeId) {
    var iter = this._bars.entries();
    var next = iter.next();
    while (!next.done) {
      next.value[1].el.classList.toggle('highlighted', next.value[0] === nodeId);
      next = iter.next();
    }
  };

  /** Remove all highlights. */
  DagGantt.prototype.unhoverNode = function() {
    var iter = this._bars.values();
    var next = iter.next();
    while (!next.done) {
      next.value.el.classList.remove('highlighted');
      next = iter.next();
    }
  };

  /** Clean up. */
  DagGantt.prototype.destroy = function() {
    this._stopLiveTimer();
    this._bars.clear();
    this._container.innerHTML = '<div class="dag-empty-hint">Run a DAG to see the timeline</div>';
    this._startTime = null;
    this._endTime = null;
  };

  // --- Private ---

  /** Recalculate all bar positions and widths based on the time range. */
  DagGantt.prototype._recalcBars = function() {
    if (!this._startTime) return;

    var now = Date.now();
    var maxEnd = this._startTime;
    var iter = this._bars.values();
    var next = iter.next();
    while (!next.done) {
      var b = next.value;
      if (b.endedAt && b.endedAt > maxEnd) maxEnd = b.endedAt;
      if (b.status === 'running') maxEnd = now;
      next = iter.next();
    }

    var totalDuration = maxEnd - this._startTime;
    if (totalDuration <= 0) totalDuration = 1000; // minimum 1s

    var iter2 = this._bars.values();
    var next2 = iter2.next();
    while (!next2.done) {
      var bar = next2.value;

      if (!bar.startedAt || bar.status === 'pending') {
        bar.barEl.style.left = '0%';
        bar.barEl.style.width = '0%';
        next2 = iter2.next();
        continue;
      }

      var left = ((bar.startedAt - this._startTime) / totalDuration) * 100;
      var end = bar.endedAt || (bar.status === 'running' ? now : bar.startedAt);
      var width = ((end - this._startTime) / totalDuration) * 100 - left;
      if (width < 0.5) width = 0.5; // minimum visible width

      bar.barEl.style.left = left.toFixed(2) + '%';
      bar.barEl.style.width = width.toFixed(2) + '%';
      next2 = iter2.next();
    }
  };

  /** Start live timer to update running bars every 200ms. */
  DagGantt.prototype._startLiveTimer = function() {
    this._stopLiveTimer();
    var self = this;
    this._liveTimer = setInterval(function() {
      self._recalcBars();
    }, 200);
  };

  /** Stop live timer. */
  DagGantt.prototype._stopLiveTimer = function() {
    if (this._liveTimer) {
      clearInterval(this._liveTimer);
      this._liveTimer = null;
    }
  };

  return DagGantt;
})();
