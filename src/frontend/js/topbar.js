/**
 * TopBar — 32px persistent status bar.
 * Shows service status, token health, git info.
 */
class TopBar {
  constructor() {
    this._statusEl = document.getElementById('service-status');
    this._statusTextEl = document.getElementById('service-status-text');
    this._tokenCountdownEl = document.getElementById('token-countdown');
    this._tokenHealthEl = document.getElementById('token-health');
    this._branchEl = document.getElementById('git-branch-name');
    this._patchEl = document.getElementById('patch-count');
    this._sidebarDot = document.getElementById('sidebar-token-dot');
    this._tokenTimer = null;
    this._uptimeTimer = null;
    this._uptimeStart = null;
    this._tokenExpiryMinutes = null;
  }

  init() {
    this._startConfigPolling();
  }

  async fetchConfig() {
    try {
      const resp = await fetch('/api/flt/config');
      if (!resp.ok) {
        this._updateServiceStatus('stopped');
        this._updateTokenDisplay(null);
        return null;
      }
      const config = await resp.json();
      this._updateTokenDisplay(config.tokenExpiryMinutes);
      if (config.fabricBaseUrl) {
        this._updateServiceStatus('running');
        if (!this._uptimeStart) this._uptimeStart = Date.now();
      } else {
        this._updateServiceStatus('stopped');
      }
      return config;
    } catch {
      this._updateServiceStatus('stopped');
      this._updateTokenDisplay(null);
      return null;
    }
  }

  _startConfigPolling() {
    this.fetchConfig();
    this._tokenTimer = setInterval(() => this.fetchConfig(), 30000);
    this._uptimeTimer = setInterval(() => this._updateUptime(), 1000);
  }

  _updateServiceStatus(status) {
    if (!this._statusEl) return;
    this._statusEl.className = 'service-status ' + status;
    const labels = { running: 'Running', stopped: 'Stopped', building: 'Building...' };
    if (this._statusTextEl) {
      let label = labels[status] || status;
      if (status === 'running' && this._uptimeStart) {
        label += ' ' + this._formatUptime(Math.floor((Date.now() - this._uptimeStart) / 1000));
      }
      this._statusTextEl.textContent = label;
    }
  }

  _updateUptime() {
    if (this._uptimeStart && this._statusEl?.classList.contains('running')) {
      const secs = Math.floor((Date.now() - this._uptimeStart) / 1000);
      if (this._statusTextEl) {
        this._statusTextEl.textContent = 'Running ' + this._formatUptime(secs);
      }
    }
  }

  _formatUptime(totalSeconds) {
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    return m + 'm' + String(s).padStart(2, '0') + 's';
  }

  _updateTokenDisplay(minutes) {
    if (!this._tokenCountdownEl || !this._tokenHealthEl) return;
    if (minutes === null || minutes === undefined) {
      this._tokenCountdownEl.textContent = 'No token';
      this._tokenHealthEl.className = 'token-health none';
      this._updateSidebarDot('');
      return;
    }
    const rounded = Math.floor(minutes);
    this._tokenCountdownEl.textContent = 'Token ' + rounded + ':' + String(Math.floor((minutes - rounded) * 60)).padStart(2, '0');
    let color = 'green';
    if (minutes <= 5) color = 'red';
    else if (minutes <= 10) color = 'amber';
    this._tokenHealthEl.className = 'token-health ' + color;
    this._updateSidebarDot(color);
  }

  _updateSidebarDot(color) {
    if (!this._sidebarDot) return;
    this._sidebarDot.className = 'sidebar-token-dot' + (color ? ' ' + color : '');
  }

  destroy() {
    if (this._tokenTimer) clearInterval(this._tokenTimer);
    if (this._uptimeTimer) clearInterval(this._uptimeTimer);
  }
}
