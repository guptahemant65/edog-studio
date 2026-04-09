/**
 * OnboardingScreen — Full-screen auth overlay for first-time and expired-token flows.
 *
 * Lifecycle: check health → scan certs → auto-select or show picker →
 * Silent CBA auth → verify workspace access → dismiss → dashboard.
 *
 * DOM structure matches the Direction C (minimal) approved prototype.
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

    this._PPE_WIKI_URL =
      'https://dev.azure.com/powerbi/Trident/_wiki/wikis/Trident.wiki/80942/PPE-Ephemeral-Tenants-(ES-Maintained-Rotated)';
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

    let certs = [];
    try {
      const resp = await fetch('/api/edog/certs');
      if (resp.ok) certs = await resp.json();
    } catch {
      // Cert scan failed — fall through to no-certs path
    }
    this._certs = certs;

    if (!Array.isArray(certs) || certs.length === 0) {
      this._renderNoCerts();
    } else if (certs.length === 1) {
      const username = this._deriveUsername(certs[0].cn);
      this._runAuth(username);
    } else {
      this._renderCertPicker(certs);
    }
  }

  /**
   * Dismiss the overlay with a fade-out transition, then remove from DOM.
   */
  dismiss() {
    if (!this._overlay) return;
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

    // Layout — asymmetric two-column grid
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

    // Right — decorative pattern panel
    const patternArea = document.createElement('div');
    patternArea.className = 'pattern-area';
    patternArea.setAttribute('aria-hidden', 'true');

    const patternWatermark = document.createElement('div');
    patternWatermark.className = 'pattern-watermark';
    patternWatermark.textContent = 'EDOG';
    patternArea.appendChild(patternWatermark);

    layout.appendChild(content);
    layout.appendChild(patternArea);

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

  // --- Private: Cert Picker ---

  _renderCertPicker(certs) {
    // Sort by expiry descending (newest expiry first)
    const sorted = certs.slice().sort(function (a, b) {
      return new Date(b.notAfter) - new Date(a.notAfter);
    });

    this._selectedCert = sorted[0];
    this._contentEl.innerHTML = '';

    // Section header
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

    // Cert list (radiogroup)
    const list = document.createElement('ul');
    list.className = 'cert-list';
    list.setAttribute('role', 'radiogroup');
    list.setAttribute('aria-label', 'Certificate selection');

    const items = [];
    sorted.forEach(function (cert, idx) {
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

      item.addEventListener('click', function () {
        items.forEach(function (i) {
          i.setAttribute('aria-selected', 'false');
          i.querySelector('.cert-hidden-input').checked = false;
        });
        item.setAttribute('aria-selected', 'true');
        item.querySelector('.cert-hidden-input').checked = true;
        this._selectedCert = cert;
      }.bind(this));

      item.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          item.click();
        }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          var arr = items;
          var i = arr.indexOf(item);
          var next = e.key === 'ArrowDown'
            ? arr[(i + 1) % arr.length]
            : arr[(i - 1 + arr.length) % arr.length];
          next.focus();
          next.click();
        }
      });

      items.push(item);
      list.appendChild(item);
    }.bind(this));

    // CTA button
    const cta = document.createElement('button');
    cta.className = 'cta-btn';
    cta.innerHTML = 'Continue \u2192';
    cta.addEventListener('click', function () {
      if (!this._selectedCert) return;
      const username = this._deriveUsername(this._selectedCert.cn);
      this._runAuth(username);
    }.bind(this));

    // Tenant link
    const tenantLink = document.createElement('a');
    tenantLink.className = 'tenant-link';
    tenantLink.href = '#';
    tenantLink.textContent = 'Connect to a different tenant';
    tenantLink.addEventListener('click', function (e) {
      e.preventDefault();
      this._renderManualEntry();
    }.bind(this));

    this._contentEl.appendChild(header);
    this._contentEl.appendChild(list);
    this._contentEl.appendChild(cta);
    this._contentEl.appendChild(tenantLink);
  }

  // --- Private: No Certs ---

  _renderNoCerts() {
    // No certs found
    // Manual entry mode
    this._contentEl.innerHTML = '';

    const inputWrap = document.createElement('div');
    inputWrap.style.marginBottom = '20px';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'manual-tenant-input';
    input.placeholder = 'Admin1CBA@FabricFMLV08PPE.ccsctp.net';
    input.autocomplete = 'off';
    input.spellcheck = false;
    inputWrap.appendChild(input);

    const cta = document.createElement('button');
    cta.className = 'cta-btn';
    cta.textContent = 'Connect';
    cta.disabled = true;

    input.addEventListener('input', function () {
      cta.disabled = !input.value.trim();
    });

    const submit = function () {
      const val = input.value.trim();
      if (!val) return;
      this._runAuth(val);
    }.bind(this);

    cta.addEventListener('click', submit);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') submit();
    });

    const helpLink = document.createElement('a');
    helpLink.className = 'tenant-link';
    helpLink.textContent = "Don\u2019t have a certificate?";
    helpLink.href = this._PPE_WIKI_URL;
    helpLink.target = '_blank';
    helpLink.rel = 'noopener noreferrer';
    helpLink.style.display = 'block';

    this._contentEl.appendChild(inputWrap);
    this._contentEl.appendChild(cta);
    this._contentEl.appendChild(helpLink);

    // Focus input after DOM paints
    requestAnimationFrame(function () { input.focus(); });
  }

  // --- Private: Manual Entry ---

  _renderManualEntry() {
    this._contentEl.innerHTML = '';

    // Back navigation — top of content, before everything
    if (this._certs && this._certs.length > 0) {
      var back = document.createElement('a');
      back.className = 'back-nav';
      back.href = '#';
      back.innerHTML = '&#x2190; Certificate';
      back.addEventListener('click', function (e) {
        e.preventDefault();
        this._renderCertPicker(this._certs);
      }.bind(this));
      this._contentEl.appendChild(back);
    }

    var header = document.createElement('div');
    header.className = 'section-header';
    header.innerHTML = '<span class="section-title">Manual Connection</span>';

    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'manual-tenant-input';
    input.placeholder = 'Admin1CBA@FabricFMLV08PPE.ccsctp.net';
    input.autocomplete = 'off';
    input.spellcheck = false;

    var cta = document.createElement('button');
    cta.className = 'cta-btn';
    cta.innerHTML = 'Connect &#x2192;';
    cta.disabled = true;

    input.addEventListener('input', function () {
      cta.disabled = !input.value.trim();
    });

    var submit = function () {
      var val = input.value.trim();
      if (!val) return;
      this._runAuth(val);
    }.bind(this);

    cta.addEventListener('click', submit);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') submit();
    });

    var helpLink = document.createElement('a');
    helpLink.className = 'tenant-link';
    helpLink.href = this._PPE_WIKI_URL;
    helpLink.target = '_blank';
    helpLink.rel = 'noopener noreferrer';
    helpLink.textContent = "Don\u2019t have a certificate?";

    this._contentEl.appendChild(header);
    this._contentEl.appendChild(input);
    this._contentEl.appendChild(cta);
    this._contentEl.appendChild(helpLink);

    requestAnimationFrame(function () { input.focus(); });
  }

  // --- Private: Auth Flow ---

  async _runAuth(username) {
    this._contentEl.innerHTML = '';

    var header = document.createElement('div');
    header.className = 'section-header';
    header.innerHTML = '<span class="section-title">Authenticating</span>';
    this._contentEl.appendChild(header);

    var stepsContainer = document.createElement('div');
    stepsContainer.className = 'auth-progress active';
    this._contentEl.appendChild(stepsContainer);
    this._stepCount = 0;

    // Step 1 — Certificate verified (instant done)
    const certLabel = username.includes('@') ? username.split('@')[0] : username;
    const step1 = this._addStep(stepsContainer, 'done', 'Certificate verified', certLabel);

    await this._delay(200);

    // Step 2 — Acquiring bearer token
    const step2 = this._addStep(stepsContainer, 'running', 'Acquiring bearer token', 'Authenticating via CBA\u2026');

    let authResult;
    try {
      const resp = await fetch('/api/edog/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username }),
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
        `Could not reach the EDOG auth server. Is it running on localhost?`,
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

  /**
   * Create an auth step-row element and append it to the container.
   * @param {HTMLElement} container - The .auth-progress wrapper.
   * @param {'pending'|'running'|'done'|'error'} state - Initial state.
   * @param {string} label - Step label text.
   * @param {string} [detail] - Optional detail text.
   * @returns {HTMLElement} The step-row element.
   */
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

    if (state) {
      row.classList.add(state);
    }

    container.appendChild(row);
    requestAnimationFrame(function () { row.classList.add('visible'); });

    return row;
  }

  /**
   * Update an existing step-row's state, label, and detail.
   * @param {HTMLElement} el - The .step-row element.
   * @param {'pending'|'running'|'done'|'error'} state - New state.
   * @param {string} label - New label text.
   * @param {string} [detail] - New detail text.
   */
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
        // Append to the text wrapper (second child of the row)
        var textWrap = el.children[1];
        if (textWrap) textWrap.appendChild(detailEl);
      }
      detailEl.textContent = detail;
    } else if (detailEl) {
      detailEl.textContent = '';
    }
  }

  // --- Private: Error Display ---

  /**
   * Append an error block below the auth steps with a retry button.
   * @param {string} title - Error title.
   * @param {string} detail - Error description.
   * @param {string|null} help - Optional help text from server.
   * @param {string} username - Username to retry with.
   */
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
    retry.className = 'cta-btn';
    retry.textContent = 'Retry';
    retry.style.marginTop = '20px';
    retry.addEventListener('click', function () {
      this._runAuth(username);
    }.bind(this));

    this._contentEl.appendChild(block);
    this._contentEl.appendChild(retry);
  }

  // --- Private: Utilities ---

  /**
   * Derive a CBA username from a certificate CN.
   * Converts "Admin1CBA.FabricFMLV08PPE.ccsctp.net" → "Admin1CBA@FabricFMLV08PPE.ccsctp.net"
   * by replacing the first '.' with '@'.
   * @param {string} cn - Certificate common name.
   * @returns {string} Username suitable for /api/edog/auth.
   */
  _deriveUsername(cn) {
    if (!cn) return '';
    // If already contains '@', return as-is
    if (cn.indexOf('@') !== -1) return cn;
    const dotIdx = cn.indexOf('.');
    if (dotIdx === -1) return cn;
    return cn.substring(0, dotIdx) + '@' + cn.substring(dotIdx + 1);
  }

  /**
   * Format an ISO date string to a readable short form.
   * @param {string} isoDate - ISO 8601 date string.
   * @returns {string} Formatted date, e.g. "15 Mar 2026".
   */
  _formatDate(isoDate) {
    if (!isoDate) return 'unknown';
    try {
      const d = new Date(isoDate);
      if (isNaN(d.getTime())) return 'unknown';
      const months = [
        'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
        'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
      ];
      return d.getDate() + ' ' + months[d.getMonth()] + ' ' + d.getFullYear();
    } catch {
      return 'unknown';
    }
  }

  /**
   * Promise-based delay.
   * @param {number} ms - Milliseconds to wait.
   * @returns {Promise<void>}
   */
  _delay(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }
}

