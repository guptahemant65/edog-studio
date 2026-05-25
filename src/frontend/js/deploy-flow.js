/**
 * DeployFlow — 5-step deploy stepper with SSE streaming and terminal.
 *
 * Uses EventSource (SSE) for real-time progress from the backend.
 * Renders into a container element. Supports resume on page refresh.
 *
 * @author Zara Okonkwo + Mika Tanaka — EDOG Studio hivemind
 */
class DeployFlow {
  constructor(containerEl) {
    this._el = containerEl;
    this._es = null;        // EventSource
    this._active = false;
    this._terminalOpen = false;
    this._terminalExpanded = false;
    this._followTail = true;
    this._wrap = true;
    this._copyToast = 0;
    this._logs = [];
    this._startTime = null;
    this._state = { step: 0, total: 5, status: 'idle', message: '', error: null, errorKind: null, errorDetail: null, fltPort: null };
    this._elapsedTimer = null;

    /** Callback: onUpdate({step, total, status, message, error, fltPort}) */
    this.onUpdate = null;
  }

  static STEPS = [
    { id: 0, label: 'Fetch token' },
    { id: 1, label: 'Update config' },
    { id: 2, label: 'Patch + Build' },
    { id: 3, label: 'Launch service' },
    { id: 4, label: 'Ready check' },
  ];

  /** Start a new deploy. */
  async startDeploy(workspaceId, artifactId, capacityId, lakehouseName, force, workspaceName) {
    // Session Guard precheck — unless the user has already confirmed via the
    // collision modal, probe for active sessions on this capacity. If any
    // exist, show the collision modal and bail out of this call. The modal's
    // "Deploy Anyway" button will re-invoke startDeploy with _collisionConfirmed.
    if (!this._collisionConfirmed) {
      const sessions = await this._preDeployCheck();
      if (sessions && sessions.length > 0) {
        this._showCollisionModal(
          sessions,
          { workspaceId, artifactId, capacityId, lakehouseName, workspaceName, force }
        );
        return;
      }
    }
    this._collisionConfirmed = false;

    this._pendingTarget = { workspaceId, artifactId, capacityId, lakehouseName, workspaceName: workspaceName || '' };
    this._active = true;
    this._startTime = Date.now();
    this._logs = [];
    this._state = { step: 0, total: 5, status: 'deploying', message: 'Initiating deploy...', error: null, errorKind: null, errorDetail: null, fltPort: null };
    this._render();
    this._startElapsedTimer();

    try {
      const resp = await fetch('/api/command/deploy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, artifactId, capacityId, lakehouseName, workspaceName: workspaceName || '', force: !!force }),
      });

      if (resp.status === 409) {
        const err = await resp.json().catch(() => ({}));
        if (err.error === 'already_deployed') {
          this._showSwitchConfirm(err.currentTarget, { workspaceId, artifactId, capacityId, lakehouseName });
          return;
        }
        this._onFailed(err.message || 'Deploy already in progress');
        return;
      }
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ message: 'Deploy request failed' }));
        this._onFailed(err.message || 'Deploy request failed');
        return;
      }
      this._connectSSE();
    } catch (e) {
      this._onFailed('Network error: ' + e.message);
    }
  }

  /** Resume from existing state (page refresh recovery). */
  resume(state) {
    this._active = state.phase === 'deploying';
    this._startTime = state.deployStartTime ? state.deployStartTime * 1000 : Date.now();
    this._logs = (state.deployLogs || []).map(l => ({ ts: l.ts, msg: l.msg, level: l.level }));
    this._state = {
      step: state.deployStep || 0,
      total: state.deployTotal || 5,
      status: state.phase === 'deploying' ? 'deploying' : state.phase,
      message: state.deployMessage || '',
      error: state.deployError || null,
      errorKind: state.deployErrorKind || null,
      errorDetail: state.deployErrorDetail || null,
      fltPort: state.fltPort || null,
    };
    this._el.style.display = 'block';
    this._render();
    if (this._active) {
      this._startElapsedTimer();
      this._connectSSE();
    }
  }

  cancel() {
    fetch('/api/command/deploy-cancel', { method: 'POST' }).catch(() => {});
    this._closeSSE();
    this._stopElapsedTimer();
    this._active = false;
    this._state.status = 'stopped';
    this._state.message = 'Deploy cancelled';
    this._render();
    if (this.onUpdate) this.onUpdate(this._state);
  }

  isActive() { return this._active; }

  destroy() {
    this._closeSSE();
    this._stopElapsedTimer();
    this._el.innerHTML = '';
  }

  // ── SSE ──────────────────────────────────────

  _connectSSE() {
    this._closeSSE();
    this._es = new EventSource('/api/command/deploy-stream');

    this._es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        this._sseErrors = 0;
        const stepChanged = data.step !== this._state.step || data.status !== this._state.status;

        this._state.step = data.step;
        this._state.status = data.status === 'deploying' ? 'deploying' : data.status;
        this._state.message = data.message || '';
        this._state.error = data.error != null ? data.error : null;
        this._state.errorKind = data.errorKind != null ? data.errorKind : null;
        this._state.errorDetail = data.errorDetail != null ? data.errorDetail : null;
        this._state.fltPort = data.fltPort != null ? data.fltPort : this._state.fltPort;

        if (data.log) {
          this._logs.push(data.log);
          if (!stepChanged) {
            // Only a new log line — append incrementally
            this._appendLog(data.log);
            if (this.onUpdate) this.onUpdate(this._state);
            return;
          }
        }

        // Step or status changed — full re-render
        this._render();
        if (this.onUpdate) this.onUpdate(this._state);
      } catch { /* malformed event */ }
    };

    this._es.addEventListener('complete', (e) => {
      try {
        const data = JSON.parse(e.data);
        this._state.step = data.step;
        this._state.status = data.status;
        this._state.message = data.message || '';
        this._state.error = data.error != null ? data.error : null;
        this._state.errorKind = data.errorKind != null ? data.errorKind : null;
        this._state.errorDetail = data.errorDetail != null ? data.errorDetail : null;
        this._state.fltPort = data.fltPort != null ? data.fltPort : null;
      } catch { /* ignore */ }

      this._closeSSE();
      this._stopElapsedTimer();
      this._active = false;
      this._render();
      if (this.onUpdate) this.onUpdate(this._state);
    });

    this._es.onerror = () => {
      this._sseErrors = (this._sseErrors || 0) + 1;
      if (this._sseErrors >= 3 && this._active) {
        this._state.message = 'Connection lost — reconnecting...';
        this._render();
      }
    };
  }

  _closeSSE() {
    if (this._es) {
      this._es.close();
      this._es = null;
    }
  }

  // ── Elapsed timer ───────────────────────────

  _startElapsedTimer() {
    this._stopElapsedTimer();
    this._elapsedTimer = setInterval(() => {
      const el = this._el.querySelector('.deploy-elapsed');
      if (el && this._startTime) {
        el.textContent = Math.floor((Date.now() - this._startTime) / 1000) + 's';
      }
    }, 1000);
  }

  _stopElapsedTimer() {
    if (this._elapsedTimer) {
      clearInterval(this._elapsedTimer);
      this._elapsedTimer = null;
    }
  }

  // ── Render ──────────────────────────────────

  _render() {
    const { step, total, status, message, error, errorKind, errorDetail, fltPort } = this._state;
    const elapsed = this._startTime ? Math.floor((Date.now() - this._startTime) / 1000) : 0;
    const pct = status === 'running' ? 100 : status === 'stopped' && !error ? 0 : Math.min(((step + (status === 'deploying' ? 0.5 : 0)) / total) * 100, 100);

    // V2 Cinematic Deploy Card
    let html = '<div class="deploy-stepper">';

    // Cinema header
    html += '<div class="deploy-cinema-header">';
    if (status === 'deploying') {
      html += '<span class="deploy-cinema-title"><span class="deploy-pulse-ring"></span> Deploying\u2026</span>';
    } else if (status === 'running') {
      html += '<span class="deploy-cinema-title" style="color:var(--status-succeeded);">Deploy complete</span>';
    } else if (status === 'stopped' && error) {
      html += '<span class="deploy-cinema-title" style="color:var(--status-failed);">Deploy failed after ' + elapsed + 's</span>';
    } else {
      html += '<span class="deploy-cinema-title">' + this._esc(message) + '</span>';
    }
    html += '<span style="display:flex;align-items:center;gap:12px;font-family:var(--font-mono);font-size:12px;color:var(--text-muted);">';
    if (this._active) {
      html += '<span class="deploy-elapsed">' + elapsed + 's</span>';
      html += '<button class="deploy-cancel-btn" id="deploy-cancel">Cancel</button>';
    }
    if (status === 'stopped' && error) {
      html += '<button class="deploy-retry-btn" id="deploy-retry">Retry</button>';
    }
    html += '</span>';
    html += '</div>';

    // Step icons row with unique icons per step
    html += '<div class="deploy-steps">';
    const stepIcons = [
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M12 12h.01"/><path d="M17 12h.01"/><path d="M7 12h.01"/></svg>',
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/></svg>',
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>',
    ];
    const checkIcon = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>';
    const xIcon = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

    for (let i = 0; i < DeployFlow.STEPS.length; i++) {
      const s = DeployFlow.STEPS[i];
      let cls = 'deploy-step';
      let icon = stepIcons[i] || String(i + 1);

      if (status === 'running') {
        cls += ' done';
        icon = checkIcon;
      } else if (i < step) {
        cls += ' done';
        icon = checkIcon;
      } else if (i === step && status === 'deploying') {
        cls += ' active';
      } else if (i === step && status === 'stopped' && error) {
        cls += ' failed';
        icon = xIcon;
      }

      const connector = i < DeployFlow.STEPS.length - 1 ? '<span class="step-connector"></span>' : '';
      html += '<div class="' + cls + '">';
      html += '<div class="step-icon-wrap">' + icon + '</div>';
      html += '<span class="step-label">' + this._esc(s.label) + '</span>';
      html += connector;
      html += '</div>';
    }
    html += '</div>';

    // Progress bar
    const barCls = status === 'running' ? 'done' : (status === 'stopped' && error) ? 'failed' : '';
    html += '<div class="deploy-progress-bar"><div class="deploy-progress-fill ' + barCls + '" style="width:' + pct + '%"></div></div>';

    // Status message
    html += '<div class="deploy-status">';
    html += '<span class="deploy-status-msg">' + this._esc(message) + '</span>';
    html += '</div>';

    // Toggle details button
    if (this._logs.length > 0 || this._active) {
      html += '<button class="deploy-toggle-details' + (this._terminalOpen ? ' open' : '') + '" id="deploy-toggle">';
      html += '<span class="deploy-chevron">\u25B6</span> Build output';
      html += '</button>';
    }

    // V2 Terminal with titlebar, gutter line numbers, color-coded output
    const termCls = 'deploy-terminal'
      + (this._terminalOpen ? ' open' : '')
      + (this._terminalExpanded ? ' expanded' : '')
      + (this._wrap ? '' : ' nowrap');
    html += '<div class="' + termCls + '" id="deploy-terminal">';
    html += '<div class="deploy-terminal-titlebar">';
    html += '<span class="deploy-terminal-dot r"></span><span class="deploy-terminal-dot y"></span><span class="deploy-terminal-dot g"></span>';
    html += '<span class="deploy-terminal-bar-title">edog deploy</span>';
    html += '<div class="deploy-terminal-actions">';
    html += '<button class="deploy-terminal-btn' + (this._wrap ? ' active' : '') + '" id="deploy-term-wrap" type="button" title="Toggle word-wrap" aria-label="Toggle word-wrap" aria-pressed="' + (this._wrap ? 'true' : 'false') + '">';
    html += '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 7 21 7"/><path d="M3 12h15a3 3 0 0 1 0 6h-4"/><polyline points="17 15 14 18 17 21"/><polyline points="3 17 10 17"/></svg>';
    html += '</button>';
    html += '<button class="deploy-terminal-btn" id="deploy-term-copy" type="button" title="Copy logs" aria-label="Copy logs">';
    html += '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
    html += '<span class="deploy-term-toast" id="deploy-term-toast">Copied</span>';
    html += '</button>';
    html += '<button class="deploy-terminal-btn" id="deploy-term-clear" type="button" title="Clear logs" aria-label="Clear logs">';
    html += '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>';
    html += '</button>';
    html += '<button class="deploy-terminal-btn" id="deploy-term-expand" type="button" title="' + (this._terminalExpanded ? 'Collapse' : 'Expand') + '" aria-label="' + (this._terminalExpanded ? 'Collapse' : 'Expand') + '" aria-pressed="' + (this._terminalExpanded ? 'true' : 'false') + '">';
    if (this._terminalExpanded) {
      html += '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';
    } else {
      html += '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';
    }
    html += '</button>';
    html += '</div>';
    html += '</div>';
    html += '<div class="deploy-terminal-body">';
    for (let i = 0; i < this._logs.length; i++) {
      const l = this._logs[i];
      const lvlCls = l.level === 'error' ? ' error' : l.level === 'warn' ? ' warn' : l.level === 'success' ? ' success' : l.level === 'dim' ? ' dim' : '';
      html += '<div class="deploy-terminal-line' + lvlCls + '">';
      html += '<span class="term-gutter">' + (i + 1) + '</span>';
      html += '<span class="term-content"><span class="ts">' + this._esc(l.ts || '') + '</span> ' + this._esc(l.msg || '') + '</span>';
      html += '</div>';
    }
    html += '</div>';
    html += '<button class="deploy-term-jump" id="deploy-term-jump" type="button" title="Jump to latest" aria-label="Jump to latest">';
    html += '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>';
    html += '<span>Jump to latest</span>';
    html += '</button>';
    html += '</div>';

    // Error banner — pick rich card when we have a known failure kind,
    // otherwise fall back to the generic banner.
    if (status === 'stopped' && error) {
      if (errorKind === 'mwc_registration') {
        html += this._renderMwcFailureCard(errorDetail || {}, step);
      } else {
        html += '<div class="deploy-error-banner" style="margin-top:var(--space-3);">';
        html += '<span class="deploy-error-icon-wrap"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="9" x2="12" y2="13"/><circle cx="12" cy="17" r="0.5" fill="currentColor"/></svg></span>';
        html += '<div class="deploy-error-content">';
        html += '<div class="deploy-error-title">Deploy failed at step ' + (step + 1) + '</div>';
        html += '<div class="deploy-error-detail">' + this._esc(error) + '</div>';
        html += '</div></div>';
      }
    }

    // Success banner
    if (status === 'running') {
      html += '<div class="deploy-success">';
      html += '<span>\u2713 Deployed successfully</span>';
      html += '<span class="deploy-success-meta">' + elapsed + 's</span>';
      if (fltPort) html += '<span class="deploy-success-meta">:' + fltPort + '</span>';
      html += '</div>';
    }

    html += '</div>';
    this._el.innerHTML = html;
    this._bindEvents();
    this._bindTerminalScroll();

    // Auto-scroll terminal only when following tail
    if (this._terminalOpen && this._followTail) {
      const term = document.getElementById('deploy-terminal');
      if (term) term.scrollTop = term.scrollHeight;
    }
    this._updateJumpBadge();
  }

  _renderMwcFailureCard(detail, step) {
    // Rich error card for DevInstanceRegistrationFailedException — gives the
    // engineer something to act on instead of a generic "deploy failed" line.
    // Shows the actual MWC-side identifiers (capacity GUID, root activity ID,
    // cluster DNS) plus the four mitigation steps in priority order.
    const cap = detail.capacityGuid || '\u2014';
    const aid = detail.rootActivityId || '\u2014';
    const cluster = detail.clusterDns || '\u2014';
    const httpStatus = detail.httpStatus || 'InternalServerError';

    let h = '<div class="deploy-mwc-failure" role="alert" aria-live="polite" style="margin-top:var(--space-3);">';

    // Header
    h += '<div class="deploy-mwc-failure-header">';
    h += '<span class="deploy-mwc-failure-icon" aria-hidden="true">';
    h += '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';
    h += '</span>';
    h += '<div class="deploy-mwc-failure-titles">';
    h += '<div class="deploy-mwc-failure-title">Dev instance registration failed</div>';
    h += '<div class="deploy-mwc-failure-subtitle">MWC dev-relay returned ' + this._esc(httpStatus) + ' \u2014 not a workload bug</div>';
    h += '</div></div>';

    // What happened
    h += '<div class="deploy-mwc-failure-explain">';
    h += 'FLT booted and called MWC to register itself as a dev instance for your capacity. MWC accepted the call, attempted its own downstream call to the analysis-services frontend, and that downstream call failed. The registration itself is fine \u2014 the cluster is unhealthy or the routing entry is stale.';
    h += '</div>';

    // Mitigations
    h += '<ol class="deploy-mwc-failure-steps">';
    h += '<li><span class="deploy-mwc-step-num">1</span><div class="deploy-mwc-step-body"><strong>Retry the deploy.</strong> This error class is overwhelmingly transient \u2014 MWC\u2019s downstream call is the flakiest link and usually self-heals within seconds.</div></li>';
    h += '<li><span class="deploy-mwc-step-num">2</span><div class="deploy-mwc-step-body"><strong>Check for a colliding session.</strong> If another machine has registered a dev instance against this capacity, MWC won\u2019t let two register at once. The session-guard probe runs pre-deploy \u2014 check its output above.</div></li>';
    h += '<li><span class="deploy-mwc-step-num">3</span><div class="deploy-mwc-step-body"><strong>Pause &amp; resume the capacity.</strong> If retries keep failing, go to the Fabric admin portal, pause this capacity, wait for it to fully stop, then resume. This forces MWC to rebuild its routing entries.</div></li>';
    h += '<li><span class="deploy-mwc-step-num">4</span><div class="deploy-mwc-step-body"><strong>Verify outbound network.</strong> If you just changed VPN or network, the workload may not reach the cluster. Run <code>Test-NetConnection ' + this._esc(cluster) + ' -Port 443</code> in PowerShell to confirm.</div></li>';
    h += '</ol>';

    // Telemetry block
    h += '<div class="deploy-mwc-failure-telemetry">';
    h += '<div class="deploy-mwc-telemetry-title">For escalation, share these identifiers with MWC support:</div>';
    h += '<div class="deploy-mwc-telemetry-rows">';
    h += this._renderTelemetryRow('Capacity GUID', cap, 'mwc-copy-cap');
    h += this._renderTelemetryRow('MWC ActivityId', aid, 'mwc-copy-aid');
    h += this._renderTelemetryRow('Cluster DNS', cluster, 'mwc-copy-cluster');
    h += '</div>';
    h += '<span class="deploy-mwc-copy-toast" id="deploy-mwc-toast">Copied</span>';
    h += '</div>';

    h += '</div>';
    return h;
  }

  _renderTelemetryRow(label, value, btnId) {
    const safe = this._esc(value);
    let h = '<div class="deploy-mwc-telemetry-row">';
    h += '<span class="deploy-mwc-telemetry-label">' + this._esc(label) + '</span>';
    h += '<code class="deploy-mwc-telemetry-value">' + safe + '</code>';
    h += '<button type="button" class="deploy-mwc-telemetry-copy" id="' + btnId + '" data-copy="' + safe + '" aria-label="Copy ' + this._esc(label) + '">';
    h += '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
    h += '</button>';
    h += '</div>';
    return h;
  }

  _bindEvents() {
    const cancel = document.getElementById('deploy-cancel');
    if (cancel) cancel.addEventListener('click', () => this.cancel());

    const retry = document.getElementById('deploy-retry');
    if (retry) retry.addEventListener('click', () => {
      // Try to get deploy target from server state first
      fetch('/api/studio/status').then(r => r.json()).then(s => {
        if (s.deployTarget) {
          const t = s.deployTarget;
          this.startDeploy(t.workspaceId, t.artifactId, t.capacityId, t.lakehouseName);
        } else if (this._pendingTarget) {
          // Fallback: use the last known target from this session
          const t = this._pendingTarget;
          this.startDeploy(t.workspaceId, t.artifactId, t.capacityId, t.lakehouseName);
        } else {
          this._onFailed('No deploy target available — select a lakehouse and try again');
        }
      }).catch(() => {
        // Server unreachable — try local fallback
        if (this._pendingTarget) {
          const t = this._pendingTarget;
          this.startDeploy(t.workspaceId, t.artifactId, t.capacityId, t.lakehouseName);
        } else {
          this._onFailed('Cannot reach server — select a lakehouse and try again');
        }
      });
    });

    const toggle = document.getElementById('deploy-toggle');
    if (toggle) toggle.addEventListener('click', () => {
      this._terminalOpen = !this._terminalOpen;
      const term = document.getElementById('deploy-terminal');
      if (term) {
        term.classList.toggle('open', this._terminalOpen);
        if (this._terminalOpen && this._followTail) term.scrollTop = term.scrollHeight;
      }
      toggle.classList.toggle('open', this._terminalOpen);
      this._updateJumpBadge();
    });

    const expand = document.getElementById('deploy-term-expand');
    if (expand) expand.addEventListener('click', () => {
      this._terminalExpanded = !this._terminalExpanded;
      this._render();
    });

    const clear = document.getElementById('deploy-term-clear');
    if (clear) clear.addEventListener('click', () => {
      this._logs = [];
      this._followTail = true;
      this._render();
    });

    const copy = document.getElementById('deploy-term-copy');
    if (copy) copy.addEventListener('click', () => this._copyLogs());

    // MWC failure card — copy buttons for capacity GUID / activity ID / cluster
    const mwcCopyBtns = this._el.querySelectorAll('.deploy-mwc-telemetry-copy');
    mwcCopyBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const val = btn.getAttribute('data-copy') || '';
        if (!val || val === '\u2014') return;
        const copyFn = navigator.clipboard?.writeText
          ? navigator.clipboard.writeText(val)
          : Promise.reject(new Error('clipboard unavailable'));
        Promise.resolve(copyFn).then(() => {
          const toast = document.getElementById('deploy-mwc-toast');
          if (toast) {
            toast.classList.add('show');
            clearTimeout(this._mwcToastTimer);
            this._mwcToastTimer = setTimeout(() => toast.classList.remove('show'), 1500);
          }
        }).catch(() => { /* clipboard blocked — silently ignore */ });
      });
    });

    const wrap = document.getElementById('deploy-term-wrap');
    if (wrap) wrap.addEventListener('click', () => {
      this._wrap = !this._wrap;
      const term = document.getElementById('deploy-terminal');
      if (term) {
        term.classList.toggle('nowrap', !this._wrap);
        if (this._followTail) term.scrollTop = term.scrollHeight;
      }
      wrap.classList.toggle('active', this._wrap);
      wrap.setAttribute('aria-pressed', this._wrap ? 'true' : 'false');
    });

    const jump = document.getElementById('deploy-term-jump');
    if (jump) jump.addEventListener('click', () => {
      const term = document.getElementById('deploy-terminal');
      if (!term) return;
      this._followTail = true;
      term.scrollTop = term.scrollHeight;
      this._updateJumpBadge();
    });
  }

  _bindTerminalScroll() {
    const term = document.getElementById('deploy-terminal');
    if (!term || term._scrollBound) return;
    term._scrollBound = true;
    term.addEventListener('scroll', () => {
      const atBottom = (term.scrollHeight - term.scrollTop - term.clientHeight) < 4;
      this._followTail = atBottom;
      this._updateJumpBadge();
    }, { passive: true });
  }

  _updateJumpBadge() {
    const jump = document.getElementById('deploy-term-jump');
    if (!jump) return;
    const show = this._terminalOpen && !this._followTail && this._logs.length > 0;
    jump.classList.toggle('visible', show);
  }

  _copyLogs() {
    const text = this._logs.map(l => ((l.ts || '') + ' ' + (l.msg || '')).trim()).join('\n');
    const toast = document.getElementById('deploy-term-toast');
    const showToast = () => {
      if (!toast) return;
      toast.classList.add('visible');
      clearTimeout(this._copyToast);
      this._copyToast = setTimeout(() => toast.classList.remove('visible'), 1400);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(showToast).catch(() => this._copyLogsFallback(text, showToast));
    } else {
      this._copyLogsFallback(text, showToast);
    }
  }

  _copyLogsFallback(text, onDone) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      onDone();
    } catch (e) { /* clipboard unavailable */ }
  }

  _onFailed(message) {
    this._closeSSE();
    this._stopElapsedTimer();
    this._active = false;
    this._state.status = 'stopped';
    this._state.error = message;
    this._state.message = 'Deploy failed';
    this._render();
    if (this.onUpdate) this.onUpdate(this._state);
  }

  /**
   * Session Guard precheck — probe /api/edog/session-probe to see whether
   * deploying will disconnect other live EDOG sessions on this capacity.
   *
   * Returns an array of active sessions, or [] when:
   *   - no sessions are active
   *   - probe endpoint is unavailable (timeout / 404 / network error)
   *   - response is malformed
   *
   * Probe failures are treated as "no collision" so users can always deploy.
   * @returns {Promise<Array<object>>}
   */
  async _preDeployCheck() {
    const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    const timeoutId = ctrl ? setTimeout(() => ctrl.abort(), 2000) : null;
    try {
      const resp = await fetch('/api/edog/session-probe', {
        method: 'GET',
        signal: ctrl ? ctrl.signal : undefined,
      });
      if (!resp.ok) return [];
      const data = await resp.json();
      const sessions = (data && (data.sessions || data.value)) || [];
      this._collisionCapacity = (data && data.capacity) || null;
      return Array.isArray(sessions) ? sessions : [];
    } catch (_e) {
      return [];
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  /**
   * Show the deploy collision modal. "Deploy Anyway" sets _collisionConfirmed
   * and re-invokes startDeploy with the same target. "Cancel" closes the modal
   * with no side effects.
   */
  _showCollisionModal(sessions, retryArgs) {
    // Remove any existing overlay
    const old = document.getElementById('sg-collision-overlay');
    if (old) old.remove();

    const cap = this._collisionCapacity || {};
    const capName = cap.displayName || cap.name || retryArgs.capacityId || 'this capacity';
    const self = this;

    const overlay = document.createElement('div');
    overlay.id = 'sg-collision-overlay';
    overlay.className = 'sg-collision-overlay';

    const rowsHtml = sessions.map(function(s) {
      const osUser = self._esc(s.osUser || s.user || 'user');
      const machine = self._esc(s.machine || '');
      const lh = self._esc(s.lakehouseName || s.lakehouseId || '');
      const since = self._esc(self._sgFmtTime(s.connectedSince || s.connectedAt));
      const last = self._esc(self._sgFmtRelative(s.lastActivity));
      return (
        '<div class="sg-session-card">' +
          '<div class="sg-session-card-avatar">' + (osUser.charAt(0) || '?').toUpperCase() + '</div>' +
          '<div class="sg-session-card-body">' +
            '<div class="sg-session-card-name">' + osUser + (machine ? '@' + machine : '') + '</div>' +
            '<div class="sg-session-card-meta">' +
              (lh ? '<span>Lakehouse <b>' + lh + '</b></span>' : '') +
              (since ? '<span>Connected since <b>' + since + '</b></span>' : '') +
              (last ? '<span><span class="sg-activity-dot"></span>Last activity ' + last + '</span>' : '') +
            '</div>' +
          '</div>' +
        '</div>'
      );
    }).join('');

    overlay.innerHTML =
      '<div class="sg-collision-modal" role="dialog" aria-modal="true" aria-labelledby="sg-collision-title">' +
        '<div class="sg-collision-head">' +
          '<div class="sg-collision-icon">' +
            '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 2 21h20L12 3z"/><path d="M12 10v5"/><circle cx="12" cy="18" r="1" fill="currentColor"/></svg>' +
          '</div>' +
          '<div class="sg-collision-titles">' +
            '<div class="sg-collision-title" id="sg-collision-title">\u26A0 Active sessions on ' + self._esc(capName) + '</div>' +
            '<div class="sg-collision-sub">Deploying will restart the FLT service and disconnect all active EDOG sessions. Their unsaved DevMode state will be lost.</div>' +
          '</div>' +
          '<button class="sg-collision-close" aria-label="Close">\u2715</button>' +
        '</div>' +
        '<div class="sg-collision-body">' +
          '<div class="sg-session-list">' + rowsHtml + '</div>' +
        '</div>' +
        '<div class="sg-collision-foot">' +
          '<button class="sg-btn-ghost" data-sg-action="cancel">Cancel</button>' +
          '<button class="sg-btn-danger" data-sg-action="confirm">Deploy Anyway</button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(overlay);

    const close = function() {
      overlay.classList.add('closing');
      setTimeout(function() { if (overlay.parentNode) overlay.remove(); }, 220);
      document.removeEventListener('keydown', escClose);
    };
    function escClose(e) {
      if (e.key === 'Escape') close();
    }
    document.addEventListener('keydown', escClose);

    overlay.addEventListener('click', function(e) {
      if (e.target === overlay) close();
    });
    overlay.querySelector('.sg-collision-close').addEventListener('click', close);
    overlay.querySelector('[data-sg-action="cancel"]').addEventListener('click', close);
    overlay.querySelector('[data-sg-action="confirm"]').addEventListener('click', function() {
      close();
      self._collisionConfirmed = true;
      self.startDeploy(
        retryArgs.workspaceId,
        retryArgs.artifactId,
        retryArgs.capacityId,
        retryArgs.lakehouseName,
        retryArgs.force,
        retryArgs.workspaceName
      );
    });
  }

  _sgFmtTime(iso) {
    if (!iso) return '';
    try {
      const d = new Date(iso);
      if (isNaN(d.getTime())) return '';
      return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    } catch (_e) { return ''; }
  }

  _sgFmtRelative(iso) {
    if (!iso) return '';
    try {
      const d = new Date(iso);
      if (isNaN(d.getTime())) return '';
      const sec = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
      if (sec < 60) return 'just now';
      if (sec < 3600) return Math.floor(sec / 60) + 'm ago';
      if (sec < 86400) return Math.floor(sec / 3600) + 'h ago';
      return Math.floor(sec / 86400) + 'd ago';
    } catch (_e) { return ''; }
  }

  /** Show centered confirmation dialog for switching deploy target (design bible §27b). */
  _showSwitchConfirm(currentTarget, newTarget) {    this._stopElapsedTimer();
    this._active = false;
    const curName = currentTarget.lakehouseName || currentTarget.artifactId || 'current';
    const newName = newTarget.lakehouseName || newTarget.artifactId || 'new';

    // Remove any existing dialog
    const old = document.getElementById('deploy-switch-dialog');
    if (old) old.remove();

    const backdrop = document.createElement('div');
    backdrop.id = 'deploy-switch-dialog';
    backdrop.className = 'deploy-dialog-backdrop';
    backdrop.setAttribute('data-open', 'true');

    backdrop.innerHTML =
      '<div class="deploy-dialog-card">' +
        '<div class="deploy-dialog-icon">' +
          '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>' +
        '</div>' +
        '<div class="deploy-dialog-title">Switch deployment?</div>' +
        '<div class="deploy-dialog-body">' +
          'The current service will be stopped and redeployed to a new lakehouse.' +
        '</div>' +
        '<div class="deploy-dialog-compare">' +
          '<div class="deploy-dialog-target from">' +
            '<span class="deploy-dialog-label">Current</span>' +
            '<span class="deploy-dialog-name">' + this._esc(curName) + '</span>' +
            '<span class="deploy-dialog-id">' + this._esc(currentTarget.capacityId || '') + '</span>' +
          '</div>' +
          '<div class="deploy-dialog-arrow">\u2192</div>' +
          '<div class="deploy-dialog-target to">' +
            '<span class="deploy-dialog-label">New</span>' +
            '<span class="deploy-dialog-name">' + this._esc(newName) + '</span>' +
            '<span class="deploy-dialog-id">' + this._esc(newTarget.capacityId || '') + '</span>' +
          '</div>' +
        '</div>' +
        '<div class="deploy-dialog-actions">' +
          '<button class="deploy-dialog-btn ghost" id="deploy-switch-cancel">Cancel</button>' +
          '<button class="deploy-dialog-btn primary" id="deploy-switch-confirm">Switch \u0026 Deploy</button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(backdrop);

    document.getElementById('deploy-switch-confirm')?.addEventListener('click', () => {
      backdrop.remove();
      const t = this._pendingTarget;
      if (t) this.startDeploy(t.workspaceId, t.artifactId, t.capacityId, t.lakehouseName, true);
    });

    const dismiss = () => {
      backdrop.remove();
      // Don't change deploy state — the current service is still running
      // Just restore the deploy button for this lakehouse
      this._el.innerHTML = '';
      this._el.style.display = 'none';
      const btn = document.getElementById('ws-deploy-btn');
      if (btn) btn.style.display = '';
    };

    document.getElementById('deploy-switch-cancel')?.addEventListener('click', dismiss);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) dismiss(); });
    const onKey = (e) => { if (e.key === 'Escape') { dismiss(); document.removeEventListener('keydown', onKey); } };
    document.addEventListener('keydown', onKey);
  }

  /** Undeploy — stop the service and return to Phase 1. */
  async undeploy() {
    try {
      await fetch('/api/command/undeploy', { method: 'POST' });
    } catch { /* best effort */ }
    this._closeSSE();
    this._stopElapsedTimer();
    this._active = false;
    this._state = { step: 0, total: 5, status: 'idle', message: '', error: null, errorKind: null, errorDetail: null, fltPort: null };
    this._el.innerHTML = '';
    this._el.style.display = 'none';
    if (this.onUpdate) this.onUpdate({ status: 'idle' });
  }

  _appendLog(log) {
    const body = this._el.querySelector('.deploy-terminal-body');
    if (!body) return;
    const cls = log.level === 'error' ? ' error' : log.level === 'warn' ? ' warn' : log.level === 'success' ? ' success' : log.level === 'dim' ? ' dim' : '';
    const lineNum = body.children.length + 1;
    const line = document.createElement('div');
    line.className = 'deploy-terminal-line' + cls;
    line.innerHTML = '<span class="term-gutter">' + lineNum + '</span><span class="term-content"><span class="ts">' + this._esc(log.ts || '') + '</span> ' + this._esc(log.msg || '') + '</span>';
    body.appendChild(line);
    if (this._terminalOpen && this._followTail) {
      const term = document.getElementById('deploy-terminal');
      if (term) term.scrollTop = term.scrollHeight;
    }
    this._updateJumpBadge();
  }

  _esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
}
