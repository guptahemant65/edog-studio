/**
 * ConnectionSupervisor — single source of truth for the FLT SignalR connection.
 *
 * Owns the "desired connection state" decision based on dev-server studio
 * status. Replaces fragmented callers (topbar, main, workspace-explorer) that
 * each used to call ws.setPort / ws.connect on their own.
 *
 * Responsibilities:
 *   1. Poll /api/studio/status (faster during transitions).
 *   2. Reconcile: phase=running + fltPort → setPort + ensureConnected.
 *      phase=deploying/stopped/crashed → suppress reconnect & toast.
 *   3. Drive the "Session disconnected" toast with a 5s debounce, auto-dismiss
 *      on reconnect.
 *   4. Provide the only phase-aware Reconnect entrypoint.
 *
 * Wired in main.js. Available as window.edogConnectionSupervisor for callers
 * that need to nudge a reconciliation (e.g. deploy flow on success).
 */
class ConnectionSupervisor {
  constructor(ws) {
    this._ws = ws;
    this._lastPhase = null;
    this._lastPort = null;
    this._toastDebounceTimer = null;
    this._toastShown = false;
    this._statusUnsub = null;
    this._pollTimer = null;
    this._pollIntervalMs = 30000;     // steady-state polling
    this._fastPollIntervalMs = 5000;  // during transitions
    this._fastPollDeadline = 0;       // wall-clock ms; while > now(), fast poll
    this._lastStatusReason = null;
    this._currentStatus = ws ? ws.status : 'disconnected';
  }

  start() {
    if (!this._ws) return;

    // Install retry gate: SignalRManager's outer retry consults this before
    // every reconnect attempt. Suppress while deploying/stopped/crashed.
    this._ws.setShouldRetryHook((_reason) => this._canRetryNow());

    // Subscribe to status changes through the modern listener API.
    this._statusUnsub = this._ws.addStatusListener((status, reason) => {
      this._onStatusChange(status, reason);
    });

    // Initial poll + interval.
    this._poll();
  }

  stop() {
    if (this._statusUnsub) { this._statusUnsub(); this._statusUnsub = null; }
    if (this._pollTimer) { clearTimeout(this._pollTimer); this._pollTimer = null; }
    if (this._toastDebounceTimer) {
      clearTimeout(this._toastDebounceTimer);
      this._toastDebounceTimer = null;
    }
  }

  /**
   * Public reconnect entrypoint. Phase-aware: refuses during deploy/stopped.
   * Called by:
   *   - The "Session disconnected" toast Reconnect button
   *   - Logs-tab activation fallback (main.js)
   *   - Anywhere else that previously called ws.connect() directly
   */
  requestReconnect(reason) {
    if (!this._canRetryNow()) {
      console.log('[Supervisor] reconnect suppressed; phase=', this._lastPhase);
      return Promise.resolve(false);
    }
    this._ws.enableRetries();
    // Bump to fast-poll for ~30s so we converge quickly if the user is
    // mid-deploy and the next poll would otherwise be 30s away.
    this._enterFastPoll(30000);
    return this._ws.ensureConnected(reason || 'manual-reconnect');
  }

  /**
   * Called externally when a deploy completes successfully. Faster than
   * waiting for the next status poll.
   */
  onDeployComplete(fltPort) {
    this._lastPhase = 'running';
    if (fltPort != null) {
      this._ws.setPort(fltPort);
      this._lastPort = fltPort;
    }
    this._ws.enableRetries();
    this._ws.ensureConnected('deploy-complete');
    this._enterFastPoll(15000);
  }

  /** Force a status poll right now (e.g. after a Restart click). */
  pokeNow() {
    this._poll();
  }

  // ===== INTERNALS =====

  _canRetryNow() {
    const phase = this._lastPhase;
    if (phase === 'deploying' || phase === 'stopped' || phase === 'crashed') {
      return false;
    }
    return true;
  }

  _enterFastPoll(durationMs) {
    this._fastPollDeadline = Date.now() + durationMs;
    if (this._pollTimer) {
      clearTimeout(this._pollTimer);
      this._pollTimer = null;
    }
    // Trigger a poll immediately to compress the latency.
    this._poll();
  }

  async _poll() {
    let next = this._pollIntervalMs;
    try {
      const resp = await fetch('/api/studio/status');
      if (resp.ok) {
        const s = await resp.json();
        this._reconcile(s);
        if (Date.now() < this._fastPollDeadline) {
          next = this._fastPollIntervalMs;
        }
      }
    } catch (_e) {
      // Dev-server polling failure — ignore. Don't change SignalR state on a
      // transient fetch error; the existing SignalR connection (if any) is
      // unaffected by dev-server health.
    } finally {
      // Always schedule the next poll, even on error.
      this._pollTimer = setTimeout(() => this._poll(), next);
    }
  }

  _reconcile(status) {
    const phase = status && status.phase;
    const port = status && status.fltPort;
    const phaseChanged = phase !== this._lastPhase;
    this._lastPhase = phase;

    if (phaseChanged) {
      // Transitions are noisy — fast-poll for 15s either way.
      this._enterFastPoll(15000);
    }

    if (phase === 'running' && port != null) {
      // Always update the port first (no-op if unchanged), then ensure connected.
      if (port !== this._lastPort) {
        this._ws.setPort(port);
        this._lastPort = port;
      } else if (this._currentStatus !== 'connected') {
        // Same port but we're not connected — converge.
        this._ws.setPort(port);
      }
      this._ws.enableRetries();
      this._ws.ensureConnected('reconcile-running');
      // If we were showing a "Session disconnected" toast and we just hit
      // running, the SignalR status change will handle dismissal. But if a
      // user manually clears the connection while phase=running, this path
      // also handles re-establishing.
    } else if (phase === 'deploying' || phase === 'stopped' || phase === 'crashed') {
      // Suppress toast during these phases — disconnection is expected.
      this._dismissToast('phase-' + phase);
    }
  }

  _onStatusChange(status, reason) {
    this._currentStatus = status;
    this._lastStatusReason = reason;
    if (status === 'connected') {
      // Reconnected — dismiss any sticky toast and cancel pending debounce.
      this._dismissToast('reconnected');
    } else if (status === 'disconnected' || status === 'reconnecting') {
      this._maybeStartToastDebounce();
    }
  }

  /**
   * Start a 5s debounce. If we're still disconnected at the end, show the
   * sticky toast. If phase changes to non-running during the wait, suppress.
   */
  _maybeStartToastDebounce() {
    if (this._toastDebounceTimer || this._toastShown) return;
    // If phase is not running, don't ever show a "Session disconnected" toast —
    // the user already knows (they triggered deploy / things crashed).
    if (this._lastPhase !== 'running' && this._lastPhase !== null) return;
    this._toastDebounceTimer = setTimeout(() => {
      this._toastDebounceTimer = null;
      // Re-check at the end of the debounce — conditions may have changed.
      if (this._currentStatus === 'connected') return;
      if (this._lastPhase && this._lastPhase !== 'running') return;
      this._showToast();
    }, 5000);
  }

  _showToast() {
    if (typeof window.edogToast !== 'function') return;
    const self = this;
    window.edogToast(
      'Session disconnected — reconnecting to FLT runtime.',
      'warning',
      {
        id: 'sg-disconnect',
        duration: 0,
        action: {
          label: 'Reconnect',
          onClick: function() { self.requestReconnect('toast-button'); }
        }
      }
    );
    this._toastShown = true;
  }

  _dismissToast(_reason) {
    if (this._toastDebounceTimer) {
      clearTimeout(this._toastDebounceTimer);
      this._toastDebounceTimer = null;
    }
    if (this._toastShown && window.edogToastManager
        && typeof window.edogToastManager.dismiss === 'function') {
      try { window.edogToastManager.dismiss('sg-disconnect'); }
      catch (_e) { /* dismiss is best-effort */ }
    }
    this._toastShown = false;
  }
}
