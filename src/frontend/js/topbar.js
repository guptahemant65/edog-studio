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
    this._createDeployTooltip();
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

      // T6: Phase indicator — prefer studioPhase (from dev-server supervisor)
      if (config.studioPhase === 'running' || config.studioPhase === 'deploying') {
        this._updateServiceStatus(config.studioPhase === 'deploying' ? 'building' : 'running');
        if (config.studioPhase === 'running' && !this._uptimeStart) this._uptimeStart = Date.now();
      } else if (config.fabricBaseUrl) {
        this._updateServiceStatus('running');
        if (!this._uptimeStart) this._uptimeStart = Date.now();
      } else if (config.studioPhase === 'crashed') {
        this._updateServiceStatus('stopped');
        if (this._statusTextEl) this._statusTextEl.textContent = 'Service Crashed';
      } else {
        this._updateServiceStatus('stopped');
        this._uptimeStart = null;
      }

      // T8: Show git/patch meta only when real data exists
      this._updateGitVisibility(health || {});

      // Sync sidebar phase from studio state
      if (window.edogSidebar) {
        if (config.studioPhase === 'running') {
          window.edogSidebar.setPhase('connected');
        } else if (config.studioPhase === 'idle' || config.studioPhase === 'stopped') {
          window.edogSidebar.setPhase('disconnected');
        }
      }

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
    const bearerSecRem = bearerSec % 60;
    const hasMwc = !!config.mwcToken;
    const mwcMin = config.tokenExpiryMinutes || 0;

    // Parse username parts
    const user = health.lastUsername || '';
    const userParts = user.split('@');
    const userName = userParts[0] || '\u2014';
    const userDomain = userParts[1] || '\u2014';

    body.innerHTML =
      this._renderCard('bearer', 'Bearer (AAD/Entra)', bearerMin, bearerSecRem, health.hasBearerToken, [
        ['User', userName],
        ['Domain', userDomain],
        ['Workspace', config.workspaceId || '\u2014'],
        ['Phase', config.phase || 'disconnected'],
        ['Countdown', health.hasBearerToken ? bearerMin + 'm ' + bearerSecRem + 's' : '\u2014'],
        ['Source', '.edog-bearer-cache'],
      ]) +
      this._renderCard('mwc', 'MWC (Capacity)', mwcMin, 0, hasMwc, [
        ['Artifact', config.artifactId || '\u2014'],
        ['Capacity', config.capacityId || '\u2014'],
        ['Endpoint', config.fabricBaseUrl ? 'pbidedicated' : '\u2014'],
        ['Expired', config.tokenExpired ? 'Yes' : 'No'],
        ['Remaining', hasMwc ? mwcMin + 'm' : '\u2014'],
        ['Source', '.edog-token-cache'],
      ]);

    // Wire per-card buttons
    this._wireCardButtons('bearer', config.bearerToken);
    this._wireCardButtons('mwc', config.mwcToken);
  }

  _wireCardButtons(id, token) {
    const copyBtn = document.getElementById('ti-copy-' + id);
    if (copyBtn) {
      copyBtn.addEventListener('click', () => {
        if (token && navigator.clipboard) {
          navigator.clipboard.writeText(token);
          copyBtn.textContent = 'Copied!';
          setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
        } else {
          copyBtn.textContent = 'No token';
          setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
        }
      });
    }
    const refreshBtn = document.getElementById('ti-refresh-' + id);
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

  _renderCard(id, title, minutes, seconds, hasToken, claims) {
    const pct = hasToken ? Math.min((minutes / 60) * 100, 100) : 0;
    const color = !hasToken ? 'red' : minutes > 10 ? 'green' : minutes > 5 ? 'amber' : 'red';
    const badge = hasToken
      ? minutes + 'm ' + (seconds ? seconds + 's' : '') + ' remaining'
      : 'Not available';
    const claimsHtml = claims.map(([k, v]) =>
      '<dt>' + k + '</dt><dd>' + v + '</dd>'
    ).join('');

    return '<div class="ti-token-card">' +
      '<div class="ti-token-header">' +
        '<span>' + title + '</span>' +
        '<span class="ti-type-badge ' + color + '">' + badge + '</span>' +
      '</div>' +
      '<div class="ti-expiry-bar"><div class="ti-expiry-fill ' + color + '" style="width:' + pct + '%"></div></div>' +
      '<div class="ti-token-body">' +
        '<dl class="ti-claims">' + claimsHtml + '</dl>' +
      '</div>' +
      '<div class="ti-card-actions">' +
        '<button class="ti-btn" id="ti-refresh-' + id + '">Refresh</button>' +
        '<button class="ti-btn" id="ti-copy-' + id + '">Copy</button>' +
      '</div>' +
    '</div>';
  }

  /** Update top bar for deploy lifecycle states. */
  setDeployStatus(status) {
    if (!this._statusEl || !this._statusTextEl) return;
    switch (status) {
      case 'deploying':
        this._statusEl.className = 'service-status building';
        this._statusTextEl.textContent = 'Deploying\u2026';
        this._uptimeStart = null;
        break;
      case 'connected':
        this._statusEl.className = 'service-status running';
        this._uptimeStart = Date.now();
        this._statusTextEl.textContent = 'Connected 0m00s';
        this._refreshDeployTooltip();
        break;
      case 'failed':
        this._statusEl.className = 'service-status stopped';
        this._statusTextEl.textContent = 'Deploy Failed';
        break;
      case 'crashed':
        this._statusEl.className = 'service-status stopped';
        this._statusTextEl.textContent = 'Service Crashed';
        break;
      case 'stopped':
        this._statusEl.className = 'service-status stopped';
        this._statusTextEl.textContent = 'Browsing';
        this._uptimeStart = null;
        break;
    }
  }

  // ─── Deploy Info Tooltip (rich hover card on service status) ───

  _createDeployTooltip() {
    if (!this._statusEl) return;
    const tip = document.createElement('div');
    tip.className = 'deploy-tooltip';
    tip.id = 'deploy-tooltip';
    this._statusEl.style.position = 'relative';
    this._statusEl.appendChild(tip);
    this._deployTip = tip;

    this._statusEl.addEventListener('mouseenter', () => {
      this._refreshDeployTooltip();
      if (this._deployTip.innerHTML) this._deployTip.classList.add('visible');
    });
    this._statusEl.addEventListener('mouseleave', () => {
      this._deployTip.classList.remove('visible');
    });
  }

  async _refreshDeployTooltip() {
    if (!this._deployTip) return;
    try {
      const resp = await fetch('/api/studio/status');
      if (!resp.ok) return;
      const s = await resp.json();
      if (!s.deployTarget || s.phase === 'idle') {
        this._deployTip.innerHTML = '';
        return;
      }
      const t = s.deployTarget;
      const phase = s.phase;
      const dotColor = phase === 'running' ? 'var(--status-succeeded)'
        : phase === 'crashed' ? 'var(--status-failed)'
        : phase === 'deploying' ? 'var(--accent)' : 'var(--text-muted)';

      this._deployTip.innerHTML =
        '<div class="dt-header">' +
          '<span class="dt-dot" style="background:' + dotColor + '"></span>' +
          '<span class="dt-phase">' + this._escTip(phase.charAt(0).toUpperCase() + phase.slice(1)) + '</span>' +
        '</div>' +
        '<dl class="dt-info">' +
          '<dt>Lakehouse</dt><dd>' + this._escTip(t.lakehouseName || t.artifactId) + '</dd>' +
          '<dt>Workspace</dt><dd class="dt-mono">' + this._escTip(t.workspaceId || '\u2014') + '</dd>' +
          '<dt>Capacity</dt><dd class="dt-mono">' + this._escTip(t.capacityId || '\u2014') + '</dd>' +
          (s.fltPid ? '<dt>PID</dt><dd class="dt-mono">' + s.fltPid + '</dd>' : '') +
          (s.fltPort ? '<dt>Port</dt><dd class="dt-mono">:' + s.fltPort + '</dd>' : '') +
        '</dl>';
    } catch {
      // Silent fail
    }
  }

  _escTip(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

  destroy() {
    if (this._tokenTimer) clearInterval(this._tokenTimer);
    if (this._uptimeTimer) clearInterval(this._uptimeTimer);
  }
}
