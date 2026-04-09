/**
 * OnboardingScreen — Full-screen auth overlay for first-time and expired-token flows.
 *
 * Lifecycle: check health → scan certs → auto-select or show picker →
 * Silent CBA auth → verify workspace access → dismiss → dashboard.
 *
 * Zara Okonkwo — vanilla JS, class-based module.
 */
class OnboardingScreen {
  constructor() {
    this._overlay = null;
    this._contentEl = null;
    this._titleEl = null;
    this._subtitleEl = null;
    this._onComplete = null;
    this._selectedCert = null;

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

    // Status bar
    const statusBar = document.createElement('div');
    statusBar.className = 'onboarding-status-bar';
    const statusLeft = document.createElement('span');
    statusLeft.textContent = 'EDOG PLAYGROUND \u2014 v2.0';
    const statusRight = document.createElement('span');
    statusRight.textContent = 'SECURE CONNECTION';
    statusBar.appendChild(statusLeft);
    statusBar.appendChild(statusRight);

    // Watermark
    const watermark = document.createElement('div');
    watermark.className = 'onboarding-watermark';
    watermark.textContent = 'EDOG_PLAYGROUND_V2';

    // Left panel
    const left = document.createElement('div');
    left.className = 'onboarding-left';

    const category = document.createElement('div');
    category.className = 'onboarding-category';
    category.textContent = 'Authentication';

    const title = document.createElement('div');
    title.className = 'onboarding-title';
    title.textContent = 'SELECT CERTIFICATE.';

    const subtitle = document.createElement('div');
    subtitle.className = 'onboarding-subtitle';
    subtitle.textContent = 'Choose a certificate to authenticate with the Fabric service.';

    const content = document.createElement('div');
    content.id = 'onb-content';

    left.appendChild(watermark);
    left.appendChild(category);
    left.appendChild(title);
    left.appendChild(subtitle);
    left.appendChild(content);

    // Right panel
    const right = document.createElement('div');
    right.className = 'onboarding-right';

    const rightFooter = document.createElement('div');
    rightFooter.className = 'onboarding-right-footer';

    const rightText = document.createElement('div');
    rightText.className = 'onboarding-right-text';
    rightText.textContent =
      'Developer cockpit for FabricLiveTable. ' +
      'Browse workspaces, manage feature flags, inspect DAGs, and debug live services.';

    const rightVersion = document.createElement('div');
    rightVersion.className = 'onboarding-right-version';
    rightVersion.textContent = 'EDOG Studio v2.0';

    rightFooter.appendChild(rightText);
    rightFooter.appendChild(rightVersion);
    right.appendChild(rightFooter);

    overlay.appendChild(statusBar);
    overlay.appendChild(left);
    overlay.appendChild(right);

    this._overlay = overlay;
    this._contentEl = content;
    this._titleEl = title;
    this._subtitleEl = subtitle;
  }

  // --- Private: Cert Picker ---

  _renderCertPicker(certs) {
    // Sort by expiry descending (newest expiry first)
    const sorted = certs.slice().sort(function (a, b) {
      return new Date(b.notAfter) - new Date(a.notAfter);
    });

    this._titleEl.textContent = 'SELECT CERTIFICATE.';
    this._subtitleEl.textContent =
      'Multiple certificates were found on this machine. Choose one to authenticate.';

    this._selectedCert = sorted[0];
    this._contentEl.innerHTML = '';

    const list = document.createElement('div');
    list.className = 'cert-list';

    const items = [];
    sorted.forEach(function (cert, idx) {
      const item = document.createElement('div');
      item.className = 'cert-item' + (idx === 0 ? ' selected' : '');

      const radio = document.createElement('div');
      radio.className = 'cert-item-radio';

      const info = document.createElement('div');

      const cn = document.createElement('div');
      cn.className = 'cert-item-cn';
      cn.textContent = cert.cn || cert.subject || cert.thumbprint;

      const expiry = document.createElement('div');
      expiry.className = 'cert-item-expiry';
      expiry.textContent = 'Expires ' + this._formatDate(cert.notAfter);

      info.appendChild(cn);
      info.appendChild(expiry);
      item.appendChild(radio);
      item.appendChild(info);

      item.addEventListener('click', function () {
        items.forEach(function (i) { i.classList.remove('selected'); });
        item.classList.add('selected');
        this._selectedCert = cert;
      }.bind(this));

      items.push(item);
      list.appendChild(item);
    }.bind(this));

    const cta = document.createElement('button');
    cta.className = 'onboarding-cta';
    cta.textContent = 'CONTINUE';
    cta.addEventListener('click', function () {
      if (!this._selectedCert) return;
      const username = this._deriveUsername(this._selectedCert.cn);
      this._runAuth(username);
    }.bind(this));

    const manualLink = document.createElement('div');
    manualLink.className = 'manual-tenant-link';
    manualLink.textContent = 'Connect to a different tenant';
    manualLink.addEventListener('click', function () {
      this._renderManualEntry();
    }.bind(this));

    this._contentEl.appendChild(list);
    this._contentEl.appendChild(cta);
    this._contentEl.appendChild(manualLink);
  }

  // --- Private: No Certs ---

  _renderNoCerts() {
    this._titleEl.textContent = 'NO CERTIFICATE FOUND.';
    this._subtitleEl.textContent =
      'No client certificates were detected. Enter your CBA username manually to authenticate.';
    this._contentEl.innerHTML = '';

    const inputWrap = document.createElement('div');
    inputWrap.style.marginBottom = 'var(--onb-space-6)';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'manual-tenant-input';
    input.placeholder = 'Admin1CBA@FabricFMLV08PPE.ccsctp.net';
    input.autocomplete = 'off';
    input.spellcheck = false;
    inputWrap.appendChild(input);

    const cta = document.createElement('button');
    cta.className = 'onboarding-cta';
    cta.textContent = 'CONNECT';
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
    helpLink.className = 'manual-tenant-link';
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
    this._titleEl.textContent = 'CONNECT MANUALLY.';
    this._subtitleEl.textContent =
      'Enter the full CBA username for the tenant you want to connect to.';
    this._contentEl.innerHTML = '';

    const inputWrap = document.createElement('div');
    inputWrap.style.marginBottom = 'var(--onb-space-6)';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'manual-tenant-input';
    input.placeholder = 'Admin1CBA@FabricFMLV08PPE.ccsctp.net';
    input.autocomplete = 'off';
    input.spellcheck = false;
    inputWrap.appendChild(input);

    const cta = document.createElement('button');
    cta.className = 'onboarding-cta';
    cta.textContent = 'CONNECT';
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
    helpLink.className = 'manual-tenant-link';
    helpLink.textContent = "Don\u2019t have a certificate?";
    helpLink.href = this._PPE_WIKI_URL;
    helpLink.target = '_blank';
    helpLink.rel = 'noopener noreferrer';
    helpLink.style.display = 'block';

    this._contentEl.appendChild(inputWrap);
    this._contentEl.appendChild(cta);
    this._contentEl.appendChild(helpLink);

    requestAnimationFrame(function () { input.focus(); });
  }

  // --- Private: Auth Flow ---

  async _runAuth(username) {
    this._titleEl.textContent = 'AUTHENTICATING.';
    this._subtitleEl.textContent = 'Establishing secure connection to Fabric services.';
    this._contentEl.innerHTML = '';

    const steps = document.createElement('div');
    steps.className = 'auth-steps';
    this._contentEl.appendChild(steps);

    // Step 1 — Certificate found (instant done)
    const certLabel = username.includes('@') ? username.split('@')[0] : username;
    const step1 = this._addStep(steps, 'done', 'Certificate found', certLabel);

    await this._delay(200);

    // Step 2 — Acquiring bearer token
    const step2 = this._addStep(steps, 'spinning', 'Acquiring bearer token', 'Authenticating via CBA\u2026');

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
    const step3 = this._addStep(steps, 'spinning', 'Loading workspaces', 'Verifying Fabric access\u2026');

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
   * Create an auth-step element and append it to the container.
   * @param {HTMLElement} container - The .auth-steps wrapper.
   * @param {'pending'|'spinning'|'done'|'error'} state - Initial state.
   * @param {string} label - Step label text.
   * @param {string} [detail] - Optional detail text.
   * @returns {HTMLElement} The step element.
   */
  _addStep(container, state, label, detail) {
    const step = document.createElement('div');
    step.className = 'auth-step';

    const icon = document.createElement('div');
    icon.className = 'auth-step-icon ' + state;

    const labelEl = document.createElement('div');
    labelEl.className = 'auth-step-label';
    labelEl.textContent = label;

    step.appendChild(icon);
    step.appendChild(labelEl);

    if (detail) {
      const detailEl = document.createElement('div');
      detailEl.className = 'auth-step-detail';
      detailEl.textContent = detail;
      step.appendChild(detailEl);
    }

    container.appendChild(step);
    return step;
  }

  /**
   * Update an existing step's icon state, label, and detail.
   * @param {HTMLElement} el - The .auth-step element.
   * @param {'pending'|'spinning'|'done'|'error'} state - New state.
   * @param {string} label - New label text.
   * @param {string} [detail] - New detail text.
   */
  _updateStep(el, state, label, detail) {
    const icon = el.querySelector('.auth-step-icon');
    if (icon) {
      icon.className = 'auth-step-icon ' + state;
    }

    const labelEl = el.querySelector('.auth-step-label');
    if (labelEl) labelEl.textContent = label;

    let detailEl = el.querySelector('.auth-step-detail');
    if (detail) {
      if (!detailEl) {
        detailEl = document.createElement('div');
        detailEl.className = 'auth-step-detail';
        el.appendChild(detailEl);
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
    retry.className = 'onboarding-cta';
    retry.textContent = 'RETRY';
    retry.style.marginTop = 'var(--onb-space-6)';
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
