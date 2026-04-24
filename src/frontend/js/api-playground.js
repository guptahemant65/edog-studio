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
    this._isOpen = false;
    this._dropdown = null;
    this._searchInput = null;
    this.onSelect = null;
    this._boundClose = null;
    this._render();
  }

  _render() {
    this._container.innerHTML = '';
    var trigger = document.createElement('button');
    trigger.className = 'api-catalog-trigger';
    trigger.textContent = 'Endpoints \u25BE';
    this._container.appendChild(trigger);

    this._dropdown = document.createElement('div');
    this._dropdown.className = 'api-catalog-dropdown';
    this._dropdown.style.display = 'none';
    this._container.appendChild(this._dropdown);

    var self = this;
    trigger.addEventListener('click', function(e) {
      e.stopPropagation();
      if (self._isOpen) { self.close(); } else { self.open(); }
    });
  }

  open() {
    this._isOpen = true;
    this._dropdown.style.display = '';
    this._dropdown.innerHTML = '';

    var searchWrap = document.createElement('div');
    this._searchInput = document.createElement('input');
    this._searchInput.className = 'api-catalog-search';
    this._searchInput.placeholder = 'Search endpoints...';
    this._searchInput.setAttribute('type', 'text');
    searchWrap.appendChild(this._searchInput);
    this._dropdown.appendChild(searchWrap);

    var listEl = document.createElement('div');
    this._dropdown.appendChild(listEl);
    this._renderList(listEl, '');

    var self = this;
    this._searchInput.addEventListener('input', function() {
      self._renderList(listEl, self._searchInput.value.toLowerCase());
    });
    this._searchInput.focus();

    this._boundClose = function(e) {
      if (!self._container.contains(e.target)) { self.close(); }
    };
    document.addEventListener('click', this._boundClose);
  }

  close() {
    this._isOpen = false;
    this._dropdown.style.display = 'none';
    if (this._boundClose) {
      document.removeEventListener('click', this._boundClose);
      this._boundClose = null;
    }
  }

  _renderList(listEl, filter) {
    listEl.innerHTML = '';
    var matched = 0;
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
      groupEl.className = 'api-catalog-group';
      var label = document.createElement('div');
      label.className = 'api-catalog-group-label';
      label.textContent = group.label;
      groupEl.appendChild(label);

      for (var j = 0; j < endpoints.length; j++) {
        var item = this._createItem(endpoints[j]);
        groupEl.appendChild(item);
        matched++;
      }
      listEl.appendChild(groupEl);
    }
    if (matched === 0) {
      var empty = document.createElement('div');
      empty.className = 'api-catalog-empty';
      empty.textContent = 'No endpoints match "' + filter + '"';
      listEl.appendChild(empty);
    }
  }

  _createItem(ep) {
    var item = document.createElement('div');
    item.className = 'api-catalog-item';
    if (ep.dangerLevel === 'destructive') item.classList.add('api-danger-destructive');

    var pill = document.createElement('span');
    pill.className = 'method-pill ' + ep.method.toLowerCase();
    pill.textContent = ep.method;

    var name = document.createElement('span');
    name.className = 'api-catalog-item-name';
    name.textContent = ep.name;

    var url = document.createElement('span');
    url.className = 'api-catalog-item-url';
    url.textContent = ep.urlTemplate;

    item.appendChild(pill);
    item.appendChild(name);
    item.appendChild(url);

    var self = this;
    item.addEventListener('click', function() {
      if (self.onSelect) self.onSelect(ep);
      self.close();
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
    this.onSend = null;
    this._render();
  }

  _render() {
    this._container.innerHTML = '';

    // URL row
    var urlRow = document.createElement('div');
    urlRow.className = 'api-url-row';

    this._methodEl = document.createElement('select');
    this._methodEl.className = 'api-method-select';
    var methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
    for (var i = 0; i < methods.length; i++) {
      var opt = document.createElement('option');
      opt.value = methods[i];
      opt.textContent = methods[i];
      this._methodEl.appendChild(opt);
    }
    urlRow.appendChild(this._methodEl);

    this._urlEl = document.createElement('input');
    this._urlEl.className = 'api-url-input';
    this._urlEl.placeholder = 'Enter URL or select from endpoints...';
    urlRow.appendChild(this._urlEl);

    this._sendBtn = document.createElement('button');
    this._sendBtn.className = 'api-send-btn';
    this._sendBtn.textContent = 'Send';
    urlRow.appendChild(this._sendBtn);

    this._cancelBtn = document.createElement('button');
    this._cancelBtn.className = 'api-cancel-btn';
    this._cancelBtn.textContent = 'Cancel';
    urlRow.appendChild(this._cancelBtn);

    // cURL copy button
    var curlBtn = document.createElement('button');
    curlBtn.className = 'api-send-btn';
    curlBtn.style.cssText = 'background:var(--surface-2);color:var(--text-dim);border:1px solid var(--border-bright)';
    curlBtn.textContent = 'Copy cURL';
    urlRow.appendChild(curlBtn);

    this._catalogWrap = document.createElement('div');
    this._catalogWrap.style.cssText = 'position:relative;display:inline-block';
    this._catalog = new EndpointCatalog(this._catalogWrap);
    urlRow.appendChild(this._catalogWrap);

    this._container.appendChild(urlRow);

    // Headers section
    var headersSection = document.createElement('div');
    headersSection.className = 'api-body-section';
    var headersLabel = document.createElement('span');
    headersLabel.className = 'api-body-label';
    headersLabel.textContent = 'Headers';
    headersSection.appendChild(headersLabel);

    this._headersEl = document.createElement('div');
    this._headersEl.className = 'api-headers';
    this._addHeaderRow('Authorization', 'Bearer \u25CF\u25CF\u25CF\u25CF', true);
    this._addHeaderRow('Content-Type', 'application/json', false);
    headersSection.appendChild(this._headersEl);

    var addHeaderBtn = document.createElement('button');
    addHeaderBtn.className = 'api-header-add';
    addHeaderBtn.textContent = '+ Add Header';
    headersSection.appendChild(addHeaderBtn);
    this._container.appendChild(headersSection);

    // Body section (hidden for GET/DELETE)
    this._bodySection = document.createElement('div');
    this._bodySection.className = 'api-body-section';
    this._bodySection.style.display = 'none';
    var bodyLabel = document.createElement('span');
    bodyLabel.className = 'api-body-label';
    bodyLabel.textContent = 'Request Body';
    this._bodySection.appendChild(bodyLabel);

    this._bodyEl = document.createElement('textarea');
    this._bodyEl.className = 'api-body-input';
    this._bodyEl.placeholder = '{"key": "value"}';
    this._bodySection.appendChild(this._bodyEl);
    this._container.appendChild(this._bodySection);

    // Wire events
    var self = this;
    this._methodEl.addEventListener('change', function() {
      var needsBody = self._methodEl.value === 'POST'
        || self._methodEl.value === 'PUT'
        || self._methodEl.value === 'PATCH';
      self._bodySection.style.display = needsBody ? '' : 'none';
    });

    this._sendBtn.addEventListener('click', function() {
      if (self.onSend) self.onSend(self.getRequest());
    });

    this._urlEl.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (self.onSend) self.onSend(self.getRequest());
      }
    });

    addHeaderBtn.addEventListener('click', function() {
      self._addHeaderRow('', '', false);
    });

    curlBtn.addEventListener('click', function() {
      var curl = self.generateCurl();
      if (navigator.clipboard) {
        navigator.clipboard.writeText(curl);
      }
    });
  }

  _addHeaderRow(key, value, readonly) {
    var row = document.createElement('div');
    row.className = 'api-header-row';

    var keyInput = document.createElement('input');
    keyInput.className = 'api-header-key';
    keyInput.value = key;
    keyInput.placeholder = 'Header name';
    if (readonly) keyInput.readOnly = true;

    var valInput = document.createElement('input');
    valInput.className = 'api-header-val';
    valInput.value = value;
    valInput.placeholder = 'Value';
    if (readonly) valInput.readOnly = true;

    var rmBtn = document.createElement('button');
    rmBtn.className = 'api-header-rm';
    rmBtn.textContent = '\u2715';
    if (readonly) { rmBtn.disabled = true; }

    rmBtn.addEventListener('click', function() { row.remove(); });

    row.appendChild(keyInput);
    row.appendChild(valInput);
    row.appendChild(rmBtn);
    this._headersEl.appendChild(row);
  }

  getRequest() {
    var headers = [];
    var rows = this._headersEl.querySelectorAll('.api-header-row');
    for (var i = 0; i < rows.length; i++) {
      var k = rows[i].querySelector('.api-header-key');
      var v = rows[i].querySelector('.api-header-val');
      if (k && v && k.value.trim()) {
        headers.push({ key: k.value.trim(), value: v.value });
      }
    }

    var method = this._methodEl.value;
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
      this._methodEl.value = req.method;
      var needsBody = req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH';
      this._bodySection.style.display = needsBody ? '' : 'none';
    }
    if (req.url !== undefined) this._urlEl.value = req.url;
    if (req.body !== undefined) this._bodyEl.value = req.body || '';

    if (req.headers) {
      // Keep the Authorization row, replace others
      var authRow = this._headersEl.querySelector('.api-header-row');
      this._headersEl.innerHTML = '';
      if (authRow) this._headersEl.appendChild(authRow);
      for (var i = 0; i < req.headers.length; i++) {
        var h = req.headers[i];
        if (h.key.toLowerCase() === 'authorization') continue;
        this._addHeaderRow(h.key, h.value, false);
      }
    }
  }

  setSending(sending) {
    this._sendBtn.style.display = sending ? 'none' : '';
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
    this._showEmpty();
  }

  _showEmpty() {
    this._container.innerHTML = '<div class="api-empty">'
      + '<span style="font-size:24px;opacity:0.3">\u25C7</span>'
      + '<span>Send a request to see the response</span>'
      + '<span class="api-empty-hint">Select an endpoint from the catalog or type a URL</span>'
      + '</div>';
  }

  showLoading() {
    this._container.innerHTML = '<div class="api-loading">'
      + '<div class="api-spinner"></div>'
      + '<span>Sending request...</span>'
      + '</div>';
  }

  showResponse(result) {
    this._lastResponse = result;
    this._container.innerHTML = '';

    // Status header
    var header = document.createElement('div');
    header.className = 'api-response-header';

    var statusClass = 's2xx';
    if (result.status >= 400 && result.status < 500) statusClass = 's4xx';
    if (result.status >= 500) statusClass = 's5xx';
    if (result.status === 0) statusClass = 's5xx';

    var statusEl = document.createElement('span');
    statusEl.className = 'api-response-status ' + statusClass;
    statusEl.textContent = result.status + ' ' + (result.statusText || '');
    header.appendChild(statusEl);

    if (result.duration !== undefined) {
      var timing = document.createElement('span');
      timing.className = 'api-response-timing';
      timing.textContent = result.duration + 'ms';
      header.appendChild(timing);
    }

    if (result.bodySize !== undefined) {
      var size = document.createElement('span');
      size.className = 'api-response-timing';
      size.textContent = this._formatSize(result.bodySize);
      header.appendChild(size);
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
    this._container.appendChild(tabs);

    // Tab content container
    var content = document.createElement('div');
    content.style.cssText = 'flex:1;overflow:auto';
    this._container.appendChild(content);

    // Render body tab content
    var bodyContent = document.createElement('div');
    bodyContent.setAttribute('data-panel', 'body');
    this._renderBody(bodyContent, result);
    content.appendChild(bodyContent);

    // Render headers tab content
    var headersContent = document.createElement('div');
    headersContent.setAttribute('data-panel', 'headers');
    headersContent.style.display = 'none';
    this._renderHeaders(headersContent, result.headers);
    content.appendChild(headersContent);

    // Tab switching
    var self = this;
    tabs.addEventListener('click', function(e) {
      var tab = e.target.getAttribute('data-tab');
      if (!tab) return;
      var allTabs = tabs.querySelectorAll('.api-resp-tab');
      for (var i = 0; i < allTabs.length; i++) {
        allTabs[i].classList.toggle('active', allTabs[i].getAttribute('data-tab') === tab);
      }
      var panels = content.querySelectorAll('[data-panel]');
      for (var j = 0; j < panels.length; j++) {
        panels[j].style.display = panels[j].getAttribute('data-panel') === tab ? '' : 'none';
      }
    });
  }

  _renderBody(container, result) {
    var bodyStr = result.body || '';

    // JSON tree controls
    var controls = document.createElement('div');
    controls.className = 'json-tree-controls';
    var expandBtn = document.createElement('button');
    expandBtn.className = 'json-tree-btn';
    expandBtn.textContent = 'Expand All';
    var collapseBtn = document.createElement('button');
    collapseBtn.className = 'json-tree-btn';
    collapseBtn.textContent = 'Collapse All';
    var rawBtn = document.createElement('button');
    rawBtn.className = 'json-tree-btn';
    rawBtn.textContent = 'Raw';
    controls.appendChild(expandBtn);
    controls.appendChild(collapseBtn);
    controls.appendChild(rawBtn);
    container.appendChild(controls);

    var treeWrap = document.createElement('div');
    treeWrap.className = 'json-tree';
    treeWrap.style.padding = 'var(--space-3)';
    container.appendChild(treeWrap);

    // Try to parse as JSON
    var parsed = null;
    try { parsed = JSON.parse(bodyStr); } catch (e) { parsed = null; }

    if (parsed !== null) {
      this._jsonTree = new JsonTree(treeWrap);
      this._jsonTree.render(parsed);

      var self = this;
      expandBtn.addEventListener('click', function() { self._jsonTree.expandAll(); });
      collapseBtn.addEventListener('click', function() { self._jsonTree.collapseAll(); });
      rawBtn.addEventListener('click', function() {
        var isRaw = treeWrap.getAttribute('data-raw') === 'true';
        if (isRaw) {
          treeWrap.setAttribute('data-raw', 'false');
          treeWrap.innerHTML = '';
          treeWrap.className = 'json-tree';
          self._jsonTree = new JsonTree(treeWrap);
          self._jsonTree.render(parsed);
          rawBtn.textContent = 'Raw';
        } else {
          treeWrap.setAttribute('data-raw', 'true');
          treeWrap.className = 'api-response-body';
          treeWrap.textContent = JSON.stringify(parsed, null, 2);
          rawBtn.textContent = 'Tree';
        }
      });
    } else {
      treeWrap.className = 'api-response-body';
      treeWrap.textContent = bodyStr;
      expandBtn.style.display = 'none';
      collapseBtn.style.display = 'none';
      rawBtn.style.display = 'none';
    }
  }

  _renderHeaders(container, headers) {
    if (!headers || Object.keys(headers).length === 0) {
      container.innerHTML = '<div class="api-empty" style="padding:var(--space-3)"><span>No response headers</span></div>';
      return;
    }
    var table = document.createElement('table');
    table.className = 'api-resp-headers-table';
    var headerKeys = Object.keys(headers);
    for (var i = 0; i < headerKeys.length; i++) {
      var row = document.createElement('tr');
      var keyCell = document.createElement('td');
      keyCell.textContent = headerKeys[i];
      var valCell = document.createElement('td');
      valCell.textContent = headers[headerKeys[i]];
      row.appendChild(keyCell);
      row.appendChild(valCell);
      table.appendChild(row);
    }
    container.appendChild(table);
  }

  showError(err) {
    this._container.innerHTML = '';
    var header = document.createElement('div');
    header.className = 'api-response-header';
    var status = document.createElement('span');
    status.className = 'api-response-status s5xx';
    status.textContent = 'Error';
    header.appendChild(status);
    this._container.appendChild(header);

    var body = document.createElement('div');
    body.className = 'api-response-body';
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

    // Saved section
    var savedSection = document.createElement('div');
    savedSection.className = 'api-sidebar-section';
    var savedTitle = document.createElement('div');
    savedTitle.className = 'api-sidebar-title';
    savedTitle.textContent = 'Saved Requests';
    savedSection.appendChild(savedTitle);

    var savedList = document.createElement('div');
    savedList.className = 'api-saved-list';
    this._renderSaved(savedList);
    savedSection.appendChild(savedList);
    this._container.appendChild(savedSection);

    // History section
    var historySection = document.createElement('div');
    historySection.className = 'api-sidebar-section';
    var historyTitle = document.createElement('div');
    historyTitle.className = 'api-sidebar-title';
    historyTitle.textContent = 'History';
    historySection.appendChild(historyTitle);

    var historyList = document.createElement('div');
    historyList.className = 'api-history-list';
    this._renderHistory(historyList);
    historySection.appendChild(historyList);
    this._container.appendChild(historySection);
  }

  _renderSaved(listEl) {
    listEl.innerHTML = '';
    if (this._saved.length === 0) {
      var hint = document.createElement('div');
      hint.style.cssText = 'font-size:var(--text-xs);color:var(--text-muted);padding:var(--space-1)';
      hint.textContent = 'No saved requests yet';
      listEl.appendChild(hint);
      return;
    }
    var lastGroup = '';
    for (var i = 0; i < this._saved.length; i++) {
      var entry = this._saved[i];
      if (entry.group && entry.group !== lastGroup) {
        var groupLabel = document.createElement('div');
        groupLabel.className = 'api-sidebar-group-label';
        groupLabel.textContent = entry.group;
        listEl.appendChild(groupLabel);
        lastGroup = entry.group;
      }
      listEl.appendChild(this._createSavedItem(entry, i));
    }
  }

  _createSavedItem(entry, index) {
    var item = document.createElement('div');
    item.className = 'api-saved-item';

    var pill = document.createElement('span');
    pill.className = 'method-pill ' + entry.method.toLowerCase();
    pill.textContent = entry.method;

    var name = document.createElement('span');
    name.textContent = entry.name || entry.url;

    item.appendChild(pill);
    item.appendChild(name);

    var self = this;
    item.addEventListener('click', function() {
      if (self.onReplay) self.onReplay(entry);
    });
    return item;
  }

  _renderHistory(listEl) {
    listEl.innerHTML = '';
    if (this._history.length === 0) {
      var hint = document.createElement('div');
      hint.style.cssText = 'font-size:var(--text-xs);color:var(--text-muted);padding:var(--space-1)';
      hint.textContent = 'No history yet';
      listEl.appendChild(hint);
      return;
    }
    for (var i = 0; i < this._history.length; i++) {
      listEl.appendChild(this._createHistoryItem(this._history[i]));
    }
  }

  _createHistoryItem(entry) {
    var item = document.createElement('div');
    item.className = 'api-history-item';

    var pill = document.createElement('span');
    pill.className = 'method-pill ' + entry.method.toLowerCase();
    pill.textContent = entry.method;

    var url = document.createElement('span');
    var urlText = entry.url || '';
    url.textContent = urlText.length > 30 ? urlText.substring(0, 30) + '...' : urlText;

    item.appendChild(pill);
    item.appendChild(url);

    if (entry.response) {
      var statusEl = document.createElement('span');
      statusEl.className = 'api-history-status';
      var sCls = 's2xx';
      if (entry.response.status >= 400 && entry.response.status < 500) sCls = 's4xx';
      if (entry.response.status >= 500 || entry.response.status === 0) sCls = 's5xx';
      statusEl.className = 'api-history-status status-code ' + sCls;
      statusEl.textContent = entry.response.status;
      item.appendChild(statusEl);
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
