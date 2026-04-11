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
  async startDeploy(workspaceId, artifactId, capacityId, lakehouseName) {
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
        body: JSON.stringify({ workspaceId, artifactId, capacityId, lakehouseName }),
      });
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
        this._state.step = data.step;
        this._state.status = data.status === 'deploying' ? 'deploying' : data.status;
        this._state.message = data.message || '';
        this._state.error = data.error || null;
        this._state.fltPort = data.fltPort || null;

        if (data.log) {
          this._logs.push(data.log);
        }

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
        this._state.error = data.error || null;
        this._state.fltPort = data.fltPort || null;
      } catch { /* ignore */ }

      this._closeSSE();
      this._stopElapsedTimer();
      this._active = false;
      this._render();
      if (this.onUpdate) this.onUpdate(this._state);
    });

    this._es.onerror = () => {
      // EventSource auto-reconnects; 'complete' event handles terminal state
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

    let html = '<div class="deploy-stepper">';

    // Step circles
    html += '<div class="deploy-steps">';
    for (let i = 0; i < DeployFlow.STEPS.length; i++) {
      const s = DeployFlow.STEPS[i];
      let cls = 'deploy-step';
      let dot = String(i + 1);

      if (status === 'running') {
        cls = 'deploy-step done';
        dot = '\u2713';
      } else if (i < step) {
        cls += ' done';
        dot = '\u2713';
      } else if (i === step && status === 'deploying') {
        cls += ' active';
      } else if (i === step && status === 'stopped' && error) {
        cls += ' failed';
        dot = '\u2715';
      }

      html += '<div class="' + cls + '">';
      html += '<div class="deploy-step-dot">' + dot + '</div>';
      html += '<span class="deploy-step-label">' + this._esc(s.label) + '</span>';
      html += '</div>';
    }
    html += '</div>';

    // Progress bar
    const barCls = status === 'running' ? 'done' : (status === 'stopped' && error) ? 'failed' : '';
    html += '<div class="deploy-progress-bar"><div class="deploy-progress-fill ' + barCls + '" style="width:' + pct + '%"></div></div>';

    // Status row
    html += '<div class="deploy-status">';
    html += '<span class="deploy-status-msg">' + this._esc(message) + '</span>';
    html += '<div class="deploy-status-actions">';
    if (this._active) {
      html += '<span class="deploy-elapsed">' + elapsed + 's</span>';
      html += '<button class="deploy-cancel-btn" id="deploy-cancel">Cancel</button>';
    }
    if (status === 'stopped' && error) {
      html += '<button class="deploy-retry-btn" id="deploy-retry">Retry</button>';
    }
    html += '</div></div>';

    // Toggle details
    if (this._logs.length > 0 || this._active) {
      const arrow = this._terminalOpen ? '\u25B4' : '\u25BE';
      html += '<button class="deploy-toggle-details" id="deploy-toggle">' + (this._terminalOpen ? 'Hide' : 'Show') + ' details ' + arrow + '</button>';
    }

    // Terminal
    html += '<div class="deploy-terminal' + (this._terminalOpen ? ' open' : '') + '" id="deploy-terminal">';
    for (const l of this._logs) {
      const lvlCls = l.level === 'error' ? ' error' : l.level === 'warn' ? ' warn' : l.level === 'success' ? ' success' : '';
      html += '<div class="deploy-terminal-line' + lvlCls + '"><span class="ts">[' + this._esc(l.ts || '') + ']</span> ' + this._esc(l.msg || '') + '</div>';
    }
    html += '</div>';

    // Success banner
    if (status === 'running') {
      html += '<div class="deploy-success">';
      html += '<span>\u2713 Deployed successfully</span>';
      html += '<span class="deploy-success-meta">' + elapsed + 's</span>';
      if (fltPort) html += '<span class="deploy-success-meta">:' + fltPort + '</span>';
      html += '</div>';
    }

    // Error card
    if (status === 'stopped' && error) {
      html += '<div class="deploy-error">';
      html += '<div class="deploy-error-title">Deploy failed at step ' + (step + 1) + '</div>';
      html += '<div class="deploy-error-detail">' + this._esc(error) + '</div>';
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
      fetch('/api/studio/status').then(r => r.json()).then(s => {
        if (s.deployTarget) {
          const t = s.deployTarget;
          this.startDeploy(t.workspaceId, t.artifactId, t.capacityId, t.lakehouseName);
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
      toggle.textContent = (this._terminalOpen ? 'Hide' : 'Show') + ' details ' + (this._terminalOpen ? '\u25B4' : '\u25BE');
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

  _esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
}
