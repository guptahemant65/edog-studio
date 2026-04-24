/**
 * F09 — API Playground
 *
 * Interactive REST API testing tool for Fabric and FLT endpoints.
 * 6 classes: JsonTree, EndpointCatalog, RequestBuilder, ResponseViewer,
 * HistorySaved, ApiPlayground (orchestrator).
 *
 * Architecture: docs/specs/features/F09-api-playground/architecture.md
 */

/* ══════════════════════════════════════════════════════════════
 * §0  ENDPOINT CATALOG DATA
 * ══════════════════════════════════════════════════════════════ */

var ENDPOINT_GROUPS = [
  { id: 'workspace',   label: 'Workspace',   order: 0 },
  { id: 'items',       label: 'Items',       order: 1 },
  { id: 'lakehouse',   label: 'Lakehouse',   order: 2 },
  { id: 'tables',      label: 'Tables',      order: 3 },
  { id: 'notebooks',   label: 'Notebooks',   order: 4 },
  { id: 'environment', label: 'Environment', order: 5 },
  { id: 'dag',         label: 'DAG',         order: 6 },
  { id: 'execution',   label: 'Execution',   order: 7 },
  { id: 'spark',       label: 'Spark',       order: 8 },
  { id: 'maintenance', label: 'Maintenance', order: 9 },
];

var ENDPOINT_CATALOG = [
  // ── Workspace (bearer) ──
  { id: 'list-workspaces',   name: 'List Workspaces',   method: 'GET',    urlTemplate: '/v1/workspaces',                                    group: 'workspace', tokenType: 'bearer', bodyTemplate: null, description: 'List all accessible workspaces', dangerLevel: 'safe' },
  { id: 'get-workspace',     name: 'Get Workspace',     method: 'GET',    urlTemplate: '/v1/workspaces/{workspaceId}',                      group: 'workspace', tokenType: 'bearer', bodyTemplate: null, description: 'Get workspace details by ID', dangerLevel: 'safe' },
  { id: 'create-workspace',  name: 'Create Workspace',  method: 'POST',   urlTemplate: '/v1/workspaces',                                    group: 'workspace', tokenType: 'bearer', bodyTemplate: { displayName: 'New Workspace' }, description: 'Create a new workspace', dangerLevel: 'caution' },
  { id: 'update-workspace',  name: 'Update Workspace',  method: 'PATCH',  urlTemplate: '/v1/workspaces/{workspaceId}',                      group: 'workspace', tokenType: 'bearer', bodyTemplate: { displayName: 'Updated Name' }, description: 'Update workspace properties', dangerLevel: 'caution' },
  { id: 'delete-workspace',  name: 'Delete Workspace',  method: 'DELETE', urlTemplate: '/v1/workspaces/{workspaceId}',                      group: 'workspace', tokenType: 'bearer', bodyTemplate: null, description: 'Permanently delete a workspace', dangerLevel: 'destructive' },

  // ── Items (bearer) ──
  { id: 'list-items',  name: 'List Items',  method: 'GET',    urlTemplate: '/v1/workspaces/{workspaceId}/items',               group: 'items', tokenType: 'bearer', bodyTemplate: null, description: 'List all items in a workspace', dangerLevel: 'safe' },
  { id: 'get-item',    name: 'Get Item',    method: 'GET',    urlTemplate: '/v1/workspaces/{workspaceId}/items/{itemId}',       group: 'items', tokenType: 'bearer', bodyTemplate: null, description: 'Get item details', dangerLevel: 'safe' },
  { id: 'delete-item', name: 'Delete Item', method: 'DELETE', urlTemplate: '/v1/workspaces/{workspaceId}/items/{itemId}',       group: 'items', tokenType: 'bearer', bodyTemplate: null, description: 'Delete an item from workspace', dangerLevel: 'destructive' },

  // ── Lakehouse (bearer) ──
  { id: 'list-lakehouses',  name: 'List Lakehouses',  method: 'GET',    urlTemplate: '/v1/workspaces/{workspaceId}/lakehouses',                          group: 'lakehouse', tokenType: 'bearer', bodyTemplate: null, description: 'List all lakehouses', dangerLevel: 'safe' },
  { id: 'get-lakehouse',    name: 'Get Lakehouse',    method: 'GET',    urlTemplate: '/v1/workspaces/{workspaceId}/lakehouses/{lakehouseId}',             group: 'lakehouse', tokenType: 'bearer', bodyTemplate: null, description: 'Get lakehouse details', dangerLevel: 'safe' },
  { id: 'create-lakehouse', name: 'Create Lakehouse', method: 'POST',   urlTemplate: '/v1/workspaces/{workspaceId}/lakehouses',                          group: 'lakehouse', tokenType: 'bearer', bodyTemplate: { displayName: 'New Lakehouse' }, description: 'Create a new lakehouse', dangerLevel: 'caution' },
  { id: 'update-lakehouse', name: 'Update Lakehouse', method: 'PATCH',  urlTemplate: '/v1/workspaces/{workspaceId}/lakehouses/{lakehouseId}',             group: 'lakehouse', tokenType: 'bearer', bodyTemplate: { displayName: 'Updated Lakehouse' }, description: 'Update lakehouse properties', dangerLevel: 'caution' },
  { id: 'delete-lakehouse', name: 'Delete Lakehouse', method: 'DELETE', urlTemplate: '/v1/workspaces/{workspaceId}/lakehouses/{lakehouseId}',             group: 'lakehouse', tokenType: 'bearer', bodyTemplate: null, description: 'Delete a lakehouse', dangerLevel: 'destructive' },

  // ── Tables (mixed) ──
  { id: 'list-tables',      name: 'List Tables',       method: 'GET', urlTemplate: '/v1/workspaces/{workspaceId}/lakehouses/{lakehouseId}/tables', group: 'tables', tokenType: 'bearer', bodyTemplate: null, description: 'List tables in a lakehouse', dangerLevel: 'safe' },
  { id: 'get-table-props',  name: 'Table Properties',  method: 'GET', urlTemplate: '{fabricBaseUrl}/liveTable/tables/{tableName}/properties',      group: 'tables', tokenType: 'mwc',    bodyTemplate: null, description: 'Get table properties (FLT)', dangerLevel: 'safe' },
  { id: 'get-table-schema', name: 'Table Schema',      method: 'GET', urlTemplate: '{fabricBaseUrl}/liveTable/tables/{tableName}/schema',          group: 'tables', tokenType: 'mwc',    bodyTemplate: null, description: 'Get table schema (FLT)', dangerLevel: 'safe' },
  { id: 'get-table-stats',  name: 'Table Stats',       method: 'GET', urlTemplate: '{fabricBaseUrl}/liveTable/tables/{tableName}/stats',           group: 'tables', tokenType: 'mwc',    bodyTemplate: null, description: 'Get table statistics (FLT)', dangerLevel: 'safe' },

  // ── Notebooks (bearer) ──
  { id: 'list-notebooks',  name: 'List Notebooks',  method: 'GET',    urlTemplate: '/v1/workspaces/{workspaceId}/notebooks',                    group: 'notebooks', tokenType: 'bearer', bodyTemplate: null, description: 'List notebooks in workspace', dangerLevel: 'safe' },
  { id: 'get-notebook',    name: 'Get Notebook',    method: 'GET',    urlTemplate: '/v1/workspaces/{workspaceId}/notebooks/{notebookId}',       group: 'notebooks', tokenType: 'bearer', bodyTemplate: null, description: 'Get notebook details', dangerLevel: 'safe' },
  { id: 'create-notebook', name: 'Create Notebook', method: 'POST',   urlTemplate: '/v1/workspaces/{workspaceId}/notebooks',                    group: 'notebooks', tokenType: 'bearer', bodyTemplate: { displayName: 'New Notebook' }, description: 'Create a new notebook', dangerLevel: 'caution' },
  { id: 'delete-notebook', name: 'Delete Notebook', method: 'DELETE', urlTemplate: '/v1/workspaces/{workspaceId}/notebooks/{notebookId}',       group: 'notebooks', tokenType: 'bearer', bodyTemplate: null, description: 'Delete a notebook', dangerLevel: 'destructive' },

  // ── Environment (bearer) ──
  { id: 'get-environment', name: 'Get Environment', method: 'GET', urlTemplate: '/v1/workspaces/{workspaceId}/environments', group: 'environment', tokenType: 'bearer', bodyTemplate: null, description: 'Get workspace environment settings', dangerLevel: 'safe' },

  // ── DAG (mwc) ──
  { id: 'get-latest-dag', name: 'Get Latest DAG',  method: 'GET',  urlTemplate: '{fabricBaseUrl}/liveTable/dag/latest',  group: 'dag', tokenType: 'mwc', bodyTemplate: null, description: 'Get the latest DAG definition', dangerLevel: 'safe' },
  { id: 'run-dag',        name: 'Run DAG',         method: 'POST', urlTemplate: '{fabricBaseUrl}/liveTable/dag/run',     group: 'dag', tokenType: 'mwc', bodyTemplate: null, description: 'Trigger a DAG execution', dangerLevel: 'caution' },
  { id: 'cancel-dag',     name: 'Cancel DAG',      method: 'POST', urlTemplate: '{fabricBaseUrl}/liveTable/dag/cancel',  group: 'dag', tokenType: 'mwc', bodyTemplate: null, description: 'Cancel running DAG execution', dangerLevel: 'caution' },
  { id: 'get-dag-status', name: 'DAG Status',      method: 'GET',  urlTemplate: '{fabricBaseUrl}/liveTable/dag/status',  group: 'dag', tokenType: 'mwc', bodyTemplate: null, description: 'Get current DAG execution status', dangerLevel: 'safe' },
  { id: 'get-dag-history',name: 'DAG History',     method: 'GET',  urlTemplate: '{fabricBaseUrl}/liveTable/dag/history', group: 'dag', tokenType: 'mwc', bodyTemplate: null, description: 'List past DAG executions', dangerLevel: 'safe' },
  { id: 'get-dag-metrics',name: 'DAG Metrics',     method: 'GET',  urlTemplate: '{fabricBaseUrl}/liveTable/dag/metrics', group: 'dag', tokenType: 'mwc', bodyTemplate: null, description: 'Get DAG execution metrics', dangerLevel: 'safe' },

  // ── Execution (mwc) ──
  { id: 'get-exec-status',  name: 'Execution Status',  method: 'GET', urlTemplate: '{fabricBaseUrl}/liveTable/execution/status',  group: 'execution', tokenType: 'mwc', bodyTemplate: null, description: 'Get current execution status', dangerLevel: 'safe' },
  { id: 'get-exec-logs',    name: 'Execution Logs',    method: 'GET', urlTemplate: '{fabricBaseUrl}/liveTable/execution/logs',    group: 'execution', tokenType: 'mwc', bodyTemplate: null, description: 'Get execution log entries', dangerLevel: 'safe' },
  { id: 'get-exec-metrics', name: 'Execution Metrics', method: 'GET', urlTemplate: '{fabricBaseUrl}/liveTable/execution/metrics', group: 'execution', tokenType: 'mwc', bodyTemplate: null, description: 'Get execution performance metrics', dangerLevel: 'safe' },

  // ── Spark (mwc) ──
  { id: 'list-spark-sessions', name: 'Spark Sessions', method: 'GET', urlTemplate: '{fabricBaseUrl}/liveTable/spark/sessions',       group: 'spark', tokenType: 'mwc', bodyTemplate: null, description: 'List active Spark sessions', dangerLevel: 'safe' },
  { id: 'get-spark-job',       name: 'Spark Job',      method: 'GET', urlTemplate: '{fabricBaseUrl}/liveTable/spark/jobs/{jobId}',   group: 'spark', tokenType: 'mwc', bodyTemplate: null, description: 'Get Spark job details', dangerLevel: 'safe' },
  { id: 'get-spark-metrics',   name: 'Spark Metrics',  method: 'GET', urlTemplate: '{fabricBaseUrl}/liveTable/spark/metrics',        group: 'spark', tokenType: 'mwc', bodyTemplate: null, description: 'Get Spark resource metrics', dangerLevel: 'safe' },

  // ── Maintenance (mwc) ──
  { id: 'force-unlock',     name: 'Force Unlock DAG',   method: 'POST', urlTemplate: '{fabricBaseUrl}/liveTable/maintenance/unlock',   group: 'maintenance', tokenType: 'mwc', bodyTemplate: null, description: 'Force unlock a stuck DAG', dangerLevel: 'destructive' },
  { id: 'list-orphaned',    name: 'List Orphaned',      method: 'GET',  urlTemplate: '{fabricBaseUrl}/liveTable/maintenance/orphaned', group: 'maintenance', tokenType: 'mwc', bodyTemplate: null, description: 'Find orphaned index folders', dangerLevel: 'safe' },
  { id: 'cleanup-orphaned', name: 'Cleanup Orphaned',   method: 'POST', urlTemplate: '{fabricBaseUrl}/liveTable/maintenance/cleanup',  group: 'maintenance', tokenType: 'mwc', bodyTemplate: null, description: 'Remove orphaned folders', dangerLevel: 'destructive' },
];

/* ══════════════════════════════════════════════════════════════
 * §1  JSON TREE RENDERER
 * ══════════════════════════════════════════════════════════════ */

class JsonTree {
  constructor(container) {
    this._container = container;
    this._data = null;
  }

  render(data) {
    this._data = data;
    this._container.innerHTML = '';
    if (data === undefined || data === null) {
      this._container.textContent = String(data);
      return;
    }
    var root = this._buildNode(data, '', 0);
    this._container.appendChild(root);
  }

  _buildNode(value, key, depth) {
    var el = document.createElement('div');
    el.className = 'json-node';
    var prefix = key !== '' ? '<span class="json-key">"' + this._esc(key) + '"</span>: ' : '';

    if (value === null) {
      el.innerHTML = prefix + '<span class="json-null">null</span>';
      return el;
    }
    var t = typeof value;
    if (t === 'string') {
      el.innerHTML = prefix + '<span class="json-string">"' + this._esc(value) + '"</span>';
      return el;
    }
    if (t === 'number') {
      el.innerHTML = prefix + '<span class="json-number">' + value + '</span>';
      return el;
    }
    if (t === 'boolean') {
      el.innerHTML = prefix + '<span class="json-boolean">' + value + '</span>';
      return el;
    }

    var isArr = Array.isArray(value);
    var keys = isArr ? null : Object.keys(value);
    var count = isArr ? value.length : keys.length;
    var open = isArr ? '[' : '{';
    var close = isArr ? ']' : '}';

    var header = document.createElement('div');
    header.className = 'json-node-header';
    var toggle = document.createElement('span');
    toggle.className = 'json-toggle';
    var expanded = depth < 2;
    toggle.textContent = expanded ? '\u25BE' : '\u25B8';

    var label = document.createElement('span');
    label.innerHTML = prefix
      + '<span class="json-bracket">' + open + '</span>'
      + '<span class="json-count"> ' + count + (count === 1 ? ' item' : ' items') + ' </span>'
      + '<span class="json-bracket">' + close + '</span>';

    header.appendChild(toggle);
    header.appendChild(label);
    el.appendChild(header);

    var children = document.createElement('div');
    children.className = 'json-children';
    if (!expanded) children.style.display = 'none';

    var i;
    if (isArr) {
      for (i = 0; i < value.length; i++) {
        children.appendChild(this._buildNode(value[i], String(i), depth + 1));
      }
    } else {
      for (i = 0; i < keys.length; i++) {
        children.appendChild(this._buildNode(value[keys[i]], keys[i], depth + 1));
      }
    }
    el.appendChild(children);

    toggle.addEventListener('click', function() {
      var isOpen = children.style.display !== 'none';
      children.style.display = isOpen ? 'none' : '';
      toggle.textContent = isOpen ? '\u25B8' : '\u25BE';
    });

    return el;
  }

  expandAll() {
    var nodes = this._container.querySelectorAll('.json-children');
    var toggles = this._container.querySelectorAll('.json-toggle');
    for (var i = 0; i < nodes.length; i++) { nodes[i].style.display = ''; }
    for (var j = 0; j < toggles.length; j++) { toggles[j].textContent = '\u25BE'; }
  }

  collapseAll() {
    var nodes = this._container.querySelectorAll('.json-children');
    var toggles = this._container.querySelectorAll('.json-toggle');
    for (var i = 0; i < nodes.length; i++) { nodes[i].style.display = 'none'; }
    for (var j = 0; j < toggles.length; j++) { toggles[j].textContent = '\u25B8'; }
  }

  _esc(str) {
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(String(str)));
    return div.innerHTML;
  }

  destroy() {
    this._container.innerHTML = '';
    this._data = null;
  }
}

/* ══════════════════════════════════════════════════════════════
 * §2  ENDPOINT CATALOG
 * ══════════════════════════════════════════════════════════════ */

class EndpointCatalog {
  constructor(container) {
    this._container = container;
    this._isOpen = true;
    this._dropdown = null;
    this._searchInput = null;
    this.onSelect = null;
    this._boundClose = null;
    this._activeItem = null;
    this._groupStates = {};
    this._render();
  }

  _render() {
    this._container.innerHTML = '';

    // Header
    var header = document.createElement('div');
    header.className = 'api-catalog-header';
    var title = document.createElement('span');
    title.className = 'api-catalog-title';
    title.textContent = 'Endpoints';
    var count = document.createElement('span');
    count.className = 'api-catalog-count';
    count.textContent = ENDPOINT_CATALOG.length;
    header.appendChild(title);
    header.appendChild(count);
    this._container.appendChild(header);

    // Search
    var searchWrap = document.createElement('div');
    searchWrap.className = 'api-catalog-search';
    var searchBox = document.createElement('div');
    searchBox.className = 'api-catalog-search-box';
    var ico = document.createElement('span');
    ico.className = 's-ico';
    ico.textContent = '\u2315';
    this._searchInput = document.createElement('input');
    this._searchInput.placeholder = 'Search endpoints...';
    this._searchInput.setAttribute('type', 'text');
    searchBox.appendChild(ico);
    searchBox.appendChild(this._searchInput);
    searchWrap.appendChild(searchBox);
    this._container.appendChild(searchWrap);

    // Scrollable list
    this._dropdown = document.createElement('div');
    this._dropdown.className = 'api-catalog-scroll';
    this._container.appendChild(this._dropdown);
    this._renderList(this._dropdown, '');

    var self = this;
    this._searchInput.addEventListener('input', function() {
      self._renderList(self._dropdown, self._searchInput.value.toLowerCase());
    });
  }

  open() { this._isOpen = true; }
  close() { this._isOpen = false; }

  _renderList(listEl, filter) {
    listEl.innerHTML = '';
    var matched = 0;
    var groupColors = ['var(--green)', 'var(--blue)', 'var(--amber)', 'var(--purple)', 'var(--red)',
      'var(--green)', 'var(--blue)', 'var(--amber)', 'var(--purple)', 'var(--red)'];
    for (var g = 0; g < ENDPOINT_GROUPS.length; g++) {
      var group = ENDPOINT_GROUPS[g];
      var endpoints = [];
      for (var i = 0; i < ENDPOINT_CATALOG.length; i++) {
        var ep = ENDPOINT_CATALOG[i];
        if (ep.group !== group.id) continue;
        if (filter && ep.name.toLowerCase().indexOf(filter) === -1
            && ep.urlTemplate.toLowerCase().indexOf(filter) === -1
            && ep.method.toLowerCase().indexOf(filter) === -1) continue;
        endpoints.push(ep);
      }
      if (endpoints.length === 0) continue;

      var groupEl = document.createElement('div');
      groupEl.className = 'api-cat-group';

      // Group header
      var hdr = document.createElement('div');
      hdr.className = 'api-cat-group-hdr';
      var chev = document.createElement('span');
      chev.className = 'g-chev open';
      chev.textContent = '\u25B8';
      var dot = document.createElement('span');
      dot.className = 'g-dot';
      dot.style.background = groupColors[g % groupColors.length];
      var lbl = document.createElement('span');
      lbl.textContent = group.label;
      var ct = document.createElement('span');
      ct.className = 'g-ct';
      ct.textContent = endpoints.length;
      hdr.appendChild(chev);
      hdr.appendChild(dot);
      hdr.appendChild(lbl);
      hdr.appendChild(ct);
      groupEl.appendChild(hdr);

      // Group body
      var body = document.createElement('div');
      body.className = 'api-cat-group-body';
      if (this._groupStates[group.id] === false) {
        body.classList.add('collapsed');
        chev.classList.remove('open');
      }
      for (var j = 0; j < endpoints.length; j++) {
        var item = this._createItem(endpoints[j]);
        body.appendChild(item);
        matched++;
      }
      groupEl.appendChild(body);

      // Toggle collapse
      (function(b, c, gid, self2) {
        hdr.addEventListener('click', function() {
          var collapsed = b.classList.toggle('collapsed');
          c.classList.toggle('open', !collapsed);
          self2._groupStates[gid] = !collapsed;
        });
      })(body, chev, group.id, this);

      listEl.appendChild(groupEl);
    }
    if (matched === 0) {
      var empty = document.createElement('div');
      empty.className = 'api-catalog-empty';
      empty.textContent = filter ? 'No endpoints match "' + filter + '"' : 'No endpoints available';
      listEl.appendChild(empty);
    }
  }

  _createItem(ep) {
    var item = document.createElement('div');
    item.className = 'api-cat-item';
    if (ep.dangerLevel === 'destructive') item.classList.add('api-danger-destructive');

    var pill = document.createElement('span');
    pill.className = 'ci-method m-' + ep.method.toLowerCase();
    pill.textContent = ep.method;

    var info = document.createElement('div');
    info.className = 'ci-info';
    var name = document.createElement('span');
    name.className = 'ci-name';
    name.textContent = ep.name;
    var path = document.createElement('span');
    path.className = 'ci-path';
    path.textContent = ep.urlTemplate;
    info.appendChild(name);
    info.appendChild(path);

    item.appendChild(pill);
    item.appendChild(info);

    var self = this;
    item.addEventListener('click', function() {
      if (self._activeItem) self._activeItem.classList.remove('active');
      item.classList.add('active');
      self._activeItem = item;
      if (self.onSelect) self.onSelect(ep);
    });
    return item;
  }

  destroy() {
    this.close();
    this._container.innerHTML = '';
    this.onSelect = null;
  }
}

/* ══════════════════════════════════════════════════════════════
 * §3  REQUEST BUILDER
 * ══════════════════════════════════════════════════════════════ */

class RequestBuilder {
  constructor(container) {
    this._container = container;
    this._methodEl = null;
    this._urlEl = null;
    this._bodyEl = null;
    this._bodySection = null;
    this._headersEl = null;
    this._sendBtn = null;
    this._cancelBtn = null;
    this._catalogWrap = null;
    this._catalog = null;
    this._activeTab = 'headers';
    this.onSend = null;
    this._render();
  }

  _render() {
    this._container.innerHTML = '';

    // ── URL bar ──
    var urlBar = document.createElement('div');
    urlBar.className = 'api-url-bar';

    // Method pill (replaces <select>)
    var methodWrap = document.createElement('div');
    methodWrap.style.position = 'relative';
    this._methodEl = document.createElement('button');
    this._methodEl.className = 'api-method-pill get';
    this._methodEl.textContent = 'GET';
    this._methodEl.setAttribute('data-value', 'GET');
    methodWrap.appendChild(this._methodEl);

    // Method dropdown
    var dd = document.createElement('div');
    dd.className = 'api-method-dd';
    var methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
    var methodColors = { GET: 'var(--green)', POST: 'var(--blue)', PUT: 'var(--amber)',
      PATCH: 'var(--purple)', DELETE: 'var(--red)' };
    for (var i = 0; i < methods.length; i++) {
      var ddItem = document.createElement('div');
      ddItem.className = 'api-method-dd-item';
      ddItem.setAttribute('data-method', methods[i]);
      var ddDot = document.createElement('span');
      ddDot.className = 'dd-dot';
      ddDot.style.background = methodColors[methods[i]];
      var ddLbl = document.createElement('span');
      ddLbl.textContent = methods[i];
      ddItem.appendChild(ddDot);
      ddItem.appendChild(ddLbl);
      dd.appendChild(ddItem);
    }
    methodWrap.appendChild(dd);
    urlBar.appendChild(methodWrap);

    // URL input
    var urlWrap = document.createElement('div');
    urlWrap.className = 'api-url-wrap';
    this._urlEl = document.createElement('input');
    this._urlEl.className = 'api-url-input';
    this._urlEl.placeholder = 'Enter request URL or select from catalog...';
    urlWrap.appendChild(this._urlEl);
    urlBar.appendChild(urlWrap);

    // Send button
    this._sendBtn = document.createElement('button');
    this._sendBtn.className = 'api-send-btn';
    var sendSpinner = document.createElement('span');
    sendSpinner.className = 'spinner';
    var sendLabel = document.createElement('span');
    sendLabel.className = 'lbl';
    sendLabel.textContent = 'Send';
    this._sendBtn.appendChild(sendSpinner);
    this._sendBtn.appendChild(sendLabel);
    urlBar.appendChild(this._sendBtn);

    // Cancel button
    this._cancelBtn = document.createElement('button');
    this._cancelBtn.className = 'api-cancel-btn';
    this._cancelBtn.textContent = 'Cancel';
    urlBar.appendChild(this._cancelBtn);

    // cURL ghost button
    var curlBtn = document.createElement('button');
    curlBtn.className = 'api-ghost-btn';
    curlBtn.textContent = 'cURL';
    urlBar.appendChild(curlBtn);

    // Save ghost button
    var saveBtn = document.createElement('button');
    saveBtn.className = 'api-ghost-btn';
    saveBtn.textContent = 'Save';
    urlBar.appendChild(saveBtn);

    this._container.appendChild(urlBar);

    // ── Request Tabs ──
    var tabBar = document.createElement('div');
    tabBar.className = 'api-req-tabs';
    var tabNames = ['Params', 'Headers', 'Body', 'Auth'];
    var tabs = {};
    for (var t = 0; t < tabNames.length; t++) {
      var tab = document.createElement('button');
      tab.className = 'api-req-tab' + (tabNames[t].toLowerCase() === this._activeTab ? ' active' : '');
      tab.setAttribute('data-tab', tabNames[t].toLowerCase());
      tab.textContent = tabNames[t];
      tabBar.appendChild(tab);
      tabs[tabNames[t].toLowerCase()] = tab;
    }
    this._container.appendChild(tabBar);

    // ── Tab panes ──
    var content = document.createElement('div');
    content.className = 'api-req-content';

    // Params pane (stub)
    var paramsPane = document.createElement('div');
    paramsPane.className = 'api-req-pane';
    paramsPane.setAttribute('data-pane', 'params');
    paramsPane.innerHTML = '<div style="padding:var(--space-3) var(--space-4);color:var(--text-muted);font-size:var(--text-sm)">Query parameters are parsed from the URL</div>';
    content.appendChild(paramsPane);

    // Headers pane
    var headersPane = document.createElement('div');
    headersPane.className = 'api-req-pane active';
    headersPane.setAttribute('data-pane', 'headers');
    this._headersEl = document.createElement('div');
    headersPane.appendChild(this._headersEl);
    this._renderHeaders();
    content.appendChild(headersPane);

    // Body pane
    var bodyPane = document.createElement('div');
    bodyPane.className = 'api-req-pane';
    bodyPane.setAttribute('data-pane', 'body');
    this._bodySection = bodyPane;
    var bodyEditor = document.createElement('div');
    bodyEditor.className = 'api-body-editor';
    this._bodyEl = document.createElement('textarea');
    this._bodyEl.className = 'api-body-textarea';
    this._bodyEl.placeholder = '{\n  "key": "value"\n}';
    var bodyLang = document.createElement('span');
    bodyLang.className = 'api-body-lang';
    bodyLang.textContent = 'JSON';
    bodyEditor.appendChild(this._bodyEl);
    bodyEditor.appendChild(bodyLang);
    bodyPane.appendChild(bodyEditor);
    content.appendChild(bodyPane);

    // Auth pane
    var authPane = document.createElement('div');
    authPane.className = 'api-req-pane';
    authPane.setAttribute('data-pane', 'auth');
    authPane.innerHTML = '<div class="api-auth-panel">'
      + '<div class="api-auth-row"><span class="api-auth-lbl">Token Type</span>'
      + '<div class="api-auth-val">Auto-detected from URL</div></div>'
      + '<div class="api-auth-row"><span class="api-auth-lbl">Token</span>'
      + '<div class="api-auth-val"><span>\u25CF\u25CF\u25CF\u25CF\u25CF\u25CF\u25CF\u25CF</span>'
      + '<button class="reveal">Show</button></div></div></div>';
    content.appendChild(authPane);

    this._container.appendChild(content);

    // ── Wire events ──
    var self = this;

    // Method pill toggle
    this._methodEl.addEventListener('click', function(e) {
      e.stopPropagation();
      dd.classList.toggle('open');
    });
    dd.addEventListener('click', function(e) {
      var item2 = e.target.closest('.api-method-dd-item');
      if (!item2) return;
      var m = item2.getAttribute('data-method');
      self._setMethod(m);
      dd.classList.remove('open');
    });
    document.addEventListener('click', function() { dd.classList.remove('open'); });

    // Tab switching
    tabBar.addEventListener('click', function(e) {
      var tabEl = e.target.closest('.api-req-tab');
      if (!tabEl) return;
      var tabId = tabEl.getAttribute('data-tab');
      var allTabs = tabBar.querySelectorAll('.api-req-tab');
      for (var k = 0; k < allTabs.length; k++) {
        allTabs[k].classList.toggle('active', allTabs[k].getAttribute('data-tab') === tabId);
      }
      var panes = content.querySelectorAll('.api-req-pane');
      for (var p = 0; p < panes.length; p++) {
        panes[p].classList.toggle('active', panes[p].getAttribute('data-pane') === tabId);
      }
      self._activeTab = tabId;
    });

    // Send
    this._sendBtn.addEventListener('click', function() {
      if (self.onSend) self.onSend(self.getRequest());
    });
    this._urlEl.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (self.onSend) self.onSend(self.getRequest());
      }
    });

    // cURL copy
    curlBtn.addEventListener('click', function() {
      var curl = self.generateCurl();
      if (navigator.clipboard) { navigator.clipboard.writeText(curl); }
    });
  }

  _setMethod(m) {
    this._methodEl.setAttribute('data-value', m);
    this._methodEl.textContent = m;
    this._methodEl.className = 'api-method-pill ' + m.toLowerCase();
  }

  _renderHeaders() {
    this._headersEl.innerHTML = '';
    var table = document.createElement('table');
    table.className = 'api-kv-table';
    var thead = document.createElement('thead');
    thead.innerHTML = '<tr><th class="kv-chk"></th><th>Key</th><th>Value</th><th></th></tr>';
    table.appendChild(thead);
    this._headersTbody = document.createElement('tbody');
    table.appendChild(this._headersTbody);
    this._headersEl.appendChild(table);

    this._addHeaderRow('Authorization', 'Bearer \u25CF\u25CF\u25CF\u25CF', true);
    this._addHeaderRow('Content-Type', 'application/json', false);

    var addRow = document.createElement('div');
    addRow.className = 'api-kv-add';
    addRow.textContent = '+ Add Header';
    var self = this;
    addRow.addEventListener('click', function() {
      self._addHeaderRow('', '', false);
    });
    this._headersEl.appendChild(addRow);
  }

  _addHeaderRow(key, value, readonly) {
    var row = document.createElement('tr');

    var chkCell = document.createElement('td');
    chkCell.className = 'kv-chk';
    var chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.checked = true;
    chk.className = 'api-kv-check';
    chkCell.appendChild(chk);
    row.appendChild(chkCell);

    var keyCell = document.createElement('td');
    keyCell.className = 'kv-key';
    var keyInput = document.createElement('input');
    keyInput.className = 'api-header-key';
    keyInput.value = key;
    keyInput.placeholder = 'Header name';
    keyInput.style.cssText = 'border:none;background:none;font:inherit;color:inherit;width:100%;outline:none';
    if (readonly) keyInput.readOnly = true;
    keyCell.appendChild(keyInput);
    row.appendChild(keyCell);

    var valCell = document.createElement('td');
    valCell.className = 'kv-val';
    var valInput = document.createElement('input');
    valInput.className = 'api-header-val';
    valInput.value = value;
    valInput.placeholder = 'Value';
    valInput.style.cssText = 'border:none;background:none;font:inherit;color:inherit;width:100%;outline:none';
    if (readonly) valInput.readOnly = true;
    valCell.appendChild(valInput);
    row.appendChild(valCell);

    var actCell = document.createElement('td');
    if (!readonly) {
      var del = document.createElement('button');
      del.className = 'api-kv-del';
      del.textContent = '\u2715';
      del.addEventListener('click', function() { row.remove(); });
      actCell.appendChild(del);
    }
    row.appendChild(actCell);

    this._headersTbody.appendChild(row);
  }

  getRequest() {
    var headers = [];
    var rows = this._headersTbody ? this._headersTbody.querySelectorAll('tr') : [];
    for (var i = 0; i < rows.length; i++) {
      var chk = rows[i].querySelector('.api-kv-check');
      if (chk && !chk.checked) continue;
      var k = rows[i].querySelector('.api-header-key');
      var v = rows[i].querySelector('.api-header-val');
      if (k && v && k.value.trim()) {
        headers.push({ key: k.value.trim(), value: v.value });
      }
    }

    var method = this._methodEl.getAttribute('data-value') || 'GET';
    var needsBody = method === 'POST' || method === 'PUT' || method === 'PATCH';

    return {
      method: method,
      url: this._urlEl.value.trim(),
      headers: headers,
      body: needsBody ? this._bodyEl.value : null,
      tokenType: this._detectTokenType(this._urlEl.value)
    };
  }

  setRequest(req) {
    if (req.method) {
      this._setMethod(req.method);
    }
    if (req.url !== undefined) this._urlEl.value = req.url;
    if (req.body !== undefined) this._bodyEl.value = req.body || '';

    if (req.headers) {
      // Rebuild header rows
      if (this._headersTbody) this._headersTbody.innerHTML = '';
      var hasAuth = false;
      for (var i = 0; i < req.headers.length; i++) {
        var h = req.headers[i];
        if (h.key.toLowerCase() === 'authorization') {
          this._addHeaderRow(h.key, h.value, true);
          hasAuth = true;
        } else {
          this._addHeaderRow(h.key, h.value, false);
        }
      }
      if (!hasAuth) {
        this._addHeaderRow('Authorization', 'Bearer \u25CF\u25CF\u25CF\u25CF', true);
      }
    }
  }

  setSending(sending) {
    this._sendBtn.classList.toggle('loading', sending);
    this._cancelBtn.classList.toggle('visible', sending);
    this._methodEl.disabled = sending;
    this._urlEl.disabled = sending;
  }

  getCancelBtn() { return this._cancelBtn; }

  generateCurl() {
    var req = this.getRequest();
    var parts = ['curl -X ' + req.method];
    parts.push('"' + req.url + '"');
    for (var i = 0; i < req.headers.length; i++) {
      parts.push('-H "' + req.headers[i].key + ': ' + req.headers[i].value + '"');
    }
    if (req.body) {
      parts.push("-d '" + req.body.replace(/'/g, "'\\''") + "'");
    }
    return parts.join(' \\\n  ');
  }

  _detectTokenType(url) {
    if (url.indexOf('pbidedicated') !== -1 || url.indexOf('{fabricBaseUrl}') !== -1) return 'mwc';
    if (url.indexOf('/v1/') !== -1 || url.indexOf('api.fabric') !== -1) return 'bearer';
    return 'none';
  }

  getCatalog() { return this._catalog; }

  destroy() {
    if (this._catalog) this._catalog.destroy();
    this._container.innerHTML = '';
    this.onSend = null;
  }
}

/* ══════════════════════════════════════════════════════════════
 * §4  RESPONSE VIEWER
 * ══════════════════════════════════════════════════════════════ */

class ResponseViewer {
  constructor(container) {
    this._container = container;
    this._jsonTree = null;
    this._activeTab = 'body';
    this._lastResponse = null;
    this._viewMode = 'tree';
    this._showEmpty();
  }

  _showEmpty() {
    this._container.innerHTML = '';
    // Header
    var header = document.createElement('div');
    header.className = 'api-resp-header';
    var label = document.createElement('span');
    label.className = 'api-resp-label';
    label.textContent = 'Response';
    header.appendChild(label);
    this._container.appendChild(header);

    // Empty state
    var empty = document.createElement('div');
    empty.className = 'api-resp-empty';
    var icon = document.createElement('div');
    icon.className = 'api-resp-empty-icon';
    icon.textContent = '\u25C7';
    var title = document.createElement('div');
    title.className = 'api-resp-empty-title';
    title.textContent = 'Send a request to see the response';
    var hint = document.createElement('div');
    hint.className = 'api-resp-empty-hint';
    hint.textContent = 'Select an endpoint from the catalog or type a URL and click Send';
    empty.appendChild(icon);
    empty.appendChild(title);
    empty.appendChild(hint);
    this._container.appendChild(empty);
  }

  showLoading() {
    this._container.innerHTML = '';
    var header = document.createElement('div');
    header.className = 'api-resp-header';
    var label = document.createElement('span');
    label.className = 'api-resp-label';
    label.textContent = 'Response';
    header.appendChild(label);
    this._container.appendChild(header);

    var shimmer = document.createElement('div');
    shimmer.className = 'api-shimmer active';
    for (var i = 0; i < 6; i++) {
      var line = document.createElement('div');
      line.className = 'api-shimmer-line';
      shimmer.appendChild(line);
    }
    this._container.appendChild(shimmer);
  }

  showResponse(result) {
    this._lastResponse = result;
    this._container.innerHTML = '';

    // Determine status class
    var statusClass = 's2xx';
    var tintClass = 'tint-ok';
    if (result.status >= 400 && result.status < 500) { statusClass = 's4xx'; tintClass = 'tint-warn'; }
    if (result.status >= 500 || result.status === 0) { statusClass = 's5xx'; tintClass = 'tint-err'; }
    this._container.classList.remove('tint-ok', 'tint-warn', 'tint-err');
    this._container.classList.add(tintClass);

    // Header with status + metrics
    var header = document.createElement('div');
    header.className = 'api-resp-header';
    var label = document.createElement('span');
    label.className = 'api-resp-label';
    label.textContent = 'Response';
    header.appendChild(label);

    var statusPill = document.createElement('span');
    statusPill.className = 'api-status-pill ' + statusClass;
    statusPill.textContent = result.status + ' ' + (result.statusText || '');
    header.appendChild(statusPill);

    if (result.duration !== undefined) {
      var timePill = document.createElement('span');
      timePill.className = 'api-metric-pill show';
      if (result.duration < 200) timePill.classList.add('fast');
      else if (result.duration < 1000) timePill.classList.add('medium');
      else timePill.classList.add('slow');
      timePill.textContent = result.duration + 'ms';
      header.appendChild(timePill);
    }

    if (result.bodySize !== undefined) {
      var sizePill = document.createElement('span');
      sizePill.className = 'api-metric-pill show';
      sizePill.textContent = this._formatSize(result.bodySize);
      header.appendChild(sizePill);
    }

    this._container.appendChild(header);

    // Tabs
    var tabs = document.createElement('div');
    tabs.className = 'api-resp-tabs';
    var bodyTab = document.createElement('button');
    bodyTab.className = 'api-resp-tab active';
    bodyTab.textContent = 'Body';
    bodyTab.setAttribute('data-tab', 'body');
    var headersTab = document.createElement('button');
    headersTab.className = 'api-resp-tab';
    headersTab.textContent = 'Headers';
    headersTab.setAttribute('data-tab', 'headers');
    tabs.appendChild(bodyTab);
    tabs.appendChild(headersTab);

    // Tree/Raw toggle (right side)
    var tabRight = document.createElement('div');
    tabRight.className = 'api-resp-tab-right';
    var toggleGroup = document.createElement('div');
    toggleGroup.className = 'api-toggle-group';
    var treeBtn = document.createElement('button');
    treeBtn.className = 'api-toggle-btn active';
    treeBtn.textContent = 'Tree';
    var rawBtn = document.createElement('button');
    rawBtn.className = 'api-toggle-btn';
    rawBtn.textContent = 'Raw';
    toggleGroup.appendChild(treeBtn);
    toggleGroup.appendChild(rawBtn);
    tabRight.appendChild(toggleGroup);
    tabs.appendChild(tabRight);

    this._container.appendChild(tabs);

    // Content
    var content = document.createElement('div');
    content.className = 'api-resp-content';

    // Body pane
    var bodyPane = document.createElement('div');
    bodyPane.className = 'api-resp-pane active';
    bodyPane.setAttribute('data-panel', 'body');
    this._renderBody(bodyPane, result, treeBtn, rawBtn);
    content.appendChild(bodyPane);

    // Headers pane
    var headersPane = document.createElement('div');
    headersPane.className = 'api-resp-pane';
    headersPane.setAttribute('data-panel', 'headers');
    this._renderHeaders(headersPane, result.headers);
    content.appendChild(headersPane);

    this._container.appendChild(content);

    // Tab switching
    tabs.addEventListener('click', function(e) {
      var tabEl = e.target.closest('.api-resp-tab');
      if (!tabEl) return;
      var tab = tabEl.getAttribute('data-tab');
      if (!tab) return;
      var allTabs = tabs.querySelectorAll('.api-resp-tab');
      for (var i = 0; i < allTabs.length; i++) {
        var dt = allTabs[i].getAttribute('data-tab');
        if (dt) allTabs[i].classList.toggle('active', dt === tab);
      }
      var panels = content.querySelectorAll('.api-resp-pane');
      for (var j = 0; j < panels.length; j++) {
        panels[j].classList.toggle('active', panels[j].getAttribute('data-panel') === tab);
      }
    });
  }

  _renderBody(container, result, treeBtn, rawBtn) {
    var bodyStr = result.body || '';
    var parsed = null;
    try { parsed = JSON.parse(bodyStr); } catch (e) { parsed = null; }

    if (parsed !== null) {
      // JSON toolbar
      var toolbar = document.createElement('div');
      toolbar.className = 'api-json-toolbar';
      var expandBtn = document.createElement('button');
      expandBtn.className = 'api-json-action';
      expandBtn.textContent = 'Expand All';
      var collapseBtn = document.createElement('button');
      collapseBtn.className = 'api-json-action';
      collapseBtn.textContent = 'Collapse All';
      var copyBtn = document.createElement('button');
      copyBtn.className = 'api-json-action';
      copyBtn.textContent = 'Copy';
      toolbar.appendChild(expandBtn);
      toolbar.appendChild(collapseBtn);
      toolbar.appendChild(copyBtn);

      // JSON tree area
      var jsonArea = document.createElement('div');
      jsonArea.className = 'api-json-area active';
      jsonArea.style.overflow = 'auto';
      jsonArea.style.padding = 'var(--space-3) var(--space-4)';
      var treeWrap = document.createElement('div');
      treeWrap.className = 'json-tree';
      jsonArea.appendChild(treeWrap);

      // Raw area
      var rawArea = document.createElement('div');
      rawArea.className = 'api-raw-view';
      rawArea.textContent = JSON.stringify(parsed, null, 2);
      rawArea.style.display = 'none';

      container.appendChild(toolbar);
      container.appendChild(jsonArea);
      container.appendChild(rawArea);

      this._jsonTree = new JsonTree(treeWrap);
      this._jsonTree.render(parsed);

      var self = this;
      expandBtn.addEventListener('click', function() { if (self._jsonTree) self._jsonTree.expandAll(); });
      collapseBtn.addEventListener('click', function() { if (self._jsonTree) self._jsonTree.collapseAll(); });
      copyBtn.addEventListener('click', function() {
        if (navigator.clipboard) navigator.clipboard.writeText(JSON.stringify(parsed, null, 2));
      });

      // Tree/Raw toggle
      treeBtn.addEventListener('click', function() {
        treeBtn.classList.add('active');
        rawBtn.classList.remove('active');
        jsonArea.style.display = '';
        rawArea.style.display = 'none';
        toolbar.style.display = '';
      });
      rawBtn.addEventListener('click', function() {
        rawBtn.classList.add('active');
        treeBtn.classList.remove('active');
        jsonArea.style.display = 'none';
        rawArea.style.display = '';
        toolbar.style.display = 'none';
      });
    } else {
      var rawView = document.createElement('div');
      rawView.className = 'api-raw-view';
      rawView.textContent = bodyStr;
      container.appendChild(rawView);
      treeBtn.style.display = 'none';
      rawBtn.style.display = 'none';
    }
  }

  _renderHeaders(container, headers) {
    if (!headers || Object.keys(headers).length === 0) {
      container.innerHTML = '<div class="api-resp-empty" style="padding:var(--space-6)">'
        + '<div class="api-resp-empty-title">No response headers</div></div>';
      return;
    }
    var wrap = document.createElement('div');
    wrap.className = 'api-resp-hdrs';
    var headerKeys = Object.keys(headers);
    for (var i = 0; i < headerKeys.length; i++) {
      var row = document.createElement('div');
      row.className = 'api-resp-hdr-row';
      var keyEl = document.createElement('span');
      keyEl.className = 'api-resp-hdr-key';
      keyEl.textContent = headerKeys[i];
      var valEl = document.createElement('span');
      valEl.className = 'api-resp-hdr-val';
      valEl.textContent = headers[headerKeys[i]];
      row.appendChild(keyEl);
      row.appendChild(valEl);
      wrap.appendChild(row);
    }
    container.appendChild(wrap);
  }

  showError(err) {
    this._container.innerHTML = '';
    this._container.classList.remove('tint-ok', 'tint-warn', 'tint-err');
    this._container.classList.add('tint-err');

    var header = document.createElement('div');
    header.className = 'api-resp-header';
    var label = document.createElement('span');
    label.className = 'api-resp-label';
    label.textContent = 'Response';
    header.appendChild(label);
    var statusPill = document.createElement('span');
    statusPill.className = 'api-status-pill s5xx';
    statusPill.textContent = 'Error';
    header.appendChild(statusPill);
    this._container.appendChild(header);

    var body = document.createElement('div');
    body.className = 'api-raw-view';
    body.textContent = err.message || String(err);
    this._container.appendChild(body);
  }

  _formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
  }

  destroy() {
    if (this._jsonTree) this._jsonTree.destroy();
    this._container.innerHTML = '';
    this._lastResponse = null;
  }
}

/* ══════════════════════════════════════════════════════════════
 * §5  HISTORY & SAVED REQUESTS
 * ══════════════════════════════════════════════════════════════ */

class HistorySaved {
  constructor(container) {
    this._container = container;
    this._history = [];
    this._saved = [];
    this.onReplay = null;
    this._maxHistory = 50;
    this._storageKeyHistory = 'edog-api-history';
    this._storageKeySaved = 'edog-api-saved';
    this._activeTab = 'history';
    this._loadFromStorage();
    this._render();
  }

  _loadFromStorage() {
    try {
      var raw = localStorage.getItem(this._storageKeyHistory);
      this._history = raw ? JSON.parse(raw) : [];
    } catch (e) { this._history = []; }

    try {
      var rawS = localStorage.getItem(this._storageKeySaved);
      this._saved = rawS ? JSON.parse(rawS) : [];
    } catch (e) { this._saved = []; }
  }

  _render() {
    this._container.innerHTML = '';

    // Header
    var header = document.createElement('div');
    header.className = 'api-hist-header';
    var h3 = document.createElement('h3');
    h3.textContent = 'Activity';
    header.appendChild(h3);
    this._container.appendChild(header);

    // Tabs
    var tabBar = document.createElement('div');
    tabBar.className = 'api-hist-tabs';
    var histTab = document.createElement('button');
    histTab.className = 'api-hist-tab active';
    histTab.setAttribute('data-tab', 'history');
    histTab.textContent = 'History';
    var savedTab = document.createElement('button');
    savedTab.className = 'api-hist-tab';
    savedTab.setAttribute('data-tab', 'saved');
    savedTab.textContent = 'Saved';
    tabBar.appendChild(histTab);
    tabBar.appendChild(savedTab);
    this._container.appendChild(tabBar);

    // Scroll area
    var scroll = document.createElement('div');
    scroll.className = 'api-hist-scroll';

    // History pane
    var historyPane = document.createElement('div');
    historyPane.className = 'api-hist-pane active';
    historyPane.setAttribute('data-pane', 'history');
    var historyList = document.createElement('div');
    historyList.className = 'api-history-list';
    this._renderHistory(historyList);
    historyPane.appendChild(historyList);
    scroll.appendChild(historyPane);

    // Saved pane
    var savedPane = document.createElement('div');
    savedPane.className = 'api-hist-pane';
    savedPane.setAttribute('data-pane', 'saved');
    var savedList = document.createElement('div');
    savedList.className = 'api-saved-list';
    this._renderSaved(savedList);
    savedPane.appendChild(savedList);
    scroll.appendChild(savedPane);

    this._container.appendChild(scroll);

    // Clear button
    var clearWrap = document.createElement('div');
    clearWrap.className = 'api-hist-clear';
    var clearBtn = document.createElement('button');
    clearBtn.className = 'api-hist-clear-btn';
    clearBtn.textContent = 'Clear History';
    clearWrap.appendChild(clearBtn);
    this._container.appendChild(clearWrap);

    // Tab switching
    var self = this;
    tabBar.addEventListener('click', function(e) {
      var tabEl = e.target.closest('.api-hist-tab');
      if (!tabEl) return;
      var tabId = tabEl.getAttribute('data-tab');
      var allTabs = tabBar.querySelectorAll('.api-hist-tab');
      for (var k = 0; k < allTabs.length; k++) {
        allTabs[k].classList.toggle('active', allTabs[k].getAttribute('data-tab') === tabId);
      }
      var panes = scroll.querySelectorAll('.api-hist-pane');
      for (var p = 0; p < panes.length; p++) {
        panes[p].classList.toggle('active', panes[p].getAttribute('data-pane') === tabId);
      }
      self._activeTab = tabId;
      clearBtn.textContent = tabId === 'history' ? 'Clear History' : 'Clear Saved';
    });

    clearBtn.addEventListener('click', function() {
      if (self._activeTab === 'history') {
        self.clearHistory();
      } else {
        self._saved = [];
        try { localStorage.removeItem(self._storageKeySaved); } catch (e) { /* ignore */ }
        var sl = self._container.querySelector('.api-saved-list');
        if (sl) self._renderSaved(sl);
      }
    });
  }

  _renderSaved(listEl) {
    listEl.innerHTML = '';
    if (this._saved.length === 0) {
      var empty = document.createElement('div');
      empty.className = 'api-hist-empty';
      empty.textContent = 'No saved requests';
      listEl.appendChild(empty);
      return;
    }
    for (var i = 0; i < this._saved.length; i++) {
      listEl.appendChild(this._createSavedItem(this._saved[i], i));
    }
  }

  _createSavedItem(entry, index) {
    var item = document.createElement('div');
    item.className = 'api-hist-entry';

    var pill = document.createElement('span');
    pill.className = 'he-m m-' + entry.method.toLowerCase();
    pill.textContent = entry.method;

    var url = document.createElement('span');
    url.className = 'he-url';
    url.textContent = entry.name || entry.url;

    item.appendChild(pill);
    item.appendChild(url);

    var self = this;
    item.addEventListener('click', function() {
      if (self.onReplay) self.onReplay(entry);
    });
    return item;
  }

  _renderHistory(listEl) {
    listEl.innerHTML = '';
    if (this._history.length === 0) {
      var empty = document.createElement('div');
      empty.className = 'api-hist-empty';
      empty.textContent = 'No history yet';
      listEl.appendChild(empty);
      return;
    }
    for (var i = 0; i < this._history.length; i++) {
      listEl.appendChild(this._createHistoryItem(this._history[i]));
    }
  }

  _createHistoryItem(entry) {
    var item = document.createElement('div');
    item.className = 'api-hist-entry';

    var pill = document.createElement('span');
    pill.className = 'he-m m-' + entry.method.toLowerCase();
    pill.textContent = entry.method;

    var url = document.createElement('span');
    url.className = 'he-url';
    var urlText = entry.url || '';
    // Trim to just the path
    try {
      var u = new URL(urlText);
      url.textContent = u.pathname;
    } catch (e) {
      url.textContent = urlText.length > 30 ? urlText.substring(0, 30) + '...' : urlText;
    }

    item.appendChild(pill);
    item.appendChild(url);

    if (entry.response) {
      var meta = document.createElement('div');
      meta.className = 'he-meta';
      var statusEl = document.createElement('span');
      statusEl.className = 'he-status';
      if (entry.response.status >= 200 && entry.response.status < 400) statusEl.classList.add('ok');
      else if (entry.response.status >= 400 && entry.response.status < 500) statusEl.classList.add('warn');
      else statusEl.classList.add('err');
      statusEl.textContent = entry.response.status;
      meta.appendChild(statusEl);

      if (entry.response.duration) {
        var time = document.createElement('span');
        time.className = 'he-time';
        time.textContent = entry.response.duration + 'ms';
        meta.appendChild(time);
      }

      item.appendChild(meta);
    }

    var self = this;
    item.addEventListener('click', function() {
      if (self.onReplay) self.onReplay(entry);
    });
    return item;
  }

  addHistoryEntry(entry) {
    this._history.unshift(entry);
    while (this._history.length > this._maxHistory) {
      this._history.pop();
    }
    // Size safety: cap at 300KB serialized
    var serialized = JSON.stringify(this._history);
    while (serialized.length > 300000 && this._history.length > 10) {
      this._history.pop();
      serialized = JSON.stringify(this._history);
    }
    try { localStorage.setItem(this._storageKeyHistory, serialized); } catch (e) { /* quota */ }
    var historyList = this._container.querySelector('.api-history-list');
    if (historyList) this._renderHistory(historyList);
  }

  saveRequest(req) {
    var entry = {
      id: this._uuid(),
      name: req.name || req.url,
      group: 'Custom',
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: req.body,
      tokenType: req.tokenType,
      isBuiltIn: false,
      createdAt: new Date().toISOString()
    };
    this._saved.push(entry);
    try { localStorage.setItem(this._storageKeySaved, JSON.stringify(this._saved)); } catch (e) { /* quota */ }
    var savedList = this._container.querySelector('.api-saved-list');
    if (savedList) this._renderSaved(savedList);
  }

  clearHistory() {
    this._history = [];
    try { localStorage.removeItem(this._storageKeyHistory); } catch (e) { /* ignore */ }
    var historyList = this._container.querySelector('.api-history-list');
    if (historyList) this._renderHistory(historyList);
  }

  _uuid() {
    if (crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      var r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  destroy() {
    this._container.innerHTML = '';
    this.onReplay = null;
  }
}

/* ══════════════════════════════════════════════════════════════
 * §6  API PLAYGROUND ORCHESTRATOR
 * ══════════════════════════════════════════════════════════════ */

class ApiPlayground {
  constructor(viewEl, apiClient, stateManager) {
    this._viewEl = viewEl;
    this._apiClient = apiClient;
    this._stateManager = stateManager;
    this._initialized = false;
    this._abortController = null;
    this._isMock = new URLSearchParams(window.location.search).has('mock');

    this._requestBuilder = null;
    this._responseViewer = null;
    this._endpointCatalog = null;
    this._historySaved = null;
  }

  activate() {
    if (!this._initialized) this._init();
    this._viewEl.style.display = '';
  }

  deactivate() {
    if (this._abortController) {
      this._abortController.abort();
      this._abortController = null;
    }
  }

  _init() {
    this._initialized = true;
    this._buildDOM();
    this._wireEvents();
  }

  _buildDOM() {
    this._viewEl.innerHTML = '';

    var playground = document.createElement('div');
    playground.className = 'api-playground';

    // Left panel: Endpoint catalog
    var catalogPanel = document.createElement('div');
    catalogPanel.className = 'api-catalog-panel';
    this._endpointCatalog = new EndpointCatalog(catalogPanel);
    playground.appendChild(catalogPanel);

    // Center: Workspace
    var workspace = document.createElement('div');
    workspace.className = 'api-workspace';

    // Request panel
    var reqPanel = document.createElement('div');
    reqPanel.className = 'api-req-panel';
    this._requestBuilder = new RequestBuilder(reqPanel);
    workspace.appendChild(reqPanel);

    // Resize handle
    var resizeH = document.createElement('div');
    resizeH.className = 'api-resize-h';
    workspace.appendChild(resizeH);

    // Response panel
    var respPanel = document.createElement('div');
    respPanel.className = 'api-resp-panel';
    this._responseViewer = new ResponseViewer(respPanel);
    workspace.appendChild(respPanel);

    playground.appendChild(workspace);

    // Right panel: History/Saved
    var histPanel = document.createElement('div');
    histPanel.className = 'api-history-panel';
    this._historySaved = new HistorySaved(histPanel);
    playground.appendChild(histPanel);

    this._viewEl.appendChild(playground);
  }

  _wireEvents() {
    var self = this;

    // Send request
    this._requestBuilder.onSend = function(request) {
      self._handleSend(request);
    };

    // Endpoint catalog selection -> populate builder
    this._endpointCatalog.onSelect = function(endpoint) {
      var resolvedUrl = self._resolveUrl(endpoint.urlTemplate);
      var headers = [];
      if (endpoint.tokenType === 'bearer') {
        headers.push({ key: 'Authorization', value: 'Bearer \u25CF\u25CF\u25CF\u25CF' });
      } else if (endpoint.tokenType === 'mwc') {
        headers.push({ key: 'Authorization', value: 'MwcToken \u25CF\u25CF\u25CF\u25CF' });
      }
      headers.push({ key: 'Content-Type', value: 'application/json' });

      self._requestBuilder.setRequest({
        method: endpoint.method,
        url: resolvedUrl,
        headers: headers,
        body: endpoint.bodyTemplate ? JSON.stringify(endpoint.bodyTemplate, null, 2) : ''
      });
    };

    // History/saved replay -> populate builder
    this._historySaved.onReplay = function(entry) {
      self._requestBuilder.setRequest({
        method: entry.method,
        url: entry.url,
        headers: entry.headers || [],
        body: entry.body || ''
      });
    };

    // Cancel button
    this._requestBuilder.getCancelBtn().addEventListener('click', function() {
      if (self._abortController) {
        self._abortController.abort();
        self._abortController = null;
      }
      self._requestBuilder.setSending(false);
      self._responseViewer.showError({ message: 'Request cancelled' });
    });
  }

  _handleSend(request) {
    var self = this;

    // Abort previous
    if (this._abortController) this._abortController.abort();
    this._abortController = new AbortController();

    // Resolve URL
    var resolvedUrl = this._resolveUrl(request.url);

    this._requestBuilder.setSending(true);
    this._responseViewer.showLoading();

    if (this._isMock) {
      this._mockSend(request, resolvedUrl);
      return;
    }

    // Build proxy request
    var proxyBody = JSON.stringify({
      method: request.method,
      url: resolvedUrl,
      headers: this._buildProxyHeaders(request.headers),
      body: request.body,
      tokenType: request.tokenType || this._detectTokenType(resolvedUrl)
    });

    var startTime = Date.now();
    fetch('/api/playground/proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: proxyBody,
      signal: this._abortController.signal
    }).then(function(resp) {
      return resp.json();
    }).then(function(result) {
      if (!result.duration) result.duration = Date.now() - startTime;
      self._responseViewer.showResponse(result);
      self._historySaved.addHistoryEntry(
        self._sanitizeForHistory(request, resolvedUrl, result)
      );
      self._requestBuilder.setSending(false);
      self._abortController = null;
    }).catch(function(e) {
      if (e.name === 'AbortError') return;
      self._responseViewer.showError(e);
      self._requestBuilder.setSending(false);
      self._abortController = null;
    });
  }

  _mockSend(request, resolvedUrl) {
    var self = this;
    var delay = 100 + Math.floor(Math.random() * 400);
    setTimeout(function() {
      var mockResult = {
        status: 200,
        statusText: 'OK',
        headers: {
          'content-type': 'application/json',
          'x-ms-request-id': self._uuid()
        },
        body: JSON.stringify({
          status: 'ok',
          message: 'Mock response for ' + request.method + ' ' + request.url,
          timestamp: new Date().toISOString(),
          data: { items: [], count: 0 }
        }),
        duration: delay,
        bodySize: 128
      };
      self._responseViewer.showResponse(mockResult);
      self._historySaved.addHistoryEntry(
        self._sanitizeForHistory(request, resolvedUrl, mockResult)
      );
      self._requestBuilder.setSending(false);
      self._abortController = null;
    }, delay);
  }

  _resolveUrl(template) {
    var config = (this._apiClient && this._apiClient.getConfig) ? this._apiClient.getConfig() : null;
    config = config || {};
    var vars = {
      workspaceId: config.workspaceId || '{workspaceId}',
      lakehouseId: config.lakehouseId || '{lakehouseId}',
      artifactId: config.artifactId || '{artifactId}',
      capacityId: config.capacityId || '{capacityId}',
      fabricBaseUrl: config.fabricBaseUrl || '{fabricBaseUrl}'
    };
    var resolved = template.replace(/\{(\w+)\}/g, function(match, key) {
      return vars[key] || match;
    });

    // Prefix relative URLs
    if (resolved.charAt(0) === '/') {
      resolved = 'https://api.fabric.microsoft.com' + resolved;
    }
    return resolved;
  }

  _buildProxyHeaders(headers) {
    var obj = {};
    for (var i = 0; i < headers.length; i++) {
      var h = headers[i];
      // Skip the masked auth header — proxy handles token injection
      if (h.key.toLowerCase() === 'authorization') continue;
      if (h.key.trim()) obj[h.key] = h.value;
    }
    return obj;
  }

  _detectTokenType(url) {
    if (url.indexOf('pbidedicated') !== -1) return 'mwc';
    if (url.indexOf('api.fabric') !== -1) return 'bearer';
    return 'none';
  }

  _sanitizeForHistory(request, resolvedUrl, result) {
    var sanitizedHeaders = [];
    for (var i = 0; i < request.headers.length; i++) {
      var h = request.headers[i];
      if (h.key.toLowerCase() === 'authorization') {
        sanitizedHeaders.push({ key: h.key, value: h.value.replace(/\s.+$/, ' \u25CF\u25CF\u25CF\u25CF') });
      } else {
        sanitizedHeaders.push({ key: h.key, value: h.value });
      }
    }

    return {
      id: this._uuid(),
      method: request.method,
      url: request.url,
      resolvedUrl: resolvedUrl,
      headers: sanitizedHeaders,
      body: request.body,
      tokenType: request.tokenType || 'none',
      response: {
        status: result.status,
        statusText: result.statusText,
        duration: result.duration,
        bodySize: result.bodySize,
        bodyPreview: (result.body || '').substring(0, 500)
      },
      timestamp: new Date().toISOString()
    };
  }

  _uuid() {
    if (crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      var r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  destroy() {
    if (this._abortController) this._abortController.abort();
    if (this._endpointCatalog) this._endpointCatalog.destroy();
    if (this._requestBuilder) this._requestBuilder.destroy();
    if (this._responseViewer) this._responseViewer.destroy();
    if (this._historySaved) this._historySaved.destroy();
    this._viewEl.innerHTML = '';
    this._initialized = false;
  }
}
