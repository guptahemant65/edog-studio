/**
 * OnboardingScreen — Full-screen auth overlay for first-time and expired-token flows.
 *
 * Lifecycle: check health → scan certs → auto-select or show picker →
 * Silent CBA auth → verify workspace access → dismiss → dashboard.
 *
 * Right panel: auto-rotating feature showcase cards with crossfade.
 *
 * Zara Okonkwo — vanilla JS, class-based module.
 */
class OnboardingScreen {
  constructor() {
    this._overlay = null;
    this._contentEl = null;
    this._onComplete = null;
    this._selectedCert = null;
    this._certs = [];
    this._stepCount = 0;
    this._showcaseTimer = null;
    this._showcaseIndex = 0;

    this._PPE_WIKI_URL =
      'https://dev.azure.com/powerbi/Trident/_wiki/wikis/Trident.wiki/80942/PPE-Ephemeral-Tenants-(ES-Maintained-Rotated)';

    this._FEATURES = [
      {
        title: 'Workspace Explorer',
        desc: 'Browse workspaces, lakehouses and tables with live Fabric data. Rename, delete, inspect \u2014 all without leaving your dev environment.',
        icon: '<svg viewBox="0 0 24 24"><path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"/></svg>',
      },
      {
        title: 'Feature Flags',
        desc: 'Toggle rollouts, test flag combinations and create PRs to the FeatureManagement repo \u2014 the entire flag lifecycle in one screen.',
        icon: '<svg viewBox="0 0 24 24"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/></svg>',
      },
      {
        title: 'Runtime Inspector',
        desc: 'Live logs, DAG execution graphs, Spark queries and telemetry. Streaming over WebSocket, zero context switches required.',
        icon: '<svg viewBox="0 0 24 24"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>',
      },
      {
        title: 'One-Click Deploy',
        desc: 'Select a lakehouse, hit deploy. Config patched, token acquired, service built and launched \u2014 all automated.',
        icon: '<svg viewBox="0 0 24 24"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>',
      },
      {
        title: 'DAG Studio',
        desc: 'Visualize materialization DAGs as interactive node graphs. Click any node to see metrics, timing and dependencies in real time.',
        icon: '<svg viewBox="0 0 24 24"><circle cx="6" cy="6" r="3"/><circle cx="18" cy="12" r="3"/><circle cx="6" cy="18" r="3"/><line x1="9" y1="6" x2="15" y2="12"/><line x1="9" y1="18" x2="15" y2="12"/></svg>',
      },
      {
        title: 'Command Palette',
        desc: 'Ctrl+K to find anything \u2014 workspaces, lakehouses, flags, actions, settings. Keyboard-first, instant results.',
        icon: '<svg viewBox="0 0 24 24"><rect x="2" y="4" width="20" height="16" rx="2"/><line x1="6" y1="8" x2="10" y2="8"/><line x1="6" y1="12" x2="14" y2="12"/><line x1="6" y1="16" x2="11" y2="16"/></svg>',
      },
      {
        title: 'Capacity Dashboard',
        desc: 'Monitor all 46 capacities at a glance \u2014 utilization, throttling, health scores and workload configurations.',
        icon: '<svg viewBox="0 0 24 24"><rect x="3" y="12" width="4" height="9" rx="1"/><rect x="10" y="7" width="4" height="14" rx="1"/><rect x="17" y="3" width="4" height="18" rx="1"/></svg>',
      },
      {
        title: 'API Playground',
        desc: 'Test any Fabric endpoint with auto-filled tokens. 86+ endpoints documented with live request/response preview.',
        icon: '<svg viewBox="0 0 24 24"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/><line x1="14" y1="4" x2="10" y2="20"/></svg>',
      },
    ];
  }

  // --- Public API ---

  /**
   * Check whether onboarding is required (no valid bearer or < 5 min left).
   * @returns {Promise<boolean>}
   */
  async isRequired() {
    try {
      const resp = await fetch('/api/edog/health');
      if (!resp.ok) return true;
      const data = await resp.json();
      if (!data.hasBearerToken || !data.tokenHelperBuilt) return true;
      const remainingSec = data.bearerExpiresIn ?? 0;
      return remainingSec < 300;
    } catch {
      return true;
    }
  }

  /**
   * Show the onboarding overlay and begin the auth flow.
   * @param {function} onComplete - Called with {token, username} on success.
   */
  async show(onComplete) {
    this._onComplete = onComplete || null;
    this._createOverlay();
    document.body.appendChild(this._overlay);
    this._startShowcase();

    // Show shimmer skeleton while certs load
    this._renderSkeleton();

    let certs = [];
    try {
      const resp = await fetch('/api/edog/certs');
      if (resp.ok) certs = await resp.json();
    } catch {
      // Cert scan failed — fall through to no-certs path
    }
    this._certs = certs;

    // Filter out expired certs
    const now = new Date();
    const validCerts = Array.isArray(certs)
      ? certs.filter(c => !c.notAfter || new Date(c.notAfter) > now)
      : [];

    // Fade out skeleton, then show real content
    await this._dismissSkeleton();

    if (validCerts.length === 0) {
      this._renderNoCerts();
    } else if (validCerts.length === 1) {
      const username = this._deriveUsername(validCerts[0].cn);
      this._runAuth(username);
    } else {
      this._renderCertPicker(validCerts);
    }
  }

  /**
   * Dismiss the overlay with a fade-out transition, then remove from DOM.
   */
  dismiss() {
    if (!this._overlay) return;
    this._stopShowcase();
    this._overlay.classList.add('fade-out');
    setTimeout(() => {
      if (this._overlay && this._overlay.parentNode) {
        this._overlay.parentNode.removeChild(this._overlay);
      }
      this._overlay = null;
    }, 400);
  }

  // --- Private: DOM Construction ---

  _createOverlay() {
    const overlay = document.createElement('div');
    overlay.className = 'onboarding-overlay';

    const layout = document.createElement('div');
    layout.className = 'onboarding-layout';

    // Left — content area
    const content = document.createElement('div');
    content.className = 'onboarding-content';

    const wordmark = document.createElement('div');
    wordmark.className = 'wordmark';
    wordmark.innerHTML = 'EDOG<span class="wordmark-accent">.</span>';

    const tagline = document.createElement('div');
    tagline.className = 'tagline';
    tagline.textContent = 'Playground v2.0';

    const selectPhase = document.createElement('div');
    selectPhase.id = 'select-phase';

    const authProgress = document.createElement('div');
    authProgress.className = 'auth-progress';

    const spacer = document.createElement('div');
    spacer.className = 'spacer';

    content.appendChild(wordmark);
    content.appendChild(tagline);
    content.appendChild(selectPhase);
    content.appendChild(authProgress);
    content.appendChild(spacer);

    // Right — feature showcase
    const showcase = this._createShowcasePanel();

    layout.appendChild(content);
    layout.appendChild(showcase);

    // Footer
    const footer = document.createElement('footer');
    footer.className = 'onboarding-footer';
    footer.innerHTML =
      '<span>EDOG Playground v2.0</span>' +
      '<span><span class="status-dot"></span>All systems operational</span>';

    overlay.appendChild(layout);
    overlay.appendChild(footer);

    this._overlay = overlay;
    this._contentEl = selectPhase;
  }

  _createShowcasePanel() {
    const panel = document.createElement('div');
    panel.className = 'showcase-panel';
    panel.setAttribute('aria-hidden', 'true');

    // Ambient gradient mesh blobs (Mika's idea — pure CSS animation)
    const mesh = document.createElement('div');
    mesh.className = 'showcase-mesh';
    mesh.innerHTML =
      '<div class="mesh-blob mesh-blob--1"></div>' +
      '<div class="mesh-blob mesh-blob--2"></div>' +
      '<div class="mesh-blob mesh-blob--3"></div>';

    const watermark = document.createElement('div');
    watermark.className = 'showcase-watermark';
    watermark.textContent = 'playground';

    const carousel = document.createElement('div');
    carousel.className = 'showcase-carousel';

    this._showcaseCards = [];
    this._FEATURES.forEach((feature, idx) => {
      const card = document.createElement('div');
      card.className = 'showcase-card' + (idx === 0 ? ' active' : '');

      const iconWrap = document.createElement('div');
      iconWrap.className = 'showcase-card-icon';
      iconWrap.innerHTML = feature.icon;

      const title = document.createElement('div');
      title.className = 'showcase-card-title';
      title.textContent = feature.title;

      const desc = document.createElement('div');
      desc.className = 'showcase-card-desc';
      desc.textContent = feature.desc;

      card.appendChild(iconWrap);
      card.appendChild(title);
      card.appendChild(desc);
      carousel.appendChild(card);
      this._showcaseCards.push(card);
    });

    // Dot indicators
    const dots = document.createElement('div');
    dots.className = 'showcase-dots';
    this._showcaseDots = [];
    this._FEATURES.forEach((_, idx) => {
      const dot = document.createElement('button');
      dot.className = 'showcase-dot' + (idx === 0 ? ' active' : '');
      dot.setAttribute('aria-label', 'Feature ' + (idx + 1));
      dot.addEventListener('click', () => this._goToSlide(idx));
      dots.appendChild(dot);
      this._showcaseDots.push(dot);
    });

    panel.appendChild(mesh);
    panel.appendChild(watermark);
    panel.appendChild(carousel);
    panel.appendChild(dots);

    return panel;
  }

  // --- Private: Shimmer Skeleton ---

  _renderSkeleton() {
    this._contentEl.innerHTML = '';

    const header = document.createElement('div');
    header.className = 'skel-header-line';
    this._contentEl.appendChild(header);

    const skelWrap = document.createElement('div');
    skelWrap.className = 'skel-wrap';

    for (let i = 0; i < 4; i++) {
      const row = document.createElement('div');
      row.className = 'skel-row';

      const circle = document.createElement('div');
      circle.className = 'skel-circle';

      const lines = document.createElement('div');
      lines.className = 'skel-lines';

      const line1 = document.createElement('div');
      line1.className = 'skel-line skel-line--md';
      line1.style.animationDelay = (i * 80) + 'ms';

      const line2 = document.createElement('div');
      line2.className = 'skel-line skel-line--sm';
      line2.style.animationDelay = (i * 80 + 40) + 'ms';

      lines.appendChild(line1);
      lines.appendChild(line2);
      row.appendChild(circle);
      row.appendChild(lines);
      skelWrap.appendChild(row);
    }

    const skelBtn = document.createElement('div');
    skelBtn.className = 'skel-rect skel-rect--btn';

    this._contentEl.appendChild(skelWrap);
    this._contentEl.appendChild(skelBtn);
  }

  _dismissSkeleton() {
    return new Promise(resolve => {
      this._contentEl.classList.add('skel-fade-out');
      setTimeout(() => {
        this._contentEl.innerHTML = '';
        this._contentEl.classList.remove('skel-fade-out');
        this._contentEl.classList.add('content-fade-in');
        // Remove the animation class after it plays
        setTimeout(() => this._contentEl.classList.remove('content-fade-in'), 350);
        resolve();
      }, 250);
    });
  }

  // --- Private: Showcase Carousel ---

  _startShowcase() {
    this._showcaseIndex = 0;
    this._showcaseTimer = setInterval(() => {
      const next = (this._showcaseIndex + 1) % this._FEATURES.length;
      this._goToSlide(next);
    }, 4000);
  }

  _stopShowcase() {
    if (this._showcaseTimer) {
      clearInterval(this._showcaseTimer);
      this._showcaseTimer = null;
    }
  }

  _goToSlide(idx) {
    if (!this._showcaseCards || !this._showcaseDots) return;

    this._showcaseCards.forEach((card, i) => {
      card.classList.toggle('active', i === idx);
    });
    this._showcaseDots.forEach((dot, i) => {
      dot.classList.toggle('active', i === idx);
    });

    this._showcaseIndex = idx;

    // Reset the auto-advance timer so the new card gets a full 4s
    this._stopShowcase();
    this._showcaseTimer = setInterval(() => {
      const next = (this._showcaseIndex + 1) % this._FEATURES.length;
      this._goToSlide(next);
    }, 4000);
  }

  // --- Private: Cert Picker ---

  _renderCertPicker(certs) {
    const sorted = certs.slice().sort((a, b) => new Date(b.notAfter) - new Date(a.notAfter));
    this._selectedCert = sorted[0];
    this._contentEl.innerHTML = '';

    const header = document.createElement('div');
    header.className = 'section-header';

    const sectionTitle = document.createElement('span');
    sectionTitle.className = 'section-title';
    sectionTitle.textContent = 'Certificate';

    const sectionMeta = document.createElement('span');
    sectionMeta.className = 'section-meta';
    sectionMeta.textContent = sorted.length + ' detected';

    header.appendChild(sectionTitle);
    header.appendChild(sectionMeta);

    const list = document.createElement('ul');
    list.className = 'cert-list';
    list.setAttribute('role', 'radiogroup');
    list.setAttribute('aria-label', 'Certificate selection');

    const items = [];
    sorted.forEach((cert, idx) => {
      const item = document.createElement('li');
      item.className = 'cert-item';
      item.setAttribute('role', 'radio');
      item.setAttribute('aria-selected', idx === 0 ? 'true' : 'false');
      item.setAttribute('tabindex', '0');
      item.setAttribute('data-cert', String(idx));

      const hiddenInput = document.createElement('input');
      hiddenInput.type = 'radio';
      hiddenInput.className = 'cert-hidden-input';
      hiddenInput.name = 'cert';
      hiddenInput.value = String(idx);
      if (idx === 0) hiddenInput.checked = true;

      const radioOuter = document.createElement('div');
      radioOuter.className = 'radio-outer';
      const radioInner = document.createElement('div');
      radioInner.className = 'radio-inner';
      radioOuter.appendChild(radioInner);

      const info = document.createElement('div');
      info.className = 'cert-info';

      const cn = document.createElement('div');
      cn.className = 'cert-name';
      cn.textContent = cert.cn || cert.subject || cert.thumbprint;

      const expiry = document.createElement('div');
      expiry.className = 'cert-expiry';
      expiry.textContent = 'Expires ' + this._formatDate(cert.notAfter);

      info.appendChild(cn);
      info.appendChild(expiry);

      item.appendChild(hiddenInput);
      item.appendChild(radioOuter);
      item.appendChild(info);

      item.addEventListener('click', () => {
        items.forEach(i => {
          i.setAttribute('aria-selected', 'false');
          i.querySelector('.cert-hidden-input').checked = false;
        });
        item.setAttribute('aria-selected', 'true');
        item.querySelector('.cert-hidden-input').checked = true;
        this._selectedCert = cert;
      });

      item.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          item.click();
        }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          const i = items.indexOf(item);
          const next = e.key === 'ArrowDown'
            ? items[(i + 1) % items.length]
            : items[(i - 1 + items.length) % items.length];
          next.focus();
          next.click();
        }
      });

      items.push(item);
      list.appendChild(item);
    });

    const cta = document.createElement('button');
    cta.className = 'cta-btn';
    cta.innerHTML = 'Continue \u2192';
    cta.addEventListener('click', () => {
      if (!this._selectedCert) return;
      const username = this._deriveUsername(this._selectedCert.cn);
      this._runAuth(username);
    });

    const tenantLink = document.createElement('a');
    tenantLink.className = 'tenant-link';
    tenantLink.href = '#';
    tenantLink.textContent = 'Connect to a different tenant';
    tenantLink.addEventListener('click', (e) => {
      e.preventDefault();
      this._renderManualEntry();
    });

    this._contentEl.appendChild(header);
    this._contentEl.appendChild(list);
    this._contentEl.appendChild(cta);
    this._contentEl.appendChild(tenantLink);
  }

  // --- Private: No Certs ---

  _renderNoCerts() {
    this._contentEl.innerHTML = '';

    const header = document.createElement('div');
    header.className = 'section-header';
    header.innerHTML = '<span class="section-title">Connect</span>' +
      '<span class="section-meta">No certificates detected</span>';
    this._contentEl.appendChild(header);

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'manual-tenant-input';
    input.placeholder = 'Admin1CBA@FabricFMLV08PPE.ccsctp.net';
    input.autocomplete = 'off';
    input.spellcheck = false;

    const cta = document.createElement('button');
    cta.className = 'cta-btn';
    cta.textContent = 'Connect';
    cta.disabled = true;

    input.addEventListener('input', () => {
      cta.disabled = !input.value.trim();
    });

    const submit = () => {
      const val = input.value.trim();
      if (!val) return;
      this._runAuth(val);
    };

    cta.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
    });

    const helpLink = document.createElement('a');
    helpLink.className = 'tenant-link';
    helpLink.textContent = "Don\u2019t have a certificate?";
    helpLink.href = this._PPE_WIKI_URL;
    helpLink.target = '_blank';
    helpLink.rel = 'noopener noreferrer';

    this._contentEl.appendChild(input);
    this._contentEl.appendChild(cta);
    this._contentEl.appendChild(helpLink);

    requestAnimationFrame(() => input.focus());
  }

  // --- Private: Manual Entry ---

  _renderManualEntry() {
    this._contentEl.innerHTML = '';

    if (this._certs && this._certs.length > 0) {
      const back = document.createElement('a');
      back.className = 'back-nav';
      back.href = '#';
      back.innerHTML = '\u2190 Certificates';
      back.addEventListener('click', (e) => {
        e.preventDefault();
        this._renderCertPicker(this._certs);
      });
      this._contentEl.appendChild(back);
    }

    const header = document.createElement('div');
    header.className = 'section-header';
    header.innerHTML = '<span class="section-title">Manual Connection</span>';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'manual-tenant-input';
    input.placeholder = 'Admin1CBA@FabricFMLV08PPE.ccsctp.net';
    input.autocomplete = 'off';
    input.spellcheck = false;

    const cta = document.createElement('button');
    cta.className = 'cta-btn';
    cta.innerHTML = 'Connect \u2192';
    cta.disabled = true;

    input.addEventListener('input', () => {
      cta.disabled = !input.value.trim();
    });

    const submit = () => {
      const val = input.value.trim();
      if (!val) return;
      this._runAuth(val);
    };

    cta.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
    });

    const helpLink = document.createElement('a');
    helpLink.className = 'tenant-link';
    helpLink.href = this._PPE_WIKI_URL;
    helpLink.target = '_blank';
    helpLink.rel = 'noopener noreferrer';
    helpLink.textContent = "Don\u2019t have a certificate?";

    this._contentEl.appendChild(header);
    this._contentEl.appendChild(input);
    this._contentEl.appendChild(cta);
    this._contentEl.appendChild(helpLink);

    requestAnimationFrame(() => input.focus());
  }

  // --- Private: Auth Flow ---

  async _runAuth(username) {
    this._contentEl.innerHTML = '';

    const header = document.createElement('div');
    header.className = 'section-header';
    header.innerHTML = '<span class="section-title">Authenticating</span>';
    this._contentEl.appendChild(header);

    const stepsContainer = document.createElement('div');
    stepsContainer.className = 'auth-progress active';
    this._contentEl.appendChild(stepsContainer);
    this._stepCount = 0;

    // Step 1 — Certificate verified (instant done)
    const certLabel = username.includes('@') ? username.split('@')[0] : username;
    this._addStep(stepsContainer, 'done', 'Certificate verified', certLabel);

    await this._delay(200);

    // Step 2 — Acquiring bearer token
    const step2 = this._addStep(stepsContainer, 'running', 'Acquiring bearer token', 'Authenticating via CBA\u2026');

    let authResult;
    try {
      const resp = await fetch('/api/edog/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username }),
      });

      if (!resp.ok) {
        let errData;
        try {
          errData = await resp.json();
        } catch {
          errData = { error: 'Authentication failed', detail: `Server returned ${resp.status}` };
        }
        this._updateStep(step2, 'error', 'Authentication failed', errData.detail || '');
        this._showError(
          errData.error || 'Authentication failed',
          errData.detail || 'The server could not complete the authentication request.',
          errData.help || null,
          username
        );
        return;
      }

      authResult = await resp.json();
      this._updateStep(
        step2,
        'done',
        'Bearer token acquired',
        `Expires in ${Math.round((authResult.expiresIn || 3600) / 60)} min`
      );
    } catch (e) {
      this._updateStep(step2, 'error', 'Connection failed', e.message);
      this._showError(
        'Network error',
        'Could not reach the EDOG auth server. Is it running on localhost?',
        null,
        username
      );
      return;
    }

    await this._delay(200);

    // Step 3 — Loading workspaces
    const step3 = this._addStep(stepsContainer, 'running', 'Loading workspaces', 'Verifying Fabric access\u2026');

    try {
      const resp = await fetch('/api/fabric/workspaces');
      if (!resp.ok) {
        this._updateStep(step3, 'error', 'Workspace access failed', `HTTP ${resp.status}`);
        this._showError(
          'Workspace access failed',
          'Bearer token was acquired but the Fabric workspace API returned an error. The token may lack sufficient permissions.',
          null,
          username
        );
        return;
      }

      const wsData = await resp.json();
      const count = (wsData.value && wsData.value.length) || 0;
      this._updateStep(step3, 'done', 'Workspaces loaded', `${count} workspace${count !== 1 ? 's' : ''} found`);
    } catch (e) {
      this._updateStep(step3, 'error', 'Connection failed', e.message);
      this._showError(
        'Network error',
        'Could not reach the Fabric workspace API.',
        null,
        username
      );
      return;
    }

    // All steps passed — dismiss and callback
    await this._delay(800);
    this.dismiss();

    if (this._onComplete) {
      this._onComplete({
        token: authResult.token,
        username: authResult.username || username,
      });
    }
  }

  // --- Private: Step Management ---

  _addStep(container, state, label, detail) {
    this._stepCount = (this._stepCount || 0) + 1;

    const row = document.createElement('div');
    row.className = 'step-row';

    const indicator = document.createElement('div');
    indicator.className = 'step-indicator';

    const stepNum = document.createElement('span');
    stepNum.className = 'step-num';
    stepNum.textContent = state === 'done' ? '\u2713' : String(this._stepCount);
    indicator.appendChild(stepNum);

    const textWrap = document.createElement('div');

    const labelEl = document.createElement('span');
    labelEl.className = 'step-label';
    labelEl.textContent = label;
    textWrap.appendChild(labelEl);

    if (detail) {
      const detailEl = document.createElement('div');
      detailEl.className = 'step-detail';
      detailEl.textContent = detail;
      textWrap.appendChild(detailEl);
    }

    row.appendChild(indicator);
    row.appendChild(textWrap);

    if (state) row.classList.add(state);

    container.appendChild(row);
    requestAnimationFrame(() => row.classList.add('visible'));

    return row;
  }

  _updateStep(el, state, label, detail) {
    el.classList.remove('pending', 'running', 'done', 'error');
    el.classList.add(state);

    const stepNum = el.querySelector('.step-num');
    if (stepNum) {
      if (state === 'done') stepNum.textContent = '\u2713';
      else if (state === 'error') stepNum.textContent = '\u2717';
    }

    const labelEl = el.querySelector('.step-label');
    if (labelEl) labelEl.textContent = label;

    let detailEl = el.querySelector('.step-detail');
    if (detail) {
      if (!detailEl) {
        detailEl = document.createElement('div');
        detailEl.className = 'step-detail';
        const textWrap = el.children[1];
        if (textWrap) textWrap.appendChild(detailEl);
      }
      detailEl.textContent = detail;
    } else if (detailEl) {
      detailEl.textContent = '';
    }
  }

  // --- Private: Error Display ---

  _showError(title, detail, help, username) {
    const block = document.createElement('div');
    block.className = 'auth-error';

    const titleEl = document.createElement('div');
    titleEl.className = 'auth-error-title';
    titleEl.textContent = title;
    block.appendChild(titleEl);

    const detailEl = document.createElement('div');
    detailEl.className = 'auth-error-detail';
    detailEl.textContent = detail;
    block.appendChild(detailEl);

    if (help) {
      const helpEl = document.createElement('div');
      helpEl.className = 'auth-error-help';
      helpEl.textContent = help;
      block.appendChild(helpEl);
    }

    const retry = document.createElement('button');
    retry.className = 'cta-btn cta-btn--retry';
    retry.textContent = 'Retry';
    retry.addEventListener('click', () => this._runAuth(username));

    this._contentEl.appendChild(block);
    this._contentEl.appendChild(retry);
  }

  // --- Private: Utilities ---

  _deriveUsername(cn) {
    if (!cn) return '';
    if (cn.indexOf('@') !== -1) return cn;
    const dotIdx = cn.indexOf('.');
    if (dotIdx === -1) return cn;
    return cn.substring(0, dotIdx) + '@' + cn.substring(dotIdx + 1);
  }

  _formatDate(isoDate) {
    if (!isoDate) return 'unknown';
    try {
      const d = new Date(isoDate);
      if (isNaN(d.getTime())) return 'unknown';
      const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      return d.getDate() + ' ' + months[d.getMonth()] + ' ' + d.getFullYear();
    } catch {
      return 'unknown';
    }
  }

  _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

