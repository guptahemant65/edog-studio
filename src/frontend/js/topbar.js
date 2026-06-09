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
    this._deployActive = false;
  }

  init() {
    this._createTokenInspector();
    this._createDeployTooltip();
    this._createGitDiffModal();
    this._createBranchSwitcher();
    this._bindTokenClick();
    this._bindGitDiffClick();
    this._startConfigPolling();
    this._fetchUserIdentity();
  }

  /**
   * Wire the FLT branch switcher to the git branch chip. The chip becomes the
   * trigger; the popover only opens in pre-deploy phases (the lock). Toast +
   * refresh are injected so branch-switcher.js never reaches for a global that
   * might not exist — we use the real edogToast and a fetchConfig refresh.
   */
  _createBranchSwitcher() {
    if (!window.BranchSwitcher || !this._branchEl) return;
    var self = this;
    this._branchSwitcher = new window.BranchSwitcher({
      triggerEl: this._branchEl,
      onToast: function (message, variant, action) {
        if (window.edogToast) {
          window.edogToast(message, variant, action ? { action: action } : undefined);
        } else {
          // Degrade gracefully if the toast manager isn't present.
          if (window.console) window.console.log('[branch-switcher] ' + message);
        }
      },
      onRefresh: function () { self.fetchConfig(); },
    });
    this._branchEl.classList.add('git-branch-trigger');
    this._branchEl.setAttribute('role', 'button');
    this._branchEl.setAttribute('tabindex', '0');
    this._branchEl.addEventListener('click', function () { self._branchSwitcher.toggle(); });
    this._branchEl.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); self._branchSwitcher.toggle(); }
    });
    // Reflect the initial (pre-deploy) phase onto the chip.
    this._branchSwitcher.setPhase('idle');
  }

  /** Forward the studio phase to the branch switcher (drives the chip lock). */
  setPhase(phase) {
    this._phase = phase;
    if (this._branchSwitcher) this._branchSwitcher.setPhase(phase || '');
  }

  /** Fetch OS identity from dev-server and populate the topbar chip. */
  async _fetchUserIdentity() {
    try {
      var resp = await fetch('/api/identity');
      if (!resp.ok) return;
      var data = await resp.json();
      var label = (data.osUser || '?') + '@' + (data.machine || '?');
      var el = document.getElementById('user-identity-label');
      if (el) el.textContent = label;
      var chip = document.getElementById('user-identity-chip');
      if (chip) chip.title = 'Logged in as ' + label;
      // Store globally for session guard and other consumers
      window.edogIdentity = data;
    } catch (_e) { /* silent — identity is best-effort */ }
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
        if (window.edogDeployStrip) window.edogDeployStrip.hide();
        if (window.edogPatchWarnings) window.edogPatchWarnings.hide();
        if (window.edogStatusBar) window.edogStatusBar.setPhase('disconnected');
        this.setPhase('stopped');
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

      // T6: Phase indicator — prefer studioPhase, but don't override active deploy error states
      if (!this._deployActive) {
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
      }

      // T8: Show git/patch meta only when real data exists
      this._updateGitVisibility(health || {});

      // Drive the branch-switcher chip lock from the studio phase. The chip
      // only unlocks in pre-deploy phases; a running/deploying FLT locks it.
      this.setPhase(config.studioPhase || (config.fabricBaseUrl ? 'running' : 'stopped'));

      // Sync sidebar phase and WebSocket port from studio state.
      // Note: ConnectionSupervisor owns the SignalR lifecycle now. We only
      // touch the sidebar pill from here; supervisor handles edogWs.setPort
      // based on its own /api/studio/status poll.
      if (window.edogSidebar) {
        if (config.studioPhase === 'running') {
          window.edogSidebar.setPhase('connected');
        } else if (config.studioPhase === 'idle' || config.studioPhase === 'stopped') {
          window.edogSidebar.setPhase('disconnected');
        }
      }

      // F1: Update deploy context strip + patch warnings banner + health chip
      if (window.edogDeployStrip || window.edogPatchWarnings || window.edogHealthChip) {
        var fetchStudio = fetch('/api/studio/status').then(function(r) {
          return r.ok ? r.json() : null;
        }).catch(function() { return null; });
        var fetchIx = window.edogHealthChip
          ? fetch('/api/edog/interceptors-status').then(function(r) {
              return r.ok ? r.json() : null;
            }).catch(function() { return null; })
          : Promise.resolve(null);
        Promise.all([fetchStudio, fetchIx]).then(function(results) {
          var s = results[0];
          var ix = results[1];
          if (s && window.edogDeployStrip) window.edogDeployStrip.update(s);
          if (s && window.edogPatchWarnings) window.edogPatchWarnings.update(s);
          if (window.edogHealthChip) window.edogHealthChip.update(s || {}, ix || {});
        });
      }

      // F3: Sync footer status bar phase
      if (window.edogStatusBar) {
        if (config.studioPhase === 'running') {
          window.edogStatusBar.setPhase('connected');
        } else if (config.studioPhase === 'deploying') {
          window.edogStatusBar.setPhase('deploying');
        } else {
          window.edogStatusBar.setPhase('disconnected');
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
      if (window.edogDeployStrip) window.edogDeployStrip.hide();
      if (window.edogPatchWarnings) window.edogPatchWarnings.hide();
      if (window.edogStatusBar) window.edogStatusBar.setPhase('disconnected');
      this.setPhase('stopped');
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
    return m + 'm ' + String(s).padStart(2, '0') + 's';
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
      if (this._inspectorEl && !this._inspectorEl.classList.contains('open')) {
        this._openInspector();
      }
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
      if (hasDirty) {
        if (this._patchEl) this._patchEl.textContent = '+' + dirty + ' dirty';
        this._patchMeta.classList.add('clickable');
        this._patchMeta.setAttribute('role', 'button');
        this._patchMeta.setAttribute('tabindex', '0');
        this._patchMeta.setAttribute('title', 'View git changes');
      }
    }
  }

  _updateSidebarDot(color) {
    if (this._sidebarDot) {
      this._sidebarDot.className = 'sidebar-token-dot' + (color ? ' ' + color : '');
    }
    // Mirror to the new sidebar token ring (legacy dot may not exist in DOM).
    if (window.edogSidebar && typeof window.edogSidebar.setTokenHealth === 'function') {
      var status = color === 'green' ? 'healthy'
        : color === 'amber' ? 'warning'
        : color === 'red' ? 'expired'
        : 'none';
      var timeLabel = (this._tokenCountdownEl && status !== 'none') ? this._tokenCountdownEl.textContent : '';
      window.edogSidebar.setTokenHealth(status, timeLabel);
    }
  }

  // ─── Token Inspector ───

  _decodeJwt(token) {
    if (!token || typeof token !== 'string') return null;
    var parts = token.split('.');
    if (parts.length !== 3) return null;
    try {
      var header = JSON.parse(atob(parts[0].replace(/-/g, '+').replace(/_/g, '/')));
      var payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
      return { header: header, payload: payload, signature: parts[2], raw: token, parts: parts };
    } catch (e) {
      return null;
    }
  }

  _collectTokens() {
    var tokens = [];
    var config = this._lastConfig || {};
    var health = this._lastHealth || {};

    // Source 1: Bearer token from config (raw JWT available)
    if (config.bearerToken) {
      var decoded = this._decodeJwt(config.bearerToken);
      var bearerSec = this._bearerExpiresAt
        ? Math.max(0, Math.floor((this._bearerExpiresAt - Date.now()) / 1000))
        : 0;
      tokens.push({
        id: 'bearer|' + (decoded && decoded.payload.aud ? decoded.payload.aud : 'default'),
        type: 'bearer',
        label: 'Bearer',
        audience: decoded && decoded.payload.aud ? String(decoded.payload.aud) : 'Unknown',
        rawToken: config.bearerToken,
        decoded: decoded,
        claims: decoded ? decoded.payload : {},
        issuedAt: decoded && decoded.payload.iat ? decoded.payload.iat * 1000 : Date.now(),
        expiresAt: this._bearerExpiresAt || (decoded && decoded.payload.exp ? decoded.payload.exp * 1000 : 0),
        username: health.lastUsername || ''
      });
    }

    // Source 2: MWC token from config (raw JWT available)
    if (config.mwcToken) {
      var mwcDecoded = this._decodeJwt(config.mwcToken);
      var mwcExpiry = mwcDecoded && mwcDecoded.payload.exp
        ? mwcDecoded.payload.exp * 1000
        : Date.now() + (config.tokenExpiryMinutes || 0) * 60000;
      tokens.push({
        id: 'mwc|' + (mwcDecoded && mwcDecoded.payload.aud ? mwcDecoded.payload.aud : 'default'),
        type: 'mwc',
        label: 'MWC',
        audience: mwcDecoded && mwcDecoded.payload.aud ? String(mwcDecoded.payload.aud) : 'Unknown',
        rawToken: config.mwcToken,
        decoded: mwcDecoded,
        claims: mwcDecoded ? mwcDecoded.payload : {},
        issuedAt: mwcDecoded && mwcDecoded.payload.iat ? mwcDecoded.payload.iat * 1000 : Date.now(),
        expiresAt: mwcExpiry
      });
    }

    // Source 3: Connected-phase tokens from TokensTab (if available)
    if (window.edogTokensTab && typeof window.edogTokensTab.getTokens === 'function') {
      var sigTokens = window.edogTokensTab.getTokens();
      sigTokens.forEach(function(tok) {
        if (tok.typeKey === 'bearer' || tok.typeKey === 'mwc') return;
        tokens.push({
          id: tok.dedupKey,
          type: tok.typeKey,
          label: tok.typeLabel,
          audience: tok.audience,
          rawToken: null,
          decoded: null,
          claims: tok.jwtClaims || {},
          issuedAt: tok.issuedAt,
          expiresAt: tok.expiresAt
        });
      });
    }

    return tokens;
  }

  _createTokenInspector() {
    if (document.getElementById('token-inspector')) return;

    var overlay = document.createElement('div');
    overlay.id = 'ti-overlay';
    overlay.className = 'ti-overlay';
    document.body.appendChild(overlay);
    this._overlayEl = overlay;

    var el = document.createElement('div');
    el.id = 'token-inspector';
    el.className = 'token-inspector';
    el.innerHTML =
      '<div class="ti-header">' +
        '<div class="ti-header-left">' +
          '<span class="ti-title">Token Inspector</span>' +
          '<span class="ti-count" id="ti-count"></span>' +
        '</div>' +
        '<button class="ti-close" id="ti-close-btn">\u2715</button>' +
      '</div>' +
      '<div class="ti-body" id="ti-body"></div>';
    document.body.appendChild(el);
    this._inspectorEl = el;
    this._inspectorView = 'list';
    this._inspectorTokens = [];
    this._ttlTickTimer = null;

    var self = this;
    const closeBtn = el.querySelector('#ti-close-btn');
    if (closeBtn) {
      closeBtn.addEventListener('click', function() {
        self._closeInspector();
      });
    }
    overlay.addEventListener('click', function() {
      self._closeInspector();
    });
    this._escHandler = function(e) {
      if (e.key === 'Escape' && self._inspectorEl.classList.contains('open')) {
        self._closeInspector();
      }
    };
    document.addEventListener('keydown', this._escHandler);
  }

  _openInspector() {
    if (!this._inspectorEl) return;
    this._inspectorView = 'list';
    this._populateInspector();
    this._inspectorEl.classList.add('open');
    this._overlayEl.classList.add('open');
    this._startTtlTick();
  }

  _closeInspector() {
    if (!this._inspectorEl) return;
    this._inspectorEl.classList.remove('open');
    this._overlayEl.classList.remove('open');
    this._stopTtlTick();
  }

  _startTtlTick() {
    this._stopTtlTick();
    var self = this;
    this._ttlTickTimer = setInterval(function() {
      if (!self._inspectorEl.classList.contains('open')) return;
      self._tickInspectorTTL();
    }, 1000);
  }

  _stopTtlTick() {
    if (this._ttlTickTimer) {
      clearInterval(this._ttlTickTimer);
      this._ttlTickTimer = null;
    }
  }

  _bindTokenClick() {
    var self = this;
    if (this._tokenHealthEl) {
      this._tokenHealthEl.addEventListener('click', function() {
        if (!self._inspectorEl) return;
        if (self._inspectorEl.classList.contains('open')) {
          self._closeInspector();
        } else {
          self._openInspector();
        }
      });
    }
  }

  _populateInspector() {
    var body = document.getElementById('ti-body');
    if (!body) return;

    this._inspectorTokens = this._collectTokens();
    var countEl = document.getElementById('ti-count');
    if (countEl) countEl.textContent = this._inspectorTokens.length || '';

    if (!this._inspectorTokens.length && !(this._inspectorView === 'decode' && this._decodeTarget)) {
      body.innerHTML = this._renderEmptyState();
      return;
    }

    if (this._inspectorView === 'decode' && this._decodeTarget) {
      this._renderDecodeView(body);
      return;
    }

    if (!this._inspectorTokens.length) {
      body.innerHTML = this._renderEmptyState();
      return;
    }

    var html = '<div class="ti-list">';
    for (var i = 0; i < this._inspectorTokens.length; i++) {
      html += this._renderTokenCard(this._inspectorTokens[i], i);
    }
    html += '</div>';
    body.innerHTML = html;

    var self = this;
    body.querySelectorAll('.ti-card').forEach(function(card) {
      card.addEventListener('click', function() {
        var idx = parseInt(card.dataset.index, 10);
        var tok = self._inspectorTokens[idx];
        if (tok) {
          self._decodeTarget = tok;
          self._inspectorView = 'decode';
          self._populateInspector();
        }
      });
    });
  }

  _renderTokenCard(tok, index) {
    var now = Date.now();
    var remainSec = Math.max(0, Math.floor((tok.expiresAt - now) / 1000));
    var totalSec = Math.max(1, Math.floor((tok.expiresAt - tok.issuedAt) / 1000));
    var pct = tok.expiresAt > now ? Math.min(100, Math.round((remainSec / totalSec) * 100)) : 0;
    var expired = tok.expiresAt <= now;
    var color = expired ? 'expired' : remainSec > 600 ? 'green' : remainSec > 300 ? 'amber' : 'red';

    var ttlText;
    if (expired) {
      var agoMin = Math.floor((now - tok.expiresAt) / 60000);
      ttlText = 'EXPIRED ' + (agoMin < 1 ? '<1m ago' : agoMin + 'm ago');
    } else {
      var mm = Math.floor(remainSec / 60);
      var ss = remainSec % 60;
      ttlText = mm + 'm ' + ss + 's remaining';
    }

    var issuedAgo = Math.floor((now - tok.issuedAt) / 60000);
    var issuedText = issuedAgo < 1 ? 'just now' : issuedAgo + 'm ago';

    return '<div class="ti-card ' + color + '" data-index="' + index + '" data-token-id="' + this._escAttr(tok.id) + '">' +
      '<div class="ti-card-header">' +
        '<span class="ti-type-badge ' + tok.type + '">' + this._getTiIcon(tok.type) + ' ' + this._escHtml(tok.label) + '</span>' +
        '<span class="ti-ttl-badge ' + color + '" data-ti-ttl="' + index + '">' + ttlText + '</span>' +
      '</div>' +
      '<div class="ti-card-audience">' + this._escHtml(tok.audience) + '</div>' +
      '<div class="ti-card-bar"><div class="ti-card-bar-fill ' + color + '" data-ti-bar="' + index + '" style="width:' + pct + '%"></div></div>' +
      '<div class="ti-card-meta">' +
        '<span>Issued ' + issuedText + '</span>' +
        '<span class="ti-decode-hint">Decode \u25B8</span>' +
      '</div>' +
    '</div>';
  }

  _renderDecodeView(body) {
    var tok = this._decodeTarget;
    if (!tok) {
      body.innerHTML = '<div class="ti-decode"><div style="color:var(--text-muted);padding:24px;text-align:center">No token selected</div></div>';
      return;
    }

    var html = '<div class="ti-decode">';

    html += '<button class="ti-back" id="ti-back-btn">\u25C2 Back to tokens</button>';

    html += '<div class="ti-decode-identity">' +
      '<span class="ti-type-badge ' + tok.type + '">' + this._getTiIcon(tok.type) + ' ' + this._escHtml(tok.label) + '</span>' +
      '<span class="ti-decode-audience">' + this._escHtml(tok.audience) + '</span>' +
    '</div>';

    if (tok.decoded && tok.decoded.raw) {
      var parts = tok.decoded.parts;
      html += '<div class="ti-section">' +
        '<div class="ti-section-title">JWT Token</div>' +
        '<div class="ti-jwt-raw">' +
          '<span class="ti-jwt-header-seg" title="Click to view header">' + this._escHtml(parts[0]) + '</span>' +
          '<span class="ti-jwt-dot">.</span>' +
          '<span class="ti-jwt-payload-seg" title="Click to view payload">' + this._escHtml(parts[1]) + '</span>' +
          '<span class="ti-jwt-dot">.</span>' +
          '<span class="ti-jwt-sig-seg">' + this._escHtml(parts[2]) + '</span>' +
        '</div>' +
      '</div>';
    } else if (tok.rawToken && tok.rawToken !== 'proxy-managed') {
      html += '<div class="ti-section">' +
        '<div class="ti-section-title">Raw Token</div>' +
        '<div class="ti-jwt-raw" style="word-break:break-all">' + this._escHtml(tok.rawToken.substring(0, 200)) + (tok.rawToken.length > 200 ? '\u2026' : '') + '</div>' +
        '<div style="font-size:11px;color:var(--text-muted);margin-top:4px">Token could not be decoded as JWT</div>' +
      '</div>';
    } else if (!tok.decoded) {
      html += '<div class="ti-section">' +
        '<div class="ti-section-title">Token Details</div>' +
        '<div style="color:var(--text-muted);font-size:12px;padding:12px 0">' +
          (tok.type === 'mwc' ? 'MWC token is proxy-managed \u2014 raw JWT not available for decode. Claims below are from the runtime interceptor.' :
           'Raw token not available for decode. Claims shown are from runtime capture.') +
        '</div>' +
      '</div>';
    }

    if (tok.decoded && tok.decoded.header) {
      html += '<div class="ti-section">' +
        '<div class="ti-section-title">Decoded Header</div>' +
        '<div class="ti-claims-table">';
      var headerKeys = Object.keys(tok.decoded.header);
      for (var h = 0; h < headerKeys.length; h++) {
        var hk = headerKeys[h];
        html += '<div class="ti-claim-key">' + this._escHtml(hk) + '</div>' +
          '<div class="ti-claim-val">' + this._escHtml(String(tok.decoded.header[hk])) + '</div>';
      }
      html += '</div></div>';
    }

    var claims = tok.claims || {};
    var claimKeys = Object.keys(claims);
    if (claimKeys.length) {
      html += '<div class="ti-section">' +
        '<div class="ti-section-title">Decoded Payload (' + claimKeys.length + ' claims)</div>' +
        '<div class="ti-claims-table">';
      for (var c = 0; c < claimKeys.length; c++) {
        var ck = claimKeys[c];
        var cv = claims[ck];
        var valHtml;
        if (ck === 'exp' || ck === 'iat' || ck === 'nbf') {
          var dateStr = new Date(cv * 1000).toLocaleString();
          valHtml = '<div class="ti-claim-val timestamp">' + this._escHtml(String(cv)) + '<span class="ti-claim-date">' + dateStr + '</span></div>';
        } else if (Array.isArray(cv)) {
          valHtml = '<div class="ti-claim-val">' + this._escHtml(JSON.stringify(cv)) + '</div>';
        } else if (typeof cv === 'object' && cv !== null) {
          valHtml = '<div class="ti-claim-val">' + this._escHtml(JSON.stringify(cv)) + '</div>';
        } else {
          valHtml = '<div class="ti-claim-val">' + this._escHtml(String(cv)) + '</div>';
        }
        html += '<div class="ti-claim-key">' + this._escHtml(ck) + '</div>' + valHtml;
      }
      html += '</div></div>';
    }

    var scopes = claims.scp ? String(claims.scp).split(' ') : [];
    var roles = Array.isArray(claims.roles) ? claims.roles : [];
    var allScopes = scopes.concat(roles);
    if (allScopes.length) {
      html += '<div class="ti-section">' +
        '<div class="ti-section-title">Scopes & Roles (' + allScopes.length + ')</div>' +
        '<div class="ti-scopes">';
      for (var s = 0; s < allScopes.length; s++) {
        html += '<span class="ti-scope-pill">' + this._escHtml(allScopes[s]) + '</span>';
      }
      html += '</div></div>';
    }

    var now = Date.now();
    var remainSec = Math.max(0, Math.floor((tok.expiresAt - now) / 1000));
    var totalSec = Math.max(1, Math.floor((tok.expiresAt - tok.issuedAt) / 1000));
    var pct = tok.expiresAt > now ? Math.min(100, Math.round((remainSec / totalSec) * 100)) : 0;
    var expired = tok.expiresAt <= now;
    var color = expired ? 'expired' : remainSec > 600 ? 'green' : remainSec > 300 ? 'amber' : 'red';
    var ttlText = expired ? 'EXPIRED' : Math.floor(remainSec / 60) + 'm ' + (remainSec % 60) + 's remaining';

    html += '<div class="ti-section">' +
      '<div class="ti-section-title">Token Lifetime</div>' +
      '<div class="ti-expiry-section">' +
        '<div class="ti-card-bar"><div class="ti-card-bar-fill ' + color + '" id="ti-decode-bar" style="width:' + pct + '%"></div></div>' +
        '<span class="ti-ttl-badge ' + color + '" id="ti-decode-ttl">' + ttlText + '</span>' +
      '</div>' +
    '</div>';

    html += '<div class="ti-actions">' +
      '<button class="ti-btn primary" id="ti-act-refresh">' +
        '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M17.65 6.35A7.958 7.958 0 0012 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0112 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>' +
        ' Refresh Token' +
      '</button>' +
      '<button class="ti-btn" id="ti-act-copy">' +
        '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>' +
        ' Copy Token' +
      '</button>';

    if (tok.rawToken) {
      html += '<a class="ti-btn ti-link" href="https://jwt.ms/#access_token=' + encodeURIComponent(tok.rawToken) + '" target="_blank" rel="noopener">' +
        'Open on jwt.ms \u2197' +
      '</a>';
    }

    html += '</div></div>';

    body.innerHTML = html;

    var self = this;

    var backBtn = document.getElementById('ti-back-btn');
    if (backBtn) {
      backBtn.addEventListener('click', function() {
        self._inspectorView = 'list';
        self._decodeTarget = null;
        self._populateInspector();
      });
    }

    var copyBtn = document.getElementById('ti-act-copy');
    if (copyBtn) {
      copyBtn.addEventListener('click', function() {
        if (tok.rawToken && navigator.clipboard) {
          navigator.clipboard.writeText(tok.rawToken);
          copyBtn.textContent = 'Copied!';
          setTimeout(function() { copyBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg> Copy Token'; }, 1500);
        } else if (tok.claims) {
          navigator.clipboard.writeText(JSON.stringify(tok.claims, null, 2));
          copyBtn.textContent = 'Claims copied!';
          setTimeout(function() { copyBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg> Copy Token'; }, 1500);
        }
      });
    }

    var refreshBtn = document.getElementById('ti-act-refresh');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', function() {
        refreshBtn.textContent = 'Refreshing\u2026';
        refreshBtn.disabled = true;
        self.fetchConfig().then(function() {
          self._inspectorView = 'list';
          self._decodeTarget = null;
          self._populateInspector();
        });
      });
    }

    var headerSeg = body.querySelector('.ti-jwt-header-seg');
    var payloadSeg = body.querySelector('.ti-jwt-payload-seg');
    if (headerSeg) {
      headerSeg.style.cursor = 'pointer';
      headerSeg.addEventListener('click', function() {
        var target = body.querySelectorAll('.ti-section')[1];
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }
    if (payloadSeg) {
      payloadSeg.style.cursor = 'pointer';
      payloadSeg.addEventListener('click', function() {
        var target = body.querySelectorAll('.ti-section')[2];
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }
  }

  _renderEmptyState() {
    return '<div class="ti-empty">' +
      '<div class="ti-empty-icon">' +
        '<svg viewBox="0 0 24 24" width="48" height="48"><path fill="currentColor" d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm0 10.99h7c-.53 4.12-3.28 7.79-7 8.94V12H5V6.3l7-3.11v8.8z"/></svg>' +
      '</div>' +
      '<div class="ti-empty-title">No tokens available</div>' +
      '<div class="ti-empty-hint">Run <code>edog auth login</code> to acquire a bearer token</div>' +
    '</div>';
  }

  _getTiIcon(type) {
    var icons = {
      bearer: '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm0 10.99h7c-.53 4.12-3.28 7.79-7 8.94V12H5V6.3l7-3.11v8.8z"/></svg>',
      mwc: '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M12.65 10C11.83 7.67 9.61 6 7 6c-3.31 0-6 2.69-6 6s2.69 6 6 6c2.61 0 4.83-1.67 5.65-4H17v4h4v-4h2v-4H12.65zM7 14c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2z"/></svg>',
      s2s: '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M6.99 11L3 15l3.99 4v-3H14v-2H6.99v-3zM21 9l-3.99-4v3H10v2h7.01v3L21 9z"/></svg>',
      obo: '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>',
      unknown: '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M11 18h2v-2h-2v2zm1-16C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm0-14c-2.21 0-4 1.79-4 4h2c0-1.1.9-2 2-2s2 .9 2 2c0 2-3 1.75-3 5h2c0-2.25 3-2.5 3-5 0-2.21-1.79-4-4-4z"/></svg>'
    };
    return icons[type] || icons.unknown;
  }

  _escHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  _escAttr(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  }

  _tickInspectorTTL() {
    var now = Date.now();

    // Decode view uses fixed IDs for its single visible card.
    if (this._inspectorView === 'decode' && this._decodeTarget) {
      var dt = this._decodeTarget;
      var dTtlEl = document.getElementById('ti-decode-ttl');
      var dBarEl = document.getElementById('ti-decode-bar');
      if (dTtlEl) {
        var dRemainSec = Math.max(0, Math.floor((dt.expiresAt - now) / 1000));
        var dTotalSec = Math.max(1, Math.floor((dt.expiresAt - dt.issuedAt) / 1000));
        var dPct = dt.expiresAt > now ? Math.min(100, Math.round((dRemainSec / dTotalSec) * 100)) : 0;
        var dExpired = dt.expiresAt <= now;
        var dColor = dExpired ? 'expired' : dRemainSec > 600 ? 'green' : dRemainSec > 300 ? 'amber' : 'red';
        if (dExpired) {
          var dAgoMin = Math.floor((now - dt.expiresAt) / 60000);
          dTtlEl.textContent = 'EXPIRED ' + (dAgoMin < 1 ? '<1m ago' : dAgoMin + 'm ago');
        } else {
          var dMm = Math.floor(dRemainSec / 60);
          var dSs = dRemainSec % 60;
          dTtlEl.textContent = dMm + 'm ' + dSs + 's remaining';
        }
        dTtlEl.className = 'ti-ttl-badge ' + dColor;
        if (dBarEl) {
          dBarEl.style.width = dPct + '%';
          dBarEl.className = 'ti-card-bar-fill ' + dColor;
        }
      }
      return;
    }

    for (var i = 0; i < this._inspectorTokens.length; i++) {
      var tok = this._inspectorTokens[i];
      var ttlEl = document.querySelector('[data-ti-ttl="' + i + '"]');
      var barEl = document.querySelector('[data-ti-bar="' + i + '"]');
      if (!ttlEl) continue;

      var remainSec = Math.max(0, Math.floor((tok.expiresAt - now) / 1000));
      var totalSec = Math.max(1, Math.floor((tok.expiresAt - tok.issuedAt) / 1000));
      var pct = tok.expiresAt > now ? Math.min(100, Math.round((remainSec / totalSec) * 100)) : 0;
      var expired = tok.expiresAt <= now;
      var color = expired ? 'expired' : remainSec > 600 ? 'green' : remainSec > 300 ? 'amber' : 'red';

      if (expired) {
        var agoMin = Math.floor((now - tok.expiresAt) / 60000);
        ttlEl.textContent = 'EXPIRED ' + (agoMin < 1 ? '<1m ago' : agoMin + 'm ago');
      } else {
        var mm = Math.floor(remainSec / 60);
        var ss = remainSec % 60;
        ttlEl.textContent = mm + 'm ' + ss + 's remaining';
      }
      ttlEl.className = 'ti-ttl-badge ' + color;
      if (barEl) {
        barEl.style.width = pct + '%';
        barEl.className = 'ti-card-bar-fill ' + color;
      }
    }
  }

  /** Update top bar for deploy lifecycle states. */
  setDeployStatus(status) {
    if (!this._statusEl || !this._statusTextEl) return;
    this._deployActive = (status === 'deploying' || status === 'failed' || status === 'crashed');
    switch (status) {
      case 'deploying':
        this._statusEl.className = 'service-status building';
        this._statusTextEl.textContent = 'Deploying\u2026';
        this._uptimeStart = null;
        break;
      case 'connected':
        this._statusEl.className = 'service-status running';
        this._uptimeStart = Date.now();
        this._statusTextEl.textContent = 'Connected 0m 00s';
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

  // ─── Git Diff Modal ─────────────────────────────────────────────
  // Centered modal (80vw × 85vh) with:
  //   • Stats bar (files / +ins / -del)
  //   • Live search across diff
  //   • Sticky file-card sidebar with per-file +/- counts
  //   • Collapsible per-file diff sections, two-column line-number gutter
  //   • Hunk headers with extracted function context
  //   • Copy-all + per-file copy
  //   • Glass-morphism backdrop, spring scale entrance, staggered card fade-in

  _createGitDiffModal() {
    if (document.getElementById('git-diff-modal')) return;

    var overlay = document.createElement('div');
    overlay.id = 'gd-overlay';
    overlay.className = 'git-diff-overlay';
    document.body.appendChild(overlay);

    var el = document.createElement('div');
    el.id = 'git-diff-modal';
    el.className = 'git-diff-modal';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-label', 'Git changes');
    el.innerHTML =
      '<div class="gd-header">' +
        '<div class="gd-header-left">' +
          '<div class="gd-title-block">' +
            '<span class="gd-title">Git Changes</span>' +
            '<div class="gd-subtitle">' +
              '<span class="gd-branch-chip" id="gd-branch">' +
                '<span class="gd-branch-dot"></span>' +
                '<span class="gd-branch-name">\u2014</span>' +
              '</span>' +
              '<span class="gd-stats" id="gd-stats">' +
                '<span class="gd-stat-your" id="gd-stat-your">' +
                  '<span class="gd-stat-your-label">Your</span>' +
                  '<span class="gd-stat-your-files"><span id="gd-stat-your-files-n">0</span> files</span>' +
                  '<span class="gd-stat-sep">\u00B7</span>' +
                  '<span class="gd-stat-add">+<span id="gd-stat-your-add-n">0</span></span>' +
                  '<span class="gd-stat-del">\u2212<span id="gd-stat-your-del-n">0</span></span>' +
                '</span>' +
                '<span class="gd-stat-divider" id="gd-stat-divider">\u2502</span>' +
                '<span class="gd-stat-edog" id="gd-stat-edog">' +
                  '<span class="gd-stat-edog-label">EDOG</span>' +
                  '<span class="gd-stat-edog-files"><span id="gd-stat-edog-files-n">0</span> files</span>' +
                  '<span class="gd-stat-edog-vis" id="gd-stat-edog-vis">(hidden)</span>' +
                '</span>' +
              '</span>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="gd-header-right">' +
          '<div class="gd-search">' +
            '<svg class="gd-search-icon" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5l3 3"/></svg>' +
            '<input type="search" id="gd-search-input" class="gd-search-input" placeholder="Search diff\u2026" spellcheck="false" autocomplete="off" />' +
            '<span class="gd-search-count" id="gd-search-count"></span>' +
          '</div>' +
          '<button class="gd-btn gd-btn-toggle" id="gd-toggle-edog" title="Toggle EDOG patch visibility (e)" aria-pressed="false">' +
            '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8s-2.5 4.5-6.5 4.5S1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/></svg>' +
            '<span class="gd-btn-label" id="gd-toggle-edog-label">Show EDOG</span>' +
          '</button>' +
          '<button class="gd-btn gd-btn-toggle" id="gd-toggle-split" title="Toggle split / unified view (s)" aria-pressed="false">' +
            '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><path d="M8 2.5v11"/></svg>' +
            '<span class="gd-btn-label" id="gd-toggle-split-label">Split</span>' +
          '</button>' +
          '<button class="gd-btn" id="gd-copy-clean-btn" title="Copy diff with EDOG patches stripped">' +
            '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 3l10 10M13 3L3 13"/></svg>' +
            '<span class="gd-btn-label">Copy Clean</span>' +
          '</button>' +
          '<button class="gd-btn" id="gd-save-patch-btn" title="Download as .patch file">' +
            '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M8 1.5v9M4.5 7L8 10.5 11.5 7M2.5 13.5h11"/></svg>' +
            '<span class="gd-btn-label">Save .patch</span>' +
          '</button>' +
          '<button class="gd-btn" id="gd-copy-btn" title="Copy full unified diff">' +
            '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="4.5" y="4.5" width="9" height="9" rx="1.5"/><path d="M11.5 4.5V3a1.5 1.5 0 00-1.5-1.5H3A1.5 1.5 0 001.5 3v7A1.5 1.5 0 003 11.5h1.5"/></svg>' +
            '<span class="gd-btn-label">Copy diff</span>' +
          '</button>' +
          '<button class="gd-btn gd-btn-icon" id="gd-help-btn" title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts">?</button>' +
          '<button class="gd-close" id="gd-close-btn" aria-label="Close" title="Close (Esc)">\u2715</button>' +
        '</div>' +
      '</div>' +
      '<div class="gd-content">' +
        '<aside class="gd-sidebar" id="gd-sidebar">' +
          '<div class="gd-sidebar-section gd-sidebar-section-your" id="gd-side-your">' +
            '<div class="gd-sidebar-title">' +
              '<span class="gd-side-caret">\u25BE</span>' +
              '<span>Your Changes</span>' +
              '<span class="gd-side-count" id="gd-side-your-count">0</span>' +
            '</div>' +
            '<div class="gd-sidebar-list" id="gd-sidebar-list-your"></div>' +
          '</div>' +
          '<div class="gd-sidebar-section gd-sidebar-section-edog collapsed" id="gd-side-edog" hidden>' +
            '<div class="gd-sidebar-title gd-sidebar-title-edog">' +
              '<span class="gd-side-caret">\u25B8</span>' +
              '<span>EDOG Patches</span>' +
              '<span class="gd-side-count" id="gd-side-edog-count">0</span>' +
            '</div>' +
            '<div class="gd-sidebar-list" id="gd-sidebar-list-edog"></div>' +
          '</div>' +
        '</aside>' +
        '<main class="gd-main" id="gd-main">' +
          '<div class="gd-empty">Loading\u2026</div>' +
        '</main>' +
      '</div>';
    document.body.appendChild(el);

    this._gitDiffEl = el;
    this._gitDiffOverlay = overlay;
    this._gitDiffData = null;
    this._gitDiffParsed = null;
    this._gitDiffSearchTerm = '';
    this._gitDiffShowEdog = false;
    this._gitDiffSplitView = false;
    this._gitDiffActiveIdx = 0;
    this._gitDiffActiveHunkIdx = 0;

    var self = this;
    overlay.addEventListener('click', function() { self._closeGitDiff(); });
    el.querySelector('#gd-close-btn').addEventListener('click', function() { self._closeGitDiff(); });
    el.querySelector('#gd-copy-btn').addEventListener('click', function() { self._copyGitDiff(); });
    el.querySelector('#gd-copy-clean-btn').addEventListener('click', function() { self._copyCleanGitDiff(); });
    el.querySelector('#gd-save-patch-btn').addEventListener('click', function() { self._saveGitDiffPatch(); });
    el.querySelector('#gd-toggle-edog').addEventListener('click', function() { self._toggleEdogVisibility(); });
    el.querySelector('#gd-toggle-split').addEventListener('click', function() { self._toggleSplitView(); });
    el.querySelector('#gd-help-btn').addEventListener('click', function() { self._toggleGdHelp(); });

    // Sidebar section header collapse (Your/EDOG)
    el.querySelectorAll('.gd-sidebar-section .gd-sidebar-title').forEach(function(title) {
      title.addEventListener('click', function() {
        var section = title.parentElement;
        section.classList.toggle('collapsed');
        var caret = title.querySelector('.gd-side-caret');
        if (caret) caret.textContent = section.classList.contains('collapsed') ? '\u25B8' : '\u25BE';
      });
    });

    var searchInput = el.querySelector('#gd-search-input');
    searchInput.addEventListener('input', function() {
      self._gitDiffSearchTerm = searchInput.value || '';
      self._applyGitDiffSearch();
    });

    this._gitDiffEscHandler = function(e) {
      if (!self._gitDiffEl || !self._gitDiffEl.classList.contains('open')) return;
      // Don't intercept shortcuts when typing in the search box (except Esc).
      var inSearch = (document.activeElement === searchInput);
      if (e.key === 'Escape') {
        // If help overlay is open, close it first.
        if (self._gitDiffHelpOpen) { self._toggleGdHelp(false); return; }
        if (inSearch && searchInput.value) {
          searchInput.value = '';
          self._gitDiffSearchTerm = '';
          self._applyGitDiffSearch();
        } else {
          self._closeGitDiff();
        }
        return;
      }
      if ((e.key === 'f' || e.key === 'F') && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        searchInput.focus();
        searchInput.select();
        return;
      }
      if (inSearch) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      switch (e.key) {
        case 'j': e.preventDefault(); self._gdNavFile(1); break;
        case 'k': e.preventDefault(); self._gdNavFile(-1); break;
        case 'n': e.preventDefault(); self._gdNavHunk(1); break;
        case 'p': e.preventDefault(); self._gdNavHunk(-1); break;
        case 'c': e.preventDefault(); self._gdToggleCurrentFile(); break;
        case 'e': e.preventDefault(); self._toggleEdogVisibility(); break;
        case 's': e.preventDefault(); self._toggleSplitView(); break;
        case '?': e.preventDefault(); self._toggleGdHelp(); break;
      }
    };
    document.addEventListener('keydown', this._gitDiffEscHandler);
  }

  _bindGitDiffClick() {
    if (!this._patchMeta) return;
    var self = this;
    var open = function() {
      if (self._patchMeta.style.display === 'none') return;
      self._openGitDiff();
    };
    this._patchMeta.addEventListener('click', open);
    this._patchMeta.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    });
  }

  async _openGitDiff() {
    if (!this._gitDiffEl) return;
    this._gitDiffEl.classList.add('open');
    this._gitDiffOverlay.classList.add('open');
    var main = document.getElementById('gd-main');
    var listYour = document.getElementById('gd-sidebar-list-your');
    var listEdog = document.getElementById('gd-sidebar-list-edog');
    if (main) main.innerHTML = '<div class="gd-empty">' + this._gdSpinner() + '<div>Loading git changes\u2026</div></div>';
    if (listYour) listYour.innerHTML = '';
    if (listEdog) listEdog.innerHTML = '';
    try {
      var resp = await fetch('/api/edog/git-diff');
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      var data = await resp.json();
      this._gitDiffData = data;
      this._renderGitDiff(data);
    } catch (e) {
      if (main) main.innerHTML = '<div class="gd-empty gd-error">Failed to load diff: ' + this._escTip(String(e && e.message || e)) + '</div>';
    }
  }

  _closeGitDiff() {
    if (!this._gitDiffEl) return;
    this._gitDiffEl.classList.remove('open');
    this._gitDiffOverlay.classList.remove('open');
  }

  _gdSpinner() {
    return '<div class="gd-spinner" aria-hidden="true"></div>';
  }

  // Parse a unified diff into a list of file entries with hunks.
  _parseUnifiedDiff(raw, source) {
    var files = [];
    if (!raw) return files;
    var lines = raw.split('\n');
    var current = null;
    var inHunk = false;
    var oldNum = 0;
    var newNum = 0;

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];

      if (line.indexOf('diff --git') === 0) {
        if (current) files.push(current);
        var pathMatch = line.match(/ a\/(.+?) b\/(.+)$/);
        var path = pathMatch ? pathMatch[2] : line.replace(/^diff --git\s+/, '');
        current = {
          source: source,
          path: path,
          oldPath: pathMatch ? pathMatch[1] : path,
          newPath: pathMatch ? pathMatch[2] : path,
          mode: null,
          isNew: false,
          isDeleted: false,
          isRename: false,
          isBinary: false,
          additions: 0,
          deletions: 0,
          hunks: [],
        };
        inHunk = false;
        continue;
      }
      if (!current) continue;

      if (line.indexOf('new file mode') === 0) { current.isNew = true; continue; }
      if (line.indexOf('deleted file mode') === 0) { current.isDeleted = true; continue; }
      if (line.indexOf('rename from') === 0) { current.isRename = true; continue; }
      if (line.indexOf('rename to') === 0) { current.isRename = true; continue; }
      if (line.indexOf('Binary files') === 0 || line.indexOf('GIT binary patch') === 0) {
        current.isBinary = true;
        inHunk = false;
        continue;
      }
      if (line.indexOf('index ') === 0 || line.indexOf('similarity ') === 0 ||
          line.indexOf('old mode') === 0 || line.indexOf('new mode') === 0) {
        continue;
      }
      if (line.indexOf('--- ') === 0 || line.indexOf('+++ ') === 0) {
        continue;
      }

      if (line.indexOf('@@') === 0) {
        var hm = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/);
        if (hm) {
          oldNum = parseInt(hm[1], 10);
          newNum = parseInt(hm[3], 10);
          current.hunks.push({
            header: line,
            context: (hm[5] || '').trim(),
            oldStart: oldNum,
            newStart: newNum,
            lines: [],
          });
          inHunk = true;
        }
        continue;
      }

      if (!inHunk) continue;
      var hunk = current.hunks[current.hunks.length - 1];
      var ch = line.charAt(0);
      if (ch === '+') {
        hunk.lines.push({ type: '+', text: line.substring(1), oldNum: null, newNum: newNum });
        newNum++;
        current.additions++;
      } else if (ch === '-') {
        hunk.lines.push({ type: '-', text: line.substring(1), oldNum: oldNum, newNum: null });
        oldNum++;
        current.deletions++;
      } else if (ch === '\\') {
        // "\ No newline at end of file" — render as meta line, no numbers.
        hunk.lines.push({ type: '\\', text: line, oldNum: null, newNum: null });
      } else {
        // Context line (leading space or empty).
        var ctx = line.length ? line.substring(1) : '';
        hunk.lines.push({ type: ' ', text: ctx, oldNum: oldNum, newNum: newNum });
        oldNum++;
        newNum++;
      }
    }
    if (current) files.push(current);
    return files;
  }

  _renderGitDiff(data) {
    var main = document.getElementById('gd-main');
    var listYour = document.getElementById('gd-sidebar-list-your');
    var listEdog = document.getElementById('gd-sidebar-list-edog');
    var branchChip = document.getElementById('gd-branch');
    var branchName = branchChip ? branchChip.querySelector('.gd-branch-name') : null;
    if (!main || !listYour || !listEdog) return;

    if (!data || !data.valid) {
      if (branchName) branchName.textContent = '\u2014';
      this._updateStatsBar(0, 0, 0, 0);
      main.innerHTML = this._renderEmptyClean('No FLT repo configured.');
      listYour.innerHTML = '';
      listEdog.innerHTML = '';
      return;
    }

    if (branchName) branchName.textContent = data.branch || '\u2014';

    var stagedFiles = this._parseUnifiedDiff(data.stagedDiff || '', 'staged');
    var unstagedFiles = this._parseUnifiedDiff(data.diff || '', 'unstaged');
    var diffFiles = unstagedFiles.concat(stagedFiles);

    // Build the EDOG-path set from the backend (preferred) plus a regex fallback.
    var edogSet = {};
    if (Array.isArray(data.edogFiles)) {
      data.edogFiles.forEach(function(p) { edogSet[p] = true; });
    }
    var edogBasenames = {
      'GTSBasedSparkClient.cs': 1, 'Program.cs': 1, 'WorkloadApp.cs': 1,
      'DagExecutionHandlerV2.cs': 1, 'ParametersManifest.json': 1, 'Test.json': 1,
      'LiveTableController.cs': 1, 'LiveTableSchedulerRunController.cs': 1,
      'CustomLiveTableTelemetryReporter.cs': 1,
    };
    var isEdogPath = function(p) {
      if (!p) return false;
      var norm = p.replace(/\\/g, '/');
      if (edogSet[p] || edogSet[norm]) return true;
      if (norm.indexOf('/DevMode/') !== -1 || norm.indexOf('DevMode/') === 0) return true;
      var base = norm.split('/').pop();
      return !!edogBasenames[base];
    };

    // Untracked from porcelain
    var porcelain = Array.isArray(data.files) ? data.files : [];
    var seen = {};
    diffFiles.forEach(function(f) { seen[f.path] = true; });
    var untracked = [];
    porcelain.forEach(function(p) {
      if (p.status === '?' && !seen[p.path]) {
        untracked.push({
          source: 'untracked', path: p.path, oldPath: p.path, newPath: p.path,
          isNew: true, isDeleted: false, isBinary: false,
          additions: 0, deletions: 0, hunks: [],
        });
      }
    });
    var allFiles = diffFiles.concat(untracked);
    allFiles.forEach(function(f) { f.isEdog = isEdogPath(f.path); });

    var yourFiles = allFiles.filter(function(f) { return !f.isEdog; });
    var edogFiles = allFiles.filter(function(f) { return f.isEdog; });

    var yourAdd = 0, yourDel = 0;
    yourFiles.forEach(function(f) { yourAdd += f.additions; yourDel += f.deletions; });
    this._updateStatsBar(yourFiles.length, yourAdd, yourDel, edogFiles.length);

    this._gitDiffParsed = allFiles;
    this._gitDiffYourFiles = yourFiles;
    this._gitDiffEdogFiles = edogFiles;

    if (!allFiles.length) {
      main.innerHTML = this._renderEmptyClean('Working tree clean');
      listYour.innerHTML = '';
      listEdog.innerHTML = '';
      this._updateEdogSectionVisibility();
      return;
    }

    // Sidebar: build per-section markup. Index passed is the global index in allFiles.
    var youHtml = '';
    for (var yi = 0; yi < yourFiles.length; yi++) {
      var gIdx = allFiles.indexOf(yourFiles[yi]);
      youHtml += this._renderFileCard(yourFiles[yi], gIdx);
    }
    listYour.innerHTML = youHtml || '<div class="gd-side-empty">No non-EDOG changes</div>';
    var sideYourCount = document.getElementById('gd-side-your-count');
    if (sideYourCount) sideYourCount.textContent = yourFiles.length;

    var edogHtml = '';
    for (var ei = 0; ei < edogFiles.length; ei++) {
      var gIdx2 = allFiles.indexOf(edogFiles[ei]);
      edogHtml += this._renderFileCard(edogFiles[ei], gIdx2);
    }
    listEdog.innerHTML = edogHtml;
    var sideEdogCount = document.getElementById('gd-side-edog-count');
    if (sideEdogCount) sideEdogCount.textContent = edogFiles.length;

    // Main: per-file diff sections — render in two groups too so EDOG sections can be hidden as a block.
    var mainHtml = '<div class="gd-main-group gd-main-group-your" id="gd-main-your">';
    for (var j = 0; j < yourFiles.length; j++) {
      var gj = allFiles.indexOf(yourFiles[j]);
      mainHtml += this._renderFileDiffSection(yourFiles[j], gj);
    }
    mainHtml += '</div>';
    mainHtml += '<div class="gd-main-group gd-main-group-edog" id="gd-main-edog">';
    if (edogFiles.length) {
      mainHtml += '<div class="gd-edog-banner">EDOG-owned patches \u2014 these files implement EDOG itself. Use "Copy Clean" to exclude them from a shareable diff.</div>';
    }
    for (var k = 0; k < edogFiles.length; k++) {
      var gk = allFiles.indexOf(edogFiles[k]);
      mainHtml += this._renderFileDiffSection(edogFiles[k], gk);
    }
    mainHtml += '</div>';
    main.innerHTML = mainHtml;

    var self = this;

    // File card click → scroll + select
    var allCards = this._gitDiffEl.querySelectorAll('.gd-file-card');
    allCards.forEach(function(card) {
      card.addEventListener('click', function() {
        var idx = card.getAttribute('data-idx');
        allCards.forEach(function(c) { c.classList.remove('selected'); });
        card.classList.add('selected');
        var target = main.querySelector('.gd-file-section[data-idx="' + idx + '"]');
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        self._gitDiffActiveIdx = parseInt(idx, 10);
        self._gitDiffActiveHunkIdx = 0;
      });
    });

    // Collapse/expand sections
    main.querySelectorAll('.gd-file-section').forEach(function(section) {
      var hdr = section.querySelector('.gd-file-section-header');
      var caret = hdr.querySelector('.gd-caret');
      hdr.addEventListener('click', function(e) {
        if (e.target.closest('.gd-file-copy-btn')) return;
        section.classList.toggle('collapsed');
        if (caret) caret.textContent = section.classList.contains('collapsed') ? '\u25B8' : '\u25BE';
      });
      var copyBtn = section.querySelector('.gd-file-copy-btn');
      if (copyBtn) {
        copyBtn.addEventListener('click', function(e) {
          e.stopPropagation();
          var idx = parseInt(section.getAttribute('data-idx'), 10);
          self._copyFileDiff(idx, copyBtn);
        });
      }
    });

    // IntersectionObserver for scrolling
    if ('IntersectionObserver' in window) {
      if (this._gitDiffObserver) { try { this._gitDiffObserver.disconnect(); } catch (_e) {} }
      var sections = main.querySelectorAll('.gd-file-section');
      var io = new IntersectionObserver(function(entries) {
        entries.forEach(function(entry) {
          if (entry.isIntersecting && entry.intersectionRatio > 0.25) {
            var idx = entry.target.getAttribute('data-idx');
            self._gitDiffEl.querySelectorAll('.gd-file-card').forEach(function(c) {
              c.classList.toggle('active', c.getAttribute('data-idx') === idx);
            });
            self._gitDiffActiveIdx = parseInt(idx, 10);
          }
        });
      }, { root: main, threshold: [0.25, 0.6] });
      sections.forEach(function(s) { io.observe(s); });
      this._gitDiffObserver = io;
    }

    this._updateEdogSectionVisibility();
    if (this._gitDiffSplitView) this._applySplitViewClass();
    if (this._gitDiffSearchTerm) this._applyGitDiffSearch();
    this._installBlameHover(main);
  }

  // ── Blame on hover ───────────────────────────────────────────
  _installBlameHover(main) {
    if (!main) return;
    var self = this;
    if (this._blameHoverInstalled === main) return;
    this._blameHoverInstalled = main;
    this._blameCache = this._blameCache || {};
    this._blameInflight = this._blameInflight || {};

    var ensureTooltip = function() {
      var tip = document.getElementById('gd-blame-tip');
      if (tip) return tip;
      tip = document.createElement('div');
      tip.id = 'gd-blame-tip';
      tip.className = 'gd-blame-tip';
      tip.setAttribute('role', 'tooltip');
      tip.innerHTML =
        '<span class="gd-blame-author"></span>' +
        '<span class="gd-blame-sep">\u00B7</span>' +
        '<span class="gd-blame-time"></span>' +
        '<span class="gd-blame-sep">\u00B7</span>' +
        '<span class="gd-blame-hash"></span>' +
        '<span class="gd-blame-sep">\u00B7</span>' +
        '<span class="gd-blame-msg"></span>';
      self._gitDiffEl.appendChild(tip);
      return tip;
    };

    var hideTip = function() {
      var tip = document.getElementById('gd-blame-tip');
      if (tip) tip.classList.remove('show');
    };

    var showTipFor = function(row, info) {
      if (!info) return;
      var tip = ensureTooltip();
      tip.querySelector('.gd-blame-author').textContent = info.author || 'unknown';
      tip.querySelector('.gd-blame-time').textContent = info.timeAgo || '';
      tip.querySelector('.gd-blame-hash').textContent = info.hash || '';
      var msg = info.summary || '';
      if (msg.length > 60) msg = msg.slice(0, 57) + '\u2026';
      tip.querySelector('.gd-blame-msg').textContent = msg ? '"' + msg + '"' : '';
      // Position above the row, clamped to modal bounds.
      var rowRect = row.getBoundingClientRect();
      var modalRect = self._gitDiffEl.getBoundingClientRect();
      tip.style.visibility = 'hidden';
      tip.classList.add('show');
      var tipRect = tip.getBoundingClientRect();
      var top = rowRect.top - modalRect.top - tipRect.height - 6;
      if (top < 6) top = rowRect.bottom - modalRect.top + 6;
      var left = rowRect.left - modalRect.left + 24;
      var maxLeft = modalRect.width - tipRect.width - 12;
      if (left > maxLeft) left = Math.max(8, maxLeft);
      tip.style.top = top + 'px';
      tip.style.left = left + 'px';
      tip.style.visibility = '';
    };

    var fetchBlame = async function(filePath, lineNum, row) {
      var cacheKey = filePath + '\u0000' + lineNum;
      if (self._blameCache[cacheKey]) {
        if (self._blameHoverRow === row) showTipFor(row, self._blameCache[cacheKey]);
        return;
      }
      var fileKey = 'F:' + filePath;
      if (!self._blameInflight[fileKey]) {
        self._blameInflight[fileKey] = (async function() {
          try {
            var resp = await fetch('/api/edog/git-blame?file=' + encodeURIComponent(filePath));
            if (!resp.ok) return {};
            var data = await resp.json();
            return (data && data.lines) || {};
          } catch (_e) { return {}; }
        })();
      }
      var lines = await self._blameInflight[fileKey];
      // Cache per line for fast subsequent hovers.
      Object.keys(lines).forEach(function(k) {
        self._blameCache[filePath + '\u0000' + k] = lines[k];
      });
      delete self._blameInflight[fileKey];
      var info = self._blameCache[cacheKey];
      if (info && self._blameHoverRow === row) showTipFor(row, info);
    };

    var onEnter = function(e) {
      var row = e.target.closest('[data-newnum]');
      if (!row || !main.contains(row)) return;
      var section = row.closest('.gd-file-section');
      if (!section) return;
      var filePath = section.getAttribute('data-path');
      // Untracked / new files have no committed blame yet.
      if (section.querySelector('.gd-source-untracked')) return;
      var lineNum = parseInt(row.getAttribute('data-newnum'), 10);
      if (!filePath || !lineNum) return;
      self._blameHoverRow = row;
      if (self._blameHoverTimer) clearTimeout(self._blameHoverTimer);
      self._blameHoverTimer = setTimeout(function() {
        if (self._blameHoverRow !== row) return;
        fetchBlame(filePath, lineNum, row);
      }, 300);
    };

    var onLeave = function(e) {
      var row = e.target.closest('[data-newnum]');
      if (!row) return;
      // Only hide if leaving to outside the row.
      var to = e.relatedTarget;
      if (to && row.contains(to)) return;
      if (self._blameHoverRow === row) self._blameHoverRow = null;
      if (self._blameHoverTimer) { clearTimeout(self._blameHoverTimer); self._blameHoverTimer = null; }
      hideTip();
    };

    main.addEventListener('mouseover', onEnter);
    main.addEventListener('mouseout', onLeave);
    main.addEventListener('scroll', hideTip, { passive: true });
  }

  // ── Save .patch download ─────────────────────────────────────
  async _saveGitDiffPatch() {
    var data = this._gitDiffData;
    if (!data || !data.valid) {
      this._gdToast('No diff to export');
      return;
    }
    var parts = [];
    if ((data.stagedDiff || '').trim()) parts.push(data.stagedDiff);
    if ((data.diff || '').trim()) parts.push(data.diff);
    var diffBody = parts.join('\n');
    if (!diffBody.trim()) {
      this._gdToast('Working tree clean \u2014 nothing to export');
      return;
    }

    // Fetch identity for the From: header (best-effort).
    var identity = { machine: '', osUser: '' };
    try {
      var r = await fetch('/api/identity');
      if (r.ok) identity = await r.json();
    } catch (_e) { /* ignore */ }

    var branch = data.branch || 'detached';
    var dateObj = new Date();
    var iso = dateObj.toISOString();
    var dateStamp = iso.slice(0, 10);
    var rfc = dateObj.toUTCString();
    var author = (identity.osUser || 'edog') + '@' + (identity.machine || 'localhost');
    var subject = 'EDOG Studio diff export from ' + branch;

    // Construct a git-mailbox-style patch that `git apply` and `git am` both accept.
    var header =
      'From 0000000000000000000000000000000000000000 ' + rfc + '\n' +
      'From: ' + author + '\n' +
      'Date: ' + rfc + '\n' +
      'Subject: [PATCH] ' + subject + '\n' +
      '\n' +
      'Generated by EDOG Studio on ' + iso + '\n' +
      'Branch: ' + branch + '\n' +
      '---\n\n';

    var patch = header + diffBody;
    if (!patch.endsWith('\n')) patch += '\n';

    var safeBranch = branch.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'branch';
    var filename = 'edog-changes-' + safeBranch + '-' + dateStamp + '.patch';

    try {
      var blob = new Blob([patch], { type: 'text/x-patch;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      setTimeout(function() {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 0);
      this._gdToast('Saved ' + filename);
    } catch (e) {
      this._gdToast('Save failed: ' + (e && e.message || e));
    }
  }

  _updateStatsBar(yourFiles, yourAdds, yourDels, edogCount) {
    var f = document.getElementById('gd-stat-your-files-n');
    var a = document.getElementById('gd-stat-your-add-n');
    var d = document.getElementById('gd-stat-your-del-n');
    var ef = document.getElementById('gd-stat-edog-files-n');
    var vis = document.getElementById('gd-stat-edog-vis');
    var divider = document.getElementById('gd-stat-divider');
    var edogWrap = document.getElementById('gd-stat-edog');
    if (f) f.textContent = yourFiles;
    if (a) a.textContent = yourAdds;
    if (d) d.textContent = yourDels;
    if (ef) ef.textContent = edogCount || 0;
    if (vis) vis.textContent = this._gitDiffShowEdog ? '(shown)' : '(hidden)';
    var hasEdog = (edogCount || 0) > 0;
    if (edogWrap) edogWrap.style.display = hasEdog ? '' : 'none';
    if (divider) divider.style.display = hasEdog ? '' : 'none';
  }

  _updateEdogSectionVisibility() {
    var show = !!this._gitDiffShowEdog;
    var sideEdog = document.getElementById('gd-side-edog');
    var mainEdog = document.getElementById('gd-main-edog');
    var hasEdog = (this._gitDiffEdogFiles && this._gitDiffEdogFiles.length) > 0;
    if (sideEdog) {
      if (!hasEdog) { sideEdog.hidden = true; }
      else { sideEdog.hidden = !show; }
    }
    if (mainEdog) mainEdog.style.display = (show && hasEdog) ? '' : 'none';
    var btn = document.getElementById('gd-toggle-edog');
    var label = document.getElementById('gd-toggle-edog-label');
    if (btn) {
      btn.setAttribute('aria-pressed', show ? 'true' : 'false');
      btn.classList.toggle('active', show);
    }
    if (label) label.textContent = show ? 'Hide EDOG' : 'Show EDOG';
    var vis = document.getElementById('gd-stat-edog-vis');
    if (vis) vis.textContent = show ? '(shown)' : '(hidden)';
  }

  _toggleEdogVisibility() {
    this._gitDiffShowEdog = !this._gitDiffShowEdog;
    this._updateEdogSectionVisibility();
  }

  _renderFileCard(file, idx) {
    var parts = file.path.split('/');
    var name = parts.pop();
    var dir = parts.join('/');
    var statusInfo = this._fileStatusInfo(file);
    var srcChip = file.source === 'staged'
      ? '<span class="gd-src-chip gd-src-staged" title="Staged">S</span>'
      : (file.source === 'untracked'
          ? '<span class="gd-src-chip gd-src-untracked" title="Untracked">U</span>'
          : '');
    var binary = file.isBinary ? '<span class="gd-binary-tag">binary</span>' : '';
    var edogTag = file.isEdog ? '<span class="gd-card-edog-tag" title="EDOG-owned patch">EDOG</span>' : '';

    var hasNumbers = (file.additions + file.deletions) > 0;
    var addPct = hasNumbers ? Math.round((file.additions / (file.additions + file.deletions)) * 100) : 0;
    var delPct = hasNumbers ? 100 - addPct : 0;
    var bar = hasNumbers
      ? '<div class="gd-card-bar"><span class="gd-bar-add" style="width:' + addPct + '%"></span><span class="gd-bar-del" style="width:' + delPct + '%"></span></div>'
      : '<div class="gd-card-bar gd-card-bar-empty"></div>';

    // Heatmap: 14 blocks, proportional to add/del counts (clamped). Visual at-a-glance churn.
    var heat = this._renderCardHeatmap(file.additions, file.deletions);

    var delay = Math.min(idx, 14) * 28;
    var cls = 'gd-file-card' + (file.isEdog ? ' gd-file-card-edog' : '');
    return '<button class="' + cls + '" data-idx="' + idx + '" data-path="' + this._escTip(file.path) + '" style="animation-delay:' + delay + 'ms">' +
      '<span class="gd-status gd-status-' + statusInfo.cls + '" title="' + statusInfo.label + '">' + statusInfo.glyph + '</span>' +
      '<span class="gd-card-text">' +
        '<span class="gd-card-name">' + this._escTip(name) + (binary ? ' ' + binary : '') + edogTag + '</span>' +
        (dir ? '<span class="gd-card-dir">' + this._escTip(dir) + '</span>' : '') +
        bar +
        heat +
      '</span>' +
      '<span class="gd-card-meta">' +
        srcChip +
        (file.additions ? '<span class="gd-card-add">+' + file.additions + '</span>' : '') +
        (file.deletions ? '<span class="gd-card-del">\u2212' + file.deletions + '</span>' : '') +
      '</span>' +
    '</button>';
  }

  _renderCardHeatmap(adds, dels) {
    var total = adds + dels;
    if (!total) return '<div class="gd-heatmap gd-heatmap-empty" aria-hidden="true"></div>';
    var slots = 14;
    var addBlocks = Math.max(adds > 0 ? 1 : 0, Math.round((adds / total) * slots));
    var delBlocks = Math.max(dels > 0 ? 1 : 0, slots - addBlocks);
    // Re-normalize if we over-allocated
    if (addBlocks + delBlocks > slots) {
      if (adds >= dels) delBlocks = slots - addBlocks;
      else addBlocks = slots - delBlocks;
    }
    var html = '<div class="gd-heatmap" title="' + adds + ' added, ' + dels + ' removed" aria-hidden="true">';
    for (var i = 0; i < addBlocks; i++) html += '<span class="gd-heat-add"></span>';
    for (var j = 0; j < delBlocks; j++) html += '<span class="gd-heat-del"></span>';
    html += '</div>';
    return html;
  }

  _renderFileDiffSection(file, idx) {
    var statusInfo = this._fileStatusInfo(file);
    var sourceTag = file.source === 'staged'
      ? '<span class="gd-source-tag gd-source-staged">STAGED</span>'
      : (file.source === 'untracked'
          ? '<span class="gd-source-tag gd-source-untracked">UNTRACKED</span>'
          : '<span class="gd-source-tag gd-source-unstaged">UNSTAGED</span>');
    var edogTag = file.isEdog
      ? '<span class="gd-source-tag gd-source-edog" title="EDOG-owned patch">EDOG</span>'
      : '';

    var headerCounts = '';
    if (file.additions) headerCounts += '<span class="gd-h-add">+' + file.additions + '</span>';
    if (file.deletions) headerCounts += '<span class="gd-h-del">\u2212' + file.deletions + '</span>';

    var body;
    if (file.isBinary) {
      body = '<div class="gd-binary-note">Binary file \u2014 no textual diff.</div>';
    } else if (!file.hunks.length) {
      if (file.source === 'untracked') {
        body = '<div class="gd-binary-note gd-untracked-note">Untracked file. Run <code>git add</code> to view its contents in a diff.</div>';
      } else {
        body = '<div class="gd-binary-note">No content changes (mode/rename only).</div>';
      }
    } else if (this._gitDiffSplitView) {
      body = this._renderSplitDiff(file);
    } else {
      var hunksHtml = '';
      for (var i = 0; i < file.hunks.length; i++) {
        hunksHtml += this._renderHunk(file.hunks[i], file);
      }
      body = '<div class="gd-hunks">' + hunksHtml + '</div>';
    }

    var sectionCls = 'gd-file-section' + (file.isEdog ? ' gd-file-section-edog' : '');
    return '<section class="' + sectionCls + '" data-idx="' + idx + '" data-path="' + this._escTip(file.path) + '"' + (file.isEdog ? ' data-edog="1"' : '') + '>' +
      '<header class="gd-file-section-header">' +
        '<span class="gd-caret">\u25BE</span>' +
        '<span class="gd-status gd-status-' + statusInfo.cls + '">' + statusInfo.glyph + '</span>' +
        '<span class="gd-file-path">' +
          '<svg class="gd-file-icon" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M3 1.5h6l4 4V14a.5.5 0 01-.5.5H3A.5.5 0 012.5 14V2A.5.5 0 013 1.5z"/><path d="M9 1.5V5a.5.5 0 00.5.5H13"/></svg>' +
          '<span class="gd-file-path-text">' + this._escTip(file.path) + '</span>' +
        '</span>' +
        edogTag +
        sourceTag +
        '<span class="gd-h-counts">' + headerCounts + '</span>' +
        '<button class="gd-file-copy-btn" title="Copy this file\'s diff">' +
          '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="4.5" y="4.5" width="9" height="9" rx="1.5"/><path d="M11.5 4.5V3a1.5 1.5 0 00-1.5-1.5H3A1.5 1.5 0 001.5 3v7A1.5 1.5 0 003 11.5h1.5"/></svg>' +
        '</button>' +
      '</header>' +
      '<div class="gd-file-section-body">' + body + '</div>' +
    '</section>';
  }

  // ── EDOG annotation pattern map ──────────────────────────────
  _edogAnnotations() {
    return [
      { rx: /EdogDevModeRegistrar\.?RegisterAll/, label: 'DevMode registration' },
      { rx: /EdogDevModeRegistrar/, label: 'DevMode registrar' },
      { rx: /EdogLogServer/, label: 'Log server startup' },
      { rx: /MapHub.*EdogPlayground|EdogPlaygroundHub/, label: 'SignalR hub' },
      { rx: /DisableFLTAuth|DisableAuth/, label: 'Auth bypass' },
      { rx: /EdogDagExecutionHook|EdogDagExecution/, label: 'DAG execution hook' },
      { rx: /EdogSparkClientWrapper|EdogSparkSession/, label: 'Spark client wrapper' },
      { rx: /EdogTokenInterceptor|EdogTokenLifecycle/, label: 'Token interceptor' },
      { rx: /EdogHttpPipelineHandler|EdogHttpFault/, label: 'HTTP pipeline' },
      { rx: /EdogFeatureFlighter|EdogFeatureOverride/, label: 'Feature flag override' },
      { rx: /EdogTelemetryInterceptor/, label: 'Telemetry interceptor (SSR)' },
      { rx: /EdogAdditionalTelemetryInterceptor/, label: 'Telemetry interceptor (Additional)' },
      { rx: /EdogWorkloadCommunicationProviderWrapper/, label: 'MWC HTTP capture (GTS/Notebook/Trident)' },
      { rx: /EdogFileSystemInterceptor/, label: 'Filesystem interceptor' },
      { rx: /EdogRetryInterceptor|EdogCacheInterceptor/, label: 'Retry/cache' },
      { rx: /EdogQa[A-Z]\w+/, label: 'QA harness' },
      { rx: /\[EDOG\]|\/\/\s*EDOG:/, label: 'EDOG marker' },
      { rx: /DevMode/, label: 'DevMode hook' },
    ];
  }

  _edogLabelFor(text) {
    if (!text) return '';
    var patterns = this._edogAnnotationsCached || (this._edogAnnotationsCached = this._edogAnnotations());
    for (var i = 0; i < patterns.length; i++) {
      if (patterns[i].rx.test(text)) return patterns[i].label;
    }
    return '';
  }

  _renderHunk(hunk, file) {
    var annotateEdog = !!(file && file.isEdog);
    var ctx = hunk.context ? '<span class="gd-hunk-ctx">' + this._escTip(hunk.context) + '</span>' : '';
    var rows = '';
    for (var i = 0; i < hunk.lines.length; i++) {
      var ln = hunk.lines[i];
      var cls, sign;
      if (ln.type === '+') { cls = 'gd-row gd-row-add'; sign = '+'; }
      else if (ln.type === '-') { cls = 'gd-row gd-row-del'; sign = '\u2212'; }
      else if (ln.type === '\\') { cls = 'gd-row gd-row-meta'; sign = ''; }
      else { cls = 'gd-row gd-row-ctx'; sign = ''; }

      var oldN = ln.oldNum != null ? ln.oldNum : '';
      var newN = ln.newNum != null ? ln.newNum : '';
      var annot = '';
      if (annotateEdog && (ln.type === '+' || ln.type === '-')) {
        var label = this._edogLabelFor(ln.text);
        if (label) annot = '<span class="gd-edog-label" title="EDOG: ' + this._escTip(label) + '">\u2190 EDOG: ' + this._escTip(label) + '</span>';
      }
      var blameAttr = (ln.newNum != null && ln.type !== '\\') ? ' data-newnum="' + ln.newNum + '"' : '';
      rows +=
        '<div class="' + cls + '"' + blameAttr + '>' +
          '<span class="gd-gutter gd-gutter-old">' + oldN + '</span>' +
          '<span class="gd-gutter gd-gutter-new">' + newN + '</span>' +
          '<span class="gd-sign">' + sign + '</span>' +
          '<span class="gd-code">' + this._escTip(ln.text) + annot + '</span>' +
        '</div>';
    }
    return '<div class="gd-hunk">' +
      '<div class="gd-hunk-header">' +
        '<span class="gd-hunk-range">@@ \u2212' + hunk.oldStart + ' +' + hunk.newStart + ' @@</span>' +
        ctx +
      '</div>' +
      '<div class="gd-hunk-body">' + rows + '</div>' +
    '</div>';
  }

  // ── Split view rendering ─────────────────────────────────────
  _renderSplitDiff(file) {
    var self = this;
    var html = '<div class="gd-hunks gd-hunks-split">';
    for (var h = 0; h < file.hunks.length; h++) {
      var hunk = file.hunks[h];
      html += '<div class="gd-hunk gd-hunk-split">' +
        '<div class="gd-hunk-header">' +
          '<span class="gd-hunk-range">@@ \u2212' + hunk.oldStart + ' +' + hunk.newStart + ' @@</span>' +
          (hunk.context ? '<span class="gd-hunk-ctx">' + this._escTip(hunk.context) + '</span>' : '') +
        '</div>' +
        '<div class="gd-hunk-body gd-split-body">';
      // Pair lines: walk through, batching consecutive del/add pairs.
      var lines = hunk.lines;
      var i = 0;
      while (i < lines.length) {
        var ln = lines[i];
        if (ln.type === ' ' || ln.type === '\\') {
          html += self._renderSplitRow(ln, ln, file);
          i++;
          continue;
        }
        // Collect a chunk of consecutive '-' followed by '+'
        var dels = [];
        var adds = [];
        while (i < lines.length && lines[i].type === '-') { dels.push(lines[i]); i++; }
        while (i < lines.length && lines[i].type === '+') { adds.push(lines[i]); i++; }
        var maxLen = Math.max(dels.length, adds.length);
        for (var k = 0; k < maxLen; k++) {
          html += self._renderSplitRow(dels[k] || null, adds[k] || null, file);
        }
      }
      html += '</div></div>';
    }
    html += '</div>';
    return html;
  }

  _renderSplitRow(left, right, file) {
    var annotateEdog = !!(file && file.isEdog);
    var renderSide = function(self, ln, side) {
      if (!ln) {
        return '<div class="gd-split-cell gd-split-empty">' +
          '<span class="gd-gutter"></span><span class="gd-sign"></span><span class="gd-code"></span>' +
          '</div>';
      }
      var cls = 'gd-split-cell';
      var sign = '';
      var num = '';
      if (ln.type === '+') { cls += ' gd-row-add'; sign = '+'; num = ln.newNum != null ? ln.newNum : ''; }
      else if (ln.type === '-') { cls += ' gd-row-del'; sign = '\u2212'; num = ln.oldNum != null ? ln.oldNum : ''; }
      else if (ln.type === '\\') { cls += ' gd-row-meta'; sign = ''; num = ''; }
      else { cls += ' gd-row-ctx'; sign = ''; num = side === 'L' ? (ln.oldNum != null ? ln.oldNum : '') : (ln.newNum != null ? ln.newNum : ''); }
      var annot = '';
      if (annotateEdog && (ln.type === '+' || ln.type === '-')) {
        var label = self._edogLabelFor(ln.text);
        if (label) annot = '<span class="gd-edog-label" title="EDOG: ' + self._escTip(label) + '">\u2190 ' + self._escTip(label) + '</span>';
      }
      return '<div class="' + cls + '">' +
        '<span class="gd-gutter">' + num + '</span>' +
        '<span class="gd-sign">' + sign + '</span>' +
        '<span class="gd-code">' + self._escTip(ln.text) + annot + '</span>' +
        '</div>';
    };
    return '<div class="gd-split-row"' + (right && right.newNum != null ? ' data-newnum="' + right.newNum + '"' : '') + '>' +
      renderSide(this, left, 'L') +
      renderSide(this, right, 'R') +
      '</div>';
  }

  _applySplitViewClass() {
    if (!this._gitDiffEl) return;
    this._gitDiffEl.classList.toggle('gd-split-mode', !!this._gitDiffSplitView);
    var btn = document.getElementById('gd-toggle-split');
    var label = document.getElementById('gd-toggle-split-label');
    if (btn) {
      btn.setAttribute('aria-pressed', this._gitDiffSplitView ? 'true' : 'false');
      btn.classList.toggle('active', !!this._gitDiffSplitView);
    }
    if (label) label.textContent = this._gitDiffSplitView ? 'Unified' : 'Split';
  }

  _toggleSplitView() {
    this._gitDiffSplitView = !this._gitDiffSplitView;
    // Re-render the diff body of all sections so split/unified switches.
    if (this._gitDiffData) this._renderGitDiff(this._gitDiffData);
    this._applySplitViewClass();
  }

  _fileStatusInfo(file) {
    if (file.isRename) return { cls: 'r', glyph: 'R', label: 'Renamed' };
    if (file.isNew && file.source === 'untracked') return { cls: 'u', glyph: '?', label: 'Untracked' };
    if (file.isNew) return { cls: 'a', glyph: 'A', label: 'Added' };
    if (file.isDeleted) return { cls: 'd', glyph: 'D', label: 'Deleted' };
    return { cls: 'm', glyph: 'M', label: 'Modified' };
  }

  _renderEmptyClean(message) {
    return '<div class="gd-empty-clean">' +
      '<div class="gd-check-circle">' +
        '<svg width="36" height="36" viewBox="0 0 36 36" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">' +
          '<circle cx="18" cy="18" r="15" class="gd-check-ring"/>' +
          '<path d="M11 18.5l5 5 9-10" class="gd-check-tick"/>' +
        '</svg>' +
      '</div>' +
      '<div class="gd-empty-title">' + this._escTip(message || 'Working tree clean') + '</div>' +
      '<div class="gd-empty-sub">Nothing to commit.</div>' +
    '</div>';
  }

  _applyGitDiffSearch() {
    var main = document.getElementById('gd-main');
    var countEl = document.getElementById('gd-search-count');
    if (!main) return;
    var term = (this._gitDiffSearchTerm || '').trim();
    var rows = main.querySelectorAll('.gd-row');
    var matchCount = 0;

    if (!term) {
      rows.forEach(function(r) {
        r.classList.remove('gd-match', 'gd-dim');
        var code = r.querySelector('.gd-code');
        if (code && code.dataset.original != null) {
          code.innerHTML = code.dataset.original;
          delete code.dataset.original;
        }
      });
      if (countEl) countEl.textContent = '';
      main.querySelectorAll('.gd-file-section').forEach(function(s) { s.classList.remove('gd-no-match'); });
      return;
    }

    var termLower = term.toLowerCase();
    var rx;
    try {
      rx = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    } catch (_e) {
      rx = null;
    }

    main.querySelectorAll('.gd-file-section').forEach(function(section) {
      var sectionMatches = 0;
      section.querySelectorAll('.gd-row').forEach(function(r) {
        var code = r.querySelector('.gd-code');
        if (!code) return;
        if (code.dataset.original == null) code.dataset.original = code.innerHTML;
        var text = code.textContent || '';
        if (text.toLowerCase().indexOf(termLower) !== -1) {
          r.classList.add('gd-match'); r.classList.remove('gd-dim');
          sectionMatches++;
          matchCount++;
          if (rx) {
            // Highlight matches inside the (already-escaped) original.
            var escapedTerm = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            var hlRx = new RegExp('(' + escapedTerm + ')', 'gi');
            code.innerHTML = code.dataset.original.replace(hlRx, '<mark class="gd-hl">$1</mark>');
          }
        } else {
          r.classList.remove('gd-match'); r.classList.add('gd-dim');
          code.innerHTML = code.dataset.original;
        }
      });
      section.classList.toggle('gd-no-match', sectionMatches === 0);
    });

    if (countEl) countEl.textContent = matchCount + (matchCount === 1 ? ' match' : ' matches');
  }

  async _copyGitDiff() {
    var data = this._gitDiffData;
    if (!data) return;
    var parts = [];
    if ((data.stagedDiff || '').trim()) parts.push(data.stagedDiff);
    if ((data.diff || '').trim()) parts.push(data.diff);
    var text = parts.join('\n');
    var btn = document.getElementById('gd-copy-btn');
    var label = btn ? btn.querySelector('.gd-btn-label') : null;
    try {
      await navigator.clipboard.writeText(text);
      if (label) {
        var orig = label.textContent;
        label.textContent = 'Copied';
        btn.classList.add('copied');
        setTimeout(function() {
          label.textContent = orig;
          btn.classList.remove('copied');
        }, 1400);
      }
    } catch (_e) {
      if (label) label.textContent = 'Copy failed';
    }
  }

  async _copyFileDiff(idx, btn) {
    var file = this._gitDiffParsed && this._gitDiffParsed[idx];
    if (!file) return;
    // Reconstruct unified diff for this file from the parsed structure.
    var out = ['diff --git a/' + file.oldPath + ' b/' + file.newPath];
    if (file.isNew) out.push('new file');
    if (file.isDeleted) out.push('deleted file');
    out.push('--- ' + (file.isNew ? '/dev/null' : 'a/' + file.oldPath));
    out.push('+++ ' + (file.isDeleted ? '/dev/null' : 'b/' + file.newPath));
    for (var i = 0; i < file.hunks.length; i++) {
      var h = file.hunks[i];
      out.push(h.header);
      for (var j = 0; j < h.lines.length; j++) {
        var l = h.lines[j];
        if (l.type === '\\') out.push(l.text);
        else if (l.type === ' ') out.push(' ' + l.text);
        else out.push(l.type + l.text);
      }
    }
    var text = out.join('\n');
    try {
      await navigator.clipboard.writeText(text);
      if (btn) {
        btn.classList.add('copied');
        setTimeout(function() { btn.classList.remove('copied'); }, 1200);
      }
    } catch (_e) { /* ignore */ }
  }

  // ── Keyboard navigation ──────────────────────────────────────
  _visibleSectionList() {
    if (!this._gitDiffEl) return [];
    var sections = this._gitDiffEl.querySelectorAll('.gd-file-section');
    var out = [];
    sections.forEach(function(s) {
      var parent = s.closest('.gd-main-group');
      if (parent && parent.style.display === 'none') return;
      out.push(s);
    });
    return out;
  }

  _gdNavFile(delta) {
    var sections = this._visibleSectionList();
    if (!sections.length) return;
    var indices = sections.map(function(s) { return parseInt(s.getAttribute('data-idx'), 10); });
    var current = this._gitDiffActiveIdx;
    var pos = indices.indexOf(current);
    if (pos < 0) pos = 0;
    var next = Math.max(0, Math.min(indices.length - 1, pos + delta));
    var nextIdx = indices[next];
    var section = sections[next];
    if (section) section.scrollIntoView({ behavior: 'smooth', block: 'start' });
    this._gitDiffActiveIdx = nextIdx;
    this._gitDiffActiveHunkIdx = 0;
    this._gitDiffEl.querySelectorAll('.gd-file-card').forEach(function(c) {
      c.classList.toggle('selected', parseInt(c.getAttribute('data-idx'), 10) === nextIdx);
    });
  }

  _gdNavHunk(delta) {
    if (!this._gitDiffEl) return;
    var section = this._gitDiffEl.querySelector('.gd-file-section[data-idx="' + this._gitDiffActiveIdx + '"]');
    if (!section) return;
    var hunks = section.querySelectorAll('.gd-hunk');
    if (!hunks.length) return;
    var idx = (this._gitDiffActiveHunkIdx || 0) + delta;
    idx = Math.max(0, Math.min(hunks.length - 1, idx));
    this._gitDiffActiveHunkIdx = idx;
    hunks[idx].scrollIntoView({ behavior: 'smooth', block: 'start' });
    hunks.forEach(function(h, i) { h.classList.toggle('gd-hunk-focus', i === idx); });
  }

  _gdToggleCurrentFile() {
    if (!this._gitDiffEl) return;
    var section = this._gitDiffEl.querySelector('.gd-file-section[data-idx="' + this._gitDiffActiveIdx + '"]');
    if (!section) return;
    section.classList.toggle('collapsed');
    var caret = section.querySelector('.gd-caret');
    if (caret) caret.textContent = section.classList.contains('collapsed') ? '\u25B8' : '\u25BE';
  }

  // ── Help overlay ─────────────────────────────────────────────
  _toggleGdHelp(force) {
    var open = (typeof force === 'boolean') ? force : !this._gitDiffHelpOpen;
    this._gitDiffHelpOpen = open;
    var existing = document.getElementById('gd-help-overlay');
    if (!open) {
      if (existing) existing.remove();
      return;
    }
    if (existing) return;
    var rows = [
      ['j / k', 'Next / previous file'],
      ['n / p', 'Next / previous hunk'],
      ['c',     'Collapse / expand current file'],
      ['e',     'Toggle EDOG visibility'],
      ['s',     'Toggle split / unified'],
      ['\u2318/Ctrl + F', 'Focus search'],
      ['?',     'Show this help'],
      ['Esc',   'Close modal / clear search / close help'],
    ];
    var rowsHtml = rows.map(function(r) {
      return '<div class="gd-help-row"><kbd class="gd-kbd">' + r[0] + '</kbd><span class="gd-help-desc">' + r[1] + '</span></div>';
    }).join('');
    var ov = document.createElement('div');
    ov.id = 'gd-help-overlay';
    ov.className = 'gd-help-overlay';
    ov.innerHTML =
      '<div class="gd-help-card" role="dialog" aria-label="Keyboard shortcuts">' +
        '<div class="gd-help-header">' +
          '<span class="gd-help-title">Keyboard Shortcuts</span>' +
          '<button class="gd-help-close" aria-label="Close">\u2715</button>' +
        '</div>' +
        '<div class="gd-help-body">' + rowsHtml + '</div>' +
      '</div>';
    this._gitDiffEl.appendChild(ov);
    var self = this;
    ov.addEventListener('click', function(e) {
      if (e.target === ov || e.target.classList.contains('gd-help-close')) {
        self._toggleGdHelp(false);
      }
    });
  }

  // ── Toast ────────────────────────────────────────────────────
  _gdToast(message) {
    if (!this._gitDiffEl) return;
    var t = document.createElement('div');
    t.className = 'gd-toast';
    t.textContent = message;
    this._gitDiffEl.appendChild(t);
    requestAnimationFrame(function() { t.classList.add('show'); });
    setTimeout(function() {
      t.classList.remove('show');
      setTimeout(function() { if (t.parentNode) t.parentNode.removeChild(t); }, 240);
    }, 1800);
  }

  // ── Copy clean (EDOG-stripped) diff ──────────────────────────
  async _copyCleanGitDiff() {
    var files = (this._gitDiffYourFiles || []).filter(function(f) {
      return f.source !== 'untracked' && f.hunks && f.hunks.length;
    });
    if (!files.length) {
      this._gdToast('No non-EDOG diff content to copy');
      return;
    }
    var out = [];
    for (var i = 0; i < files.length; i++) {
      var file = files[i];
      out.push('diff --git a/' + file.oldPath + ' b/' + file.newPath);
      if (file.isNew) out.push('new file');
      if (file.isDeleted) out.push('deleted file');
      out.push('--- ' + (file.isNew ? '/dev/null' : 'a/' + file.oldPath));
      out.push('+++ ' + (file.isDeleted ? '/dev/null' : 'b/' + file.newPath));
      for (var h = 0; h < file.hunks.length; h++) {
        var hunk = file.hunks[h];
        out.push(hunk.header);
        for (var k = 0; k < hunk.lines.length; k++) {
          var l = hunk.lines[k];
          if (l.type === '\\') out.push(l.text);
          else if (l.type === ' ') out.push(' ' + l.text);
          else out.push(l.type + l.text);
        }
      }
    }
    var text = out.join('\n') + '\n';
    var edogCount = (this._gitDiffEdogFiles || []).length;
    try {
      await navigator.clipboard.writeText(text);
      this._gdToast('Copied clean diff (' + files.length + ' file' + (files.length === 1 ? '' : 's') +
        (edogCount ? ', ' + edogCount + ' EDOG patch' + (edogCount === 1 ? '' : 'es') + ' excluded' : '') + ')');
    } catch (_e) {
      this._gdToast('Copy failed');
    }
  }

  destroy() {
    if (this._tokenTimer) clearInterval(this._tokenTimer);
    if (this._uptimeTimer) clearInterval(this._uptimeTimer);
  }
}
