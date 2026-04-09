/**
 * MockRenderer — Populates all views with realistic mock data.
 *
 * Zara + Mika: This module renders mock content into every view
 * so the full cockpit can be demonstrated without a backend.
 */
class MockRenderer {
  constructor() {
    this._logEntries = MockData.generateLogEntries(80);
    this._selectedSparkId = null;
    this._activeEnvTab = 'flags';
    this._bookmarks = [];
  }

  init() {
    this._initContextMenu();
    this._renderTopBar();
    this._renderWorkspaceTree();
    this._renderLogs();
    this._renderDagStudio();
    this._renderSparkInspector();
    this._renderApiPlayground();
    this._renderEnvironment();
    this._renderTokenInspector();
    this._renderFileChangeBar();
    this._bindInteractions();
  }

  // ── Top Bar ──
  _renderTopBar() {
    const cfg = MockData.config;
    const statusEl = document.getElementById('service-status');
    const statusText = document.getElementById('service-status-text');
    const tokenEl = document.getElementById('token-countdown');
    const tokenHealth = document.getElementById('token-health');
    const branchEl = document.getElementById('git-branch-name');
    const patchEl = document.getElementById('patch-count');
    const sidebarDot = document.getElementById('sidebar-token-dot');

    if (statusEl) statusEl.className = 'service-status running';
    if (statusText) statusText.textContent = 'Running 14m22s';
    if (tokenEl) tokenEl.textContent = 'Token 42:18';
    if (tokenHealth) tokenHealth.className = 'token-health green';
    if (branchEl) branchEl.textContent = cfg.gitBranch;
    if (patchEl) patchEl.textContent = cfg.patchCount + ' patches';
    if (sidebarDot) sidebarDot.className = 'sidebar-token-dot green';

    // Enable all sidebar icons (connected mode)
    document.querySelectorAll('.sidebar-icon').forEach(i => i.classList.remove('disabled'));
  }

  // ── Workspace Explorer ──
  _renderWorkspaceTree() {
    const tree = document.getElementById('ws-tree-content');
    if (!tree) return;

    let html = '';
    MockData.workspaces.forEach((ws, wsIdx) => {
      const isFirst = wsIdx === 0;
      html += `<div class="ws-tree-item" data-ws-idx="${wsIdx}" style="padding-left:12px">
        <span class="ws-tree-toggle">${isFirst ? '\u25BE' : '\u25B8'}</span>
        <span class="ws-tree-label">${ws.displayName}</span>
      </div>`;

      if (isFirst) {
        const items = MockData.getItemsForWorkspace(wsIdx);
        items.forEach((item, itemIdx) => {
          const isLH = item.type === 'Lakehouse';
          const cls = isLH ? '' : ' dimmed';
          const dot = isLH ? '<span class="ws-dot lakehouse"></span>' : '<span class="ws-dot other"></span>';
          const selected = itemIdx === 0 ? ' selected' : '';
          html += `<div class="ws-tree-item${cls}${selected}" data-ws-idx="${wsIdx}" data-item-idx="${itemIdx}" style="padding-left:28px">
            ${dot}<span class="ws-tree-label">${item.displayName}</span>
            <span class="ws-tree-type">${item.type}</span>
          </div>`;
        });
      }
    });

    // Favorites
    const favEl = document.getElementById('ws-favorites-list');
    if (favEl) {
      let favHtml = '';
      MockData.favorites.forEach(f => {
        favHtml += `<div class="ws-fav-item">\u25C6 ${f.name} <span class="ws-fav-detail">${f.workspaceName}</span></div>`;
      });
      favEl.innerHTML = favHtml;
    }

    tree.innerHTML = html;

    // Populate content panel for first lakehouse
    this._renderLakehouseContent(0, 0);
    this._renderTableInspector(0);
  }

  _renderLakehouseContent(wsIdx, itemIdx) {
    const content = document.getElementById('ws-content-body');
    if (!content) return;

    const ws = MockData.workspaces[wsIdx];
    const items = MockData.getItemsForWorkspace(wsIdx);
    const item = items[itemIdx];
    const tables = MockData.tablesForLakehouse;

    content.innerHTML = `
      <div class="ws-content-header">
        <div class="ws-content-name">${item.displayName}</div>
        <div class="ws-content-meta">
          <span class="ws-meta-id" title="Click to copy">${item.id.substring(0, 8)}...</span>
          <span class="ws-meta-badge">F2 PPE \u25CF West US 2</span>
          <span class="capacity-pill ok">\u25CF Healthy</span>
          <span class="ws-meta-modified">Modified ${this._relativeTime(item.lastModified)}</span>
        </div>
        <div class="ws-content-actions">
          <button class="ws-deploy-btn">\u25B6 Deploy to this Lakehouse</button>
          <button class="ws-action-btn">Open in Fabric</button>
          <button class="ws-action-btn">Rename</button>
        </div>
      </div>
      <div class="ws-section">
        <div class="ws-section-title">TABLES <span class="ws-section-count">${tables.length}</span></div>
        <table class="ws-table">
          <thead><tr><th>Name</th><th>Type</th><th>Format</th><th>Rows</th><th>Size</th></tr></thead>
          <tbody>
            ${tables.map((t, ti) => `<tr class="ws-table-row${ti === 0 ? ' selected' : ''}" data-table-idx="${ti}">
              <td class="ws-table-name">${t.name}</td>
              <td><span class="ws-type-badge">${t.type}</span></td>
              <td>${t.format}</td>
              <td class="ws-table-num">${this._formatNum(t.rowCount)}</td>
              <td class="ws-table-num">${this._formatBytes(t.sizeBytes)}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
      <div class="ws-section">
        <div class="ws-section-title">MLV DEFINITIONS</div>
        <div class="ws-mlv-grid">
          <div class="ws-mlv-card">
            <div class="ws-mlv-name">sales_summary</div>
            <div class="ws-mlv-meta">SQL \u00B7 Auto Refresh \u00B7 Last run: 30m ago</div>
            <span class="status-pill succeeded">Succeeded</span>
          </div>
          <div class="ws-mlv-card">
            <div class="ws-mlv-name">customer_360</div>
            <div class="ws-mlv-meta">SQL \u00B7 Auto Refresh \u00B7 Last run: 30m ago</div>
            <span class="status-pill succeeded">Succeeded</span>
          </div>
          <div class="ws-mlv-card">
            <div class="ws-mlv-name">inventory_metrics</div>
            <div class="ws-mlv-meta">PySpark \u00B7 Manual \u00B7 Last run: 2h ago</div>
            <span class="status-pill failed">Failed</span>
          </div>
        </div>
      </div>`;

    // Bind table row clicks
    content.querySelectorAll('.ws-table-row').forEach(row => {
      row.addEventListener('click', () => {
        content.querySelectorAll('.ws-table-row').forEach(r => r.classList.remove('selected'));
        row.classList.add('selected');
        this._renderTableInspector(parseInt(row.dataset.tableIdx));
      });
    });
  }

  _renderTableInspector(tableIdx) {
    const inspector = document.getElementById('ws-inspector-content');
    if (!inspector) return;
    const t = MockData.tablesForLakehouse[tableIdx];
    inspector.innerHTML = `
      <div class="ws-insp-section">
        <div class="ws-insp-title">TABLE INFO</div>
        <dl class="ws-insp-kv">
          <dt>Name</dt><dd>${t.name}</dd>
          <dt>Type</dt><dd>${t.type}</dd>
          <dt>Format</dt><dd>${t.format}</dd>
          <dt>Location</dt><dd>${t.location}</dd>
          <dt>Rows</dt><dd>${this._formatNum(t.rowCount)}</dd>
          <dt>Size</dt><dd>${this._formatBytes(t.sizeBytes)}</dd>
        </dl>
      </div>
      <div class="ws-insp-section">
        <div class="ws-insp-title">SCHEMA</div>
        <table class="ws-schema-table">
          <thead><tr><th>Column</th><th>Type</th><th>Null</th></tr></thead>
          <tbody>
            <tr><td>id</td><td>BIGINT</td><td>\u2717</td></tr>
            <tr><td>region</td><td>STRING</td><td>\u2713</td></tr>
            <tr><td>amount</td><td>DECIMAL(18,2)</td><td>\u2717</td></tr>
            <tr><td>quantity</td><td>INT</td><td>\u2713</td></tr>
            <tr><td>transaction_date</td><td>TIMESTAMP</td><td>\u2717</td></tr>
            <tr><td>customer_id</td><td>BIGINT</td><td>\u2713</td></tr>
            <tr><td>product_sku</td><td>STRING</td><td>\u2713</td></tr>
            <tr><td>store_code</td><td>STRING</td><td>\u2713</td></tr>
          </tbody>
        </table>
      </div>
      <div class="ws-insp-section">
        <div class="ws-insp-title">PREVIEW</div>
        <div class="ws-preview-note">First 3 rows</div>
        <table class="ws-preview-table">
          <thead><tr><th>id</th><th>region</th><th>amount</th><th>quantity</th></tr></thead>
          <tbody>
            <tr><td>1001</td><td>West US</td><td>249.99</td><td>3</td></tr>
            <tr><td>1002</td><td>East US</td><td>89.50</td><td>1</td></tr>
            <tr><td>1003</td><td>EU West</td><td>1,247.00</td><td>12</td></tr>
          </tbody>
        </table>
      </div>`;
  }

  // ── Logs ──
  _renderLogs() {
    const container = document.getElementById('logs-container');
    if (!container) return;

    // Replace empty state with log entries
    let html = '';
    this._logEntries.forEach((entry, i) => {
      const levelCls = entry.level.toLowerCase();
      const bookmark = entry.bookmarked ? ' bookmarked' : '';
      html += `<div class="log-row log-level-${levelCls}${bookmark}" data-log-idx="${i}">
        <span class="log-gutter">
          <span class="log-bookmark-star" data-idx="${i}">${entry.bookmarked ? '\u2605' : '\u2606'}</span>
        </span>
        <span class="log-time">${entry.timestamp}</span>
        <span class="log-level-badge">${entry.level.charAt(0)}</span>
        <span class="log-component">${entry.component}</span>
        <span class="log-message">${this._decorateLogMessage(entry.message)}</span>
      </div>`;
    });
    container.innerHTML = html;
    container.classList.add('has-entries');

    // Update stats
    const errors = this._logEntries.filter(e => e.level === 'Error').length;
    this._setTextSafe('stat-logs', String(this._logEntries.length));
    this._setTextSafe('stat-ssr', '24');
    this._setTextSafe('stat-errors', String(errors));
    this._setTextSafe('visible-count', String(this._logEntries.length));
    this._setTextSafe('total-count', String(this._logEntries.length));

    // Bind log row clicks → detail panel
    container.addEventListener('click', (e) => {
      const row = e.target.closest('.log-row');
      if (!row || e.target.classList.contains('log-bookmark-star')) return;
      this._openLogDetail(parseInt(row.dataset.logIdx));
    });

    // Bind bookmark clicks
    container.querySelectorAll('.log-bookmark-star').forEach(star => {
      star.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt(star.dataset.idx);
        this._logEntries[idx].bookmarked = !this._logEntries[idx].bookmarked;
        star.textContent = this._logEntries[idx].bookmarked ? '\u2605' : '\u2606';
        star.closest('.log-row').classList.toggle('bookmarked');
      });
    });

    // Apply breakpoint highlights
    this._applyBreakpointHighlights();

    // Bind log toolbar filters
    this._bindLogFilters();

    // Render breakpoints bar
    const bpBar = document.getElementById('breakpoints-bar');
    if (bpBar) {
      bpBar.innerHTML = `
        <span class="bp-label">Breakpoints</span>
        <div class="bp-pills">
          <span class="bp-pill"><span class="bp-pill-color" style="background:var(--level-error)"></span> NullReference <span class="bp-pill-close">\u2715</span></span>
          <span class="bp-pill"><span class="bp-pill-color" style="background:var(--level-warning)"></span> throttl.* <span class="bp-pill-close">\u2715</span></span>
        </div>
        <button class="bp-add">+ Add</button>
        <button class="bp-add" id="open-bookmarks-btn">\u2606 Bookmarks</button>`;
    }
  }

  // ── DAG Studio ──
  _renderDagStudio() {
    const dagContent = document.getElementById('dag-studio-content');
    if (!dagContent) return;

    dagContent.innerHTML = `
      <div class="dag-toolbar">
        <button class="dag-btn primary">\u25B6 Run DAG</button>
        <button class="dag-btn danger">\u2718 Cancel</button>
        <button class="dag-btn">\u21BB Refresh DAG</button>
        <div style="flex:1"></div>
        <span style="font-size:var(--text-xs);color:var(--text-muted)">8 nodes \u00B7 Running \u00B7 5/8 completed</span>
      </div>
      <div class="dag-body">
        <div class="dag-graph-panel" id="dag-graph-panel"></div>
        <div class="dag-side-panel">
          <div class="dag-gantt-section">
            <div class="dag-section-title">Execution Timeline</div>
            <div class="gantt-chart" id="dag-gantt"></div>
          </div>
          <div class="dag-history-section">
            <div class="dag-section-title">History</div>
            <table class="dag-history-table">
              <thead><tr><th>ID</th><th>Status</th><th>Duration</th><th>Nodes</th><th>Time</th></tr></thead>
              <tbody id="dag-history-body"></tbody>
            </table>
          </div>
        </div>
      </div>`;

    this._renderDagGraph();
    this._renderGantt();
    this._renderDagHistory();
    this._bindDagNodeClicks();
  }

  _renderDagGraph() {
    const panel = document.getElementById('dag-graph-panel');
    if (!panel) return;

    const nodes = MockData.dagNodes;
    // Simple layered layout
    const layers = this._computeDagLayers(nodes);
    const nodeWidth = 150, nodeHeight = 44, layerGap = 100, nodeGap = 60;
    const svgWidth = (layers.length) * (nodeWidth + layerGap) + 80;
    const maxPerLayer = Math.max(...layers.map(l => l.length));
    const svgHeight = maxPerLayer * (nodeHeight + nodeGap) + 40;

    const positions = {};
    layers.forEach((layer, li) => {
      const x = 40 + li * (nodeWidth + layerGap);
      const totalH = layer.length * nodeHeight + (layer.length - 1) * nodeGap;
      const startY = (svgHeight - totalH) / 2;
      layer.forEach((node, ni) => {
        positions[node.nodeId] = { x, y: startY + ni * (nodeHeight + nodeGap) };
      });
    });

    let svg = `<svg viewBox="0 0 ${svgWidth} ${svgHeight}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <marker id="dag-arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--text-muted)" />
        </marker>
      </defs>`;

    // Edges
    MockData.dagEdges.forEach(e => {
      const from = positions[e.from];
      const to = positions[e.to];
      if (from && to) {
        svg += `<line class="dag-edge" x1="${from.x + nodeWidth}" y1="${from.y + nodeHeight/2}" x2="${to.x}" y2="${to.y + nodeHeight/2}" />`;
      }
    });

    // Nodes
    nodes.forEach(n => {
      const pos = positions[n.nodeId];
      if (!pos) return;
      const badge = n.kind === 'sql' ? 'SQL' : 'PY';
      svg += `<g class="dag-node ${n.status}" transform="translate(${pos.x},${pos.y})">
        <rect width="${nodeWidth}" height="${nodeHeight}" />
        <text class="dag-node-label" x="10" y="18">${n.name.length > 16 ? n.name.substring(0,16) + '..' : n.name}</text>
        <text class="dag-node-badge" x="10" y="34" fill="var(--text-muted)">${badge} \u00B7 ${n.duration ? (n.duration/1000).toFixed(1) + 's' : n.status}</text>
      </g>`;
    });

    svg += '</svg>';
    panel.innerHTML = svg;
  }

  _computeDagLayers(nodes) {
    const nodeMap = {};
    nodes.forEach(n => nodeMap[n.nodeId] = n);

    const levels = {};
    const computeLevel = (nodeId) => {
      if (levels[nodeId] !== undefined) return levels[nodeId];
      const node = nodeMap[nodeId];
      if (node.parents.length === 0) { levels[nodeId] = 0; return 0; }
      const parentLevels = node.parents.map(p => computeLevel(p));
      levels[nodeId] = Math.max(...parentLevels) + 1;
      return levels[nodeId];
    };
    nodes.forEach(n => computeLevel(n.nodeId));

    const maxLevel = Math.max(...Object.values(levels));
    const layers = [];
    for (let i = 0; i <= maxLevel; i++) {
      layers.push(nodes.filter(n => levels[n.nodeId] === i));
    }
    return layers;
  }

  _renderGantt() {
    const gantt = document.getElementById('dag-gantt');
    if (!gantt) return;

    const nodes = MockData.dagNodes;
    const maxDuration = Math.max(...nodes.filter(n => n.duration).map(n => n.duration), 1);
    let html = '';
    nodes.forEach(n => {
      const pct = n.duration ? Math.max((n.duration / maxDuration) * 100, 5) : (n.status === 'running' ? 60 : 2);
      const left = n.parents.length === 0 ? 0 : 10 + Math.random() * 20;
      html += `<div class="gantt-row">
        <span class="gantt-label">${n.name.length > 14 ? n.name.substring(0,14) + '..' : n.name}</span>
        <div class="gantt-track"><div class="gantt-bar ${n.status}" style="left:${left}%;width:${pct - left}%"></div></div>
      </div>`;
    });
    gantt.innerHTML = html;
  }

  _renderDagHistory() {
    const body = document.getElementById('dag-history-body');
    if (!body) return;
    let html = '';
    MockData.dagHistory.forEach(h => {
      const cls = h.status.toLowerCase();
      html += `<tr>
        <td>${h.iterationId}</td>
        <td><span class="status-pill ${cls}">${h.status}</span></td>
        <td>${h.duration}</td>
        <td>${h.completed}/${h.total}${h.failed ? ' \u00B7 ' + h.failed + ' failed' : ''}</td>
        <td>${h.startTime}</td>
      </tr>`;
    });
    body.innerHTML = html;
  }

  // ── Spark Inspector ──
  _renderSparkInspector() {
    const panel = document.getElementById('view-spark');
    if (!panel) return;

    panel.innerHTML = `<div class="spark-inspector">
      <div class="spark-list-panel">
        <div class="spark-list-header">Spark Requests <span style="margin-left:auto;color:var(--text-dim)">${MockData.sparkRequests.length}</span></div>
        <div class="spark-list-filters">
          <button class="spark-filter-btn active">All</button>
          <button class="spark-filter-btn">2xx</button>
          <button class="spark-filter-btn">4xx</button>
          <button class="spark-filter-btn">5xx</button>
        </div>
        <div class="spark-list" id="spark-list"></div>
      </div>
      <div class="spark-detail-panel" id="spark-detail">
        <div class="spark-empty-detail">Select a request to view details</div>
      </div>
    </div>`;

    const list = document.getElementById('spark-list');
    MockData.sparkRequests.forEach((req, i) => {
      const methodCls = req.method.toLowerCase();
      const statusCls = req.status < 300 ? 's2xx' : req.status < 500 ? 's4xx' : 's5xx';
      const retryBadge = req.retries > 0 ? `<span class="spark-retries">\u00D7${req.retries}</span>` : '';
      const el = document.createElement('div');
      el.className = 'spark-item' + (i === 0 ? ' selected' : '');
      el.dataset.idx = i;
      el.innerHTML = `<span class="method-pill ${methodCls}">${req.method}</span>
        <span class="spark-endpoint">${req.endpoint}</span>
        <span class="status-code ${statusCls}">${req.status}</span>
        <span class="spark-duration">${req.duration}ms</span>
        ${retryBadge}`;
      el.addEventListener('click', () => {
        list.querySelectorAll('.spark-item').forEach(s => s.classList.remove('selected'));
        el.classList.add('selected');
        this._renderSparkDetail(i);
      });
      list.appendChild(el);
    });

    this._renderSparkDetail(0);

    // Spark filter buttons
    const filterBtns = panel.querySelectorAll('.spark-filter-btn');
    filterBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        filterBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const filter = btn.textContent.trim();
        panel.querySelectorAll('.spark-item').forEach(item => {
          const status = parseInt(item.querySelector('.status-code')?.textContent || '0');
          const show = filter === 'All' ||
            (filter === '2xx' && status >= 200 && status < 300) ||
            (filter === '4xx' && status >= 400 && status < 500) ||
            (filter === '5xx' && status >= 500);
          item.style.display = show ? '' : 'none';
        });
      });
    });
  }

  _renderSparkDetail(idx) {
    const detail = document.getElementById('spark-detail');
    if (!detail) return;
    this._sparkDetailIdx = idx;
    this._sparkActiveTab = this._sparkActiveTab || 'request';
    this._renderSparkDetailTab();
  }

  _renderSparkDetailTab() {
    const detail = document.getElementById('spark-detail');
    if (!detail) return;
    const req = MockData.sparkRequests[this._sparkDetailIdx || 0];
    const methodCls = req.method.toLowerCase();
    const statusCls = req.status < 300 ? 's2xx' : req.status < 500 ? 's4xx' : 's5xx';
    const tab = this._sparkActiveTab || 'request';

    let body = '';
    if (tab === 'request') {
      body = `<dl class="spark-kv">
          <dt>Method</dt><dd><span class="method-pill ${methodCls}">${req.method}</span></dd>
          <dt>Endpoint</dt><dd>${req.endpoint}</dd>
          <dt>Status</dt><dd><span class="status-code ${statusCls}">${req.status}</span></dd>
          <dt>Duration</dt><dd>${req.duration}ms</dd>
          <dt>Retries</dt><dd>${req.retries}</dd>
          <dt>Time</dt><dd>${req.timestamp}</dd>
        </dl>
        ${req.body ? '<div style="margin-top:var(--space-3)"><div style="font-size:var(--text-xs);color:var(--text-muted);margin-bottom:var(--space-1);font-weight:700;text-transform:uppercase;letter-spacing:0.08em">Request Body</div><div class="spark-code-block">' + this._escapeHtml(req.body) + '</div></div>' : ''}`;
    } else if (tab === 'response') {
      body = `<dl class="spark-kv">
          <dt>Status</dt><dd><span class="status-code ${statusCls}">${req.status}</span></dd>
          <dt>Content-Type</dt><dd>application/json</dd>
          <dt>x-ms-request-id</dt><dd>${MockData.uuid().substring(0, 8)}</dd>
        </dl>
        <div style="margin-top:var(--space-3)"><div style="font-size:var(--text-xs);color:var(--text-muted);margin-bottom:var(--space-1);font-weight:700;text-transform:uppercase;letter-spacing:0.08em">Response Body</div><div class="spark-code-block">${this._escapeHtml(req.response)}</div></div>`;
    } else {
      const total = req.duration;
      const submit = Math.round(total * 0.15);
      const process = Math.round(total * 0.7);
      const response = total - submit - process;
      body = `<div style="font-size:var(--text-xs);font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:var(--space-2)">Waterfall</div>
        <div style="display:flex;flex-direction:column;gap:6px">
          <div style="display:flex;align-items:center;gap:var(--space-2)"><span style="width:60px;font-size:var(--text-xs);color:var(--text-dim)">Submit</span><div style="flex:1;height:14px;background:var(--surface-2);border-radius:3px;overflow:hidden"><div style="height:100%;width:${Math.max(submit/total*100,5)}%;background:var(--level-message);border-radius:3px"></div></div><span style="width:50px;text-align:right;font-family:var(--font-mono);font-size:var(--text-xs);color:var(--text-muted)">${submit}ms</span></div>
          <div style="display:flex;align-items:center;gap:var(--space-2)"><span style="width:60px;font-size:var(--text-xs);color:var(--text-dim)">Process</span><div style="flex:1;height:14px;background:var(--surface-2);border-radius:3px;overflow:hidden"><div style="height:100%;width:${Math.max(process/total*100,5)}%;background:var(--status-succeeded);border-radius:3px"></div></div><span style="width:50px;text-align:right;font-family:var(--font-mono);font-size:var(--text-xs);color:var(--text-muted)">${process}ms</span></div>
          <div style="display:flex;align-items:center;gap:var(--space-2)"><span style="width:60px;font-size:var(--text-xs);color:var(--text-dim)">Response</span><div style="flex:1;height:14px;background:var(--surface-2);border-radius:3px;overflow:hidden"><div style="height:100%;width:${Math.max(response/total*100,5)}%;background:var(--accent);border-radius:3px"></div></div><span style="width:50px;text-align:right;font-family:var(--font-mono);font-size:var(--text-xs);color:var(--text-muted)">${response}ms</span></div>
        </div>
        <div style="margin-top:var(--space-3);font-size:var(--text-sm);color:var(--text-dim)">Total: ${total}ms</div>
        ${req.retries > 0 ? '<div style="margin-top:var(--space-4);font-size:var(--text-xs);font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:var(--space-2)">Retry Chain (' + req.retries + ' retries)</div><div style="display:flex;align-items:center;gap:var(--space-1);flex-wrap:wrap">' + Array.from({length: req.retries}, (_, i) => '<span style="padding:var(--space-1) var(--space-2);border:1px solid var(--level-error);border-radius:var(--radius-sm);font-size:var(--text-xs);font-family:var(--font-mono);color:var(--level-error)">Attempt ' + (i+1) + ' \u2717</span><span style="font-size:10px;color:var(--text-muted)">' + (i < req.retries - 1 ? '\u2192 2s delay \u2192' : '\u2192') + '</span>').join('') + '<span style="padding:var(--space-1) var(--space-2);border:1px solid var(--status-succeeded);border-radius:var(--radius-sm);font-size:var(--text-xs);font-family:var(--font-mono);color:var(--status-succeeded)">Final \u2713</span></div>' : ''}`;
    }

    detail.innerHTML = `
      <div class="spark-detail-tabs">
        <button class="spark-detail-tab${tab === 'request' ? ' active' : ''}" data-tab="request">Request</button>
        <button class="spark-detail-tab${tab === 'response' ? ' active' : ''}" data-tab="response">Response</button>
        <button class="spark-detail-tab${tab === 'timing' ? ' active' : ''}" data-tab="timing">Timing</button>
      </div>
      <div class="spark-detail-content">${body}</div>`;

    detail.querySelectorAll('.spark-detail-tab').forEach(t => {
      t.addEventListener('click', () => {
        this._sparkActiveTab = t.dataset.tab;
        this._renderSparkDetailTab();
      });
    });
  }

  // ── API Playground ──
  _renderApiPlayground() {
    const panel = document.getElementById('view-api');
    if (!panel) return;

    panel.innerHTML = `<div class="api-playground">
      <div class="api-main">
        <div class="api-request-section">
          <div class="api-url-row">
            <select class="api-method-select" id="api-method"><option>GET</option><option>POST</option><option>PUT</option><option>PATCH</option><option>DELETE</option></select>
            <input class="api-url-input" id="api-url" value="https://api.fabric.microsoft.com/v1/workspaces" placeholder="Enter URL..." />
            <button class="api-send-btn" id="api-send-btn">Send</button>
            <button class="api-send-btn" id="api-curl-btn" style="background:var(--surface-2);color:var(--text-dim);border:1px solid var(--border-bright)">Copy cURL</button>
          </div>
          <div class="api-body-section" id="api-body-area" style="display:none">
            <span class="api-body-label">Request Body</span>
            <textarea class="api-body-input" id="api-body-textarea" placeholder='{"key": "value"}'></textarea>
          </div>
          <div class="api-body-section">
            <span class="api-body-label">Headers</span>
            <div style="font-size:var(--text-xs);color:var(--text-dim);font-family:var(--font-mono);padding:var(--space-1) 0">Authorization: Bearer eyJ0eX...  (auto-filled)</div>
          </div>
        </div>
        <div class="api-response-section" id="api-response-section">
          <div class="api-response-header" id="api-resp-header">
            <span class="api-response-status s2xx">200 OK</span>
            <span class="api-response-timing">342ms</span>
            <span style="margin-left:auto;font-size:var(--text-xs);color:var(--text-muted)">application/json</span>
          </div>
          <div class="api-response-body" id="api-resp-body">${this._escapeHtml(JSON.stringify({
            value: MockData.workspaces.map(ws => ({ id: ws.id, displayName: ws.displayName, type: ws.type, state: ws.state })),
            continuationToken: null,
          }, null, 2))}</div>
        </div>
      </div>
      <div class="api-sidebar">
        <div class="api-sidebar-section">
          <div class="api-sidebar-title">Saved Requests</div>
          ${this._renderApiSaved()}
        </div>
        <div class="api-sidebar-section">
          <div class="api-sidebar-title">History</div>
          ${this._renderApiHistory()}
        </div>
      </div>
    </div>`;

    // Method change → show/hide body
    const methodEl = document.getElementById('api-method');
    const bodyArea = document.getElementById('api-body-area');
    if (methodEl && bodyArea) {
      methodEl.addEventListener('change', () => {
        const needsBody = ['POST', 'PUT', 'PATCH'].includes(methodEl.value);
        bodyArea.style.display = needsBody ? '' : 'none';
      });
    }

    // Send button → mock response
    const sendBtn = document.getElementById('api-send-btn');
    if (sendBtn) {
      sendBtn.addEventListener('click', () => {
        const respBody = document.getElementById('api-resp-body');
        const respHeader = document.getElementById('api-resp-header');
        if (respBody) { respBody.style.opacity = '0.3'; }
        setTimeout(() => {
          const duration = 100 + Math.floor(Math.random() * 400);
          if (respHeader) respHeader.innerHTML = '<span class="api-response-status s2xx">200 OK</span><span class="api-response-timing">' + duration + 'ms</span><span style="margin-left:auto;font-size:var(--text-xs);color:var(--text-muted)">application/json</span>';
          if (respBody) { respBody.style.opacity = '1'; respBody.textContent = JSON.stringify({ status: 'ok', message: 'Mock response', timestamp: new Date().toISOString() }, null, 2); }
        }, 600);
      });
    }

    // Copy cURL
    const curlBtn = document.getElementById('api-curl-btn');
    if (curlBtn) {
      curlBtn.addEventListener('click', () => {
        const method = document.getElementById('api-method')?.value || 'GET';
        const url = document.getElementById('api-url')?.value || '';
        const curl = 'curl -X ' + method + ' "' + url + '" -H "Authorization: Bearer eyJ0eX..."';
        navigator.clipboard?.writeText(curl);
        this._showToast('cURL copied to clipboard');
      });
    }

    // Saved request clicks → populate builder
    panel.querySelectorAll('.api-saved-item').forEach((item, i) => {
      item.style.cursor = 'pointer';
      item.addEventListener('click', () => {
        const req = MockData.savedRequests[i];
        if (!req) return;
        const methodEl = document.getElementById('api-method');
        const urlEl = document.getElementById('api-url');
        if (methodEl) methodEl.value = req.method;
        if (urlEl) urlEl.value = req.url;
        const bodyArea = document.getElementById('api-body-area');
        if (bodyArea) bodyArea.style.display = ['POST', 'PUT', 'PATCH'].includes(req.method) ? '' : 'none';
      });
    });
  }

  _renderApiSaved() {
    let html = '';
    let lastGroup = '';
    MockData.savedRequests.forEach(req => {
      if (req.group !== lastGroup) {
        html += `<div class="api-sidebar-group-label">${req.group}</div>`;
        lastGroup = req.group;
      }
      const cls = req.method.toLowerCase();
      html += `<div class="api-saved-item"><span class="method-pill ${cls}">${req.method}</span><span>${req.name}</span></div>`;
    });
    return html;
  }

  _renderApiHistory() {
    return MockData.apiHistory.map(h => {
      const cls = h.method.toLowerCase();
      const sCls = h.status < 300 ? 's2xx' : h.status < 500 ? 's4xx' : 's5xx';
      return `<div class="api-history-item">
        <span class="method-pill ${cls}">${h.method}</span>
        <span>${h.url.length > 30 ? h.url.substring(0, 30) + '...' : h.url}</span>
        <span class="api-history-status status-code ${sCls}">${h.status}</span>
      </div>`;
    }).join('');
  }

  // ── Environment ──
  _renderEnvironment() {
    const panel = document.getElementById('view-environment');
    if (!panel) return;

    panel.innerHTML = `<div class="environment-view">
      <div class="env-tabs">
        <button class="env-tab active" data-tab="flags">Feature Flags</button>
        <button class="env-tab" data-tab="lock">Lock Monitor</button>
        <button class="env-tab" data-tab="orphans">Orphaned Resources</button>
      </div>
      <div class="env-content" id="env-content"></div>
    </div>`;

    // Bind tab clicks
    panel.querySelectorAll('.env-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        panel.querySelectorAll('.env-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        this._activeEnvTab = tab.dataset.tab;
        this._renderEnvContent();
      });
    });

    this._renderEnvContent();
  }

  _renderEnvContent() {
    const content = document.getElementById('env-content');
    if (!content) return;

    if (this._activeEnvTab === 'flags') this._renderFeatureFlags(content);
    else if (this._activeEnvTab === 'lock') this._renderLockMonitor(content);
    else if (this._activeEnvTab === 'orphans') this._renderOrphanedResources(content);
  }

  _renderFeatureFlags(el) {
    const rings = ['onebox', 'test', 'daily', 'cst', 'dxt', 'msit', 'prod'];
    el.innerHTML = `
      <div class="ff-toolbar">
        <input class="ff-search" placeholder="Search flags..." />
        <div class="ff-group-tabs">
          <button class="ff-group-tab active">All (${MockData.featureFlags.length})</button>
          <button class="ff-group-tab">Enabled</button>
          <button class="ff-group-tab">Partial</button>
          <button class="ff-group-tab">Disabled</button>
        </div>
      </div>
      <table class="ff-table">
        <thead><tr>
          <th>Flag Name</th>
          <th>Description</th>
          ${rings.map(r => `<th>${r}</th>`).join('')}
          <th>Override</th>
        </tr></thead>
        <tbody>
          ${MockData.featureFlags.map(f => `<tr>
            <td>${f.name}</td>
            <td>${f.description}</td>
            ${rings.map(r => {
              const v = f.rings[r];
              if (v === true) return '<td class="ff-cell-on">\u2713</td>';
              if (v === 'conditional') return '<td class="ff-cell-conditional" title="Conditional: Requires WorkspaceObjectId">\u25D0</td>';
              return '<td class="ff-cell-off">\u2717</td>';
            }).join('')}
            <td>
              <input type="checkbox" class="ff-override-toggle" ${f.override === true ? 'checked' : ''} ${f.override === false ? 'data-forced-off="true"' : ''}>
              ${f.override !== null ? '<span class="ff-override-indicator"></span>' : ''}
            </td>
          </tr>`).join('')}
        </tbody>
      </table>`;

    // Flag search
    const search = el.querySelector('.ff-search');
    if (search) {
      search.addEventListener('input', () => {
        const q = search.value.toLowerCase();
        el.querySelectorAll('.ff-table tbody tr').forEach(tr => {
          const name = (tr.querySelector('td:first-child')?.textContent || '').toLowerCase();
          const desc = (tr.querySelector('td:nth-child(2)')?.textContent || '').toLowerCase();
          tr.style.display = (name.includes(q) || desc.includes(q)) ? '' : 'none';
        });
      });
    }

    // Group tabs
    const tabs = el.querySelectorAll('.ff-group-tab');
    tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        tabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        const label = tab.textContent.trim().split(' ')[0];
        el.querySelectorAll('.ff-table tbody tr').forEach(tr => {
          const onCount = tr.querySelectorAll('.ff-cell-on').length;
          const offCount = tr.querySelectorAll('.ff-cell-off').length;
          const total = onCount + offCount + tr.querySelectorAll('.ff-cell-conditional').length;
          let show = true;
          if (label === 'Enabled') show = onCount === total;
          else if (label === 'Disabled') show = offCount === total;
          else if (label === 'Partial') show = onCount > 0 && onCount < total;
          tr.style.display = show ? '' : 'none';
        });
      });
    });
  }

  _renderLockMonitor(el) {
    const lock = MockData.lockState;
    el.innerHTML = `
      <div class="lock-card">
        <div class="lock-status-row">
          <span class="lock-indicator ${lock.locked ? 'locked' : 'unlocked'}"></span>
          <span class="lock-label">${lock.locked ? 'Locked' : 'Unlocked'}</span>
        </div>
        ${lock.locked ? `
        <div class="lock-meta">
          Holder: <strong>${lock.holder}</strong><br>
          Locked since: ${lock.age} ago
        </div>` : ''}
        <div class="lock-actions">
          <button class="lock-btn danger">Force Unlock</button>
          <button class="lock-btn">Refresh</button>
        </div>
      </div>
      <div style="margin-top:var(--space-4)">
        <div class="dag-section-title">Recent Lock Events</div>
        <table class="dag-history-table" style="max-width:480px">
          <thead><tr><th>Event</th><th>Iteration</th><th>Time</th></tr></thead>
          <tbody>
            <tr><td>Locked</td><td>${lock.holder}</td><td>2 min ago</td></tr>
            <tr><td>Unlocked</td><td>${MockData.dagHistory[1].iterationId}</td><td>35 min ago</td></tr>
            <tr><td>Locked</td><td>${MockData.dagHistory[1].iterationId}</td><td>38 min ago</td></tr>
            <tr><td>Force Unlock</td><td>${MockData.dagHistory[2].iterationId}</td><td>1h 32m ago</td></tr>
          </tbody>
        </table>
      </div>`;
  }

  _renderOrphanedResources(el) {
    const folders = MockData.orphanedFolders;
    const totalSize = '175.1 MB';
    el.innerHTML = `
      <div style="margin-bottom:var(--space-3)">
        <span class="orphan-total">${folders.length} orphaned folders \u00B7 ${totalSize} total</span>
        <button class="orphan-clean-btn" style="margin-left:var(--space-3)">Clean All</button>
      </div>
      <table class="orphan-table">
        <thead><tr><th>Path</th><th>Size</th><th>Age</th><th></th></tr></thead>
        <tbody>
          ${folders.map(f => `<tr>
            <td>${f.path}</td>
            <td>${f.size}</td>
            <td>${f.age}</td>
            <td><button class="lock-btn" style="font-size:var(--text-xs);padding:1px 8px">Delete</button></td>
          </tr>`).join('')}
        </tbody>
      </table>`;
  }

  // ── Token Inspector ──
  _renderTokenInspector() {
    const existing = document.getElementById('token-inspector');
    if (existing) return;

    const drawer = document.createElement('div');
    drawer.id = 'token-inspector';
    drawer.className = 'token-inspector';
    drawer.innerHTML = `
      <div class="ti-header">
        <span class="ti-title">Token Inspector</span>
        <button class="ti-close" id="ti-close-btn">\u2715</button>
      </div>
      <div class="ti-body">
        ${this._renderTokenCard(MockData.tokenInfo.bearer)}
        ${this._renderTokenCard(MockData.tokenInfo.mwc)}
        <div class="ti-actions">
          <button class="ti-btn primary">Refresh Token</button>
          <button class="ti-btn">Copy Bearer</button>
          <button class="ti-btn">Copy MWC</button>
        </div>
      </div>`;
    document.body.appendChild(drawer);
  }

  _renderTokenCard(token) {
    const pct = Math.min((token.expiresIn / 60) * 100, 100);
    const color = token.expiresIn > 10 ? 'green' : token.expiresIn > 5 ? 'amber' : 'red';
    return `<div class="ti-token-card">
      <div class="ti-token-header">
        <span>${token.type}</span>
        <span class="ti-type-badge">${token.expiresIn}m remaining</span>
      </div>
      <div class="ti-expiry-bar"><div class="ti-expiry-fill ${color}" style="width:${pct}%"></div></div>
      <div class="ti-token-body">
        <dl class="ti-claims">
          ${Object.entries(token.claims).map(([k,v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}
        </dl>
        <div class="ti-scopes">
          ${token.scopes.map(s => `<span class="ti-scope-pill">${s}</span>`).join('')}
        </div>
      </div>
    </div>`;
  }

  // ── File Change Notification ──
  _renderFileChangeBar() {
    const bar = document.getElementById('file-change-bar');
    if (!bar) return;
    bar.innerHTML = `Files changed: <span class="fc-files">GTSBasedSparkClient.cs, WorkloadApp.cs</span>
      <div style="margin-left:auto;display:flex;gap:var(--space-2)">
        <button class="fc-btn primary">Re-deploy</button>
        <button class="fc-btn" id="fc-dismiss">Dismiss</button>
      </div>`;
  }

  // ── Interactions ──
  _bindInteractions() {
    // Token inspector toggle
    const tokenEl = document.getElementById('token-health');
    if (tokenEl) {
      tokenEl.style.cursor = 'pointer';
      tokenEl.addEventListener('click', () => {
        const drawer = document.getElementById('token-inspector');
        if (drawer) drawer.classList.toggle('open');
      });
    }
    const tiClose = document.getElementById('ti-close-btn');
    if (tiClose) tiClose.addEventListener('click', () => {
      const drawer = document.getElementById('token-inspector');
      if (drawer) drawer.classList.remove('open');
    });

    // File change dismiss
    const fcDismiss = document.getElementById('fc-dismiss');
    if (fcDismiss) fcDismiss.addEventListener('click', () => {
      const bar = document.getElementById('file-change-bar');
      if (bar) bar.style.display = 'none';
    });

    // Bookmarks drawer toggle
    const bmBtn = document.getElementById('open-bookmarks-btn');
    if (bmBtn) bmBtn.addEventListener('click', () => {
      const drawer = document.getElementById('bookmarks-drawer');
      if (drawer) drawer.classList.toggle('open');
    });

    // Workspace tree clicks + context menu
    const tree = document.getElementById('ws-tree-content');
    if (tree) {
      tree.querySelectorAll('.ws-tree-item').forEach(item => {
        item.addEventListener('click', () => {
          tree.querySelectorAll('.ws-tree-item').forEach(i => i.classList.remove('selected'));
          item.classList.add('selected');
        });
        item.addEventListener('contextmenu', (e) => this._showContextMenu(e, item));
      });
    }

    // Deploy button
    const deployBtn = document.querySelector('.ws-deploy-btn');
    if (deployBtn) deployBtn.addEventListener('click', () => this._startDeployFlow());

    // Extend command palette with data types
    if (typeof CommandPalette !== 'undefined') {
      const origGet = CommandPalette.prototype._getCommands;
      CommandPalette.prototype._getCommands = function() {
        const cmds = origGet.call(this);
        MockData.workspaces.forEach(ws => {
          cmds.push({ group: 'Workspaces', icon: '\u25A6', label: ws.displayName, action: () => this._sidebar?.switchView('workspace') });
        });
        MockData.getItemsForWorkspace(0).filter(i => i.type === 'Lakehouse').forEach(item => {
          cmds.push({ group: 'Lakehouses', icon: '\u25C6', label: item.displayName, action: () => this._sidebar?.switchView('workspace') });
        });
        MockData.tablesForLakehouse.forEach(t => {
          cmds.push({ group: 'Tables', icon: '\u25A4', label: t.name, action: () => this._sidebar?.switchView('workspace') });
        });
        MockData.featureFlags.slice(0, 6).forEach(f => {
          cmds.push({ group: 'Feature Flags', icon: '\u2691', label: f.name, action: () => this._sidebar?.switchView('environment') });
        });
        return cmds;
      };
    }
  }

  // ── Log Detail Panel ──
  _openLogDetail(idx) {
    const entry = this._logEntries[idx];
    if (!entry) return;
    const panel = document.getElementById('detail-panel');
    if (!panel) return;

    const title = document.getElementById('detail-title');
    if (title) title.textContent = entry.level + ' \u2014 ' + entry.component;

    const content = panel.querySelector('.detail-content');
    if (content) {
      const props = { Duration: '2.3s', NodeName: 'RefreshSalesData', ThreadId: 42, CorrelationId: MockData.uuid().substring(0, 8) };
      content.innerHTML = `
        <div style="display:grid;grid-template-columns:90px 1fr;gap:var(--space-1) var(--space-3);font-size:var(--text-sm);padding:var(--space-3)">
          <dt style="color:var(--text-muted);font-weight:500">Timestamp</dt><dd style="font-family:var(--font-mono)">${entry.timestamp}</dd>
          <dt style="color:var(--text-muted);font-weight:500">Level</dt><dd><span class="log-level-badge" style="font-size:var(--text-xs)">${entry.level}</span></dd>
          <dt style="color:var(--text-muted);font-weight:500">Component</dt><dd style="font-family:var(--font-mono)">${entry.component}</dd>
          ${entry.rootActivityId ? '<dt style="color:var(--text-muted);font-weight:500">RAID</dt><dd style="font-family:var(--font-mono)">' + entry.rootActivityId + '</dd>' : ''}
        </div>
        <div style="padding:0 var(--space-3) var(--space-3)">
          <div style="font-size:var(--text-xs);font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:var(--space-2)">Message</div>
          <div style="font-family:var(--font-mono);font-size:var(--text-sm);padding:var(--space-3);background:var(--surface-2);border-radius:var(--radius-md);border:1px solid var(--border);line-height:1.6">${this._escapeHtml(entry.message)}</div>
        </div>
        <div style="padding:0 var(--space-3) var(--space-3)">
          <div style="font-size:var(--text-xs);font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:var(--space-2)">Properties</div>
          <div style="font-family:var(--font-mono);font-size:var(--text-xs);padding:var(--space-3);background:var(--surface-2);border-radius:var(--radius-md);border:1px solid var(--border);white-space:pre;line-height:1.8">${this._escapeHtml(JSON.stringify(props, null, 2))}</div>
        </div>`;
    }

    panel.classList.add('visible');
    const closeBtn = document.getElementById('detail-close');
    if (closeBtn) closeBtn.onclick = () => panel.classList.remove('visible');
  }

  // ── Breakpoint Highlights ──
  _applyBreakpointHighlights() {
    const breakpoints = [
      { regex: /NullReference/i, color: 'var(--level-error)' },
      { regex: /throttl/i, color: 'var(--level-warning)' },
    ];
    document.querySelectorAll('#logs-container .log-row').forEach(row => {
      const msg = row.querySelector('.log-message')?.textContent || '';
      for (const bp of breakpoints) {
        if (bp.regex.test(msg)) {
          row.style.borderLeft = '3px solid ' + bp.color;
          break;
        }
      }
    });
  }

  // ── Log Toolbar Filters ──
  _bindLogFilters() {
    // Level buttons
    document.querySelectorAll('.level-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        btn.classList.toggle('active');
        this._applyLogFilters();
      });
    });
    // Preset buttons
    document.querySelectorAll('.preset-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this._applyLogFilters();
      });
    });
  }

  _applyLogFilters() {
    const activeLevels = new Set();
    document.querySelectorAll('.level-btn.active').forEach(b => activeLevels.add(b.dataset.level?.toLowerCase()));

    const activePreset = document.querySelector('.preset-btn.active')?.dataset.preset || 'all';
    const presetComponents = {
      all: null,
      flt: ['dagexecutionhandler', 'refreshengine', 'tokenmanager', 'metastoreclient'],
      dag: ['dagexecutionhandler'],
      spark: ['sparkclient'],
    };
    const allowedComps = presetComponents[activePreset];

    let visible = 0;
    document.querySelectorAll('#logs-container .log-row').forEach(row => {
      const level = row.className.match(/log-level-(\w+)/)?.[1] || '';
      const comp = row.querySelector('.log-component')?.textContent.toLowerCase() || '';
      const levelOk = activeLevels.size === 0 || activeLevels.has(level);
      const compOk = !allowedComps || allowedComps.some(c => comp.includes(c));
      const show = levelOk && compOk;
      row.style.display = show ? '' : 'none';
      if (show) visible++;
    });
    this._setTextSafe('visible-count', String(visible));
  }

  // ── Error Code Decorator ──
  _decorateLogMessage(msg) {
    let safe = this._escapeHtml(msg);
    for (const [code, info] of Object.entries(MockData.errorCodes)) {
      if (safe.includes(code)) {
        const tooltip = this._escapeHtml(info.message + '\nType: ' + info.type + '\nFix: ' + info.fix);
        safe = safe.replace(code, '<span class="error-code-hint" title="' + tooltip + '">' + code + '</span>');
      }
    }
    return safe;
  }

  // ── DAG Node Detail ──
  _bindDagNodeClicks() {
    const panel = document.getElementById('dag-graph-panel');
    if (!panel) return;
    panel.addEventListener('click', (e) => {
      const node = e.target.closest('.dag-node');
      if (!node) return;
      const nodeId = node.classList.toString().match(/\b(n\d+)\b/)?.[0];
      if (!nodeId) {
        const allNodes = panel.querySelectorAll('.dag-node');
        const idx = Array.from(allNodes).indexOf(node);
        if (idx >= 0 && MockData.dagNodes[idx]) {
          this._openDagNodeDetail(MockData.dagNodes[idx]);
        }
      }
    });
  }

  _openDagNodeDetail(node) {
    let detail = document.getElementById('dag-node-detail');
    if (!detail) {
      detail = document.createElement('div');
      detail.id = 'dag-node-detail';
      detail.className = 'dag-node-detail';
      const graphPanel = document.querySelector('.dag-graph-panel');
      if (graphPanel) graphPanel.appendChild(detail);
    }

    const kindBadge = node.kind === 'sql'
      ? '<span class="status-pill" style="background:var(--comp-default-bg);color:var(--comp-default)">SQL</span>'
      : '<span class="status-pill" style="background:var(--comp-dq-bg);color:var(--comp-dq)">PySpark</span>';
    const statusCls = node.status;
    const mockSql = 'CREATE OR REPLACE MATERIALIZED VIEW ' + node.name + ' AS\nSELECT region, SUM(amount) as total\nFROM sales_transactions\nWHERE date >= CURRENT_DATE - 30\nGROUP BY region';

    detail.innerHTML = `
      <div style="display:flex;align-items:center;gap:var(--space-2);margin-bottom:var(--space-3)">
        <span style="font-size:var(--text-lg);font-weight:600">${node.name}</span>
        ${kindBadge}
        <span class="status-pill ${statusCls}">${node.status}</span>
        ${node.duration ? '<span style="font-size:var(--text-xs);color:var(--text-muted);font-family:var(--font-mono)">' + (node.duration / 1000).toFixed(1) + 's</span>' : ''}
        <button style="margin-left:auto;background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:var(--text-lg)" onclick="document.getElementById('dag-node-detail').classList.remove('open')">\u2715</button>
      </div>
      ${node.errorMessage ? '<div style="padding:var(--space-2) var(--space-3);background:var(--row-error-tint);border:1px solid rgba(229,69,59,0.12);border-radius:var(--radius-md);font-size:var(--text-sm);color:var(--level-error);margin-bottom:var(--space-3)">' + this._escapeHtml(node.errorMessage) + '</div>' : ''}
      <div style="font-size:var(--text-xs);font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:var(--space-2)">Definition</div>
      <div style="font-family:var(--font-mono);font-size:var(--text-xs);padding:var(--space-3);background:var(--surface-2);border-radius:var(--radius-md);border:1px solid var(--border);white-space:pre;line-height:1.7;max-height:120px;overflow-y:auto">${this._escapeHtml(mockSql)}</div>`;

    detail.classList.add('open');
  }

  // ── Context Menu ──
  _initContextMenu() {
    const menu = document.createElement('div');
    menu.className = 'ws-ctx-menu';
    menu.id = 'ws-ctx-menu';
    document.body.appendChild(menu);

    const toast = document.createElement('div');
    toast.className = 'edog-toast';
    toast.id = 'edog-toast';
    document.body.appendChild(toast);

    document.addEventListener('click', () => this._hideContextMenu());
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') this._hideContextMenu(); });
  }

  _showContextMenu(e, treeItem) {
    e.preventDefault();
    const menu = document.getElementById('ws-ctx-menu');
    if (!menu) return;

    const isLH = !treeItem.classList.contains('dimmed') && treeItem.dataset.itemIdx !== undefined;
    const isWS = treeItem.dataset.wsIdx !== undefined && treeItem.dataset.itemIdx === undefined;
    const name = treeItem.querySelector('.ws-tree-label')?.textContent || '';

    let items = [];
    if (isLH) {
      items.push({ label: '\u25B6 Deploy to this Lakehouse', cls: 'accent', action: () => this._startDeployFlow(name) });
      items.push({ label: '\u2606 Save as Favorite', action: () => this._showToast('Saved "' + name + '" to favorites') });
      items.push({ sep: true });
    }
    items.push({ label: 'Rename', action: () => this._showToast('Rename: ' + name) });
    items.push({ label: 'Open in Fabric', action: () => this._showToast('Opening in Fabric...') });
    items.push({ label: 'Copy ID', action: () => { navigator.clipboard?.writeText(MockData.uuid()); this._showToast('ID copied to clipboard'); } });
    items.push({ label: 'Copy Name', action: () => { navigator.clipboard?.writeText(name); this._showToast('"' + name + '" copied'); } });
    if (!isWS) {
      items.push({ sep: true });
      items.push({ label: 'Delete', cls: 'danger', action: () => this._showToast('Delete: ' + name + ' (mock)') });
    }

    menu.innerHTML = items.map(it =>
      it.sep ? '<div class="ws-ctx-sep"></div>'
        : `<div class="ws-ctx-item${it.cls ? ' ' + it.cls : ''}">${it.label}</div>`
    ).join('');

    // Bind item clicks
    const itemEls = menu.querySelectorAll('.ws-ctx-item');
    let idx = 0;
    items.forEach(it => {
      if (it.sep) return;
      const el = itemEls[idx++];
      el.addEventListener('click', (ev) => { ev.stopPropagation(); this._hideContextMenu(); it.action(); });
    });

    // Position — keep on screen
    menu.classList.add('visible');
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    const x = Math.min(e.clientX, window.innerWidth - mw - 8);
    const y = Math.min(e.clientY, window.innerHeight - mh - 8);
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
  }

  _hideContextMenu() {
    const menu = document.getElementById('ws-ctx-menu');
    if (menu) menu.classList.remove('visible');
  }

  _showToast(msg) {
    const toast = document.getElementById('edog-toast');
    if (!toast) return;
    toast.textContent = msg;
    toast.classList.add('visible');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => toast.classList.remove('visible'), 2000);
  }

  // ── Deploy Flow ──
  _startDeployFlow(lakehouseName) {
    const content = document.getElementById('ws-content-body');
    if (!content) return;
    lakehouseName = lakehouseName || 'TestLakehouse-01';

    const steps = [
      'Fetching MWC token\u2026',
      'Patching FLT code\u2026',
      'Building service\u2026',
      'Launching service\u2026',
      'Waiting for service ready\u2026',
    ];

    content.innerHTML = `
      <div class="deploy-progress">
        <div class="ws-content-name">Deploying to ${this._escapeHtml(lakehouseName)}</div>
        <div style="margin-top:var(--space-4)">
          ${steps.map((s, i) => `<div class="deploy-step" id="deploy-step-${i}">
            <span class="deploy-step-num">${i + 1}</span>
            <span class="deploy-step-label">${s}</span>
          </div>`).join('')}
        </div>
        <div id="deploy-done" style="display:none;margin-top:var(--space-6)">
          <div style="font-size:var(--text-lg);font-weight:600;color:var(--status-succeeded);margin-bottom:var(--space-2)">\u2713 Deployed successfully</div>
          <div style="font-size:var(--text-sm);color:var(--text-dim);margin-bottom:var(--space-4)">Service is running on localhost:5555</div>
          <button class="ws-deploy-btn" id="deploy-view-logs">\u2261 View Logs</button>
        </div>
      </div>`;

    // Animate steps
    let current = 0;
    const advance = () => {
      if (current > 0) {
        const prev = document.getElementById('deploy-step-' + (current - 1));
        if (prev) { prev.classList.remove('active'); prev.classList.add('done'); }
      }
      if (current < steps.length) {
        const step = document.getElementById('deploy-step-' + current);
        if (step) step.classList.add('active');
        current++;
        setTimeout(advance, 1200 + Math.random() * 600);
      } else {
        const last = document.getElementById('deploy-step-' + (steps.length - 1));
        if (last) { last.classList.remove('active'); last.classList.add('done'); }
        const done = document.getElementById('deploy-done');
        if (done) done.style.display = 'block';
        // Wire "View Logs" button
        const btn = document.getElementById('deploy-view-logs');
        if (btn) btn.addEventListener('click', () => {
          const sidebar = document.querySelector('.sidebar-icon[data-view="logs"]');
          if (sidebar) sidebar.click();
        });
      }
    };
    setTimeout(advance, 300);
  }

  // ── Helpers ──
  _setTextSafe(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  _formatNum(n) {
    return n.toLocaleString();
  }

  _formatBytes(bytes) {
    if (bytes >= 1e9) return (bytes / 1e9).toFixed(1) + ' GB';
    if (bytes >= 1e6) return (bytes / 1e6).toFixed(0) + ' MB';
    if (bytes >= 1e3) return (bytes / 1e3).toFixed(0) + ' KB';
    return bytes + ' B';
  }

  _relativeTime(isoStr) {
    const diff = Date.now() - new Date(isoStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return mins + 'm ago';
    const hours = Math.floor(mins / 60);
    if (hours < 24) return hours + 'h ago';
    return Math.floor(hours / 24) + 'd ago';
  }

  _escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}
