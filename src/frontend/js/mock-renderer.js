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
          <span class="ws-meta-badge">F2 PPE ● West US 2</span>
          <span class="ws-meta-modified">Modified ${this._relativeTime(item.lastModified)}</span>
        </div>
        <div class="ws-content-actions">
          <button class="ws-deploy-btn">\u25B6 Deploy to this Lakehouse</button>
          <button class="ws-action-btn ghost">Open in Fabric</button>
          <button class="ws-action-btn ghost">Rename</button>
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
        <span class="log-message">${entry.message}</span>
      </div>`;
    });
    container.innerHTML = html;
    container.classList.add('has-entries');

    // Update stats
    const errors = this._logEntries.filter(e => e.level === 'Error').length;
    const warnings = this._logEntries.filter(e => e.level === 'Warning').length;
    this._setTextSafe('stat-logs', String(this._logEntries.length));
    this._setTextSafe('stat-ssr', '24');
    this._setTextSafe('stat-errors', String(errors));
    this._setTextSafe('visible-count', String(this._logEntries.length));
    this._setTextSafe('total-count', String(this._logEntries.length));

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
  }

  _renderSparkDetail(idx) {
    const detail = document.getElementById('spark-detail');
    if (!detail) return;
    const req = MockData.sparkRequests[idx];
    const methodCls = req.method.toLowerCase();
    const statusCls = req.status < 300 ? 's2xx' : req.status < 500 ? 's4xx' : 's5xx';

    detail.innerHTML = `
      <div class="spark-detail-tabs">
        <button class="spark-detail-tab active">Request</button>
        <button class="spark-detail-tab">Response</button>
        <button class="spark-detail-tab">Timing</button>
      </div>
      <div class="spark-detail-content">
        <dl class="spark-kv">
          <dt>Method</dt><dd><span class="method-pill ${methodCls}">${req.method}</span></dd>
          <dt>Endpoint</dt><dd>${req.endpoint}</dd>
          <dt>Status</dt><dd><span class="status-code ${statusCls}">${req.status}</span></dd>
          <dt>Duration</dt><dd>${req.duration}ms</dd>
          <dt>Retries</dt><dd>${req.retries}</dd>
          <dt>Time</dt><dd>${req.timestamp}</dd>
        </dl>
        ${req.body ? `<div style="margin-top:var(--space-3)">
          <div style="font-size:var(--text-xs);color:var(--text-muted);margin-bottom:var(--space-1);font-weight:600">REQUEST BODY</div>
          <div class="spark-code-block">${this._escapeHtml(req.body)}</div>
        </div>` : ''}
        <div style="margin-top:var(--space-3)">
          <div style="font-size:var(--text-xs);color:var(--text-muted);margin-bottom:var(--space-1);font-weight:600">RESPONSE</div>
          <div class="spark-code-block">${this._escapeHtml(req.response)}</div>
        </div>
      </div>`;
  }

  // ── API Playground ──
  _renderApiPlayground() {
    const panel = document.getElementById('view-api');
    if (!panel) return;

    panel.innerHTML = `<div class="api-playground">
      <div class="api-main">
        <div class="api-request-section">
          <div class="api-url-row">
            <select class="api-method-select"><option>GET</option><option>POST</option><option>PUT</option><option>PATCH</option><option>DELETE</option></select>
            <input class="api-url-input" value="https://api.fabric.microsoft.com/v1/workspaces" placeholder="Enter URL..." />
            <button class="api-send-btn">Send</button>
          </div>
          <div class="api-body-section">
            <span class="api-body-label">Headers</span>
            <div style="font-size:var(--text-xs);color:var(--text-dim);font-family:var(--font-mono);padding:var(--space-1) 0">Authorization: Bearer eyJ0eX...  (auto-filled)</div>
          </div>
        </div>
        <div class="api-response-section">
          <div class="api-response-header">
            <span class="api-response-status s2xx">200 OK</span>
            <span class="api-response-timing">342ms</span>
            <span style="margin-left:auto;font-size:var(--text-xs);color:var(--text-muted)">application/json; charset=utf-8</span>
          </div>
          <div class="api-response-body">${this._escapeHtml(JSON.stringify({
            value: MockData.workspaces.map(ws => ({ id: ws.id, displayName: ws.displayName, type: ws.type, state: ws.state })),
            continuationToken: null,
            continuationUri: null,
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

    // Workspace tree clicks
    const tree = document.getElementById('ws-tree-content');
    if (tree) {
      tree.querySelectorAll('.ws-tree-item').forEach(item => {
        item.addEventListener('click', () => {
          tree.querySelectorAll('.ws-tree-item').forEach(i => i.classList.remove('selected'));
          item.classList.add('selected');
        });
      });
    }
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
