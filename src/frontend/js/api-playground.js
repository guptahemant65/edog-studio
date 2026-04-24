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
