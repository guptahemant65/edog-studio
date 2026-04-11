/**
 * TopBar — 44px persistent status bar.
 * Shows tenant chip, phase indicator, token health, git info, Ctrl+K hint.
 * Owns the Token Inspector drawer (slide-in from right on click).
 */
class TopBar {
  constructor() {
    this._statusEl = document.getElementById('service-status');
    this._statusTextEl = document.getElementById('service-status-text');
    this._tokenCountdownEl = document.getElementById('token-countdown');
    this._tokenHealthEl = document.getElementById('token-health');
    this._branchEl = document.getElementById('git-branch-name');
    this._patchEl = document.getElementById('patch-count');
    this._gitMeta = document.getElementById('git-meta');
    this._patchMeta = document.getElementById('patch-meta');
    this._tenantNameEl = document.getElementById('tenant-name');
    this._tenantEnvEl = document.getElementById('tenant-env');
    this._sidebarDot = document.getElementById('sidebar-token-dot');
    this._tokenTimer = null;
    this._uptimeTimer = null;
    this._countdownTimer = null;
    this._uptimeStart = null;
    this._bearerExpiresAt = null;
    this._lastConfig = null;
    this._lastHealth = null;
    this._inspectorEl = null;
  }

  init() {
    this._createTokenInspector();
    this._bindTokenClick();
    this._startConfigPolling();
  }

  /**
   * Fetch both /api/flt/config and /api/edog/health in parallel.
   * Uses bearer token seconds from health endpoint for accurate countdown.
   */
  async fetchConfig() {
    try {
      const [configResp, healthResp] = await Promise.all([
        fetch('/api/flt/config'),
        fetch('/api/edog/health').catch(() => null)
      ]);

      if (!configResp.ok) {
        this._updateServiceStatus('stopped');
        this._updateTokenDisplay(null);
        return null;
      }

      const config = await configResp.json();
      const health = healthResp && healthResp.ok ? await healthResp.json() : null;
      this._lastConfig = config;
      this._lastHealth = health;

      // T5: Update tenant chip from health data
      if (health && health.lastUsername) {
        this._updateTenantChip(health.lastUsername);
      }

      // T7: Use bearerExpiresIn (seconds) from health endpoint
      if (health && health.hasBearerToken && typeof health.bearerExpiresIn === 'number') {
        this._bearerExpiresAt = Date.now() + (health.bearerExpiresIn * 1000);
        this._updateTokenCountdown();
      } else {
        this._bearerExpiresAt = null;
        this._updateTokenDisplay(null);
      }

      // T6: Phase indicator based on fabricBaseUrl
      if (config.fabricBaseUrl) {
        this._updateServiceStatus('running');
        if (!this._uptimeStart) this._uptimeStart = Date.now();
      } else {
        this._updateServiceStatus('stopped');
        this._uptimeStart = null;
      }

      // T8: Show git/patch meta only when real data exists
      this._updateGitVisibility(health || {});

      // Refresh inspector if open
      if (this._inspectorEl && this._inspectorEl.classList.contains('open')) {
        this._populateInspector();
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
    this._uptimeTimer = setInterval(() => this._tickCountdown(), 1000);
  }

  /** T5: Parse username into tenant name + environment label. */
  _updateTenantChip(username) {
    if (!this._tenantNameEl || !this._tenantEnvEl) return;
    const parts = username.split('@');
    const name = parts[0] || username;
    let env = '\u2014';
    if (parts[1]) {
      const domain = parts[1].split('.')[0] || '';
      env = domain.replace(/^Fabric/i, '');
    }
    this._tenantNameEl.textContent = name;
    this._tenantEnvEl.textContent = env;
  }

  /** T6: Update phase/connection indicator. */
  _updateServiceStatus(status) {
    if (!this._statusEl) return;
    this._statusEl.className = 'service-status ' + status;
    const labels = { running: 'Connected', stopped: 'Browsing', building: 'Deploying\u2026' };
    if (this._statusTextEl) {
      let label = labels[status] || status;
      if (status === 'running' && this._uptimeStart) {
        label += ' ' + this._formatUptime(Math.floor((Date.now() - this._uptimeStart) / 1000));
      }
      this._statusTextEl.textContent = label;
    }
  }

  /** T7: Tick the bearer token countdown every second. */
  _tickCountdown() {
    if (this._bearerExpiresAt) {
      this._updateTokenCountdown();
    }
    if (this._uptimeStart && this._statusEl?.classList.contains('running')) {
      const secs = Math.floor((Date.now() - this._uptimeStart) / 1000);
      if (this._statusTextEl) {
        this._statusTextEl.textContent = 'Connected ' + this._formatUptime(secs);
      }
    }
  }

  _formatUptime(totalSeconds) {
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    return m + 'm' + String(s).padStart(2, '0') + 's';
  }

  /** T7: Compute remaining seconds and update token display. */
  _updateTokenCountdown() {
    if (!this._bearerExpiresAt) {
      this._updateTokenDisplay(null);
      return;
    }
    const remainingSec = Math.max(0, Math.floor((this._bearerExpiresAt - Date.now()) / 1000));
    if (remainingSec <= 0) {
      this._bearerExpiresAt = null;
      this._updateTokenDisplay(null);
      return;
    }
    this._updateTokenDisplaySeconds(remainingSec);
  }

  /** T7: Render bearer token countdown from seconds. */
  _updateTokenDisplaySeconds(totalSeconds) {
    if (!this._tokenCountdownEl || !this._tokenHealthEl) return;
    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    this._tokenCountdownEl.textContent = 'Token ' + mins + ':' + String(secs).padStart(2, '0');
    let color = 'green';
    if (totalSeconds <= 300) color = 'red';
    else if (totalSeconds <= 600) color = 'amber';
    this._tokenHealthEl.className = 'token-health ' + color;
    this._updateSidebarDot(color);
  }

  _updateTokenDisplay(minutes) {
    if (!this._tokenCountdownEl || !this._tokenHealthEl) return;
    if (minutes === null || minutes === undefined) {
      this._tokenCountdownEl.textContent = 'No token';
      this._tokenHealthEl.className = 'token-health none';
      this._updateSidebarDot('');
      return;
    }
    const totalSeconds = Math.floor(minutes * 60);
    this._updateTokenDisplaySeconds(totalSeconds);
  }

  /** T8: Show git/patch meta from health API response. */
  _updateGitVisibility(health) {
    if (this._gitMeta) {
      const branch = health.gitBranch || '';
      const hasGit = branch.length > 0;
      this._gitMeta.style.display = hasGit ? '' : 'none';
      if (hasGit && this._branchEl) this._branchEl.textContent = branch;
    }
    if (this._patchMeta) {
      const dirty = health.gitDirtyFiles || 0;
      const hasDirty = dirty > 0;
      this._patchMeta.style.display = hasDirty ? '' : 'none';
      if (hasDirty && this._patchEl) this._patchEl.textContent = '+' + dirty + ' dirty';
    }
  }

  _updateSidebarDot(color) {
    if (!this._sidebarDot) return;
    this._sidebarDot.className = 'sidebar-token-dot' + (color ? ' ' + color : '');
  }

  // ─── Token Inspector ───

  _createTokenInspector() {
    if (document.getElementById('token-inspector')) return;
    const el = document.createElement('div');
    el.id = 'token-inspector';
    el.className = 'token-inspector';
    el.innerHTML =
      '<div class="ti-header">' +
        '<span class="ti-title">Token Inspector</span>' +
        '<button class="ti-close" id="ti-close-btn">\u2715</button>' +
      '</div>' +
      '<div class="ti-body" id="ti-body"></div>';
    document.body.appendChild(el);
    this._inspectorEl = el;

    el.querySelector('#ti-close-btn').addEventListener('click', () => {
      el.classList.remove('open');
    });
  }

  _bindTokenClick() {
    if (this._tokenHealthEl) {
      this._tokenHealthEl.addEventListener('click', () => {
        if (!this._inspectorEl) return;
        this._populateInspector();
        this._inspectorEl.classList.toggle('open');
      });
    }
  }

  _populateInspector() {
    const body = document.getElementById('ti-body');
    if (!body) return;
    const config = this._lastConfig || {};
    const health = this._lastHealth || {};

    const bearerSec = this._bearerExpiresAt
      ? Math.max(0, Math.floor((this._bearerExpiresAt - Date.now()) / 1000))
      : 0;
    const bearerMin = Math.floor(bearerSec / 60);
    const hasMwc = !!config.mwcToken;
    const mwcMin = config.tokenExpiryMinutes || 0;

    body.innerHTML =
      this._renderCard('Bearer (AAD/Entra)', bearerMin, health.hasBearerToken, [
        ['User', health.lastUsername || '\u2014'],
        ['Phase', config.phase || 'disconnected'],
        ['Workspace', config.workspaceId || '\u2014'],
      ]) +
      this._renderCard('MWC (Capacity)', mwcMin, hasMwc, [
        ['Artifact', config.artifactId || '\u2014'],
        ['Capacity', config.capacityId || '\u2014'],
        ['Expired', config.tokenExpired ? 'Yes' : 'No'],
      ]) +
      '<div class="ti-actions">' +
        '<button class="ti-btn primary" id="ti-refresh-btn">Refresh Token</button>' +
        '<button class="ti-btn" id="ti-copy-bearer">Copy Bearer</button>' +
      '</div>';

    // Wire copy button
    const copyBtn = document.getElementById('ti-copy-bearer');
    if (copyBtn) {
      copyBtn.addEventListener('click', () => {
        const token = config.bearerToken;
        if (token && navigator.clipboard) {
          navigator.clipboard.writeText(token);
          copyBtn.textContent = 'Copied!';
          setTimeout(() => { copyBtn.textContent = 'Copy Bearer'; }, 1500);
        }
      });
    }

    // Wire refresh button
    const refreshBtn = document.getElementById('ti-refresh-btn');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => {
        refreshBtn.textContent = 'Refreshing\u2026';
        refreshBtn.disabled = true;
        this.fetchConfig().then(() => {
          this._populateInspector();
        });
      });
    }
  }

  _renderCard(title, minutes, hasToken, claims) {
    const pct = hasToken ? Math.min((minutes / 60) * 100, 100) : 0;
    const color = !hasToken ? 'red' : minutes > 10 ? 'green' : minutes > 5 ? 'amber' : 'red';
    const badge = hasToken ? minutes + 'm remaining' : 'Not available';
    const claimsHtml = claims.map(([k, v]) =>
      '<dt>' + k + '</dt><dd>' + v + '</dd>'
    ).join('');

    return '<div class="ti-token-card">' +
      '<div class="ti-token-header">' +
        '<span>' + title + '</span>' +
        '<span class="ti-type-badge">' + badge + '</span>' +
      '</div>' +
      '<div class="ti-expiry-bar"><div class="ti-expiry-fill ' + color + '" style="width:' + pct + '%"></div></div>' +
      '<div class="ti-token-body">' +
        '<dl class="ti-claims">' + claimsHtml + '</dl>' +
      '</div>' +
    '</div>';
  }

  destroy() {
    if (this._tokenTimer) clearInterval(this._tokenTimer);
    if (this._uptimeTimer) clearInterval(this._uptimeTimer);
  }
}
