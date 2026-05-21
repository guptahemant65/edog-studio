/**
 * FabricApiClient — API wrapper for Fabric REST and FLT service endpoints.
 *
 * Two token modes:
 *   - Bearer token (Phase 1 disconnected): Fabric public APIs — workspaces,
 *     lakehouses, tables, CRUD operations.
 *   - MWC token (Phase 2 connected): FLT service APIs — DAG, Spark, telemetry.
 *
 * All Fabric API methods throw on failure so callers (e.g. WorkspaceExplorer)
 * can surface errors via toast notifications.
 */
class FabricApiClient {
  constructor() {
    this._bearerToken = null;
    this._mwcToken = null;
    this._fabricBaseUrl = null;
    this._config = null;
    this._phase = 'disconnected';
    // Proxy through our server to avoid CORS — server forwards to api.fabric.microsoft.com
    this._baseUrl = '/api/fabric';
  }

  async init() {
    await this.fetchConfig();
  }

  /**
   * Fetch config from the EDOG control server and extract tokens.
   * @returns {Promise<object|null>} Config object, or null if unavailable.
   */
  async fetchConfig() {
    try {
      const resp = await fetch('/api/flt/config');
      if (!resp.ok) return null;
      this._config = await resp.json();
      this._mwcToken = this._config.mwcToken || null;
      this._fabricBaseUrl = this._config.fabricBaseUrl || null;
      this._bearerToken = this._config.bearerToken || null;
      this._phase = this._config.phase || (this._mwcToken ? 'connected' : 'disconnected');
      return this._config;
    } catch {
      return null;
    }
  }

  /** @returns {'connected'|'disconnected'} Current lifecycle phase. */
  getPhase() {
    return this._phase;
  }

  /** @returns {object|null} Raw config object from last fetchConfig(). */
  getConfig() { return this._config; }

  /** @returns {boolean} Whether a bearer token is available for Fabric APIs. */
  hasBearerToken() {
    return !!this._bearerToken;
  }

  /**
   * Check auth state via the EDOG health endpoint.
   * @returns {Promise<{authenticated: boolean, expiresIn: number}>}
   */
  async getAuthState() {
    try {
      const resp = await fetch('/api/edog/health');
      if (!resp.ok) return { authenticated: false, expiresIn: 0 };
      const data = await resp.json();
      return {
        authenticated: data.hasBearerToken && data.bearerExpiresIn > 300,
        expiresIn: data.bearerExpiresIn,
      };
    } catch {
      return { authenticated: false, expiresIn: 0 };
    }
  }

  // --- Fabric Public APIs (bearer token) ---

  async listWorkspaces() {
    return this._fabricGet('/workspaces?$top=100');
  }

  async listWorkspaceItems(workspaceId) {
    return this._fabricGet(`/workspaces/${workspaceId}/items`);
  }

  async listLakehouses(workspaceId) {
    return this._fabricGet(`/workspaces/${workspaceId}/lakehouses`);
  }

  async listTables(workspaceId, lakehouseId) {
    return this._fabricGet(`/workspaces/${workspaceId}/lakehouses/${lakehouseId}/tables`);
  }

  /**
   * List tables via capacity host (schema-enabled lakehouses).
   * Proxied through dev-server to avoid CORS and keep MWC tokens server-side.
   */
  async listTablesViaCapacity(workspaceId, lakehouseId, capacityId) {
    const params = `wsId=${workspaceId}&lhId=${lakehouseId}&capId=${capacityId}`;
    const resp = await fetch(`/api/mwc/tables?${params}`);
    if (!resp.ok) {
      const err = new Error(`MWC table listing failed: ${resp.status}`);
      err.status = resp.status;
      throw err;
    }
    return resp.json();
  }

  /**
   * Get detailed metadata for tables (columns, type, location) via batch LRO.
   * @param {string} workspaceId
   * @param {string} lakehouseId
   * @param {string} capacityId
   * @param {Array<{name: string, schema: string}>} tables - Tables with schema annotation.
   *   Schemas-enabled lakehouses partition tables under per-schema endpoints; we MUST
   *   pass `schema` so the server can route each batch to the right `/schemas/{name}/`
   *   endpoint. The server falls back to "dbo" for bare-string entries (legacy callers),
   *   which only works for default-schema-only lakehouses.
   * @returns {Promise<{tables: Array<object>, errors?: Array<{schema, error}>}>}
   */
  async getTableDetails(workspaceId, lakehouseId, capacityId, tables) {
    const resp = await fetch('/api/mwc/table-details', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        wsId: workspaceId,
        lhId: lakehouseId,
        capId: capacityId,
        tables,
      }),
    });
    if (!resp.ok) {
      const err = new Error(`Table details failed: ${resp.status}`);
      err.status = resp.status;
      throw err;
    }
    return resp.json();
  }

  /**
   * Get row count and size for a single table via OneLake delta log.
   * @param {string} workspaceId
   * @param {string} lakehouseId
   * @param {string} tableName
   * @param {string} [schema='dbo'] - Schema the table lives in. Required for
   *   schemas-enabled lakehouses; defaults to 'dbo' for backwards compat.
   */
  async getTableStats(workspaceId, lakehouseId, tableName, schema) {
    const parts = [
      `wsId=${workspaceId}`,
      `lhId=${lakehouseId}`,
      `tableName=${encodeURIComponent(tableName)}`,
    ];
    if (schema) parts.push(`schema=${encodeURIComponent(schema)}`);
    const resp = await fetch(`/api/mwc/table-stats?${parts.join('&')}`);
    if (!resp.ok) return null;
    return resp.json();
  }

  /**
   * Get FLT/Spark catalog metadata for a single table from OneLake.
   *
   * Reads {lh}/Tables/{schema}/{table}/_metadata/table.json.gz directly — no
   * deployed FLT service required. For MLVs the response includes `viewText`
   * (the SELECT statement) and `sourceEntities`. For regular tables it
   * includes `allColumns`, `partitionColumnNames`, `storage`, `properties`.
   *
   * @param {string} workspaceId
   * @param {string} lakehouseId
   * @param {string} schema - Schema the table lives in (REQUIRED — auto-discovered
   *   via /api/onelake/schemas; pass the value the user clicked).
   * @param {string} table - Table name (case-sensitive on the wire).
   * @returns {Promise<object>} Parsed catalog JSON, or `null` when no FLT
   *   metadata exists (auto-discovered tables without _metadata/ — 404 is
   *   not exceptional and surfaces as null for the caller to render gracefully).
   * @throws {Error} On non-404 errors (auth, decode failures, etc.).
   */
  async getTableMetadata(workspaceId, lakehouseId, schema, table) {
    const qs = new URLSearchParams({
      wsId: workspaceId,
      lhId: lakehouseId,
      schema,
      table,
    }).toString();
    const resp = await fetch(`/api/onelake/table-metadata?${qs}`);
    if (resp.status === 404) {
      const body = await resp.json().catch(() => ({}));
      if (body.error === 'metadata_not_found') return null;
    }
    if (!resp.ok) {
      const err = new Error(`Table metadata failed: ${resp.status}`);
      err.status = resp.status;
      try {
        err.body = await resp.json();
      } catch {
        err.body = null;
      }
      throw err;
    }
    return resp.json();
  }

  /**
   * Fetch the first N rows of a Lakehouse Delta table.
   *
   * Backend replays the table's Delta log to find active parquet files,
   * deterministically picks the first by path, reads via pyarrow, and
   * coerces values for JSON safety (temporals → ISO, decimals → string,
   * binary → hex, struct/list → recursive). Partition columns are
   * appended as trailing columns marked `isPartition: true`.
   *
   * @param {string} workspaceId - Workspace GUID.
   * @param {string} lakehouseId - Lakehouse GUID.
   * @param {string} schema - Schema name (`"dbo"` for non-schemas-enabled).
   * @param {string} table - Table name.
   * @param {number} [limit=10] - Max rows (server caps at 100).
   * @returns {Promise<{
   *   schemaName: string, tableName: string,
   *   columns: Array<{name: string, type: string, isPartition?: boolean}>,
   *   rows: Array<Object>,
   *   rowsReturned: number, truncated: boolean,
   *   fileCount?: number, sourceFile?: string,
   *   warnings: Array<string>
   * } | null>} Resolves to null when the table has no `_delta_log/`
   *   (404 from server — surface a "not materialized" empty state).
   * @throws {Error} On non-404 errors (auth, parse failures, network).
   */
  async getTablePreviewRows(workspaceId, lakehouseId, schema, table, limit = 10) {
    const qs = new URLSearchParams({
      wsId: workspaceId,
      lhId: lakehouseId,
      schema,
      table,
      limit: String(limit),
    }).toString();
    const resp = await fetch(`/api/onelake/table-preview-rows?${qs}`);
    if (resp.status === 404) {
      const body = await resp.json().catch(() => ({}));
      if (body.error === 'delta_log_not_found') return null;
    }
    if (!resp.ok) {
      const err = new Error(`Table preview rows failed: ${resp.status}`);
      err.status = resp.status;
      try {
        err.body = await resp.json();
      } catch {
        err.body = null;
      }
      throw err;
    }
    return resp.json();
  }

  // --- Fabric CRUD APIs ---

  /**
   * Rename a workspace.
   * @param {string} workspaceId - Workspace GUID.
   * @param {string} newName - New display name.
   */
  async renameWorkspace(workspaceId, newName) {
    return this._fabricPatch(`/workspaces/${workspaceId}`, { displayName: newName });
  }

  /**
   * Delete a workspace.
   * @param {string} workspaceId - Workspace GUID.
   */
  async deleteWorkspace(workspaceId) {
    return this._fabricDelete(`/workspaces/${workspaceId}`);
  }

  /**
   * Rename a lakehouse.
   * @param {string} workspaceId - Parent workspace GUID.
   * @param {string} lakehouseId - Lakehouse GUID.
   * @param {string} newName - New display name.
   */
  async renameLakehouse(workspaceId, lakehouseId, newName) {
    return this._fabricPatch(
      `/workspaces/${workspaceId}/lakehouses/${lakehouseId}`,
      { displayName: newName }
    );
  }

  /**
   * Delete a lakehouse.
   * @param {string} workspaceId - Parent workspace GUID.
   * @param {string} lakehouseId - Lakehouse GUID.
   */
  async deleteLakehouse(workspaceId, lakehouseId) {
    return this._fabricDelete(`/workspaces/${workspaceId}/lakehouses/${lakehouseId}`);
  }

  /**
   * Rename a generic workspace item (Notebook, Pipeline, etc.).
   * @param {string} workspaceId - Parent workspace GUID.
   * @param {string} itemId - Item GUID.
   * @param {string} newName - New display name.
   */
  async renameItem(workspaceId, itemId, newName) {
    return this._fabricPatch(`/workspaces/${workspaceId}/items/${itemId}`, { displayName: newName });
  }

  /**
   * Delete a generic workspace item (Notebook, Pipeline, etc.).
   * @param {string} workspaceId - Parent workspace GUID.
   * @param {string} itemId - Item GUID.
   */
  async deleteItem(workspaceId, itemId) {
    return this._fabricDelete(`/workspaces/${workspaceId}/items/${itemId}`);
  }

  /**
   * Create a new workspace, optionally in a specific capacity.
   * @param {string} name - Display name for the new workspace.
   * @param {string} [capacityId] - Optional capacity GUID.
   */
  async createWorkspace(name, capacityId) {
    var body = { displayName: name };
    if (capacityId) body.capacityId = capacityId;
    return this._fabricPost('/workspaces', body);
  }

  /**
   * Create a new lakehouse inside a workspace.
   * @param {string} workspaceId - Parent workspace GUID.
   * @param {string} name - Display name for the new lakehouse.
   * @param {object} [options] - Optional creation options.
   * @param {string} [options.description] - Lakehouse description.
   * @param {boolean} [options.enableSchemas] - Enable multi-schema support.
   * @param {string[]} [options.defaultSchemas] - Default schemas to create.
   */
  async createLakehouse(workspaceId, name, options) {
    var body = { displayName: name };
    var opts = options || {};
    if (opts.description) body.description = opts.description;
    if (opts.enableSchemas !== undefined || opts.defaultSchemas) {
      body.creationPayload = {};
      if (opts.enableSchemas !== undefined) body.creationPayload.enableSchemas = opts.enableSchemas;
      if (opts.defaultSchemas) body.creationPayload.defaultSchemas = opts.defaultSchemas;
    }
    return this._fabricPost('/workspaces/' + workspaceId + '/lakehouses', body);
  }

  /**
   * List available capacities the user has access to.
   * @returns {Promise<{value: Array}>} Array of capacity objects.
   */
  async listCapacities() {
    return this._fabricGet('/capacities');
  }

  /**
   * Create a new Fabric capacity. The server injects adminsUpns from the
   * authenticated user and mode=1; the caller only supplies UI-facing fields.
   * @param {string} displayName - Capacity display name.
   * @param {string} sku - SKU code (e.g. "P3", "F2").
   * @param {string} region - Azure region code (e.g. "westus2").
   * @returns {Promise<object>} Created capacity metadata.
   */
  async createCapacity(displayName, sku, region) {
    return this._fabricPost('/capacities', { displayName: displayName, sku: sku, region: region });
  }

  /**
   * Create a new notebook inside a workspace.
   * @param {string} workspaceId - Parent workspace GUID.
   * @param {string} name - Display name for the new notebook.
   */
  async createNotebook(workspaceId, name) {
    return this._fabricPost('/workspaces/' + workspaceId + '/notebooks', { displayName: name });
  }

  /**
   * Assign a workspace to a specific capacity.
   * @param {string} workspaceId - Workspace GUID.
   * @param {string} capacityId - Capacity GUID to assign.
   */
  async assignToCapacity(workspaceId, capacityId) {
    return this._fabricPost('/workspaces/' + workspaceId + '/assignToCapacity', { capacityId: capacityId });
  }

  // --- Notebook APIs (server-side LRO handling) ---

  /**
   * List notebooks in a workspace with properties.
   * @param {string} workspaceId
   * @returns {Promise<{value: Array}>}
   */
  async listNotebooks(workspaceId) {
    return this._fabricGet(`/workspaces/${workspaceId}/notebooks`);
  }

  /**
   * Fetch notebook cell content via server-side LRO handler.
   * Returns decoded notebook-content.sql text and .platform metadata.
   * @param {string} workspaceId
   * @param {string} notebookId
   * @returns {Promise<{content: string, platform: string}>}
   */
  async getNotebookContent(workspaceId, notebookId) {
    const params = `wsId=${workspaceId}&nbId=${notebookId}`;
    const resp = await fetch(`/api/notebook/content?${params}`);
    if (!resp.ok) {
      const err = new Error(`Notebook content fetch failed: ${resp.status}`);
      err.status = resp.status;
      throw err;
    }
    return resp.json();
  }

  /**
   * Save notebook cell content via server-side handler.
   * @param {string} workspaceId
   * @param {string} notebookId
   * @param {string} content - Raw notebook-content.sql text.
   * @param {string} [platform] - Optional .platform JSON string.
   */
  async saveNotebookContent(workspaceId, notebookId, content, platform = '') {
    const resp = await fetch('/api/notebook/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wsId: workspaceId, nbId: notebookId, content, platform }),
    });
    if (!resp.ok) {
      const err = new Error(`Notebook save failed: ${resp.status}`);
      err.status = resp.status;
      throw err;
    }
    return resp.json();
  }

  /**
   * Start notebook execution via Job Scheduler.
   * @param {string} workspaceId
   * @param {string} notebookId
   * @returns {Promise<{location: string, status: string}>}
   */
  async runNotebook(workspaceId, notebookId) {
    const resp = await fetch('/api/notebook/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wsId: workspaceId, nbId: notebookId }),
    });
    if (!resp.ok) {
      const err = new Error(`Notebook run failed: ${resp.status}`);
      err.status = resp.status;
      throw err;
    }
    return resp.json();
  }

  /**
   * Poll notebook run status.
   * @param {string} locationUrl - Job status URL from runNotebook response.
   * @returns {Promise<{status: string, failureReason?: string, startTimeUtc?: string, endTimeUtc?: string}>}
   */
  async getNotebookRunStatus(locationUrl) {
    const resp = await fetch(`/api/notebook/run-status?location=${encodeURIComponent(locationUrl)}`);
    if (!resp.ok) return { status: 'Unknown' };
    return resp.json();
  }

  /**
   * Cancel a running notebook job.
   * @param {string} locationUrl - Job status URL.
   */
  async cancelNotebookRun(locationUrl) {
    const resp = await fetch('/api/notebook/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ location: locationUrl }),
    });
    if (!resp.ok) {
      const err = new Error(`Cancel failed: ${resp.status}`);
      err.status = resp.status;
      throw err;
    }
    return resp.json();
  }

  // --- Notebook Jupyter Cell Execution APIs ---

  /**
   * Create a Jupyter session for per-cell execution. Requires MWC token + capacity host.
   * @param {string} workspaceId
   * @param {string} notebookId
   * @param {string} capacityId
   * @param {string} [lakehouseId] - Default lakehouse ID for MWC token generation.
   * @returns {Promise<{kernelId: string, sessionId: string, wsUrl?: string, mwcToken?: string}>}
   */
  async createJupyterSession(workspaceId, notebookId, capacityId, lakehouseId = '') {
    const resp = await fetch('/api/notebook/create-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wsId: workspaceId, nbId: notebookId, capId: capacityId, lhId: lakehouseId }),
    });
    if (!resp.ok) {
      const err = new Error(`Jupyter session creation failed: ${resp.status}`);
      err.status = resp.status;
      throw err;
    }
    return resp.json();
  }

  /**
   * Execute a cell via Jupyter (server-side or returns WebSocket info for client).
   * @param {string} workspaceId
   * @param {string} notebookId
   * @param {string} capacityId
   * @param {string} code - Cell code to execute.
   * @param {string} [language] - Cell language (pyspark, sparksql).
   * @returns {Promise<object>} Execution result or WebSocket connection info.
   */
  async executeCell(workspaceId, notebookId, capacityId, code, language = 'sparksql') {
    const resp = await fetch('/api/notebook/execute-cell', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wsId: workspaceId, nbId: notebookId, capId: capacityId, code, language }),
    });
    if (!resp.ok) {
      const err = new Error(`Cell execution failed: ${resp.status}`);
      err.status = resp.status;
      throw err;
    }
    return resp.json();
  }

  /**
   * Close a Jupyter session.
   * @param {string} workspaceId
   * @param {string} notebookId
   * @param {string} capacityId
   * @param {string} sessionId
   */
  async closeJupyterSession(workspaceId, notebookId, capacityId, sessionId) {
    const resp = await fetch('/api/notebook/close-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wsId: workspaceId, nbId: notebookId, capId: capacityId, sessionId }),
    });
    if (!resp.ok) {
      console.warn('Failed to close Jupyter session:', resp.status);
    }
    return resp.ok;
  }

  // --- Environment APIs ---

  /**
   * List environments in a workspace with publish details.
   * @param {string} workspaceId
   * @returns {Promise<{value: Array}>}
   */
  async listEnvironments(workspaceId) {
    return this._fabricGet(`/workspaces/${workspaceId}/environments`);
  }

  // --- FLT Service APIs (MWC token, connected mode) ---

  async getLatestDag() {
    if (!this._mwcToken) return null;
    return this._fltFetch('/liveTable/getLatestDag?showExtendedLineage=true');
  }

  /**
   * Fetch getLatestDag for an arbitrary lakehouse (disconnected mode).
   *
   * Used by the wizard's "Import from Lakehouse" flow. The dev-server
   * acquires a LiveTable MWC token on demand for the target ws/lh/cap
   * and proxies the call. Returns null on any failure so callers can
   * gracefully fall back to the table-listing path.
   *
   * @param {string} workspaceId
   * @param {string} lakehouseId
   * @param {string} capacityId
   * @returns {Promise<object|null>} DAG payload or null.
   */
  async getLatestDagForLakehouse(workspaceId, lakehouseId, capacityId) {
    if (!workspaceId || !lakehouseId || !capacityId) return null;
    try {
      const qs = new URLSearchParams({
        wsId: workspaceId,
        lhId: lakehouseId,
        capId: capacityId,
      }).toString();
      const resp = await fetch(`/api/import-dag?${qs}`);
      if (!resp.ok) {
        console.warn('Import DAG fetch failed:', resp.status);
        return null;
      }
      const text = await resp.text();
      return text ? JSON.parse(text) : null;
    } catch (e) {
      console.warn('Import DAG fetch error:', e.message);
      return null;
    }
  }

  async runDag(iterationId) {
    if (!this._mwcToken) return null;
    return this._fltFetch(`/liveTableSchedule/runDAG/${iterationId}`, { method: 'POST' });
  }

  async cancelDag(iterationId) {
    if (!this._mwcToken) return null;
    // FLT uses HTTP DELETE for cancel — not GET or POST
    return this._fltFetch(`/liveTableSchedule/cancelDAG/${iterationId}`, { method: 'DELETE' });
  }

  // --- DAG Studio APIs (MWC token, connected mode) ---

  /** Get per-node execution metrics for a completed DAG iteration. */
  async getDagExecMetrics(iterationId) {
    return this._fltFetchStrict(`/liveTable/getDAGExecMetrics/${iterationId}`);
  }

  /**
   * List historical DAG execution iteration IDs with pagination.
   * @param {object} [opts] - { historyCount: number, statuses: string[], continuationToken: string }
   * @returns {Promise<{iterations: Array, continuationToken: string|null}>}
   */
  async listDagExecutions(opts = {}) {
    const params = new URLSearchParams();
    params.set('historyCount', String(opts.historyCount || 20));
    if (opts.statuses) opts.statuses.forEach(s => params.append('statuses', s));
    if (opts.continuationToken) params.set('continuationToken', opts.continuationToken);
    const resp = await this._fltFetchRaw(`/liveTable/listDAGExecutionIterationIds?${params}`);
    const data = await resp.json();
    return {
      iterations: data,
      continuationToken: resp.headers.get('x-ms-continuation-token') || null,
    };
  }

  /** Get the currently locked DAG execution iteration (if any). */
  async getLockedExecution() {
    return this._fltFetchStrict('/liveTableMaintanance/getLockedDAGExecutionIteration');
  }

  /**
   * Force-unlock a stuck DAG execution.
   * @param {string} lockedIterationId - The iteration ID to unlock.
   */
  async forceUnlockDag(lockedIterationId) {
    return this._fltFetchStrict(
      `/liveTableMaintanance/forceUnlockDAGExecution/${lockedIterationId}`,
      { method: 'POST' }
    );
  }

  /** Get DAG schedule/settings. */
  async getDagSettings() {
    return this._fltFetchStrict('/liveTable/settings');
  }

  /**
   * Update DAG schedule/settings.
   * @param {object} body - Settings payload.
   */
  async updateDagSettings(body) {
    return this._fltFetchStrict('/liveTable/settings', {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
  }

  /** List all MLV execution definitions in current lakehouse. */
  async listMlvDefinitions() {
    return this._fltFetchStrict('/liveTable/mlvExecutionDefinitions');
  }

  /**
   * Get the execution status of a specific DAG iteration (polling fallback).
   * @param {string} iterationId
   */
  async getDagExecStatus(iterationId) {
    return this._fltFetchStrict(`/liveTableSchedule/getDAGExecStatus/${iterationId}`);
  }

  // --- Generic HTTP method wrappers (Fabric public API) ---

  /** @param {string} path - API path appended to base URL. */
  async _fabricGet(path) {
    return this._fabricFetch(path, { method: 'GET' });
  }

  /**
   * @param {string} path - API path appended to base URL.
   * @param {object} body - JSON request body.
   */
  async _fabricPost(path, body) {
    return this._fabricFetch(path, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  /**
   * @param {string} path - API path appended to base URL.
   * @param {object} body - JSON request body.
   */
  async _fabricPatch(path, body) {
    return this._fabricFetch(path, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
  }

  /** @param {string} path - API path appended to base URL. */
  async _fabricDelete(path) {
    return this._fabricFetch(path, { method: 'DELETE' });
  }

  // --- Internal fetch wrappers ---

  /**
   * Core Fabric API fetch. Attaches bearer token and throws on failure.
   * @param {string} path - API path (appended to this._baseUrl).
   * @param {object} options - fetch() options (method, body, etc.).
   * @returns {Promise<object>} Parsed JSON response.
   * @throws {Error} With .status, .body, .path on API errors; plain Error on network failures.
   */
  async _fabricFetch(path, options = {}) {
    try {
      const config = this._config || await this.fetchConfig();
      if (!config) {
        const err = new Error('No config available — is the EDOG server running?');
        err.path = path;
        throw err;
      }
      const headers = { 'Content-Type': 'application/json' };
      if (this._bearerToken) {
        headers['Authorization'] = `Bearer ${this._bearerToken}`;
      }
      const resp = await fetch(this._baseUrl + path, { ...options, headers });
      if (!resp.ok) {
        const errorText = await resp.text().catch(() => '');
        const err = new Error(`Fabric API error: ${resp.status}`);
        err.status = resp.status;
        err.body = errorText;
        err.path = path;
        throw err;
      }
      const text = await resp.text();
      return text ? JSON.parse(text) : {};
    } catch (e) {
      if (e.status) throw e;
      console.warn('Fabric API fetch failed:', path, e.message);
      const err = new Error(`Network error: ${e.message}`);
      err.path = path;
      throw err;
    }
  }

  async _fltFetch(path, options = {}) {
    try {
      var url = '/api/flt-proxy' + path;
      var headers = { 'Content-Type': 'application/json' };
      var resp = await fetch(url, { ...options, headers: headers });
      if (!resp.ok) {
        console.warn('FLT API error:', resp.status, path);
        return null;
      }
      var text = await resp.text();
      return text ? JSON.parse(text) : {};
    } catch (e) {
      console.warn('FLT API fetch failed:', path, e.message);
      return null;
    }
  }

  /**
   * FLT fetch with structured errors — throws on any failure, never returns null.
   * Use for DAG Studio APIs where callers need to handle specific error types.
   * @param {string} path - API path appended to FLT base URL.
   * @param {object} [options] - fetch() options.
   * @returns {Promise<object>} Parsed JSON response.
   * @throws {Error} With .status, .body, .path properties.
   */
  async _fltFetchStrict(path, options = {}) {
    if (!this._mwcToken) {
      var err = new Error('FLT service not connected — ensure MWC token is available');
      err.status = 0;
      err.path = path;
      throw err;
    }
    var url = '/api/flt-proxy' + path;
    var headers = {
      'Content-Type': 'application/json',
      ...options.headers,
    };
    var resp = await fetch(url, { ...options, headers: headers });
    if (!resp.ok) {
      var err2 = new Error('FLT API error: ' + resp.status + ' ' + path);
      err2.status = resp.status;
      err2.body = await resp.text().catch(function() { return ''; });
      err2.path = path;
      throw err2;
    }
    var text = await resp.text();
    return text ? JSON.parse(text) : {};
  }

  /**
   * FLT fetch returning raw Response object (for reading response headers
   * like continuation tokens from paginated endpoints).
   * @param {string} path - API path appended to FLT base URL.
   * @param {object} [options] - fetch() options.
   * @returns {Promise<Response>} Raw fetch Response.
   * @throws {Error} With .status, .path properties.
   */
  async _fltFetchRaw(path, options = {}) {
    if (!this._mwcToken) {
      var err = new Error('FLT service not connected');
      err.status = 0;
      err.path = path;
      throw err;
    }
    var url = '/api/flt-proxy' + path;
    var headers = { 'Content-Type': 'application/json' };
    var resp = await fetch(url, { ...options, headers: headers });
    if (!resp.ok) {
      var err2 = new Error('FLT API error: ' + resp.status + ' ' + path);
      err2.status = resp.status;
      err2.path = path;
      throw err2;
    }
    return resp;
  }
}
