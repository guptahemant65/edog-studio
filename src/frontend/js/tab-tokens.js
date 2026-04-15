/**
 * TokensTab v2 — EDOG Studio Tokens Internals View
 *
 * Deduped token cards keyed by (tokenType + audience). Each unique
 * combination gets ONE card that updates in-place with usage count,
 * latest endpoint, refresh count, and TTL countdown.
 *
 * Architecture:
 *   - Topic: 'token' via SignalR SubscribeToTopic streaming
 *   - Event shape: { tokenType, scheme, audience, expiryUtc, issuedUtc, httpClientName, endpoint }
 *   - Dedup key: resolvedType + audience
 *   - Security: Raw tokens NEVER sent. Only metadata + selected JWT claims.
 *
 * Pattern: constructor(containerEl, signalr) -> activate() -> deactivate()
 */
class TokensTab {
  constructor(containerEl, signalr) {
    this._container = containerEl;
    this._signalr = signalr;

    // ── State ──
    this._tokenMap = new Map();   // dedupKey -> token object
    this._rawEvents = [];         // raw event log (capped)
    this._selectedKey = null;
    this._kbIndex = -1;
    this._typeFilter = 'all';
    this._filterText = '';
    this._timelineMode = false;
    this._detailOpen = false;
    this._detailHeight = 340;
    this._tickTimer = null;
    this._isTicking = false;
    this._isActive = false;
    this._maxEvents = 500;

    // ── DOM refs ──
    this._searchInput = null;
    this._counterEl = null;
    this._pillsEl = null;
    this._timelineBtn = null;
    this._exportBtn = null;
    this._exportDropdown = null;
    this._cardsEl = null;
    this._timelineEl = null;
    this._detailEl = null;
    this._detailTitle = null;
    this._detailAud = null;
    this._detailBody = null;
    this._tooltipEl = null;

    // ── SVG ring constants ──
    this._RING_R = 18;
    this._RING_C = 2 * Math.PI * this._RING_R;

    // ── Token type resolution table ──
    this._TYPE_TABLE = {
      'bearer':           { key: 'bearer',  label: 'Bearer',  color: 'var(--tok-bearer)',  dim: 'var(--tok-bearer-dim)' },
      'mwcv1':            { key: 'mwc',     label: 'MWC',     color: 'var(--tok-mwc)',     dim: 'var(--tok-mwc-dim)' },
      'mwc':              { key: 'mwc',     label: 'MWC',     color: 'var(--tok-mwc)',     dim: 'var(--tok-mwc-dim)' },
      's2s':              { key: 's2s',     label: 'S2S',     color: 'var(--tok-s2s)',     dim: 'var(--tok-s2s-dim)' },
      'servicetoservice': { key: 's2s',     label: 'S2S',     color: 'var(--tok-s2s)',     dim: 'var(--tok-s2s-dim)' },
      'onbehalfof':       { key: 'obo',     label: 'OBO',     color: 'var(--tok-obo)',     dim: 'var(--tok-obo-dim)' },
      'obo':              { key: 'obo',     label: 'OBO',     color: 'var(--tok-obo)',     dim: 'var(--tok-obo-dim)' }
    };

    // ── SVG icons per resolved type ──
    this._ICONS = {
      bearer:  '<svg viewBox="0 0 24 24"><path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm0 10.99h7c-.53 4.12-3.28 7.79-7 8.94V12H5V6.3l7-3.11v8.8z"/></svg>',
      mwc:     '<svg viewBox="0 0 24 24"><path d="M12.65 10C11.83 7.67 9.61 6 7 6c-3.31 0-6 2.69-6 6s2.69 6 6 6c2.61 0 4.83-1.67 5.65-4H17v4h4v-4h2v-4H12.65zM7 14c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2z"/></svg>',
      s2s:     '<svg viewBox="0 0 24 24"><path d="M6.99 11L3 15l3.99 4v-3H14v-2H6.99v-3zM21 9l-3.99-4v3H10v2h7.01v3L21 9z"/></svg>',
      obo:     '<svg viewBox="0 0 24 24"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>',
      unknown: '<svg viewBox="0 0 24 24"><path d="M11 18h2v-2h-2v2zm1-16C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm0-14c-2.21 0-4 1.79-4 4h2c0-1.1.9-2 2-2s2 .9 2 2c0 2-3 1.75-3 5h2c0-2.25 3-2.5 3-5 0-2.21-1.79-4-4-4z"/></svg>'
    };

    // ── Claim tooltips ──
    this._CLAIM_DESC = {
      aud: 'Audience \u2014 the intended recipient of the token',
      iss: 'Issuer \u2014 the identity provider that issued this token',
      iat: 'Issued At \u2014 Unix timestamp when the token was created',
      nbf: 'Not Before \u2014 token is not valid before this time',
      exp: 'Expiration \u2014 Unix timestamp when the token expires',
      oid: 'Object ID \u2014 unique identifier for the user in Azure AD',
      tid: 'Tenant ID \u2014 the Azure AD tenant that issued the token',
      preferred_username: 'Username \u2014 the human-readable identifier for the user',
      roles: 'Roles \u2014 application-level permissions granted to this token',
      scp: 'Scopes \u2014 delegated permissions granted via user consent',
      sub: 'Subject \u2014 unique identifier for the token subject',
      appid: 'Application ID \u2014 the client that requested the token',
      workspaceId: 'Fabric Workspace ID this token is scoped to',
      artifactId: 'Artifact ID \u2014 the specific lakehouse this token targets',
      capacityId: 'Capacity ID \u2014 the Fabric capacity backing this workspace',
      ver: 'Version \u2014 the access token format version'
    };

    this._SECURITY_CLAIMS = new Set(['exp', 'aud', 'roles', 'scp', 'iss', 'tid']);

    this._buildDOM();
    this._bindEvents();
  }

  // ═══════ LIFECYCLE ═══════

  activate() {
    this._isActive = true;
    this._signalr.on('token', this._onEvent);
    this._signalr.subscribeTopic('token');
    document.addEventListener('click', this._onDocClick);
    this._startTicking();
    this._render();
  }

  deactivate() {
    this._isActive = false;
    document.removeEventListener('click', this._onDocClick);
    this._signalr.unsubscribeTopic('token');
    this._signalr.off('token', this._onEvent);
    this._stopTicking();
  }

  // ═══════ EVENT HANDLER (core dedup logic) ═══════

  _onEvent = (event) => {
    if (!event || !event.data) return;
    const d = event.data;

    const typeInfo = this._resolveType(d.tokenType);
    const audience = d.audience || '';
    const dedupKey = typeInfo.key + '|' + audience;
    const issuedMs = d.issuedUtc ? new Date(d.issuedUtc).getTime() : Date.now();
    const expiresMs = d.expiryUtc ? new Date(d.expiryUtc).getTime() : (issuedMs + 3600000);
    const eventTime = event.timestamp ? new Date(event.timestamp).getTime() : Date.now();

    // Store raw event (capped)
    this._rawEvents.push({ time: eventTime, type: typeInfo.key, audience: audience, endpoint: d.endpoint || '' });
    if (this._rawEvents.length > this._maxEvents) this._rawEvents.shift();

    const existing = this._tokenMap.get(dedupKey);

    if (existing) {
      // Token already tracked for this type+audience
      const tokenExpired = existing.expiresAt <= Date.now();
      const isNewIssuance = Math.abs(existing.issuedAt - issuedMs) > 5000;

      if (tokenExpired && isNewIssuance) {
        // Expired token refreshed with a new issuance
        existing.refreshCount++;
        existing.issuedAt = issuedMs;
        existing.expiresAt = expiresMs;
      } else if (isNewIssuance && issuedMs > existing.issuedAt) {
        // New issuance while old hasn't expired (proactive refresh)
        existing.refreshCount++;
        existing.issuedAt = issuedMs;
        existing.expiresAt = expiresMs;
      }

      // Always update usage
      existing.usageCount++;
      existing.lastSeen = eventTime;
      if (d.endpoint) {
        existing.lastEndpoint = d.endpoint;
        existing.usage.unshift({
          time: eventTime,
          method: this._guessMethod(d.endpoint),
          path: d.endpoint
        });
        if (existing.usage.length > 50) existing.usage.length = 50;
      }
      if (d.httpClientName) existing.httpClientName = d.httpClientName;
      if (d.claims) existing.jwtClaims = d.claims;
    } else {
      // Brand new type+audience combination
      const tok = {
        dedupKey: dedupKey,
        typeKey: typeInfo.key,
        typeLabel: typeInfo.label,
        typeColor: typeInfo.color,
        typeDim: typeInfo.dim,
        rawType: d.tokenType || '',
        scheme: d.scheme || typeInfo.label,
        audience: audience,
        issuedAt: issuedMs,
        expiresAt: expiresMs,
        httpClientName: d.httpClientName || '',
        usageCount: 1,
        refreshCount: 0,
        lastSeen: eventTime,
        lastEndpoint: d.endpoint || '',
        jwtClaims: d.claims || {},
        usage: []
      };

      if (d.endpoint) {
        tok.usage.push({
          time: eventTime,
          method: this._guessMethod(d.endpoint),
          path: d.endpoint
        });
      }

      this._tokenMap.set(dedupKey, tok);
    }

    if (this._isActive) this._render();
  }

  // ═══════ DOM CONSTRUCTION ═══════

  _buildDOM() {
    this._container.innerHTML = '';
    const root = document.createElement('div');
    root.className = 'tok-tab';

    // Toolbar
    const toolbar = document.createElement('div');
    toolbar.className = 'tok-toolbar';
    toolbar.innerHTML =
      '<div class="tok-search">' +
        '<svg viewBox="0 0 24 24"><path d="M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>' +
        '<input type="text" placeholder="Filter by audience, client, endpoint\u2026" autocomplete="off" spellcheck="false" />' +
      '</div>' +
      '<span class="tok-counter"></span>' +
      '<div class="tok-pills">' +
        '<button class="tok-pill active-all" data-type="all">All<span class="tok-pill-count"></span></button>' +
        '<button class="tok-pill" data-type="bearer">Bearer<span class="tok-pill-count"></span></button>' +
        '<button class="tok-pill" data-type="mwc">MWC<span class="tok-pill-count"></span></button>' +
        '<button class="tok-pill" data-type="s2s">S2S<span class="tok-pill-count"></span></button>' +
        '<button class="tok-pill" data-type="obo">OBO<span class="tok-pill-count"></span></button>' +
      '</div>' +
      '<div class="tok-toolbar-sep"></div>' +
      '<button class="tok-toolbar-btn" data-action="timeline">' +
        '<svg viewBox="0 0 24 24"><path d="M3 14h4v-4H3v4zm0 5h4v-4H3v4zM3 9h4V5H3v4zm5 5h13v-4H8v4zm0 5h13v-4H8v4zM8 5v4h13V5H8z"/></svg>' +
        'Timeline' +
      '</button>' +
      '<div class="tok-export-wrap">' +
        '<button class="tok-toolbar-btn" data-action="export">' +
          '<svg viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>' +
          'Export' +
        '</button>' +
        '<div class="tok-export-dropdown">' +
          '<button data-format="json">Export as JSON</button>' +
          '<button data-format="csv">Export as CSV</button>' +
        '</div>' +
      '</div>';
    root.appendChild(toolbar);

    // Cards container
    const cards = document.createElement('div');
    cards.className = 'tok-cards';
    root.appendChild(cards);

    // Timeline container
    const timeline = document.createElement('div');
    timeline.className = 'tok-timeline';
    root.appendChild(timeline);

    // Detail panel
    const detail = document.createElement('div');
    detail.className = 'tok-detail';
    detail.innerHTML =
      '<div class="tok-detail-resize"></div>' +
      '<div class="tok-detail-header">' +
        '<span class="tok-detail-title"></span>' +
        '<span class="tok-detail-aud"></span>' +
        '<button class="tok-detail-close" aria-label="Close detail panel">\u2715</button>' +
      '</div>' +
      '<div class="tok-detail-body"></div>' +
      '<div class="tok-detail-footer">' +
        '<button class="tok-detail-btn primary" data-action="copy-claims">' +
          '<svg viewBox="0 0 24 24"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>' +
          'Copy Claims' +
        '</button>' +
        '<button class="tok-detail-btn" data-action="copy-curl">' +
          '<svg viewBox="0 0 24 24"><path d="M9.4 16.6L4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4zm5.2 0l4.6-4.6-4.6-4.6L16 6l6 6-6 6-1.4-1.4z"/></svg>' +
          'Copy as cURL' +
        '</button>' +
        '<span class="tok-sensitive-banner">\u26A0 Sensitive data \u2014 do not share tokens</span>' +
      '</div>';
    root.appendChild(detail);

    // Tooltip
    const tooltip = document.createElement('div');
    tooltip.className = 'tok-tooltip';
    root.appendChild(tooltip);

    this._container.appendChild(root);

    // Cache DOM refs
    this._searchInput = toolbar.querySelector('input');
    this._counterEl = toolbar.querySelector('.tok-counter');
    this._pillsEl = toolbar.querySelector('.tok-pills');
    this._timelineBtn = toolbar.querySelector('[data-action="timeline"]');
    this._exportBtn = toolbar.querySelector('[data-action="export"]');
    this._exportDropdown = toolbar.querySelector('.tok-export-dropdown');
    this._cardsEl = cards;
    this._timelineEl = timeline;
    this._detailEl = detail;
    this._detailTitle = detail.querySelector('.tok-detail-title');
    this._detailAud = detail.querySelector('.tok-detail-aud');
    this._detailBody = detail.querySelector('.tok-detail-body');
    this._tooltipEl = tooltip;
  }

  // ═══════ EVENT BINDING ═══════

  _bindEvents() {
    this._searchInput.addEventListener('input', (e) => {
      this._filterText = e.target.value;
      this._render();
    });

    this._pillsEl.addEventListener('click', (e) => {
      const pill = e.target.closest('.tok-pill');
      if (!pill) return;
      this._typeFilter = pill.dataset.type;
      this._updatePillStates();
      this._render();
    });

    this._timelineBtn.addEventListener('click', () => this._toggleTimeline());

    this._exportBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._exportDropdown.classList.toggle('open');
    });

    this._exportDropdown.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      this._exportData(btn.dataset.format);
      this._exportDropdown.classList.remove('open');
    });

    this._onDocClick = (e) => {
      if (!this._isActive) return;
      if (!e.target.closest('.tok-export-wrap')) {
        this._exportDropdown.classList.remove('open');
      }
    };

    this._detailEl.querySelector('.tok-detail-close').addEventListener('click', () => this._closeDetail());
    this._initDetailResize();
    this._detailEl.querySelector('[data-action="copy-claims"]').addEventListener('click', () => this._copyClaims());
    this._detailEl.querySelector('[data-action="copy-curl"]').addEventListener('click', () => this._copyCurl());
    this._container.addEventListener('keydown', (e) => this._onKeyDown(e));
  }

  // ═══════ RENDERING ═══════

  _render() {
    if (!this._isActive) return;
    const visible = this._getVisible();
    this._updateCounts();

    if (this._timelineMode) {
      this._renderTimeline(visible);
    } else {
      this._renderCards(visible);
    }
  }

  _renderCards(visible) {
    if (!visible.length && !this._tokenMap.size) {
      this._showEmpty(
        'No tokens captured',
        'Tokens will appear here when your FLT service makes authenticated API calls. Deploy to a lakehouse to start capturing.'
      );
      return;
    }
    if (!visible.length) {
      this._showEmpty('No matching tokens', 'Try adjusting your filter or type selection');
      return;
    }

    const fragment = document.createDocumentFragment();
    visible.forEach(tok => fragment.appendChild(this._buildCard(tok)));
    this._cardsEl.innerHTML = '';
    this._cardsEl.appendChild(fragment);
  }

  _buildCard(tok) {
    const el = document.createElement('div');
    const expired = this._isExpired(tok);
    const color = this._ttlColor(tok);
    const frac = this._ttlFrac(tok);
    const pct = Math.round(frac * 100);
    const minLeft = this._ttlMin(tok);

    let cls = 'tok-card';
    if (expired) cls += ' expired';
    else if (minLeft < 2) cls += ' critical-pulse';
    else if (minLeft < 10) cls += ' warning-pulse';
    if (tok.dedupKey === this._selectedKey) cls += ' selected';

    el.className = cls;
    el.dataset.key = tok.dedupKey;
    el.tabIndex = 0;
    el.setAttribute('role', 'button');
    el.setAttribute('aria-label', tok.typeLabel + ' token for ' + tok.audience);
    el.style.setProperty('--_card-color', tok.typeColor);
    el.style.setProperty('--_card-dim', tok.typeDim);

    // Row 1: type badge + audience + TTL ring
    const ttlText = this._fmtTTLBadge(tok);
    const ttlBadgeColor = expired ? 'grey' : color;

    // Row 2: progress bar
    // Row 3: client + usage + last endpoint
    // Row 4: issued/expires + refresh count

    el.innerHTML =
      '<div class="tok-card-header">' +
        '<span class="tok-type-badge">' + (this._ICONS[tok.typeKey] || this._ICONS.unknown) + ' ' + this._escHTML(tok.typeLabel) + '</span>' +
        '<span class="tok-card-audience" title="' + this._escAttr(tok.audience) + '">' + this._escHTML(tok.audience || '(no audience)') + '</span>' +
        '<span class="tok-ttl-badge ' + ttlBadgeColor + '" data-ttl-badge="' + this._escAttr(tok.dedupKey) + '">' + ttlText + '</span>' +
      '</div>' +
      '<div class="tok-progress"><div class="tok-progress-fill ' + color + '" data-ttl-bar="' + this._escAttr(tok.dedupKey) + '" style="width:' + pct + '%"></div></div>' +
      '<div class="tok-card-info">' +
        (tok.httpClientName ? '<span class="tok-meta"><svg viewBox="0 0 24 24"><path d="M20 18c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2H4c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2H0v2h24v-2h-4zM4 6h16v10H4V6z"/></svg> ' + this._escHTML(tok.httpClientName) + '</span><span class="tok-sep">\u00B7</span>' : '') +
        '<span class="tok-meta">Used ' + tok.usageCount + '\u00D7</span>' +
        (tok.lastEndpoint ? '<span class="tok-sep">\u00B7</span><span class="tok-meta tok-mono">Last: ' + this._escHTML(this._truncPath(tok.lastEndpoint)) + '</span>' : '') +
      '</div>' +
      '<div class="tok-card-info">' +
        '<span class="tok-mono">Issued ' + this._fmtTime(tok.issuedAt) + '</span>' +
        '<span class="tok-sep">\u00B7</span>' +
        '<span class="tok-mono">' + (expired ? 'Expired' : 'Expires') + ' ' + this._fmtTime(tok.expiresAt) + '</span>' +
        (tok.refreshCount > 0 ? '<span class="tok-sep">\u00B7</span><span class="tok-refresh-tag">Refreshed ' + tok.refreshCount + '\u00D7</span>' : '') +
        (expired ? '<span class="tok-sep">\u00B7</span><span class="tok-expired-tag">EXPIRED ' + this._fmtExpiredAgo(tok) + '</span>' : '') +
      '</div>';

    el.addEventListener('click', () => this._selectToken(tok.dedupKey));
    return el;
  }

  _showEmpty(title, hint) {
    this._cardsEl.innerHTML =
      '<div class="tok-empty">' +
        '<div class="tok-empty-icon">' +
          '<svg viewBox="0 0 24 24"><path d="M12.65 10C11.83 7.67 9.61 6 7 6c-3.31 0-6 2.69-6 6s2.69 6 6 6c2.61 0 4.83-1.67 5.65-4H17v4h4v-4h2v-4H12.65zM7 14c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2z"/></svg>' +
        '</div>' +
        '<div class="tok-empty-title">' + this._escHTML(title) + '</div>' +
        '<div class="tok-empty-hint">' + this._escHTML(hint) + '</div>' +
      '</div>';
  }

  // ═══════ LIVE TICK (efficient per-second update) ═══════

  _startTicking() {
    this._stopTicking();
    this._tickTimer = setInterval(() => this._tick(), 1000);
  }

  _stopTicking() {
    if (this._tickTimer) {
      clearInterval(this._tickTimer);
      this._tickTimer = null;
    }
  }

  _tick() {
    if (this._isTicking || !this._isActive) return;
    this._isTicking = true;
    let needsFullRender = false;

    try {
      for (const tok of this._tokenMap.values()) {
        const expired = this._isExpired(tok);
        const color = this._ttlColor(tok);

        // Update TTL badge text
        const badgeEl = this._cardsEl.querySelector('[data-ttl-badge="' + CSS.escape(tok.dedupKey) + '"]');
        if (badgeEl) {
          const newText = this._fmtTTLBadge(tok);
          if (badgeEl.textContent !== newText) badgeEl.textContent = newText;
          badgeEl.className = 'tok-ttl-badge ' + (expired ? 'grey' : color);
        }

        // Update progress bar
        const barEl = this._cardsEl.querySelector('[data-ttl-bar="' + CSS.escape(tok.dedupKey) + '"]');
        if (barEl) {
          barEl.style.width = Math.round(this._ttlFrac(tok) * 100) + '%';
          barEl.className = 'tok-progress-fill ' + color;
        }

        // Update card-level state classes
        const cardEl = this._cardsEl.querySelector('[data-key="' + CSS.escape(tok.dedupKey) + '"]');
        if (cardEl) {
          const minLeft = this._ttlMin(tok);
          cardEl.classList.toggle('critical-pulse', !expired && minLeft < 2);
          cardEl.classList.toggle('warning-pulse', !expired && minLeft >= 2 && minLeft < 10);

          if (expired && !cardEl.classList.contains('expired')) {
            cardEl.classList.add('expired');
            cardEl.classList.remove('critical-pulse', 'warning-pulse');
            needsFullRender = true;
          }
        }
      }

      if (needsFullRender) {
        requestAnimationFrame(() => this._render());
      }
    } finally {
      this._isTicking = false;
    }
  }

  // ═══════ TIMELINE ═══════

  _toggleTimeline() {
    this._timelineMode = !this._timelineMode;
    this._cardsEl.classList.toggle('hidden', this._timelineMode);
    this._timelineEl.classList.toggle('active', this._timelineMode);
    this._timelineBtn.classList.toggle('active', this._timelineMode);
    this._render();
  }

  _renderTimeline(visible) {
    if (!visible.length) {
      this._timelineEl.innerHTML = '<div class="tok-empty"><div class="tok-empty-title">No tokens to display</div></div>';
      return;
    }

    const allTimes = visible.flatMap(t => [t.issuedAt, t.expiresAt]);
    let minTime = Math.min(...allTimes);
    let maxTime = Math.max(...allTimes, Date.now());
    const pad = (maxTime - minTime) * 0.05;
    minTime -= pad;
    maxTime += pad;
    const span = maxTime - minTime;
    const toX = t => ((t - minTime) / span) * 100;

    const containerWidth = this._timelineEl.offsetWidth || 600;
    const tickCount = containerWidth < 600 ? 3 : containerWidth < 900 ? 5 : 8;
    let ticksHTML = '';
    for (let i = 0; i <= tickCount; i++) {
      const t = minTime + (span * i / tickCount);
      ticksHTML += '<div class="tok-timeline-tick" style="left:' + toX(t) + '%">' + this._fmtTime(t) + '</div>';
    }

    const nowX = toX(Date.now());
    let barsHTML = '';
    visible.forEach(tok => {
      const left = toX(tok.issuedAt);
      const right = toX(Math.min(tok.expiresAt, maxTime));
      const width = Math.max(1, right - left);
      const expired = this._isExpired(tok);
      const audLabel = tok.audience.length > 30 ? tok.audience.slice(0, 28) + '..' : tok.audience;

      barsHTML +=
        '<div class="tok-timeline-row">' +
          '<div class="tok-timeline-row-label ' + tok.typeKey + '">' + tok.typeLabel + '</div>' +
          '<div class="tok-timeline-row-track">' +
            '<div class="tok-timeline-bar ' + tok.typeKey +
              (expired ? ' expired' : '') +
              (tok.dedupKey === this._selectedKey ? ' selected' : '') +
              '" data-key="' + this._escAttr(tok.dedupKey) + '" tabindex="0" ' +
              'style="left:' + left + '%;width:' + width + '%" ' +
              'title="' + this._escAttr(tok.audience) + ' (' + this._fmtTTL(tok) + ')">' +
              this._escHTML(audLabel) +
            '</div>' +
          '</div>' +
        '</div>';
    });

    this._timelineEl.innerHTML =
      '<div class="tok-timeline-canvas">' +
        '<div class="tok-timeline-axis">' + ticksHTML + '</div>' +
        '<div class="tok-timeline-now" style="left:' + nowX + '%"></div>' +
        '<div class="tok-timeline-bars">' + barsHTML + '</div>' +
      '</div>';

    this._timelineEl.querySelectorAll('.tok-timeline-bar').forEach(el => {
      el.addEventListener('click', () => this._selectToken(el.dataset.key));
      el.addEventListener('mouseenter', (e) => this._showTooltip(e, el.dataset.key));
      el.addEventListener('mouseleave', () => this._hideTooltip());
    });
  }

  // ═══════ DETAIL PANEL ═══════

  _selectToken(dedupKey) {
    this._selectedKey = dedupKey;

    this._cardsEl.querySelectorAll('.tok-card').forEach(c => {
      c.classList.toggle('selected', c.dataset.key === dedupKey);
    });
    this._timelineEl.querySelectorAll('.tok-timeline-bar').forEach(b => {
      b.classList.toggle('selected', b.dataset.key === dedupKey);
    });

    const tok = this._tokenMap.get(dedupKey);
    if (!tok) return;

    this._detailTitle.innerHTML = '<span style="color:' + tok.typeColor + '">' + tok.typeLabel + '</span>';
    this._detailAud.textContent = tok.audience;
    this._renderDetailBody(tok);
    this._openDetail();
  }

  _renderDetailBody(tok) {
    const claims = tok.jwtClaims || {};
    const claimKeys = Object.keys(claims);

    let payloadRows = '';
    claimKeys.forEach(k => {
      const v = claims[k];
      const isSecurity = this._SECURITY_CLAIMS.has(k);
      let valHTML;
      if (k === 'roles' && Array.isArray(v)) {
        valHTML = '<span class="tok-jwt-val roles">' +
          v.map(r => '<span class="tok-role-tag">' + this._escHTML(r) + '</span>').join('') + '</span>';
      } else if (k === 'exp' || k === 'iat' || k === 'nbf') {
        valHTML = '<span class="tok-jwt-val' + (isSecurity ? ' highlight' : '') + '">' +
          this._escHTML(String(v)) +
          ' <span style="color:var(--text-muted);font-size:10px">(' + this._fmtTimestamp(v) + ')</span></span>';
      } else {
        valHTML = '<span class="tok-jwt-val' + (isSecurity ? ' highlight' : '') + '">' + this._escHTML(String(v)) + '</span>';
      }
      const desc = this._CLAIM_DESC[k] || '';
      payloadRows += '<div class="tok-jwt-row"' + (desc ? ' title="' + this._escAttr(desc) + '"' : '') + '>' +
        '<span class="tok-jwt-key">' + this._escHTML(k) + '</span>' + valHTML + '</div>';
    });

    let metaRows =
      '<div class="tok-jwt-row"><span class="tok-jwt-key">scheme</span><span class="tok-jwt-val">' + this._escHTML(tok.scheme) + '</span></div>' +
      '<div class="tok-jwt-row"><span class="tok-jwt-key">audience</span><span class="tok-jwt-val">' + this._escHTML(tok.audience) + '</span></div>' +
      '<div class="tok-jwt-row"><span class="tok-jwt-key">httpClient</span><span class="tok-jwt-val">' + this._escHTML(tok.httpClientName) + '</span></div>' +
      '<div class="tok-jwt-row"><span class="tok-jwt-key">issued</span><span class="tok-jwt-val">' + this._fmtTimestamp(Math.floor(tok.issuedAt / 1000)) + '</span></div>' +
      '<div class="tok-jwt-row"><span class="tok-jwt-key">expires</span><span class="tok-jwt-val' + (this._isExpired(tok) ? ' highlight' : '') + '">' + this._fmtTimestamp(Math.floor(tok.expiresAt / 1000)) + '</span></div>' +
      '<div class="tok-jwt-row"><span class="tok-jwt-key">TTL</span><span class="tok-jwt-val">' + this._fmtTTL(tok) + '</span></div>' +
      '<div class="tok-jwt-row"><span class="tok-jwt-key">usage</span><span class="tok-jwt-val">' + tok.usageCount + ' calls</span></div>' +
      '<div class="tok-jwt-row"><span class="tok-jwt-key">refreshed</span><span class="tok-jwt-val">' + tok.refreshCount + '\u00D7</span></div>' +
      (tok.rawType && tok.rawType !== tok.typeLabel ? '<div class="tok-jwt-row"><span class="tok-jwt-key">rawType</span><span class="tok-jwt-val">' + this._escHTML(tok.rawType) + '</span></div>' : '');

    let usageRows = '';
    tok.usage.forEach(u => {
      const mc = u.method.toLowerCase();
      usageRows +=
        '<div class="tok-usage-row">' +
          '<span class="tok-usage-time">' + this._fmtTime(u.time) + '</span>' +
          '<span class="tok-usage-method ' + mc + '">' + u.method + '</span>' +
          '<span class="tok-usage-path">' + this._escHTML(u.path) + '</span>' +
        '</div>';
    });

    this._detailBody.innerHTML =
      '<div class="tok-detail-col">' +
        '<div class="tok-jwt-panel">' +
          '<div class="tok-jwt-panel-header">Token Metadata</div>' +
          '<div class="tok-jwt-panel-body">' + metaRows + '</div>' +
        '</div>' +
        (claimKeys.length > 0 ?
          '<div class="tok-jwt-panel">' +
            '<div class="tok-jwt-panel-header">JWT Claims (' + claimKeys.length + ')</div>' +
            '<div class="tok-jwt-panel-body">' + payloadRows + '</div>' +
          '</div>'
        : '') +
      '</div>' +
      '<div class="tok-detail-col">' +
        '<div class="tok-usage-panel">' +
          '<div class="tok-usage-header">' +
            '<svg viewBox="0 0 24 24"><path d="M3.4 20.4l17.45-7.48c.81-.35.81-1.49 0-1.84L3.4 3.6c-.66-.29-1.39.2-1.39.91L2 9.12c0 .5.37.93.87.99L17 12 2.87 13.88c-.5.07-.87.5-.87 1l.01 4.61c0 .71.73 1.2 1.39.91z"/></svg>' +
            'Usage Stream (' + tok.usage.length + ' calls)' +
          '</div>' +
          '<div class="tok-usage-body">' +
            (usageRows || '<div style="padding:12px;color:var(--text-muted);text-align:center">No API calls recorded</div>') +
          '</div>' +
        '</div>' +
      '</div>';
  }

  _openDetail() {
    this._detailEl.style.height = this._detailHeight + 'px';
    this._detailEl.classList.add('open');
    this._detailOpen = true;
    this._cardsEl.classList.add('has-detail');
    this._cardsEl.style.paddingBottom = (this._detailHeight + 20) + 'px';
  }

  _closeDetail() {
    this._detailEl.classList.remove('open');
    this._detailEl.style.height = '0';
    this._detailOpen = false;
    this._selectedKey = null;
    this._cardsEl.classList.remove('has-detail');
    this._cardsEl.style.paddingBottom = '';
    this._cardsEl.querySelectorAll('.tok-card').forEach(c => c.classList.remove('selected'));
    this._timelineEl.querySelectorAll('.tok-timeline-bar').forEach(b => b.classList.remove('selected'));
  }

  _initDetailResize() {
    const handle = this._detailEl.querySelector('.tok-detail-resize');
    let startY, startH;

    handle.addEventListener('mousedown', (e) => {
      startY = e.clientY;
      startH = this._detailEl.offsetHeight;
      e.preventDefault();

      const onMove = (ev) => {
        const newH = Math.max(120, startH + (startY - ev.clientY));
        this._detailEl.style.height = newH + 'px';
        this._detailHeight = newH;
        this._cardsEl.style.paddingBottom = (newH + 20) + 'px';
      };

      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  // ═══════ TOOLTIP ═══════

  _showTooltip(e, dedupKey) {
    const tok = this._tokenMap.get(dedupKey);
    if (!tok) return;

    this._tooltipEl.innerHTML =
      '<div class="tok-tip-row"><span class="tok-tip-key">Type</span><span class="tok-tip-val" style="color:' + tok.typeColor + '">' + tok.typeLabel + '</span></div>' +
      '<div class="tok-tip-row"><span class="tok-tip-key">TTL</span><span class="tok-tip-val">' + this._fmtTTL(tok) + '</span></div>' +
      '<div class="tok-tip-row"><span class="tok-tip-key">Audience</span><span class="tok-tip-val">' + this._escHTML(tok.audience) + '</span></div>' +
      '<div class="tok-tip-row"><span class="tok-tip-key">Calls</span><span class="tok-tip-val">' + tok.usageCount + '</span></div>' +
      '<div class="tok-tip-row"><span class="tok-tip-key">Refreshed</span><span class="tok-tip-val">' + tok.refreshCount + '\u00D7</span></div>';

    const rect = e.target.getBoundingClientRect();
    this._tooltipEl.style.left = (rect.left + rect.width / 2) + 'px';
    this._tooltipEl.style.top = (rect.top - 8) + 'px';
    this._tooltipEl.style.transform = 'translate(-50%, -100%)';
    this._tooltipEl.classList.add('visible');
  }

  _hideTooltip() {
    this._tooltipEl.classList.remove('visible');
  }

  // ═══════ KEYBOARD ═══════

  _onKeyDown(e) {
    const cards = Array.from(this._cardsEl.querySelectorAll('.tok-card'));

    if (e.key === 'ArrowDown' && cards.length) {
      e.preventDefault();
      this._kbIndex = Math.min(this._kbIndex + 1, cards.length - 1);
      this._focusCard(cards);
    } else if (e.key === 'ArrowUp' && cards.length) {
      e.preventDefault();
      this._kbIndex = Math.max(this._kbIndex - 1, 0);
      this._focusCard(cards);
    } else if (e.key === 'Enter' && this._kbIndex >= 0 && this._kbIndex < cards.length) {
      e.preventDefault();
      this._selectToken(cards[this._kbIndex].dataset.key);
    } else if (e.key === 'Escape') {
      if (this._detailOpen) {
        this._closeDetail();
        e.preventDefault();
      }
    } else if (e.key === 't' && !e.ctrlKey && !e.altKey && e.target.tagName !== 'INPUT') {
      e.preventDefault();
      this._toggleTimeline();
    }
  }

  _focusCard(cards) {
    cards.forEach(c => c.classList.remove('selected'));
    if (this._kbIndex >= 0 && this._kbIndex < cards.length) {
      cards[this._kbIndex].classList.add('selected');
      cards[this._kbIndex].focus();
      cards[this._kbIndex].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  // ═══════ FILTERING ═══════

  _getVisible() {
    const all = Array.from(this._tokenMap.values());
    return all.filter(tok => {
      if (this._typeFilter !== 'all' && tok.typeKey !== this._typeFilter) return false;
      if (this._filterText) {
        const ft = this._filterText.toLowerCase();
        const searchable = (tok.typeKey + ' ' + tok.typeLabel + ' ' + tok.audience + ' ' + tok.httpClientName + ' ' + tok.lastEndpoint).toLowerCase();
        if (!searchable.includes(ft)) return false;
      }
      return true;
    }).sort((a, b) => {
      const aExp = this._isExpired(a);
      const bExp = this._isExpired(b);
      if (aExp !== bExp) return aExp ? 1 : -1;
      return this._ttlSec(a) - this._ttlSec(b);
    });
  }

  _updateCounts() {
    const all = this._tokenMap.size;
    const counts = { bearer: 0, mwc: 0, s2s: 0, obo: 0, unknown: 0 };
    for (const t of this._tokenMap.values()) {
      counts[t.typeKey] = (counts[t.typeKey] || 0) + 1;
    }

    this._pillsEl.querySelectorAll('.tok-pill').forEach(p => {
      const type = p.dataset.type;
      const countEl = p.querySelector('.tok-pill-count');
      if (type === 'all') {
        countEl.textContent = all ? ' ' + all : '';
      } else {
        countEl.textContent = counts[type] ? ' ' + counts[type] : '';
      }
    });

    const vis = this._getVisible().length;
    this._counterEl.textContent = vis === all ? all + ' tokens' : vis + ' of ' + all + ' tokens';
  }

  _updatePillStates() {
    this._pillsEl.querySelectorAll('.tok-pill').forEach(p => {
      p.className = 'tok-pill';
      if (p.dataset.type === this._typeFilter) {
        p.classList.add('active-' + this._typeFilter);
      }
    });
  }

  // ═══════ EXPORT ═══════

  _exportData(format) {
    const visible = this._getVisible();
    let content;

    if (format === 'json') {
      const data = visible.map(tok => ({
        type: tok.typeKey,
        audience: tok.audience,
        issuedAt: new Date(tok.issuedAt).toISOString(),
        expiresAt: new Date(tok.expiresAt).toISOString(),
        httpClientName: tok.httpClientName,
        usageCount: tok.usageCount,
        refreshCount: tok.refreshCount,
        lastEndpoint: tok.lastEndpoint,
        claims: tok.jwtClaims
      }));
      content = JSON.stringify(data, null, 2);
    } else {
      const rows = [['Type', 'Audience', 'Issued', 'Expires', 'HttpClient', 'UsageCount', 'RefreshCount', 'LastEndpoint']];
      visible.forEach(tok => {
        rows.push([
          tok.typeKey,
          tok.audience,
          new Date(tok.issuedAt).toISOString(),
          new Date(tok.expiresAt).toISOString(),
          tok.httpClientName,
          String(tok.usageCount),
          String(tok.refreshCount),
          tok.lastEndpoint
        ]);
      });
      content = rows.map(r => r.join(',')).join('\n');
    }

    try { navigator.clipboard.writeText(content); } catch (_) { /* clipboard may not be available */ }
  }

  _copyClaims() {
    const tok = this._tokenMap.get(this._selectedKey);
    if (!tok) return;
    const data = {
      type: tok.typeKey,
      audience: tok.audience,
      issuedAt: new Date(tok.issuedAt).toISOString(),
      expiresAt: new Date(tok.expiresAt).toISOString(),
      usageCount: tok.usageCount,
      refreshCount: tok.refreshCount,
      claims: tok.jwtClaims
    };
    try { navigator.clipboard.writeText(JSON.stringify(data, null, 2)); } catch (_) { /* */ }
  }

  _copyCurl() {
    const tok = this._tokenMap.get(this._selectedKey);
    if (!tok) return;
    const curl = 'curl -H "Authorization: ' + tok.scheme + ' <' + tok.typeLabel + '_TOKEN>" https://' + tok.audience + '/v1/resource';
    try { navigator.clipboard.writeText(curl); } catch (_) { /* */ }
  }

  // ═══════ TYPE RESOLUTION ═══════

  _resolveType(rawType) {
    if (!rawType) return { key: 'unknown', label: 'Unknown', color: 'var(--tok-unknown)', dim: 'var(--tok-unknown-dim)' };
    const key = rawType.toLowerCase().replace(/[^a-z0-9]/g, '');
    const match = this._TYPE_TABLE[key];
    if (match) return match;
    // Unknown type: show raw string as label
    return { key: 'unknown', label: rawType, color: 'var(--tok-unknown)', dim: 'var(--tok-unknown-dim)' };
  }

  // ═══════ TTL HELPERS ═══════

  _isExpired(tok) { return tok.expiresAt <= Date.now(); }
  _ttlMs(tok) { return Math.max(0, tok.expiresAt - Date.now()); }
  _ttlSec(tok) { return Math.floor(this._ttlMs(tok) / 1000); }
  _ttlMin(tok) { return Math.floor(this._ttlMs(tok) / 60000); }

  _ttlFrac(tok) {
    const total = tok.expiresAt - tok.issuedAt;
    if (total <= 0) return 0;
    return Math.max(0, Math.min(1, (tok.expiresAt - Date.now()) / total));
  }

  _ttlColor(tok) {
    if (this._isExpired(tok)) return 'grey';
    const m = this._ttlMin(tok);
    if (m >= 10) return 'green';
    if (m >= 2) return 'amber';
    return 'red';
  }

  _fmtTTL(tok) {
    if (this._isExpired(tok)) {
      const ago = Math.floor((Date.now() - tok.expiresAt) / 60000);
      return ago < 1 ? 'EXPIRED <1m ago' : 'EXPIRED ' + ago + 'm ago';
    }
    const s = this._ttlSec(tok);
    const mm = Math.floor(s / 60);
    const ss = s % 60;
    return String(mm).padStart(2, '0') + ':' + String(ss).padStart(2, '0');
  }

  _fmtTTLBadge(tok) {
    if (this._isExpired(tok)) return 'EXPIRED';
    const s = this._ttlSec(tok);
    const mm = Math.floor(s / 60);
    const ss = s % 60;
    return String(mm).padStart(2, '0') + ':' + String(ss).padStart(2, '0') + ' remaining';
  }

  _fmtExpiredAgo(tok) {
    const ago = Math.floor((Date.now() - tok.expiresAt) / 60000);
    return ago < 1 ? '<1m ago' : ago + 'm ago';
  }

  _fmtTime(ms) {
    const d = new Date(ms);
    return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  _fmtTimestamp(unix) {
    return new Date(unix * 1000).toLocaleString('en-US', {
      hour12: false, year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
  }

  _truncPath(path) {
    if (!path) return '';
    return path.length > 40 ? path.slice(0, 38) + '\u2026' : path;
  }

  _guessMethod(endpoint) {
    if (!endpoint) return 'GET';
    const lower = endpoint.toLowerCase();
    if (lower.includes('sessions') && !lower.includes('/sessions/')) return 'POST';
    if (lower.includes('statements') && !lower.includes('/statements/')) return 'POST';
    if (lower.includes('instances') && !lower.includes('/instances/')) return 'POST';
    if (lower.includes('resolve') || lower.includes('exchange')) return 'POST';
    return 'GET';
  }

  _escHTML(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  _escAttr(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}
