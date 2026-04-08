/**
 * FabricApiClient — API wrapper for Fabric and FLT service endpoints.
 */
class FabricApiClient {
  constructor() {
    this._bearerToken = null;
    this._mwcToken = null;
    this._fabricBaseUrl = null;
    this._config = null;
    this._baseUrl = 'https://api.fabric.microsoft.com/v1';
  }

  async init() {
    await this.fetchConfig();
  }

  async fetchConfig() {
    try {
      const resp = await fetch('/api/flt/config');
      if (!resp.ok) return null;
      this._config = await resp.json();
      this._mwcToken = this._config.mwcToken || null;
      this._fabricBaseUrl = this._config.fabricBaseUrl || null;
      return this._config;
    } catch {
      return null;
    }
  }

  getPhase() {
    return this._mwcToken ? 'connected' : 'disconnected';
  }

  getConfig() { return this._config; }

  // --- Fabric Public APIs (bearer token) ---

  async listWorkspaces() {
    return this._fabricFetch('/workspaces?$top=100');
  }

  async listWorkspaceItems(workspaceId) {
    return this._fabricFetch('/workspaces/' + workspaceId + '/items');
  }

  async listLakehouses(workspaceId) {
    return this._fabricFetch('/workspaces/' + workspaceId + '/lakehouses');
  }

  async listTables(workspaceId, lakehouseId) {
    return this._fabricFetch('/workspaces/' + workspaceId + '/lakehouses/' + lakehouseId + '/tables');
  }

  // --- FLT Service APIs (MWC token, connected mode) ---

  async getLatestDag() {
    if (!this._fabricBaseUrl || !this._mwcToken) return null;
    return this._fltFetch('/liveTable/getLatestDag?showExtendedLineage=true');
  }

  async runDag(iterationId) {
    if (!this._fabricBaseUrl || !this._mwcToken) return null;
    return this._fltFetch('/liveTableSchedule/runDAG/' + iterationId, { method: 'POST' });
  }

  async cancelDag(iterationId) {
    if (!this._fabricBaseUrl || !this._mwcToken) return null;
    return this._fltFetch('/liveTableSchedule/cancelDAG/' + iterationId, { method: 'POST' });
  }

  // --- Internal fetch wrappers ---

  async _fabricFetch(path) {
    try {
      const config = this._config || await this.fetchConfig();
      if (!config) return { value: [] };
      const headers = { 'Content-Type': 'application/json' };
      if (this._bearerToken) headers['Authorization'] = 'Bearer ' + this._bearerToken;
      const resp = await fetch(this._baseUrl + path, { headers });
      if (!resp.ok) {
        console.warn('Fabric API error:', resp.status, path);
        return { value: [] };
      }
      return resp.json();
    } catch (e) {
      console.warn('Fabric API fetch failed:', path, e.message);
      return { value: [] };
    }
  }

  async _fltFetch(path, options = {}) {
    try {
      const url = this._fabricBaseUrl + path;
      const headers = {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + this._mwcToken,
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
