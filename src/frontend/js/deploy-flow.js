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
    this._logs = [];
    this._startTime = null;
    this._state = { step: 0, total: 5, status: 'idle', message: '', error: null, fltPort: null };
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
  async startDeploy(workspaceId, artifactId, capacityId, lakehouseName, force) {
    this._pendingTarget = { workspaceId, artifactId, capacityId, lakehouseName };
    this._active = true;
    this._startTime = Date.now();
    this._logs = [];
    this._state = { step: 0, total: 5, status: 'deploying', message: 'Initiating deploy...', error: null, fltPort: null };
    this._render();
    this._startElapsedTimer();

    try {
      const resp = await fetch('/api/command/deploy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, artifactId, capacityId, lakehouseName, force: !!force }),
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
    const { step, total, status, message, error, fltPort } = this._state;
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
    html += '<div class="deploy-terminal' + (this._terminalOpen ? ' open' : '') + '" id="deploy-terminal">';
    html += '<div class="deploy-terminal-titlebar">';
    html += '<span class="deploy-terminal-dot r"></span><span class="deploy-terminal-dot y"></span><span class="deploy-terminal-dot g"></span>';
    html += '<span class="deploy-terminal-bar-title">edog deploy</span>';
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
    html += '</div></div>';

    // Error banner (V2 dramatic style)
    if (status === 'stopped' && error) {
      html += '<div class="deploy-error-banner" style="margin-top:var(--space-3);">';
      html += '<span class="deploy-error-icon-wrap"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="9" x2="12" y2="13"/><circle cx="12" cy="17" r="0.5" fill="currentColor"/></svg></span>';
      html += '<div class="deploy-error-content">';
      html += '<div class="deploy-error-title">Deploy failed at step ' + (step + 1) + '</div>';
      html += '<div class="deploy-error-detail">' + this._esc(error) + '</div>';
      html += '</div></div>';
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

    // Auto-scroll terminal
    if (this._terminalOpen) {
      const term = document.getElementById('deploy-terminal');
      if (term) term.scrollTop = term.scrollHeight;
    }
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
        if (this._terminalOpen) term.scrollTop = term.scrollHeight;
      }
      toggle.classList.toggle('open', this._terminalOpen);
    });
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

  /** Show centered confirmation dialog for switching deploy target (design bible §27b). */
  _showSwitchConfirm(currentTarget, newTarget) {
    this._stopElapsedTimer();
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
    this._state = { step: 0, total: 5, status: 'idle', message: '', error: null, fltPort: null };
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
    if (this._terminalOpen) {
      const term = document.getElementById('deploy-terminal');
      if (term) term.scrollTop = term.scrollHeight;
    }
  }

  _esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
}
