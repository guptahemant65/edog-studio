// ===== COMMAND CENTER — Control Panel (Tab 4) =====

class ControlPanel {
  constructor(containerEl, { autoDetector, stateManager }) {
    this.container = containerEl;
    this.autoDetector = autoDetector;
    this.state = stateManager;

    // DOM refs
    this.connBar = document.getElementById('cp-connection-bar');
    this.dagOverview = document.getElementById('cp-dag-overview');
    this.execCard = document.getElementById('cp-execution');
    this.historyEl = document.getElementById('cp-history');

    // State
    this._config = null;
    this._dagData = null;
    this._lastDagFetch = 0;
    this._activeIterationId = null;
    this._elapsedTimer = null;
    this._isActive = false;

    // Subscribe to AutoDetector
    this._wireAutoDetector();
  }

  // === Lifecycle ===

  async activate() {
    this._isActive = true;
    await this._fetchConfigAndRender();
    this._fetchDagIfStale();
    this._fetchAndRenderHistory();
  }

  deactivate() {
    this._isActive = false;
    if (this._elapsedTimer) {
      clearInterval(this._elapsedTimer);
      this._elapsedTimer = null;
    }
  }

  // === API Methods ===

  async _safeJsonError(resp) {
    var body = {};
    try { body = await resp.json(); } catch (_) {}
    throw { status: resp.status, body: body };
  }

  _fabricHeaders() {
    return {
      'Authorization': 'Bearer ' + this._config.mwcToken,
      'X-CORRELATION-ID': crypto.randomUUID ? crypto.randomUUID() : Date.now().toString()
    };
  }

  async _fetchConfig() {
    const resp = await fetch('/api/flt/config');
    if (!resp.ok) await this._safeJsonError(resp);
    return await resp.json();
  }

  async _fetchLatestDag() {
    var url = this._config.fabricBaseUrl + '/liveTable/getLatestDag?showExtendedLineage=true';
    const resp = await fetch(url, { headers: this._fabricHeaders() });
    if (!resp.ok) await this._safeJsonError(resp);
    return await resp.json();
  }

  async _runDag() {
    var iterationId = crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      var r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
    var url = this._config.fabricBaseUrl + '/liveTableSchedule/runDAG/' + iterationId;
    const resp = await fetch(url, { method: 'POST', headers: this._fabricHeaders() });
    if (!resp.ok) await this._safeJsonError(resp);
    return { iterationId: iterationId, statusCode: resp.status };
  }

  async _cancelDag(iterationId) {
    var url = this._config.fabricBaseUrl + '/liveTableSchedule/cancelDAG/' + encodeURIComponent(iterationId);
    const resp = await fetch(url, { method: 'POST', headers: this._fabricHeaders() });
    if (!resp.ok) await this._safeJsonError(resp);
    var body = {};
    try { body = await resp.json(); } catch (_) {}
    return body;
  }

  async _fetchHistory() {
    const resp = await fetch('/api/executions');
    if (!resp.ok) return [];
    return await resp.json();
  }

  // === Orchestration ===

  async _fetchConfigAndRender() {
    try {
      this._config = await this._fetchConfig();
      this._renderConnectionBar(this._config);
    } catch (err) {
      this._config = null;
      this._renderConnectionError(err);
    }
  }

  async _fetchDagIfStale() {
    // Need config with valid token to call Fabric directly
    if (!this._config || !this._config.fabricBaseUrl || this._config.tokenExpired) {
      if (!this._activeIterationId) this._renderExecutionIdle();
      return;
    }
    if (Date.now() - this._lastDagFetch < 30000) {
      if (this._dagData) this._renderDagOverview(this._dagData);
      if (!this._activeIterationId) this._renderExecutionIdle();
      return;
    }
    try {
      this.dagOverview.innerHTML = '<div class="cp-loading">Loading DAG\u2026</div>';
      this._dagData = await this._fetchLatestDag();
      this._lastDagFetch = Date.now();
      this._renderDagOverview(this._dagData);
    } catch (err) {
      this._renderDagError(err);
    }
    if (!this._activeIterationId) this._renderExecutionIdle();
  }

  async _fetchAndRenderHistory() {
    try {
      const executions = await this._fetchHistory();
      this._renderHistory(executions);
    } catch (_) {
      // Leave existing history content intact on transient failure
    }
  }

  // === Rendering — Connection Bar ===

  _renderConnectionBar(config) {
    const expMins = config.tokenExpiryMinutes || 0;
    const expired = config.tokenExpired || expMins <= 0;
    const stateClass = expired ? 'expired' : 'connected';
    const statusText = expired
      ? 'Token Expired'
      : 'Connected \u00b7 Token valid (' + Math.round(expMins) + ' min)';

    this.connBar.className = 'connection-bar ' + stateClass;
    this.connBar.innerHTML =
      '<div class="conn-status-row">' +
        '<span class="conn-dot"></span>' +
        '<span class="conn-status-text">' + this._escapeHtml(statusText) + '</span>' +
      '</div>' +
      '<div class="conn-ids">' +
        this._renderIdRow('Workspace', config.workspaceId) +
        this._renderIdRow('Lakehouse', config.artifactId) +
        this._renderIdRow('Capacity', config.capacityId) +
      '</div>' +
      (expired
        ? '<div class="cp-banner warning">Run <code>edog --refresh-token</code> in terminal ' +
          '<button class="btn-copy" data-copy="edog --refresh-token">copy</button></div>'
        : '');

    this._bindCopyButtons(this.connBar);
  }

  _renderIdRow(label, value) {
    if (!value) return '';
    return '<div class="conn-id-row">' +
      '<span class="conn-id-label">' + this._escapeHtml(label) + '</span>' +
      '<code class="conn-id-value">' + this._escapeHtml(value) + '</code>' +
      '<button class="btn-copy" data-copy="' + this._escapeHtml(value) + '">copy</button>' +
    '</div>';
  }

  _renderConnectionError(err) {
    this.connBar.className = 'connection-bar error';
    var msg = (err && err.body && err.body.message) ? err.body.message : 'Cannot reach EDOG API proxy';
    this.connBar.innerHTML =
      '<div class="conn-status-row">' +
        '<span class="conn-dot"></span>' +
        '<span class="conn-status-text">Connection Error</span>' +
      '</div>' +
      '<div class="cp-banner error">' + this._escapeHtml(msg) +
        ' <button class="btn-secondary cp-retry-btn">Retry</button>' +
      '</div>';

    var self = this;
    var retryBtn = this.connBar.querySelector('.cp-retry-btn');
    if (retryBtn) retryBtn.addEventListener('click', function() { self.activate(); });
  }

  // === Rendering — DAG Overview ===

  _renderDagOverview(dagData) {
    var self = this;
    var nodes = this._extractNodes(dagData);
    var dagName = this._extractDagName(dagData);
    var refreshMode = this._extractRefreshMode(dagData);

    if (!nodes || nodes.length === 0) {
      this.dagOverview.innerHTML =
        '<div class="overview-header">' +
          '<h3>DAG Overview</h3>' +
          '<button class="btn-secondary cp-refresh-dag">&#8635; Refresh</button>' +
        '</div>' +
        '<div class="overview-empty">No LiveTable definitions found. Create materialized views in Fabric first.</div>';
      this._bindRefreshDag(this.dagOverview);
      return;
    }

    var rowsHtml = nodes.map(function(n) {
      var deps = (n.dependencies && n.dependencies.length) ? n.dependencies.map(function(d) { return self._escapeHtml(d); }).join(', ') : '\u2014';
      return '<tr>' +
        '<td class="node-name">' + self._escapeHtml(n.name) + '</td>' +
        '<td class="node-type">' + self._escapeHtml(n.type || '\u2014') + '</td>' +
        '<td class="node-deps">' + deps + '</td>' +
      '</tr>';
    }).join('');

    this.dagOverview.innerHTML =
      '<div class="overview-header">' +
        '<h3>' + this._escapeHtml(dagName || 'DAG') + '</h3>' +
        '<div class="overview-badges">' +
          '<span class="status-pill running">' + nodes.length + ' nodes</span>' +
          (refreshMode ? '<span class="status-pill">' + this._escapeHtml(refreshMode) + '</span>' : '') +
        '</div>' +
        '<button class="btn-secondary cp-refresh-dag">&#8635; Refresh</button>' +
      '</div>' +
      '<table class="node-table">' +
        '<thead><tr><th>Node Name</th><th>Type</th><th>Dependencies</th></tr></thead>' +
        '<tbody>' + rowsHtml + '</tbody>' +
      '</table>';
    this._bindRefreshDag(this.dagOverview);
  }

  _extractNodes(dagData) {
    if (!dagData) return [];
    var raw = dagData.nodes || dagData.nodeDefinitions || dagData.dagNodes ||
              dagData.Nodes || dagData.NodeDefinitions || [];
    if (Array.isArray(raw)) {
      return raw.map(function(n) {
        return {
          name: n.name || n.Name || n.displayName || n.DisplayName || 'Unknown',
          type: n.type || n.Type || n.nodeType || n.NodeType || null,
          dependencies: n.dependencies || n.Dependencies || n.inputNodes || n.InputNodes || []
        };
      });
    }
    if (typeof raw === 'object' && raw !== null) {
      return Object.entries(raw).map(function(entry) {
        var key = entry[0], val = entry[1];
        return {
          name: key,
          type: (val && (val.type || val.Type)) || null,
          dependencies: (val && (val.dependencies || val.Dependencies)) || []
        };
      });
    }
    return [];
  }

  _extractDagName(dagData) {
    return (dagData && (dagData.dagName || dagData.DagName || dagData.displayName ||
            dagData.DisplayName || dagData.name || dagData.Name)) || null;
  }

  _extractRefreshMode(dagData) {
    return (dagData && (dagData.refreshMode || dagData.RefreshMode ||
            (dagData.settings && dagData.settings.refreshMode))) || null;
  }

  _renderDagError(err) {
    var status = (err && err.status) || 0;
    var body = (err && err.body) || {};
    var banner;

    if (status === 401 || status === 403 || body.error === 'token_expired') {
      banner = '<div class="cp-banner warning">Authentication failed. Run <code>edog --refresh-token</code> ' +
        '<button class="btn-copy" data-copy="edog --refresh-token">copy</button></div>';
    } else if (status === 404) {
      banner = '<div class="cp-banner error">Lakehouse not found. Verify IDs in edog-config.json.</div>';
    } else if (status === 502 || status === 0) {
      banner = '<div class="cp-banner error">Cannot reach Fabric service. Check VPN/network. ' +
        '<button class="btn-secondary cp-refresh-dag">Retry</button></div>';
    } else {
      banner = '<div class="cp-banner error">Server error (' + status + '): ' + this._escapeHtml(body.message || 'Unknown') +
        ' <button class="btn-secondary cp-refresh-dag">Retry</button></div>';
    }

    this.dagOverview.innerHTML =
      '<div class="overview-header"><h3>DAG Overview</h3></div>' + banner;

    this._bindCopyButtons(this.dagOverview);
    this._bindRefreshDag(this.dagOverview);
  }

  async _refreshDag() {
    this._lastDagFetch = 0;
    await this._fetchDagIfStale();
  }

  // === Rendering — Execution Control ===

  _renderExecutionIdle() {
    var self = this;
    var lastExec = this._getLastExecution();
    var lastSummary = '';
    if (lastExec) {
      var st = lastExec.status || '';
      var isOk = st === 'Succeeded' || st === 'Completed';
      var isFail = st === 'Failed';
      var statusIcon = isOk ? '\u2713' : isFail ? '\u2717' : '\u2298';
      var statusClass = isOk ? 'succeeded' : isFail ? 'failed' : 'cancelled';
      var dur = lastExec.duration ? (lastExec.duration / 1000).toFixed(1) + 's' : '';
      var ago = lastExec.endTime ? this._timeAgo(new Date(lastExec.endTime)) : '';
      lastSummary = '<div class="last-exec-summary">' +
        'Last: <span class="status-pill ' + statusClass + '">' + statusIcon + ' ' + this._escapeHtml(st) + '</span>' +
        (dur ? ' \u00b7 ' + dur : '') + (ago ? ' \u00b7 ' + ago : '') +
      '</div>';
    }

    var dagLoaded = this._dagData && this._extractNodes(this._dagData).length > 0;
    var configOk = this._config && !this._config.tokenExpired;
    var disabled = !dagLoaded || !configOk;
    var disabledReason = !configOk ? 'Token expired' : !dagLoaded ? 'No DAG loaded' : '';

    this.execCard.className = 'execution-card idle';
    this.execCard.innerHTML =
      '<button class="btn-run"' + (disabled ? ' disabled title="' + this._escapeHtml(disabledReason) + '"' : '') + '>' +
        '\u25b6 Run DAG' +
      '</button>' + lastSummary;

    var runBtn = this.execCard.querySelector('.btn-run');
    if (runBtn) runBtn.addEventListener('click', function() { self._handleRunDag(); });
  }

  _renderExecutionActive(iterationId, execution) {
    var self = this;
    var startMs = execution && execution.startTime
      ? new Date(execution.startTime).getTime()
      : Date.now();
    var elapsed = Math.round((Date.now() - startMs) / 1000);
    var totalNodes = (execution && execution.nodeCount) ||
                     (this._extractNodes(this._dagData) || []).length || 0;
    var completed = (execution && execution.completedNodes) || 0;
    var failed = (execution && execution.failedNodes) || 0;
    var done = completed + failed;
    var pct = totalNodes > 0 ? Math.round((done / totalNodes) * 100) : 0;
    var shortId = iterationId ? this._escapeHtml(iterationId.substring(iterationId.length - 8)) : '...';

    // Build node list from execution data
    var nodeListHtml = '';
    if (execution && execution.nodes) {
      var entries = (typeof execution.nodes.entries === 'function')
        ? Array.from(execution.nodes.entries())
        : Object.entries(execution.nodes);
      nodeListHtml = entries.map(function(pair) {
        var name = pair[0], info = pair[1];
        var status = ((info && info.status) || '').toLowerCase();
        var icon, cls, durText;
        if (status === 'completed' || status === 'succeeded') {
          icon = '\u2713'; cls = 'completed';
          durText = info.duration ? (info.duration / 1000).toFixed(1) + 's' : '';
        } else if (status === 'running' || status === 'executing') {
          icon = '\u27f3'; cls = 'running';
          durText = info.startTime ? Math.round((Date.now() - new Date(info.startTime).getTime()) / 1000) + 's' : '';
        } else if (status === 'failed' || status === 'faulted') {
          icon = '\u2717'; cls = 'failed';
          durText = self._escapeHtml(info.errorCode || '');
        } else if (status === 'skipped') {
          icon = '\u2298'; cls = 'skipped'; durText = '';
        } else {
          icon = '\u25cb'; cls = 'waiting'; durText = '';
        }
        return '<div class="node-status-item ' + cls + '">' +
          '<span class="node-icon">' + icon + '</span>' +
          '<span class="node-name">' + self._escapeHtml(name) + '</span>' +
          '<span class="node-dur">' + durText + '</span>' +
        '</div>';
      }).join('');
    }

    this.execCard.className = 'execution-card active';
    this.execCard.innerHTML =
      '<div class="exec-active-header">' +
        '<span class="exec-status-icon">\u27f3</span>' +
        '<span>Running: <code>...' + shortId + '</code></span>' +
        '<span class="exec-elapsed" id="cp-elapsed">' + elapsed + 's</span>' +
      '</div>' +
      '<div class="exec-progress"><div class="exec-progress-fill" style="width:' + pct + '%"></div></div>' +
      '<div class="exec-progress-text">' + done + '/' + totalNodes + ' nodes</div>' +
      '<div class="node-status-list">' + nodeListHtml + '</div>' +
      '<div class="exec-actions">' +
        '<button class="btn-cancel">\u23f9 Cancel</button>' +
        '<button class="btn-secondary cp-watch-logs">\u2197 Watch Logs</button>' +
      '</div>';

    var cancelBtn = this.execCard.querySelector('.btn-cancel');
    if (cancelBtn) cancelBtn.addEventListener('click', function() { self._handleCancelDag(iterationId); });
    var watchBtn = this.execCard.querySelector('.cp-watch-logs');
    if (watchBtn) watchBtn.addEventListener('click', function() { self._handleWatchLogs(); });

    // Start elapsed timer
    if (this._elapsedTimer) clearInterval(this._elapsedTimer);
    var timerStart = startMs;
    this._elapsedTimer = setInterval(function() {
      var el = document.getElementById('cp-elapsed');
      if (el) el.textContent = Math.round((Date.now() - timerStart) / 1000) + 's';
    }, 1000);
  }

  // === Action Handlers ===

  async _handleRunDag() {
    var btn = this.execCard.querySelector('.btn-run');
    if (btn) { btn.disabled = true; btn.textContent = '\u27f3 Submitting\u2026'; }

    try {
      var result = await this._runDag();
      this._activeIterationId = result.iterationId;
      if (this.autoDetector && typeof this.autoDetector.ensureExecution === 'function') {
        this.autoDetector.ensureExecution(result.iterationId);
      }
      this._renderExecutionActive(result.iterationId, {
        status: 'Running',
        startTime: new Date().toISOString(),
        nodeCount: 0
      });
    } catch (err) {
      if (btn) { btn.disabled = false; btn.textContent = '\u25b6 Run DAG'; }
      var body = (err && err.body) || {};
      var msg = body.error === 'token_expired'
        ? 'Token expired \u2014 run edog --refresh-token'
        : body.message || ('Error (' + ((err && err.status) || 'unknown') + ')');
      var existing = this.execCard.querySelector('.exec-error');
      if (existing) existing.remove();
      var errorDiv = document.createElement('div');
      errorDiv.className = 'cp-banner error exec-error';
      errorDiv.textContent = msg;
      this.execCard.appendChild(errorDiv);
    }
  }

  async _handleCancelDag(iterationId) {
    var btn = this.execCard.querySelector('.btn-cancel');
    if (!btn) return;

    // Inline confirmation
    if (!btn.dataset.confirmed) {
      btn.textContent = 'Cancel? Confirm';
      btn.dataset.confirmed = 'pending';
      setTimeout(function() {
        if (btn.dataset.confirmed === 'pending') {
          btn.textContent = '\u23f9 Cancel';
          delete btn.dataset.confirmed;
        }
      }, 3000);
      return;
    }

    btn.disabled = true;
    btn.textContent = '\u27f3 Cancelling\u2026';
    delete btn.dataset.confirmed;

    try {
      await this._cancelDag(iterationId);
      this._activeIterationId = null;
      if (this._elapsedTimer) { clearInterval(this._elapsedTimer); this._elapsedTimer = null; }
      this._renderExecutionIdle();
      this._fetchAndRenderHistory();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = '\u23f9 Cancel';
      var body = (err && err.body) || {};
      var msg = body.error === 'token_expired'
        ? 'Token expired \u2014 run edog --refresh-token'
        : body.message || ('Cancel failed (' + ((err && err.status) || 'unknown') + ')');
      var existing = this.execCard.querySelector('.exec-error');
      if (existing) existing.remove();
      var errorDiv = document.createElement('div');
      errorDiv.className = 'cp-banner error exec-error';
      errorDiv.textContent = msg;
      this.execCard.appendChild(errorDiv);
    }
  }

  _handleWatchLogs() {
    if (!window.edogViewer) return;
    window.edogViewer.switchTab('logs');
    if (this._activeIterationId && this.autoDetector) {
      var exec = this.autoDetector.detectedExecutions.get(this._activeIterationId);
      if (exec && exec.raids && exec.raids.size > 0) {
        var firstRaid = exec.raids.values().next().value;
        var raidInput = document.getElementById('raid-filter-input');
        if (raidInput) raidInput.value = firstRaid;
        window.edogViewer.applyRaidFilter(firstRaid);
      }
    }
  }

  // === Rendering — History ===

  _renderHistory(executions) {
    if (!executions || executions.length === 0) {
      this.historyEl.innerHTML = '';
      return;
    }

    var self = this;
    var rows = executions.slice(0, 10).map(function(ex) {
      var shortId = ex.iterationId
        ? '...' + self._escapeHtml(ex.iterationId.substring(ex.iterationId.length - 8))
        : '\u2014';
      var st = ex.status || '';
      var statusClass = st === 'Succeeded' ? 'succeeded' : st === 'Failed' ? 'failed' : 'cancelled';
      var statusIcon = st === 'Succeeded' ? '\u2713' : st === 'Failed' ? '\u2717' : '\u2298';
      var ago = ex.firstSeen ? self._timeAgo(new Date(ex.firstSeen)) : '';
      var evtCount = (ex.logCount || 0) + (ex.eventCount || 0);
      return '<tr>' +
        '<td><code>' + shortId + '</code></td>' +
        '<td><span class="status-pill ' + statusClass + '">' + statusIcon + ' ' + self._escapeHtml(st) + '</span></td>' +
        '<td>' + evtCount + ' events</td>' +
        '<td class="history-time">' + ago + '</td>' +
      '</tr>';
    }).join('');

    this.historyEl.innerHTML =
      '<div class="history-header">' +
        '<h4>Recent Executions</h4>' +
        '<button class="btn-secondary cp-refresh-history">&#8635;</button>' +
      '</div>' +
      '<table class="exec-history-table">' +
        '<thead><tr><th>Iteration</th><th>Status</th><th>Events</th><th>Time</th></tr></thead>' +
        '<tbody>' + rows + '</tbody>' +
      '</table>';

    var refreshBtn = this.historyEl.querySelector('.cp-refresh-history');
    if (refreshBtn) refreshBtn.addEventListener('click', function() { self._fetchAndRenderHistory(); });
  }

  // === AutoDetector Integration ===

  _wireAutoDetector() {
    if (!this.autoDetector) return;
    var self = this;

    var origDetected = this.autoDetector.onExecutionDetected;
    this.autoDetector.onExecutionDetected = function(exec, id) {
      if (origDetected) origDetected(exec, id);
      if (self._isActive && id === self._activeIterationId) {
        self._renderExecutionActive(id, exec);
      }
    };

    var origUpdated = this.autoDetector.onExecutionUpdated;
    this.autoDetector.onExecutionUpdated = function(exec, id) {
      if (origUpdated) origUpdated(exec, id);
      if (self._isActive && id === self._activeIterationId) {
        self._renderExecutionActive(id, exec);
        if (exec.status === 'Completed' || exec.status === 'Failed' || exec.status === 'Cancelled') {
          self._activeIterationId = null;
          if (self._elapsedTimer) { clearInterval(self._elapsedTimer); self._elapsedTimer = null; }
          setTimeout(function() {
            self._renderExecutionIdle();
            self._fetchAndRenderHistory();
          }, 3000);
        }
      }
    };
  }

  // === Helpers ===

  _escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
              .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  _bindCopyButtons(container) {
    container.querySelectorAll('.btn-copy[data-copy]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        navigator.clipboard.writeText(btn.getAttribute('data-copy'));
      });
    });
  }

  _bindRefreshDag(container) {
    var self = this;
    container.querySelectorAll('.cp-refresh-dag').forEach(function(btn) {
      btn.addEventListener('click', function() { self._refreshDag(); });
    });
  }

  _getLastExecution() {
    if (!this.autoDetector) return null;
    var execs = Array.from(this.autoDetector.detectedExecutions.entries());
    if (execs.length === 0) return null;
    var completed = execs.filter(function(entry) {
      var e = entry[1];
      return e.status === 'Completed' || e.status === 'Failed' || e.status === 'Cancelled';
    });
    if (completed.length === 0) return execs[execs.length - 1] ? execs[execs.length - 1][1] : null;
    return completed[completed.length - 1][1];
  }

  _timeAgo(date) {
    var secs = Math.round((Date.now() - date.getTime()) / 1000);
    if (secs < 60) return secs + 's ago';
    if (secs < 3600) return Math.round(secs / 60) + ' min ago';
    if (secs < 86400) return Math.round(secs / 3600) + ' hr ago';
    return Math.round(secs / 86400) + 'd ago';
  }
}
