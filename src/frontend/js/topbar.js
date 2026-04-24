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

      // Sync sidebar phase and WebSocket port from studio state
      if (window.edogSidebar) {
        if (config.studioPhase === 'running') {
          window.edogSidebar.setPhase('connected');
        } else if (config.studioPhase === 'idle' || config.studioPhase === 'stopped') {
          window.edogSidebar.setPhase('disconnected');
        }
      }
      if (config.fltPort && config.studioPhase === 'running' && window.edogWs) {
        window.edogWs.setPort(config.fltPort);
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
      if (hasDirty && this._patchEl) this._patchEl.textContent = '+' + dirty + ' dirty';
    }
  }

  _updateSidebarDot(color) {
    if (!this._sidebarDot) return;
    this._sidebarDot.className = 'sidebar-token-dot' + (color ? ' ' + color : '');
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
    el.querySelector('#ti-close-btn').addEventListener('click', function() {
      self._closeInspector();
    });
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

    if (!this._inspectorTokens.length) {
      body.innerHTML = this._renderEmptyState();
      return;
    }

    if (this._inspectorView === 'decode' && this._decodeTarget) {
      this._renderDecodeView(body);
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
    if (!tok) return;

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
