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
   * @param {string[]} tableNames - Array of table names to get details for.
   * @returns {Promise<object>} Result with per-table schema, type, location.
   */
  async getTableDetails(workspaceId, lakehouseId, capacityId, tableNames) {
    const resp = await fetch('/api/mwc/table-details', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        wsId: workspaceId,
        lhId: lakehouseId,
        capId: capacityId,
        tables: tableNames,
      }),
    });
    if (!resp.ok) {
      const err = new Error(`Table details failed: ${resp.status}`);
      err.status = resp.status;
      throw err;
    }
    return resp.json();
  }

  /** Get row count and size for a single table via OneLake delta log. */
  async getTableStats(workspaceId, lakehouseId, tableName) {
    const params = `wsId=${workspaceId}&lhId=${lakehouseId}&tableName=${encodeURIComponent(tableName)}`;
    const resp = await fetch(`/api/mwc/table-stats?${params}`);
    if (!resp.ok) return null;
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
   * Create a new workspace.
   * @param {string} name - Display name for the new workspace.
   */
  async createWorkspace(name) {
    return this._fabricPost('/workspaces', { displayName: name });
  }

  /**
   * Create a new lakehouse inside a workspace.
   * @param {string} workspaceId - Parent workspace GUID.
   * @param {string} name - Display name for the new lakehouse.
   */
  async createLakehouse(workspaceId, name) {
    return this._fabricPost(`/workspaces/${workspaceId}/lakehouses`, { displayName: name });
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
   * @returns {Promise<{kernelId: string, sessionId: string, wsUrl?: string, mwcToken?: string}>}
   */
  async createJupyterSession(workspaceId, notebookId, capacityId) {
    const resp = await fetch('/api/notebook/create-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wsId: workspaceId, nbId: notebookId, capId: capacityId }),
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
    if (!this._fabricBaseUrl || !this._mwcToken) return null;
    return this._fltFetch('/liveTable/getLatestDag?showExtendedLineage=true');
  }

  async runDag(iterationId) {
    if (!this._fabricBaseUrl || !this._mwcToken) return null;
    return this._fltFetch(`/liveTableSchedule/runDAG/${iterationId}`, { method: 'POST' });
  }

  async cancelDag(iterationId) {
    if (!this._fabricBaseUrl || !this._mwcToken) return null;
    return this._fltFetch(`/liveTableSchedule/cancelDAG/${iterationId}`, { method: 'POST' });
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
      const url = this._fabricBaseUrl + path;
      const headers = {
        'Content-Type': 'application/json',
        'Authorization': `MwcToken ${this._mwcToken}`,
      };
      const resp = await fetch(url, { ...options, headers });
      if (!resp.ok) {
        console.warn('FLT API error:', resp.status, path);
        return null;
      }
      const text = await resp.text();
      return text ? JSON.parse(text) : {};
    } catch (e) {
      console.warn('FLT API fetch failed:', path, e.message);
      return null;
    }
  }
}
