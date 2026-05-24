/**
 * EDOG Real-Time Log Viewer — Execution Summary (Vertical Drawer)
 *
 * Renders execution analytics into a slide-in right drawer (#exec-drawer):
 *   - Hero status (orb + label + duration + iteration id + dag name)
 *   - Glass metric cards (status, duration, nodes ring, errors, refresh, parallel)
 *   - Node breakdown (vertical cards with status pill + proportional duration bar)
 *   - Errors (red-tinted cards with code/node/count/message)
 *   - Key Moments Timeline (vertical dotted rail with colored dots)
 *
 * Data-extraction (compute / extract*) is preserved verbatim from the previous
 * implementation. Only render() and clearSummary() are reshaped for the drawer.
 */

class ExecutionSummary {
  constructor(state, renderer) {
    this.state = state;
    this.renderer = renderer;
    this._closing = false;
  }

  // ─────────────────────────────────────────────────────────────────────
  //  DATA EXTRACTION (unchanged — preserves compute() data logic)
  // ─────────────────────────────────────────────────────────────────────

  compute = (iterationId) => {
    if (!iterationId) return null;
    const idLower = iterationId.toLowerCase();

    const logs = this.state.logs.filter(l => {
      const lid = (l.iterationId || '').toLowerCase();
      const msg = (l.message || '').toLowerCase();
      const rid = (l.rootActivityId || '').toLowerCase();
      return lid.includes(idLower) || msg.includes(idLower) || rid.includes(idLower);
    });

    const ssrEvents = this.state.telemetry.filter(e => {
      const eid = ((e.attributes && e.attributes.IterationId) || '').toLowerCase();
      const cid = (e.correlationId || '').toLowerCase();
      return eid.includes(idLower) || cid.includes(idLower);
    });

    const metrics = this.extractMetrics(logs, ssrEvents);
    const nodes = this.extractNodes(logs, ssrEvents);
    const errors = this.extractErrors(logs);
    const timeline = this.extractTimeline(logs);
    const dagName = this.extractDagName(logs, ssrEvents);

    return { iterationId, metrics, nodes, errors, timeline, dagName, logCount: logs.length, ssrCount: ssrEvents.length };
  }

  extractMetrics = (logs, ssrEvents) => {
    const result = { status: 'Unknown', duration: '—', durationMs: 0, started: '—', refreshMode: '—', nodeCount: '—', errorCount: 0, parallelLimit: '—' };

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

    const runDagEvents = ssrEvents.filter(e => (e.activityName || '').toLowerCase().includes('rundag'));
    if (runDagEvents.length > 0) {
      const last = runDagEvents[runDagEvents.length - 1];
      if (last.activityStatus) result.status = last.activityStatus;
      if (last.durationMs) { result.duration = this.renderer.formatDuration(last.durationMs); result.durationMs = last.durationMs; }
      if (last.timestamp) result.started = this.renderer.formatTime(last.timestamp);
    }

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

    result.errorCount = logs.filter(l => l.level === 'Error').length;
    return result;
  }

  extractNodes = (logs, ssrEvents) => {
    const nodeMap = new Map();

    ssrEvents.filter(e => (e.activityName || '').toLowerCase().includes('nodeexecution')).forEach(e => {
      const nodeName = (e.attributes && (e.attributes.NodeName || e.attributes.nodeName)) || e.activityName || 'Unknown';
      nodeMap.set(nodeName, {
        name: nodeName,
        status: e.activityStatus || 'Unknown',
        duration: e.durationMs ? this.renderer.formatDuration(e.durationMs) : '—',
        durationMs: e.durationMs || 0,
        error: e.resultCode && e.resultCode !== 'OK' ? e.resultCode : ''
      });
    });

    for (const log of logs) {
      const msg = log.message || '';
      const execMatch = msg.match(/Executed node\s+['"]?(\w+)['"]?\s+with final status\s+(\w+)/i);
      if (execMatch) {
        const name = execMatch[1];
        const existing = nodeMap.get(name) || { name, status: 'Unknown', duration: '—', durationMs: 0, error: '' };
        existing.status = execMatch[2];
        nodeMap.set(name, existing);
      }
      const startMatch = msg.match(/Executing node\s+['"]?(\w+)['"]?/i);
      if (startMatch && !nodeMap.has(startMatch[1])) {
        nodeMap.set(startMatch[1], { name: startMatch[1], status: 'Running', duration: '—', durationMs: 0, error: '' });
      }
    }

    for (const log of logs) {
      const msg = log.message || '';
      if (msg.includes('[DAG_FAULTED_NODES]')) {
        const faultedMatch = msg.match(/\[DAG_FAULTED_NODES\]\s*(.*)/i);
        if (faultedMatch) {
          const names = faultedMatch[1].split(',').map(s => s.trim()).filter(Boolean);
          names.forEach(name => {
            if (!nodeMap.has(name)) {
              nodeMap.set(name, { name, status: 'Skipped', duration: '—', durationMs: 0, error: 'upstream' });
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
      const codeMatch = msg.match(/\b(MLV_\w+|FLT_\w+|SPARK_\w+|ERR_\w+|ERROR_\w+)\b/);
      if (!codeMatch) return;
      const code = codeMatch[1];
      const existing = errorMap.get(code) || { code, message: msg.substring(0, 180), count: 0, node: '' };
      existing.count++;
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
        let type = 'start';
        if (msg.toLowerCase().includes('completed') || msg.toLowerCase().includes('finished')) {
          type = msg.toLowerCase().includes('error') || msg.toLowerCase().includes('fault') ? 'end-fail' : 'end-success';
        }
        events.push({ time, text: msg.replace('[DAG STATUS]', '').trim(), type });
      } else if (msg.match(/Executing node\s+['"]?(\w+)['"]?/i)) {
        const m = msg.match(/Executing node\s+['"]?(\w+)['"]?/i);
        events.push({ time, text: `Node ${m[1]} started`, type: 'start' });
      } else if (msg.match(/Executed node\s+['"]?(\w+)['"]?\s+with final status\s+(\w+)/i)) {
        const m = msg.match(/Executed node\s+['"]?(\w+)['"]?\s+with final status\s+(\w+)/i);
        const ok = m[2].toLowerCase() === 'succeeded' || m[2].toLowerCase() === 'completed';
        events.push({ time, text: `${m[1]} ${m[2]}`, type: ok ? 'end-success' : 'end-fail' });
      } else if (log.level === 'Error') {
        events.push({ time, text: msg.substring(0, 120), type: 'error' });
      } else if (msg.includes('[DAG_FAULTED_NODES]')) {
        events.push({ time, text: msg.replace('[DAG_FAULTED_NODES]', 'Skipped nodes:').trim(), type: 'skip' });
      }
    }
    return events.slice(0, 50);
  }

  extractDagName = (logs, ssrEvents) => {
    for (const e of ssrEvents) {
      const n = e.attributes && (e.attributes.DagName || e.attributes.dagName || e.attributes.TableName);
      if (n) return String(n);
    }
    for (const log of logs) {
      const m = (log.message || '').match(/[Dd]ag(?:Name)?[:\s=]+['"]?([\w.-]+)['"]?/);
      if (m) return m[1];
    }
    return '';
  }

  // ─────────────────────────────────────────────────────────────────────
  //  RENDER
  // ─────────────────────────────────────────────────────────────────────

  render = (data) => {
    if (!data) return;
    const drawer = document.getElementById('exec-drawer');
    const container = document.getElementById('exec-summary-data');
    if (!drawer || !container) return;

    const statusKey = String(data.metrics.status || '').toLowerCase();
    const statusMap = {
      'completed': { cls: 'status-success', icon: '●', color: 'var(--status-succeeded)', bg: 'rgba(24,160,88,0.12)', label: 'Completed' },
      'succeeded': { cls: 'status-success', icon: '●', color: 'var(--status-succeeded)', bg: 'rgba(24,160,88,0.12)', label: 'Succeeded' },
      'failed':    { cls: 'status-failed',  icon: '✕', color: 'var(--status-failed)',    bg: 'rgba(229,69,59,0.12)', label: 'Failed' },
      'running':   { cls: 'status-running', icon: '◐', color: 'var(--level-warning)',    bg: 'rgba(229,148,12,0.14)', label: 'Running' },
      'cancelled': { cls: 'status-failed',  icon: '⊘', color: 'var(--level-warning)',    bg: 'rgba(229,148,12,0.12)', label: 'Cancelled' }
    };
    const s = statusMap[statusKey] || { cls: '', icon: '◆', color: 'var(--text-muted)', bg: 'var(--surface-3)', label: data.metrics.status || 'Unknown' };

    const nodesSucceeded = data.nodes.filter(n => /succeeded|completed/i.test(n.status)).length;
    const nodesTotal = data.nodes.length;
    const ringPct = nodesTotal > 0 ? Math.round((nodesSucceeded / nodesTotal) * 100) : 0;
    const ringCirc = 100; // pathLength=100
    const ringOffset = 100 - ringPct;

    const maxDurMs = Math.max(1, ...data.nodes.map(n => n.durationMs || 0));

    // Format hero duration into number/unit
    const dur = this.formatDurationParts(data.metrics.durationMs, data.metrics.duration);

    // Header
    const iterShort = data.iterationId.length > 16
      ? data.iterationId.slice(0, 6) + '…' + data.iterationId.slice(-6)
      : data.iterationId;

    let html = `
      <header class="exd-head" style="--exd-status-color:${s.color};--exd-status-bg:${s.bg};--exd-accent-glow:${s.bg}">
        <div class="exd-head-top">
          <span class="exd-eyebrow">Execution</span>
          <button class="exd-close" id="exd-close-btn" title="Close (Esc)" aria-label="Close drawer">✕</button>
        </div>
        <div class="exd-status-hero ${s.cls}" style="--exd-status-color:${s.color};--exd-status-bg:${s.bg}">
          <div class="exd-status-orb">${s.icon}</div>
          <div class="exd-status-meta">
            <div class="exd-status-label">${this.esc(s.label)}</div>
            ${data.dagName ? `<div class="exd-status-dag">${this.esc(data.dagName)}</div>` : `<div class="exd-status-dag">${data.logCount} logs · ${data.ssrCount} ssr</div>`}
          </div>
          <div class="exd-duration-big">
            <span class="num">${this.esc(dur.num)}</span>
            <span class="unit">${this.esc(dur.unit)}</span>
          </div>
        </div>
        <div class="exd-iter" id="exd-iter-copy" title="Click to copy ${this.esc(data.iterationId)}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>
          <span class="iter-val">${this.esc(iterShort)}</span>
        </div>
      </header>

      <section class="exd-section">
        <div class="exd-section-title">Key Metrics</div>
        <div class="exd-metrics">
          <div class="exd-metric ${s.cls === 'status-failed' ? 'is-error' : s.cls === 'status-success' ? 'is-success' : s.cls === 'status-running' ? 'is-running' : ''}">
            <div class="exd-metric-head">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/></svg>
              Status
            </div>
            <span class="exd-metric-badge" style="background:${s.bg};color:${s.color}">${s.icon} ${this.esc(s.label)}</span>
          </div>

          <div class="exd-metric">
            <div class="exd-metric-head">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>
              Duration
            </div>
            <div class="exd-metric-value">${this.esc(data.metrics.duration)}</div>
            <div class="exd-metric-sub">started ${this.esc(data.metrics.started)}</div>
          </div>

          <div class="exd-metric metric-nodes">
            <div class="exd-ring">
              <svg viewBox="0 0 36 36">
                <circle class="track" cx="18" cy="18" r="15.915" pathLength="100"/>
                <circle class="fill" cx="18" cy="18" r="15.915" pathLength="100"
                        style="--exd-arc-target:${ringOffset};stroke:${nodesSucceeded === nodesTotal && nodesTotal > 0 ? 'var(--status-succeeded)' : nodesSucceeded < nodesTotal ? 'var(--level-warning)' : 'var(--accent)'}"/>
              </svg>
              <div class="label">${ringPct}%</div>
            </div>
            <div class="exd-metric-body">
              <div class="exd-metric-head">Nodes</div>
              <div class="exd-metric-value">${nodesSucceeded}/${nodesTotal || '—'}</div>
              <div class="exd-metric-sub">${nodesTotal ? 'succeeded' : 'no nodes'}</div>
            </div>
          </div>

          <div class="exd-metric ${data.metrics.errorCount > 0 ? 'is-error' : 'is-success'}">
            <div class="exd-metric-head">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 22h20L12 2z"/><path d="M12 9v5"/><circle cx="12" cy="18" r="0.6" fill="currentColor"/></svg>
              Errors
            </div>
            <div class="exd-metric-value">${data.metrics.errorCount}</div>
            <div class="exd-metric-sub">${data.metrics.errorCount > 0 ? 'see below' : 'clean run'}</div>
          </div>

          <div class="exd-metric">
            <div class="exd-metric-head">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
              Refresh
            </div>
            <div class="exd-metric-value" style="font-size:14px">${this.esc(data.metrics.refreshMode)}</div>
            <div class="exd-metric-sub">mode</div>
          </div>

          <div class="exd-metric">
            <div class="exd-metric-head">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="6" y1="3" x2="6" y2="21"/><line x1="12" y1="3" x2="12" y2="21"/><line x1="18" y1="3" x2="18" y2="21"/></svg>
              Parallel
            </div>
            <div class="exd-metric-value">${this.esc(data.metrics.parallelLimit)}</div>
            <div class="exd-metric-sub">limit</div>
          </div>
        </div>
      </section>

      <section class="exd-section">
        <div class="exd-section-title">Node Breakdown <span class="count">${nodesTotal}</span></div>
        ${this.renderNodes(data.nodes, maxDurMs)}
      </section>

      ${data.errors.length > 0 ? `
      <section class="exd-section">
        <div class="exd-section-title">Errors <span class="count">${data.errors.length}</span></div>
        <div class="exd-errors">${this.renderErrors(data.errors)}</div>
      </section>` : ''}

      <section class="exd-section">
        <div class="exd-section-title">Key Moments <span class="count">${data.timeline.length}</span></div>
        ${this.renderTimeline(data.timeline, statusKey)}
      </section>
    `;

    container.innerHTML = html;
    this.wireInteractions(container, data);
    this.open();
  }

  renderNodes = (nodes, maxDurMs) => {
    if (nodes.length === 0) {
      return `<div class="exd-empty-line">No node executions detected</div>`;
    }
    const statusClass = (st) => {
      const s = String(st || '').toLowerCase();
      if (s === 'succeeded' || s === 'completed') return { cls: 'is-success', pill: 'pill-success', label: st };
      if (s === 'failed' || s === 'faulted')      return { cls: 'is-failed',  pill: 'pill-failed',  label: st };
      if (s === 'running' || s === 'started')     return { cls: 'is-running', pill: 'pill-running', label: st };
      if (s === 'skipped')                        return { cls: 'is-skipped', pill: 'pill-skipped', label: st };
      return { cls: '', pill: 'pill-unknown', label: st || 'Unknown' };
    };

    const items = nodes.map(n => {
      const sc = statusClass(n.status);
      const scale = maxDurMs > 0 ? Math.max(0.04, (n.durationMs || 0) / maxDurMs) : 0;
      return `
        <div class="exd-node ${sc.cls}" style="--exd-bar-scale:${scale.toFixed(3)}">
          <div class="exd-node-head">
            <span class="exd-node-name" title="${this.esc(n.name)}">${this.esc(n.name)}</span>
            <span class="exd-pill ${sc.pill}">${this.esc(sc.label)}</span>
            <span class="exd-node-dur">${this.esc(n.duration)}</span>
          </div>
          <div class="exd-node-bar"><div class="fill"></div></div>
          ${n.error ? `<div class="exd-node-err">${this.esc(n.error)}</div>` : ''}
        </div>
      `;
    }).join('');
    return `<div class="exd-nodes">${items}</div>`;
  }

  renderErrors = (errors) => {
    return errors.map(e => `
      <div class="exd-error">
        <div class="exd-error-head">
          <span class="exd-error-code">${this.esc(e.code)}</span>
          ${e.node ? `<span class="exd-error-node">${this.esc(e.node)}</span>` : ''}
          <span class="exd-error-count">×${e.count}</span>
        </div>
        <div class="exd-error-msg">${this.esc(e.message)}</div>
      </div>
    `).join('');
  }

  renderTimeline = (events, statusKey) => {
    if (events.length === 0) {
      return `<div class="exd-empty-line">No key moments detected</div>`;
    }
    const flowing = statusKey === 'running';
    const items = events.map(e => `
      <div class="exd-tl-item tl-${this.esc(e.type)}">
        <span class="exd-tl-time">${this.esc(e.time)}</span>
        <span class="exd-tl-text">${this.esc(e.text)}</span>
      </div>
    `).join('');
    return `<div class="exd-timeline ${flowing ? 'is-flowing' : ''}">${items}</div>`;
  }

  wireInteractions = (container, data) => {
    // Close button
    const closeBtn = container.querySelector('#exd-close-btn');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        this.clearSummary();
        // Also clear the underlying RAID filter via main.js wiring
        const mainClear = document.getElementById('exec-badge-clear');
        if (mainClear) mainClear.click();
      });
    }
    // Iteration ID copy
    const iter = container.querySelector('#exd-iter-copy');
    if (iter && data && data.iterationId) {
      iter.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(data.iterationId);
          iter.classList.remove('copied');
          void iter.offsetWidth; // restart animation
          iter.classList.add('copied');
        } catch (_) { /* clipboard unavailable */ }
      });
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  //  OPEN / CLOSE
  // ─────────────────────────────────────────────────────────────────────

  open = () => {
    const drawer = document.getElementById('exec-drawer');
    const rtContent = document.getElementById('rt-content');
    if (!drawer) return;
    drawer.classList.remove('closing');
    drawer.classList.add('open', 'has-data');
    drawer.setAttribute('aria-hidden', 'false');
    if (rtContent) rtContent.classList.add('exec-drawer-open');
  }

  clearSummary = () => {
    const drawer = document.getElementById('exec-drawer');
    const container = document.getElementById('exec-summary-data');
    const rtContent = document.getElementById('rt-content');
    if (!drawer) return;
    if (!drawer.classList.contains('open')) return;
    drawer.classList.add('closing');
    drawer.classList.remove('open');
    drawer.setAttribute('aria-hidden', 'true');
    if (rtContent) rtContent.classList.remove('exec-drawer-open');
    setTimeout(() => {
      drawer.classList.remove('closing', 'has-data');
      if (container) container.innerHTML = '';
    }, 240);
  }

  // ─────────────────────────────────────────────────────────────────────
  //  HELPERS
  // ─────────────────────────────────────────────────────────────────────

  formatDurationParts = (ms, fallback) => {
    if (!ms || ms <= 0) {
      const f = String(fallback || '—');
      return { num: f, unit: '' };
    }
    if (ms < 1000)     return { num: String(Math.round(ms)),                 unit: 'ms' };
    if (ms < 60_000)   return { num: (ms / 1000).toFixed(1),                 unit: 's'  };
    if (ms < 3_600_000) {
      const m = Math.floor(ms / 60_000);
      const s = Math.floor((ms % 60_000) / 1000);
      return { num: `${m}:${String(s).padStart(2, '0')}`, unit: 'min' };
    }
    return { num: (ms / 3_600_000).toFixed(1), unit: 'h' };
  }

  esc = (text) => {
    const d = document.createElement('div');
    d.textContent = String(text == null ? '' : text);
    return d.innerHTML;
  }
}
