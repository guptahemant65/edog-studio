/**
 * EDOG Real-Time Log Viewer - Execution Summary
 */

// ===== EXECUTION SUMMARY (W0.4) =====

class ExecutionSummary {
  constructor(state, renderer) {
    this.state = state;
    this.renderer = renderer;
  }

  compute = (iterationId) => {
    if (!iterationId) return null;
    const idLower = iterationId.toLowerCase();

    // Gather matching logs
    const logs = this.state.logs.filter(l => {
      const lid = (l.iterationId || '').toLowerCase();
      const msg = (l.message || '').toLowerCase();
      const rid = (l.rootActivityId || '').toLowerCase();
      return lid.includes(idLower) || msg.includes(idLower) || rid.includes(idLower);
    });

    // Gather matching SSR events
    const ssrEvents = this.state.telemetry.filter(e => {
      const eid = ((e.attributes && e.attributes.IterationId) || '').toLowerCase();
      const cid = (e.correlationId || '').toLowerCase();
      return eid.includes(idLower) || cid.includes(idLower);
    });

    // Extract DAG metrics
    const metrics = this.extractMetrics(logs, ssrEvents);
    const nodes = this.extractNodes(logs, ssrEvents);
    const errors = this.extractErrors(logs);
    const timeline = this.extractTimeline(logs);

    return { metrics, nodes, errors, timeline, logCount: logs.length, ssrCount: ssrEvents.length };
  }

  extractMetrics = (logs, ssrEvents) => {
    const result = { status: 'Unknown', duration: '—', started: '—', refreshMode: '—', nodeCount: '—', errorCount: 0, parallelLimit: '—' };

    // Find DAG status from logs
    for (const log of logs) {
      const msg = log.message || '';
      if (msg.includes('[DAG STATUS]')) {
        if (msg.includes('Completed') || msg.includes('completed')) {
          result.status = msg.includes('error') || msg.includes('Error') || msg.includes('fault') ? 'Failed' : 'Completed';
        } else if (msg.includes('Started') || msg.includes('started') || msg.includes('Starting')) {
          if (result.status === 'Unknown') result.status = 'Running';
        }
      }
    }

    // Check SSR for RunDag activity
    const runDagEvents = ssrEvents.filter(e => (e.activityName || '').toLowerCase().includes('rundag'));
    if (runDagEvents.length > 0) {
      const last = runDagEvents[runDagEvents.length - 1];
      if (last.activityStatus) result.status = last.activityStatus;
      if (last.durationMs) result.duration = this.renderer.formatDuration(last.durationMs);
      if (last.timestamp) result.started = this.renderer.formatTime(last.timestamp);
    }

    // Extract from log messages
    for (const log of logs) {
      const msg = log.message || '';
      const refreshMatch = msg.match(/refresh\s*(?:mode|type)?\s*[=:]\s*(\w+)/i);
      if (refreshMatch) result.refreshMode = refreshMatch[1];
      const nodeCountMatch = msg.match(/(\d+)\s*nodes?/i);
      if (nodeCountMatch && result.nodeCount === '—') result.nodeCount = nodeCountMatch[1];
      const parallelMatch = msg.match(/parallel\s*(?:limit|degree)?\s*[=:]\s*(\d+)/i);
      if (parallelMatch) result.parallelLimit = parallelMatch[1];
      if (log.timestamp && result.started === '—') result.started = this.renderer.formatTime(log.timestamp);
    }

    // Count errors
    result.errorCount = logs.filter(l => l.level === 'Error').length;

    return result;
  }

  extractNodes = (logs, ssrEvents) => {
    const nodeMap = new Map();

    // From SSR NodeExecution activities
    ssrEvents.filter(e => (e.activityName || '').toLowerCase().includes('nodeexecution')).forEach(e => {
      const nodeName = (e.attributes && (e.attributes.NodeName || e.attributes.nodeName)) || e.activityName || 'Unknown';
      nodeMap.set(nodeName, {
        name: nodeName,
        status: e.activityStatus || 'Unknown',
        duration: e.durationMs ? this.renderer.formatDuration(e.durationMs) : '—',
        error: e.resultCode && e.resultCode !== 'OK' ? e.resultCode : ''
      });
    });

    // From log messages about node execution
    for (const log of logs) {
      const msg = log.message || '';
      const execMatch = msg.match(/Executed node\s+['"]?(\w+)['"]?\s+with final status\s+(\w+)/i);
      if (execMatch) {
        const name = execMatch[1];
        const existing = nodeMap.get(name) || { name, status: 'Unknown', duration: '—', error: '' };
        existing.status = execMatch[2];
        nodeMap.set(name, existing);
      }
      const startMatch = msg.match(/Executing node\s+['"]?(\w+)['"]?/i);
      if (startMatch && !nodeMap.has(startMatch[1])) {
        nodeMap.set(startMatch[1], { name: startMatch[1], status: 'Running', duration: '—', error: '' });
      }
    }

    // Faulted/skipped nodes
    for (const log of logs) {
      const msg = log.message || '';
      if (msg.includes('[DAG_FAULTED_NODES]')) {
        const faultedMatch = msg.match(/\[DAG_FAULTED_NODES\]\s*(.*)/i);
        if (faultedMatch) {
          const names = faultedMatch[1].split(',').map(s => s.trim()).filter(Boolean);
          names.forEach(name => {
            if (!nodeMap.has(name)) {
              nodeMap.set(name, { name, status: 'Skipped', duration: '—', error: 'upstream' });
            }
          });
        }
      }
    }

    return Array.from(nodeMap.values());
  }

  extractErrors = (logs) => {
    const errorMap = new Map();
    logs.filter(l => l.level === 'Error').forEach(log => {
      const msg = log.message || '';
      const codeMatch = msg.match(/\b(MLV_\w+|ERR_\w+|ERROR_\w+)\b/);
      const code = codeMatch ? codeMatch[1] : 'UNKNOWN_ERROR';
      const existing = errorMap.get(code) || { code, message: msg.substring(0, 120), count: 0, node: '' };
      existing.count++;
      // Try to extract node name from context
      const nodeMatch = msg.match(/[Nn]ode[:\s]+['"]?(\w+)['"]?/);
      if (nodeMatch) existing.node = nodeMatch[1];
      errorMap.set(code, existing);
    });
    return Array.from(errorMap.values());
  }

  extractTimeline = (logs) => {
    const events = [];
    for (const log of logs) {
      const msg = log.message || '';
      const time = this.renderer.formatTime(log.timestamp);
      if (msg.includes('[DAG STATUS]')) {
        let icon = '🟢', type = 'start';
        if (msg.toLowerCase().includes('completed') || msg.toLowerCase().includes('finished')) {
          icon = msg.toLowerCase().includes('error') || msg.toLowerCase().includes('fault') ? '🔴' : '🟢';
          type = msg.toLowerCase().includes('error') ? 'end-fail' : 'end-success';
        }
        events.push({ time, icon, text: msg.replace('[DAG STATUS]', '').trim(), type });
      } else if (msg.match(/Executing node\s+['"]?(\w+)['"]?/i)) {
        const m = msg.match(/Executing node\s+['"]?(\w+)['"]?/i);
        events.push({ time, icon: '▶️', text: `Node ${m[1]} started`, type: 'start' });
      } else if (msg.match(/Executed node\s+['"]?(\w+)['"]?\s+with final status\s+(\w+)/i)) {
        const m = msg.match(/Executed node\s+['"]?(\w+)['"]?\s+with final status\s+(\w+)/i);
        const ok = m[2].toLowerCase() === 'succeeded' || m[2].toLowerCase() === 'completed';
        events.push({ time, icon: ok ? '✅' : '❌', text: `${m[1]} ${m[2]}`, type: ok ? 'end-success' : 'end-fail' });
      } else if (log.level === 'Error') {
        events.push({ time, icon: '❌', text: msg.substring(0, 100), type: 'error' });
      } else if (msg.includes('[DAG_FAULTED_NODES]')) {
        events.push({ time, icon: '⊘', text: msg.replace('[DAG_FAULTED_NODES]', 'Skipped nodes:').trim(), type: 'skip' });
      }
    }
    return events.slice(0, 50); // Cap at 50 events
  }

  render = (data) => {
    if (!data) return;
    const container = document.getElementById('exec-summary-data');
    const emptyEl = document.getElementById('exec-summary-empty');
    if (!container) return;

    if (emptyEl) emptyEl.style.display = 'none';
    container.style.display = 'block';

    const statusIcon = { 'Completed': '🟢', 'Succeeded': '🟢', 'Failed': '🔴', 'Running': '🟡', 'Cancelled': '🟠' }[data.metrics.status] || '⚪';
    const statusClass = { 'Completed': 'success', 'Succeeded': 'success', 'Failed': 'error', 'Running': 'running', 'Cancelled': 'warning' }[data.metrics.status] || '';

    const nodesSucceeded = data.nodes.filter(n => n.status.toLowerCase() === 'succeeded' || n.status.toLowerCase() === 'completed').length;

    let nodesHtml = '';
    if (data.nodes.length > 0) {
      nodesHtml = `<table><thead><tr><th>Node</th><th>Status</th><th>Duration</th><th>Error</th></tr></thead><tbody>`;
      data.nodes.forEach(n => {
        const icon = { 'Succeeded': '✅', 'Completed': '✅', 'Failed': '❌', 'Running': '🟡', 'Skipped': '⊘' }[n.status] || '⚪';
        nodesHtml += `<tr><td>${this.esc(n.name)}</td><td>${icon} ${this.esc(n.status)}</td><td>${this.esc(n.duration)}</td><td style="color:#f87171">${this.esc(n.error)}</td></tr>`;
      });
      nodesHtml += `</tbody></table>`;
    } else {
      nodesHtml = `<div style="padding:16px;color:var(--text-dim);text-align:center">No node data found</div>`;
    }

    let errorsHtml = '';
    if (data.errors.length > 0) {
      errorsHtml = data.errors.map(e => `
        <div class="exec-error-item">
          <span class="exec-error-code">❌ ${this.esc(e.code)}</span> — "${this.esc(e.message)}"
          <div class="exec-error-meta">${e.node ? `Node: ${this.esc(e.node)} │ ` : ''}Count: ${e.count}</div>
        </div>
      `).join('');
    }

    let timelineHtml = '';
    if (data.timeline.length > 0) {
      timelineHtml = data.timeline.map(e => `
        <div class="timeline-item ${e.type}">
          <span class="timeline-time">${this.esc(e.time)}</span>
          <span class="timeline-icon">${e.icon}</span>
          <span class="timeline-text">${this.esc(e.text)}</span>
        </div>
      `).join('');
    } else {
      timelineHtml = `<div style="padding:12px;color:var(--text-dim)">No key moments detected</div>`;
    }

    container.innerHTML = `
      <div class="exec-summary-grid">
        <div class="exec-metrics">
          <h3>Key Metrics</h3>
          <div class="exec-metric-row"><span class="exec-metric-label">Status</span><span class="exec-metric-value ${statusClass}">${statusIcon} ${this.esc(data.metrics.status)}</span></div>
          <div class="exec-metric-row"><span class="exec-metric-label">Duration</span><span class="exec-metric-value">${this.esc(data.metrics.duration)}</span></div>
          <div class="exec-metric-row"><span class="exec-metric-label">Started</span><span class="exec-metric-value">${this.esc(data.metrics.started)}</span></div>
          <div class="exec-metric-row"><span class="exec-metric-label">Refresh</span><span class="exec-metric-value">${this.esc(data.metrics.refreshMode)}</span></div>
          <div class="exec-metric-row"><span class="exec-metric-label">Nodes</span><span class="exec-metric-value">${nodesSucceeded}/${data.nodes.length} ✅</span></div>
          <div class="exec-metric-row"><span class="exec-metric-label">Errors</span><span class="exec-metric-value ${data.metrics.errorCount > 0 ? 'error' : ''}">${data.metrics.errorCount}</span></div>
          <div class="exec-metric-row"><span class="exec-metric-label">Parallel</span><span class="exec-metric-value">${this.esc(data.metrics.parallelLimit)}</span></div>
        </div>
        <div class="node-table">
          <h3>Node Breakdown</h3>
          ${nodesHtml}
        </div>
      </div>
      ${data.errors.length > 0 ? `<div class="exec-errors"><h3>Errors</h3>${errorsHtml}</div>` : ''}
      <div class="exec-timeline">
        <h3>Key Moments Timeline</h3>
        ${timelineHtml}
      </div>
    `;
  }

  clearSummary = () => {
    const container = document.getElementById('exec-summary-data');
    const emptyEl = document.getElementById('exec-summary-empty');
    if (container) container.style.display = 'none';
    if (emptyEl) emptyEl.style.display = 'flex';
  }

  esc = (text) => {
    const d = document.createElement('div');
    d.textContent = String(text || '');
    return d.innerHTML;
  }
}
