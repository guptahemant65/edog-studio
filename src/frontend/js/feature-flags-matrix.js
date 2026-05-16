/* ──────────────────────────────────────────────────────────────────────
 * Environment Panel — Card 3: Feature Flags Matrix
 * F11 / C03. Asymmetric force-ON override model (V1).
 *
 *   GET  /api/edog/feature-flags/catalog         — declared rows + FM enrichment
 *   GET  /api/edog/feature-flags/overrides       — current force-ON map
 *   POST /api/edog/feature-flags/overrides       — { flag, value: true }
 *   DELETE /api/edog/feature-flags/overrides/{flag}
 *   POST /api/edog/feature-flags/overrides/reset
 *   POST /api/edog/feature-flags/refresh         — force-resync FM cache
 *
 * Observation-class tracking comes from the SignalR `flag` topic — each event
 * has { wireKey, value, overridden } plus a sequence timestamp. We classify:
 *   - `live`        — at least one eval observed AFTER the most recent override mutation
 *   - `cached`      — last eval predates the most recent override (consumer captured pre-override)
 *   - `unobserved`  — no evaluations yet observed for this flag (default)
 * Honesty commitment (architecture §3.9): `unobserved` does NOT claim "wrapper
 * bypassed" — it only says we haven't seen a value yet.
 * ────────────────────────────────────────────────────────────────────── */
class FeatureFlagsMatrix {
  /**
   * @param {HTMLElement} mountEl
   * @param {SignalRManager} signalr
   */
  constructor(mountEl, signalr) {
    this._mount = mountEl;
    this._signalr = signalr;
    this._catalog = null;            // last catalog response
    this._overrides = {};            // wireKey → boolean (always true in V1)
    this._observations = new Map();  // wireKey → { lastEvalAt, lastOverrideAt, observationClass }
    this._lastOverrideMutationAt = 0;
    this._filterText = '';
    this._activeFilters = new Set(); // 'overridden' | 'partial' | 'missing'
    this._sovExpanded = false;
    this._initialized = false;
    this._destroyed = false;
    this._loadInFlight = false;
    this._onFlagEvent = this._onFlagEvent.bind(this);
  }

  /* ── Lifecycle ────────────────────────────────────────────────────── */

  activate() {
    if (!this._initialized) {
      this._renderShell();
      this._initialized = true;
    }
    this.load();
    if (this._signalr) {
      this._signalr.on('flag', this._onFlagEvent);
      try { this._signalr.subscribeTopic('flag'); } catch (_) { /* noop */ }
    }
  }

  deactivate() {
    if (this._signalr) {
      this._signalr.off('flag', this._onFlagEvent);
      try { this._signalr.unsubscribeTopic('flag'); } catch (_) { /* noop */ }
    }
  }

  destroy() {
    this._destroyed = true;
    if (this._syncPollTimer) {
      clearTimeout(this._syncPollTimer);
      this._syncPollTimer = null;
    }
    if (this._inspector) {
      this._inspector.destroy();
      this._inspector = null;
    }
    this.deactivate();
  }

  /* ── Flag Inspector ───────────────────────────────────────────────── */

  openInspector(wireKey) {
    if (!wireKey || !this._catalog) return;
    const row = (this._catalog.rows || []).find(r => r.wireKey === wireKey);
    if (!row) return;
    const matrixCard = this._mount.querySelector('#card-feature-flags');
    const placeholder = this._mount.querySelector('#ffPlaceholderCard');
    const inspectorMount = this._mount.querySelector('#ffInspectorMount');
    if (!inspectorMount) return;
    if (matrixCard) matrixCard.hidden = true;
    if (placeholder) placeholder.hidden = true;
    inspectorMount.hidden = false;
    if (!this._inspector) {
      this._inspector = new FlagInspector(inspectorMount, {
        catalog: this._catalog,
        overrides: this._overrides,
        onClose: () => this.closeInspector(),
        onOverrideSet: (k) => this.setOverride(k, true).then(() => this._refreshInspector()),
        onOverrideClear: (k) => this.clearOverride(k).then(() => this._refreshInspector()),
      });
    }
    this._inspector.show(row, {
      catalog: this._catalog,
      overrides: this._overrides,
    });
  }

  closeInspector() {
    const matrixCard = this._mount.querySelector('#card-feature-flags');
    const placeholder = this._mount.querySelector('#ffPlaceholderCard');
    const inspectorMount = this._mount.querySelector('#ffInspectorMount');
    if (this._inspector) this._inspector.hide();
    if (inspectorMount) inspectorMount.hidden = true;
    if (matrixCard) matrixCard.hidden = false;
    if (placeholder) placeholder.hidden = false;
  }

  _refreshInspector() {
    if (this._inspector && !this._inspector.isHidden()) {
      const wireKey = this._inspector.currentWireKey();
      if (wireKey) {
        const row = (this._catalog.rows || []).find(r => r.wireKey === wireKey);
        if (row) {
          this._inspector.show(row, {
            catalog: this._catalog,
            overrides: this._overrides,
          });
        }
      }
    }
  }

  /* ── Network ──────────────────────────────────────────────────────── */

  async load() {
    if (this._loadInFlight) return;
    this._loadInFlight = true;
    try {
      const [catalogResp, overridesResp] = await Promise.all([
        fetch('/api/edog/feature-flags/catalog').then(r => r.ok ? r.json() : Promise.reject(r)),
        fetch('/api/edog/feature-flags/overrides').then(r => r.ok ? r.json() : Promise.reject(r)),
      ]);
      this._catalog = catalogResp;
      this._overrides = overridesResp.overrides || {};
      this._render();
      this._maybeScheduleSyncPoll();
    } catch (err) {
      this._renderError(err);
    } finally {
      this._loadInFlight = false;
    }
  }

  _maybeScheduleSyncPoll() {
    const fm = (this._catalog && this._catalog.fm) || {};
    // While the FM clone is in flight (or we're cold with 0 indexed flags),
    // poll the catalog every 1.5s so the user doesn't sit on a wall of "?".
    const needsPoll = fm.syncInProgress === true || (fm.indexedCount === 0 && fm.stale === true);
    if (this._syncPollTimer) {
      clearTimeout(this._syncPollTimer);
      this._syncPollTimer = null;
    }
    if (!needsPoll || this._destroyed) return;
    this._syncPollTimer = setTimeout(() => {
      this._syncPollTimer = null;
      if (!this._destroyed) this.load();
    }, 1500);
  }

  async setOverride(wireKey, value) {
    // V1: only force-ON. Cleared via DELETE, not value=false.
    try {
      const resp = await fetch('/api/edog/feature-flags/overrides', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ flag: wireKey, value: !!value }),
      });
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        this._toast(`failed`, body.message || body.error || `HTTP ${resp.status}`);
        return;
      }
      const body = await resp.json();
      this._overrides = body.overrides || {};
      this._lastOverrideMutationAt = Date.now();
      this._showFltSyncToast(body.fltSync);
      this._render();
    } catch (err) {
      this._toast('failed', err.message || String(err));
    }
  }

  async clearOverride(wireKey) {
    try {
      const resp = await fetch(`/api/edog/feature-flags/overrides/${encodeURIComponent(wireKey)}`, {
        method: 'DELETE',
      });
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        this._toast('failed', body.message || body.error || `HTTP ${resp.status}`);
        return;
      }
      const body = await resp.json();
      this._overrides = body.overrides || {};
      this._lastOverrideMutationAt = Date.now();
      this._showFltSyncToast(body.fltSync);
      this._render();
    } catch (err) {
      this._toast('failed', err.message || String(err));
    }
  }

  async resetAll() {
    if (!confirm('Clear ALL feature-flag overrides for this session?')) return;
    try {
      const resp = await fetch('/api/edog/feature-flags/overrides/reset', { method: 'POST' });
      if (!resp.ok) return;
      const body = await resp.json();
      this._overrides = body.overrides || {};
      this._lastOverrideMutationAt = Date.now();
      this._showFltSyncToast(body.fltSync);
      this._render();
    } catch (err) {
      this._toast('failed', err.message || String(err));
    }
  }

  async refreshFM() {
    try {
      const resp = await fetch('/api/edog/feature-flags/refresh', { method: 'POST' });
      if (!resp.ok) return;
      // Poll once after a beat — sync runs on a background thread.
      setTimeout(() => this.load(), 1500);
    } catch (_) { /* noop */ }
  }

  /* ── Render ───────────────────────────────────────────────────────── */

  _renderShell() {
    this._mount.innerHTML = `
      <div class="environment-panel" id="environmentPanel">
        <div class="panel-header">
          <div>
            <div class="panel-title">Environment</div>
            <div class="panel-subtitle">Auth, deploy state, feature flags, and runtime config for this session.</div>
          </div>
        </div>

        <div class="env-card" id="card-feature-flags">
          <div class="env-card-header">
            <div class="env-card-title">
              <span>Feature Flags</span>
              <span class="card-badge" id="ffRowCount">— rows</span>
              <span class="fm-status" id="ffFmStatus"><span class="dot"></span><span class="label">FM cache: loading</span></span>
            </div>
            <div class="env-card-actions">
              <button class="env-btn" id="ffRefreshBtn" title="Re-sync FeatureManagement repo">Refresh FM</button>
              <button class="env-btn danger" id="ffResetBtn" title="Clear all overrides">Reset all overrides</button>
            </div>
          </div>

          <div class="override-strip" id="ffOverrideStrip">
            <span><span class="strip-count" id="ffStripCount">0</span><span class="strip-text"> override(s) active this session.</span></span>
            <span class="strip-chips" id="ffStripChips"></span>
            <span class="strip-hint">Applies to <strong>future</strong> evaluations only.</span>
          </div>

          <div class="ff-filterbar">
            <label class="ff-search">
              <span class="ff-search-icon" aria-hidden="true">&#128269;</span>
              <input type="text" id="ffFilterInput" placeholder="Filter by name or wire key" autocomplete="off">
            </label>
            <span class="ff-pill" data-filter="overridden">Overridden</span>
            <span class="ff-pill" data-filter="partial">Partial</span>
            <span class="ff-pill" data-filter="missing">Missing in FM</span>
            <span class="ff-spacer"></span>
            <span class="ff-pill" id="ffSovToggle" title="Show 8 sovereign envs as separate columns">Sov: folded</span>
          </div>

          <div class="ff-table-wrap" id="ffTableWrap">
            <div class="ff-empty"><span class="empty-glyph">&#9881;</span>Loading feature flags…</div>
          </div>

          <div class="ff-toast-strip" id="ffToast"></div>
        </div>

        <div class="flag-inspector-mount" id="ffInspectorMount" hidden></div>

        <div class="env-card" id="ffPlaceholderCard">
          <div class="env-card-header">
            <div class="env-card-title"><span>Configuration · Auth · Deploy</span><span class="card-badge">coming soon</span></div>
          </div>
          <div class="env-card-placeholder">Cards 1, 2, 4, 5 land in follow-up commits.</div>
        </div>
      </div>
    `;

    this._mount.querySelector('#ffRefreshBtn').addEventListener('click', () => this.refreshFM());
    this._mount.querySelector('#ffResetBtn').addEventListener('click', () => this.resetAll());
    this._mount.querySelector('#ffFilterInput').addEventListener('input', (e) => {
      this._filterText = (e.target.value || '').toLowerCase().trim();
      this._renderTable();
    });
    this._mount.querySelectorAll('.ff-pill[data-filter]').forEach(el => {
      el.addEventListener('click', () => {
        const key = el.dataset.filter;
        if (this._activeFilters.has(key)) this._activeFilters.delete(key);
        else this._activeFilters.add(key);
        el.classList.toggle('active');
        this._renderTable();
      });
    });
    const sovBtn = this._mount.querySelector('#ffSovToggle');
    sovBtn.addEventListener('click', () => {
      this._sovExpanded = !this._sovExpanded;
      sovBtn.classList.toggle('active', this._sovExpanded);
      sovBtn.textContent = this._sovExpanded ? 'Sov: expanded' : 'Sov: folded';
      this._renderTable();
    });
  }

  _render() {
    if (!this._catalog) return;
    this._renderHeader();
    this._renderStrip();
    this._renderTable();
  }

  _renderHeader() {
    const rc = this._catalog.rowCount || 0;
    this._mount.querySelector('#ffRowCount').textContent = `${rc} ${rc === 1 ? 'flag' : 'flags'}`;
    const fm = this._catalog.fm || {};
    const statusEl = this._mount.querySelector('#ffFmStatus');
    const labelEl = statusEl.querySelector('.label');
    statusEl.classList.remove('synced', 'syncing', 'stale', 'error');
    if (fm.error && !fm.indexedCount) {
      statusEl.classList.add('error');
      labelEl.textContent = `FM cache: ${fm.error}`;
    } else if (fm.syncInProgress) {
      statusEl.classList.add('syncing');
      labelEl.textContent = 'FM cache: syncing…';
    } else if (fm.stale && fm.indexedCount === 0) {
      statusEl.classList.add('stale');
      labelEl.textContent = 'FM cache: not yet synced — declared-only';
    } else if (fm.stale) {
      statusEl.classList.add('stale');
      labelEl.textContent = `FM cache: stale (${this._fmtAge(fm.cacheAgeSeconds)})`;
    } else {
      statusEl.classList.add('synced');
      labelEl.textContent = `FM cache: ${fm.indexedCount} flags (${this._fmtAge(fm.cacheAgeSeconds)} ago)`;
    }
  }

  _renderStrip() {
    const strip = this._mount.querySelector('#ffOverrideStrip');
    const keys = Object.keys(this._overrides);
    if (keys.length === 0) {
      strip.classList.remove('visible');
      return;
    }
    strip.classList.add('visible');
    this._mount.querySelector('#ffStripCount').textContent = String(keys.length);
    const chipsEl = this._mount.querySelector('#ffStripChips');
    chipsEl.innerHTML = '';
    keys.forEach(k => {
      const chip = document.createElement('span');
      chip.className = 'strip-chip';
      chip.innerHTML = `<span>${this._escape(k)}</span><span class="chip-x" title="Clear override">&#10005;</span>`;
      chip.querySelector('.chip-x').addEventListener('click', () => this.clearOverride(k));
      chipsEl.appendChild(chip);
    });
  }

  _renderTable() {
    if (!this._catalog) return;
    const wrap = this._mount.querySelector('#ffTableWrap');
    const rows = this._filterRows(this._catalog.rows || []);
    if (rows.length === 0) {
      wrap.innerHTML = '<div class="ff-empty"><span class="empty-glyph">&#9789;</span>No flags match the current filters.</div>';
      return;
    }
    const mainline = (this._catalog.workspace && this._catalog.workspace.mainlineEnvs) || [];
    const sovereign = (this._catalog.workspace && this._catalog.workspace.sovereignEnvs) || [];

    const header = `
      <thead>
        <tr>
          <th class="col-name">Flag</th>
          ${mainline.map(e => `<th class="col-env" title="${this._escape(e)}">${this._escape(e)}</th>`).join('')}
          <th class="col-sov-rollup" title="Sovereign rollup">Sov</th>
          ${sovereign.map(e => `<th class="col-sov" title="${this._escape(e)}">${this._escape(e)}</th>`).join('')}
          <th class="col-state">State</th>
          <th class="col-obs">Obs</th>
        </tr>
      </thead>
    `;

    const body = `<tbody>${rows.map(r => this._renderRow(r, mainline, sovereign)).join('')}</tbody>`;

    const fm = (this._catalog && this._catalog.fm) || {};
    const syncing = fm.syncInProgress === true || (fm.indexedCount === 0 && fm.stale === true);
    const tableCls = `ff-table ${this._sovExpanded ? 'sov-expanded' : ''}${syncing ? ' fm-syncing' : ''}`;
    wrap.innerHTML = `<table class="${tableCls.trim()}">${header}${body}</table>`;

    // Wire toggle clicks
    wrap.querySelectorAll('.ff-switch[data-flag]').forEach(sw => {
      sw.addEventListener('click', () => this._onSwitchClick(sw));
      sw.addEventListener('keydown', (e) => {
        if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); this._onSwitchClick(sw); }
      });
    });
    // Wire flag-name click -> open Flag Inspector
    wrap.querySelectorAll('.ff-name-link[data-flag]').forEach(link => {
      link.addEventListener('click', () => this.openInspector(link.dataset.flag));
      link.addEventListener('keydown', (e) => {
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
          this.openInspector(link.dataset.flag);
        }
      });
    });
  }

  _renderRow(row, mainline, sovereign) {
    const overridden = !!row.isOverridden;
    const rowCls = overridden ? 'overridden' : '';
    const mainCells = mainline.map(env => this._renderCell(row.perEnv[env] || { state: 'missing' }, '')).join('');
    const sovCells = sovereign.map(env => this._renderCell(row.perEnv[env] || { state: 'missing' }, 'sov')).join('');
    const sovRollup = `<td class="ff-cell ff-sov-rollup col-sov-rollup" title="${this._sovTooltip(row, sovereign)}">${this._sovGlyph(row, sovereign)}</td>`;

    const effective = row.effectiveForMyWorkspace;
    const effectiveLabel = overridden
      ? '<span class="ff-effective forced">FORCED</span>'
      : (effective ? '<span class="ff-effective on">on</span>' : '<span class="ff-effective off">off</span>');
    const switchCls = overridden ? 'ff-switch on' : 'ff-switch';

    const obsClass = this._observationClassFor(row.wireKey);
    const obsCell = `<span class="ff-obs ${obsClass}" title="${this._obsTooltip(obsClass)}">${obsClass}</span>`;

    const rowTitle = row.summary ? this._escape(row.summary) : this._escape(row.wireKey);

    return `
      <tr class="${rowCls}" data-flag="${this._escape(row.wireKey)}" title="${rowTitle}">
        <td class="col-name">
          <div class="ff-name-cell">
            <div class="ff-name-line">
              <span class="ff-name ff-name-link" data-flag="${this._escape(row.wireKey)}" tabindex="0" role="button" title="Open flag inspector">${this._escape(row.name)}</span>
              <span class="ff-wirekey">${this._escape(row.wireKey)}</span>
            </div>
          </div>
        </td>
        ${mainCells}
        ${sovRollup}
        ${sovCells}
        <td class="col-state">
          <div class="ff-toggle">
            <span class="${switchCls}" role="switch" aria-checked="${overridden}" tabindex="0" data-flag="${this._escape(row.wireKey)}" title="Click to ${overridden ? 'clear' : 'force-ON'} override"></span>
            ${effectiveLabel}
          </div>
        </td>
        <td class="col-obs">${obsCell}</td>
      </tr>
    `;
  }

  _renderCell(cell, kind) {
    const state = cell.state || 'missing';
    const glyphMap = { on: '&#10003;', off: '&#10005;', partial: '&#9680;', empty: '&#8211;', missing: '?' };
    const titleMap = {
      on: 'Enabled for this env',
      off: 'Explicitly disabled',
      partial: 'Targeted rollout',
      empty: 'Not deployed to this env',
      missing: 'Flag not found in FeatureManagement repo',
    };
    let title = titleMap[state] || state;
    if (state === 'partial' && Array.isArray(cell.targets) && cell.targets.length) {
      const summary = cell.targets.map(t => `${t.pivot || '?'} · ${t.valueCount || 0}`).join(', ');
      title = `Targeted rollout — ${summary}`;
    }
    if (cell.unevaluable) {
      title = 'Targeted rollout — cannot evaluate locally (RegionName / MemberOf)';
    }
    const inclMy = cell.includesMyWorkspace ? ' includes-my-ws' : '';
    const hatched = state === 'partial' && cell.unevaluable ? ' unevaluable' : '';
    const kindCls = kind ? ` ${kind}` : '';
    return `<td class="ff-cell state-${state}${inclMy}${hatched}${kindCls}" title="${title}">${glyphMap[state] || '?'}</td>`;
  }

  _sovGlyph(row, sovereign) {
    const states = sovereign.map(e => (row.perEnv[e] || {}).state || 'missing');
    if (states.includes('on')) return '<span style="color:var(--status-succeeded);">&#10003;</span>';
    if (states.includes('partial')) return '<span style="color:var(--level-warning);">&#9680;</span>';
    if (states.every(s => s === 'missing' || s === 'empty')) return '<span style="color:var(--text-muted);">&#8211;</span>';
    return '<span style="color:var(--text-muted);">&#10005;</span>';
  }

  _sovTooltip(row, sovereign) {
    return sovereign
      .map(e => `${e}: ${(row.perEnv[e] || {}).state || 'missing'}`)
      .join(' · ');
  }

  /* ── Filters ──────────────────────────────────────────────────────── */

  _filterRows(rows) {
    const txt = this._filterText;
    const filters = this._activeFilters;
    return rows.filter(r => {
      if (txt) {
        const hay = `${r.name} ${r.wireKey} ${r.summary || ''}`.toLowerCase();
        if (!hay.includes(txt)) return false;
      }
      if (filters.has('overridden') && !r.isOverridden) return false;
      if (filters.has('missing') && r.missingReason !== 'missing-in-fm') return false;
      if (filters.has('partial')) {
        const hasPartial = Object.values(r.perEnv || {}).some(c => c && c.state === 'partial');
        if (!hasPartial) return false;
      }
      return true;
    });
  }

  /* ── Switch click ─────────────────────────────────────────────────── */

  _onSwitchClick(sw) {
    if (sw.getAttribute('aria-disabled') === 'true') return;
    const flag = sw.dataset.flag;
    const currentlyOn = sw.classList.contains('on');
    if (currentlyOn) this.clearOverride(flag);
    else this.setOverride(flag, true);
  }

  /* ── SignalR event + observation classification ───────────────────── */

  _onFlagEvent(envelope) {
    const data = envelope && envelope.data;
    if (!data) return;
    const wireKey = data.featureName || data.wireKey;
    if (!wireKey) return;
    const now = Date.now();
    const obs = this._observations.get(wireKey) || { lastEvalAt: 0, lastResult: null };
    obs.lastEvalAt = now;
    obs.lastResult = !!data.result;
    obs.overridden = !!data.overridden;
    this._observations.set(wireKey, obs);
    // Re-paint the obs cell incrementally without a full table redraw.
    const cell = this._mount.querySelector(`tr[data-flag="${CSS.escape(wireKey)}"] .ff-obs`);
    if (cell) {
      const cls = this._observationClassFor(wireKey);
      cell.classList.remove('live', 'cached', 'unobserved');
      cell.classList.add(cls);
      cell.textContent = cls;
      cell.title = this._obsTooltip(cls);
    }
  }

  _observationClassFor(wireKey) {
    const obs = this._observations.get(wireKey);
    if (!obs || !obs.lastEvalAt) return 'unobserved';
    if (obs.lastEvalAt >= this._lastOverrideMutationAt) return 'live';
    return 'cached';
  }

  _obsTooltip(cls) {
    if (cls === 'live') return 'Latest evaluation observed AFTER the most recent override change.';
    if (cls === 'cached') return 'Latest evaluation predates the most recent override — consumer captured an old value.';
    return 'No evaluations observed yet (does NOT imply wrapper is bypassed).';
  }

  /* ── UI feedback ──────────────────────────────────────────────────── */

  _showFltSyncToast(sync) {
    if (!sync) return;
    const el = this._mount.querySelector('#ffToast');
    if (!el) return;
    el.classList.remove('applied', 'failed', 'not-connected');
    const fltSync = sync.fltSync;
    let msg = '';
    if (fltSync === 'applied') {
      msg = `✓ Pushed to FLT (rev ${sync.revision}, ${Math.round(sync.durationMs || 0)} ms)`;
      el.classList.add('applied');
    } else if (fltSync === 'not-connected') {
      msg = 'Saved locally — FLT is not running yet. Will replay when connected.';
      el.classList.add('not-connected');
    } else if (fltSync === 'failed') {
      msg = `⚠ FLT push failed: ${sync.error || 'unknown'} (rev ${sync.revision})`;
      el.classList.add('failed');
    } else {
      msg = `fltSync: ${fltSync}`;
    }
    el.textContent = msg;
    el.classList.add('visible');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => el.classList.remove('visible'), 5000);
  }

  _toast(kind, msg) {
    this._showFltSyncToast({ fltSync: kind, error: msg, revision: '?', durationMs: 0 });
  }

  _renderError(err) {
    const wrap = this._mount.querySelector('#ffTableWrap');
    const msg = err && err.statusText ? `${err.status} ${err.statusText}` : (err && err.message) || String(err);
    if (wrap) wrap.innerHTML = `<div class="ff-error">Failed to load feature flags: ${this._escape(msg)}</div>`;
  }

  /* ── Utilities ────────────────────────────────────────────────────── */

  _fmtAge(seconds) {
    if (seconds == null) return 'unknown age';
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    return `${Math.floor(seconds / 3600)}h`;
  }

  _trunc(s, n) {
    if (!s) return '';
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }

  _escape(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}

window.FeatureFlagsMatrix = FeatureFlagsMatrix;
