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
    this._active = false;
    this._loadInFlight = false;
    this._refreshInFlight = false;
    this._mutationsInFlight = new Set(); // wireKeys with in-flight POST/DELETE
    this._filterDebounceTimer = null;
    this._onFlagEvent = this._onFlagEvent.bind(this);
    this._onVisibilityChange = this._onVisibilityChange.bind(this);
  }

  /* ── Lifecycle ────────────────────────────────────────────────────── */

  activate() {
    if (this._active) return; // re-entry guard — avoids duplicate event listeners
    this._active = true;
    if (!this._initialized) {
      this._renderShell();
      this._initialized = true;
    }
    this.load();
    if (this._signalr) {
      this._signalr.on('flag', this._onFlagEvent);
      try { this._signalr.subscribeTopic('flag'); } catch (_) { /* noop */ }
    }
    document.addEventListener('visibilitychange', this._onVisibilityChange);
  }

  deactivate() {
    if (!this._active) return;
    this._active = false;
    if (this._signalr) {
      this._signalr.off('flag', this._onFlagEvent);
      try { this._signalr.unsubscribeTopic('flag'); } catch (_) { /* noop */ }
    }
    if (this._syncPollTimer) {
      clearTimeout(this._syncPollTimer);
      this._syncPollTimer = null;
    }
    if (this._filterDebounceTimer) {
      clearTimeout(this._filterDebounceTimer);
      this._filterDebounceTimer = null;
    }
    document.removeEventListener('visibilitychange', this._onVisibilityChange);
  }

  _onVisibilityChange() {
    if (document.hidden) {
      // Pause the sync poll while the user can't see the table — saves
      // catalog round-trips when the tab/window is backgrounded.
      if (this._syncPollTimer) {
        clearTimeout(this._syncPollTimer);
        this._syncPollTimer = null;
      }
    } else if (this._active) {
      // Resume by re-loading once; load() reschedules the poll if needed.
      this.load();
    }
  }

  destroy() {
    this._destroyed = true;
    if (this._syncPollTimer) {
      clearTimeout(this._syncPollTimer);
      this._syncPollTimer = null;
    }
    if (this._stripScrollCleanup) { this._stripScrollCleanup(); this._stripScrollCleanup = null; }
    if (this._badgeObserver) { this._badgeObserver.disconnect(); this._badgeObserver = null; }
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
    const inspectorMount = this._mount.querySelector('#ffInspectorMount');
    if (!inspectorMount) return;
    if (matrixCard) matrixCard.hidden = true;
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
    const inspectorMount = this._mount.querySelector('#ffInspectorMount');
    if (this._inspector) this._inspector.hide();
    if (inspectorMount) inspectorMount.hidden = true;
    if (matrixCard) matrixCard.hidden = false;
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
      // Server snapshot, MERGED with in-flight optimistic mutations so we
      // don't transiently revert a toggle the user just flipped while our
      // POST is still on the wire (race window ~50-300 ms).
      const serverOverrides = overridesResp.overrides || {};
      if (this._mutationsInFlight.size === 0) {
        this._overrides = serverOverrides;
      } else {
        const merged = { ...serverOverrides };
        for (const k of this._mutationsInFlight) {
          if (Object.prototype.hasOwnProperty.call(this._overrides, k)) {
            merged[k] = this._overrides[k];
          } else {
            delete merged[k];
          }
        }
        this._overrides = merged;
      }
      this._syncCatalogOverrideFlags();
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
    if (this._syncPollTimer) {
      clearTimeout(this._syncPollTimer);
      this._syncPollTimer = null;
    }
    if (this._destroyed || !this._active || document.hidden) return;
    // Stop polling when the FM cache has reported a terminal error and is
    // not in the middle of a retry. The user must click "Refresh FM" to
    // re-attempt — otherwise we'd hammer git endlessly every 500 ms.
    if (fm.error && !fm.syncInProgress) return;
    // While the FM clone is in flight (or we're cold with 0 indexed flags),
    // poll the catalog every 500 ms so the user doesn't sit on a wall of "?".
    const needsPoll = fm.syncInProgress === true || (fm.indexedCount === 0 && fm.stale === true);
    if (!needsPoll) return;
    this._syncPollTimer = setTimeout(() => {
      this._syncPollTimer = null;
      if (!this._destroyed && this._active && !document.hidden) this.load();
    }, 500);
  }

  async setOverride(wireKey, value) {
    // V1: only force-ON. Cleared via DELETE, not value=false.
    if (this._mutationsInFlight.has(wireKey)) return; // guard against double-click races
    const prev = Object.prototype.hasOwnProperty.call(this._overrides, wireKey)
      ? this._overrides[wireKey]
      : undefined;
    this._mutationsInFlight.add(wireKey);
    // Optimistic — flip the switch immediately so the user sees feedback
    // before the HTTP round-trip + FLT push completes (~50-300 ms).
    this._overrides = { ...this._overrides, [wireKey]: !!value };
    this._lastOverrideMutationAt = Date.now();
    this._patchRowOverride(wireKey, !!value);
    this._render();
    try {
      const resp = await fetch('/api/edog/feature-flags/overrides', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ flag: wireKey, value: !!value }),
      });
      if (!resp.ok) {
        // Revert optimistic mutation.
        this._revertOverride(wireKey, prev);
        const body = await resp.json().catch(() => ({}));
        this._toast(`failed`, body.message || body.error || `HTTP ${resp.status}`);
        return;
      }
      const body = await resp.json();
      this._overrides = body.overrides || {};
      this._syncCatalogOverrideFlags();
      this._showFltSyncToast(body.fltSync);
      this._render();
    } catch (err) {
      this._revertOverride(wireKey, prev);
      this._toast('failed', err.message || String(err));
    } finally {
      this._mutationsInFlight.delete(wireKey);
      this._render();
    }
  }

  async clearOverride(wireKey) {
    if (this._mutationsInFlight.has(wireKey)) return;
    const prev = Object.prototype.hasOwnProperty.call(this._overrides, wireKey)
      ? this._overrides[wireKey]
      : undefined;
    this._mutationsInFlight.add(wireKey);
    // Optimistic clear so the switch flips back to off immediately.
    const next = { ...this._overrides };
    delete next[wireKey];
    this._overrides = next;
    this._lastOverrideMutationAt = Date.now();
    this._patchRowOverride(wireKey, false);
    this._render();
    try {
      const resp = await fetch(`/api/edog/feature-flags/overrides/${encodeURIComponent(wireKey)}`, {
        method: 'DELETE',
      });
      if (!resp.ok) {
        this._revertOverride(wireKey, prev);
        const body = await resp.json().catch(() => ({}));
        this._toast('failed', body.message || body.error || `HTTP ${resp.status}`);
        return;
      }
      const body = await resp.json();
      this._overrides = body.overrides || {};
      this._syncCatalogOverrideFlags();
      this._showFltSyncToast(body.fltSync);
      this._render();
    } catch (err) {
      this._revertOverride(wireKey, prev);
      this._toast('failed', err.message || String(err));
    } finally {
      this._mutationsInFlight.delete(wireKey);
      this._render();
    }
  }

  /* Mutate the in-memory catalog row so subsequent renders reflect the
   * current override map without re-fetching /catalog. The server stamps
   * isOverridden + effectiveForMyWorkspace at catalog-build time and we
   * mirror the same logic client-side here. */
  _patchRowOverride(wireKey, overridden) {
    if (!this._catalog || !Array.isArray(this._catalog.rows)) return;
    const row = this._catalog.rows.find(r => r && r.wireKey === wireKey);
    if (!row) return;
    row.isOverridden = !!overridden;
    if (overridden) {
      row._preOverrideEffective = row._preOverrideEffective ?? row.effectiveForMyWorkspace;
      row.effectiveForMyWorkspace = true;
      row.overrideValue = true;
    } else {
      row.overrideValue = null;
      if (row._preOverrideEffective != null) {
        row.effectiveForMyWorkspace = row._preOverrideEffective;
        row._preOverrideEffective = null;
      }
    }
  }

  _syncCatalogOverrideFlags() {
    if (!this._catalog || !Array.isArray(this._catalog.rows)) return;
    for (const row of this._catalog.rows) {
      const isOn = !!this._overrides[row.wireKey];
      this._patchRowOverride(row.wireKey, isOn);
    }
  }

  _revertOverride(wireKey, prev) {
    if (prev === undefined) {
      const next = { ...this._overrides };
      delete next[wireKey];
      this._overrides = next;
      this._patchRowOverride(wireKey, false);
    } else {
      this._overrides = { ...this._overrides, [wireKey]: prev };
      this._patchRowOverride(wireKey, !!prev);
    }
    this._render();
  }

  async resetAll() {
    if (!confirm('Clear ALL feature-flag overrides for this session?')) return;
    const previousOverrides = { ...this._overrides };
    // Optimistic clear-all.
    this._overrides = {};
    this._lastOverrideMutationAt = Date.now();
    this._syncCatalogOverrideFlags();
    this._render();
    try {
      const resp = await fetch('/api/edog/feature-flags/overrides/reset', { method: 'POST' });
      if (!resp.ok) {
        this._overrides = previousOverrides;
        this._syncCatalogOverrideFlags();
        this._render();
        this._toast('failed', `HTTP ${resp.status}`);
        return;
      }
      const body = await resp.json();
      this._overrides = body.overrides || {};
      this._syncCatalogOverrideFlags();
      this._showFltSyncToast(body.fltSync);
      this._render();
    } catch (err) {
      this._overrides = previousOverrides;
      this._syncCatalogOverrideFlags();
      this._render();
      this._toast('failed', err.message || String(err));
    }
  }

  async refreshFM() {
    if (this._refreshInFlight) return;
    this._refreshInFlight = true;
    this._updateRefreshBtn();
    try {
      const resp = await fetch('/api/edog/feature-flags/refresh', { method: 'POST' });
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        this._toast('failed', body.detail || body.error || `HTTP ${resp.status}`);
        return;
      }
      // The endpoint kicks off a background sync. Reload immediately — the
      // catalog response will carry syncInProgress=true and the poller picks
      // up the cadence from there.
      await this.load();
    } catch (err) {
      this._toast('failed', err.message || String(err));
    } finally {
      this._refreshInFlight = false;
      this._updateRefreshBtn();
    }
  }

  _updateRefreshBtn() {
    const btn = this._mount.querySelector('#ffRefreshBtn');
    if (!btn) return;
    const fm = (this._catalog && this._catalog.fm) || {};
    const syncing = this._refreshInFlight || fm.syncInProgress === true;
    btn.disabled = syncing;
    btn.classList.toggle('is-loading', syncing);
    btn.textContent = syncing ? 'Refreshing…' : 'Refresh FM';
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

        <div class="ecard-status-strip" id="ecardStatusStrip" aria-hidden="true">
          <button class="estrip-seg" data-card="card-config-snapshot"><span class="estrip-label">Config</span><span class="estrip-badge" data-mirror="card-config-snapshot">--</span></button>
          <span class="estrip-sep">\u00B7</span>
          <button class="estrip-seg" data-card="card-token-state"><span class="estrip-label">Token</span><span class="estrip-badge" data-mirror="card-token-state">--</span></button>
          <span class="estrip-sep">\u00B7</span>
          <button class="estrip-seg" data-card="card-build-patch"><span class="estrip-label">Build</span><span class="estrip-badge" data-mirror="card-build-patch">--</span></button>
          <span class="estrip-sep">\u00B7</span>
          <button class="estrip-seg" data-card="card-interceptors"><span class="estrip-label">Interceptors</span><span class="estrip-badge" data-mirror="card-interceptors">--</span></button>
        </div>

        <div class="ecard-grid">
          <div class="env-card ecard-collapsible" id="card-config-snapshot">
            <div class="env-card-header">
              <div class="env-card-title"><span class="ecard-chevron">\u25BE</span> Config Snapshot</div>
              <span class="ecard-header-badge">loading</span>
              <div class="env-card-actions"><button class="ecard-refresh-btn" title="Refresh config">\u21BB</button></div>
            </div>
            <div class="env-card-body"><div class="ecard-shimmer"><span class="sk-bar sk-kv"></span><span class="sk-bar sk-kv"></span><span class="sk-bar sk-kv"></span></div></div>
          </div>

          <div class="env-card ecard-collapsible" id="card-token-state">
            <div class="env-card-header">
              <div class="env-card-title"><span class="ecard-chevron">\u25BE</span> Token State</div>
              <span class="ecard-header-badge">loading</span>
              <div class="env-card-actions"><button class="ecard-refresh-btn" title="Refresh tokens">\u21BB</button></div>
            </div>
            <div class="env-card-body"><div class="ecard-shimmer"><span class="sk-bar sk-kv"></span><span class="sk-bar sk-kv"></span></div></div>
          </div>

          <div class="env-card ecard-collapsible" id="card-build-patch">
            <div class="env-card-header">
              <div class="env-card-title"><span class="ecard-chevron">\u25BE</span> Build & Patch</div>
              <span class="ecard-header-badge">loading</span>
              <div class="env-card-actions"><button class="ecard-refresh-btn" title="Refresh build info">\u21BB</button></div>
            </div>
            <div class="env-card-body"><div class="ecard-shimmer"><span class="sk-bar sk-kv"></span><span class="sk-bar sk-kv"></span></div></div>
          </div>

          <div class="env-card ecard-collapsible" id="card-interceptors">
            <div class="env-card-header">
              <div class="env-card-title"><span class="ecard-chevron">\u25BE</span> Interceptors</div>
              <span class="ecard-header-badge">loading</span>
              <div class="env-card-actions"><button class="ecard-refresh-btn" title="Refresh interceptors">\u21BB</button></div>
            </div>
            <div class="env-card-body"><div class="ecard-shimmer"><span class="sk-bar sk-kv"></span><span class="sk-bar sk-kv"></span><span class="sk-bar sk-kv"></span></div></div>
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
            <span><span class="strip-count" id="ffStripCount">0</span><span class="strip-text" id="ffStripText"> overrides active this session.</span></span>
            <span class="strip-chips" id="ffStripChips"></span>
            <span class="strip-hint">Applies to <strong>future</strong> evaluations only.</span>
          </div>

          <div class="ff-filterbar">
            <label class="ff-search">
              <span class="ff-search-icon" aria-hidden="true">&#128269;</span>
              <input type="text" id="ffFilterInput" placeholder="Filter by name or wire key" autocomplete="off" aria-label="Filter flags by name or wire key">
              <button class="ff-search-clear" id="ffFilterClear" hidden aria-label="Clear filter" title="Clear filter">&#10005;</button>
            </label>
            <span class="ff-pill" data-filter="overridden" role="button" tabindex="0" aria-pressed="false">Overridden</span>
            <span class="ff-pill" data-filter="partial" role="button" tabindex="0" aria-pressed="false">Partial</span>
            <span class="ff-pill" data-filter="missing" role="button" tabindex="0" aria-pressed="false">Missing in FM</span>
            <span class="ff-spacer"></span>
            <span class="ff-pill" id="ffSovToggle" role="button" tabindex="0" aria-pressed="false" title="Show 8 sovereign envs as separate columns">Sov: folded</span>
          </div>

          <div class="ff-table-wrap" id="ffTableWrap">
            <div class="ff-skeleton" aria-busy="true" aria-live="polite">
              <div class="ff-skeleton-head">
                <span class="sk-bar sk-name"></span>
                <span class="sk-bar sk-env"></span>
                <span class="sk-bar sk-env"></span>
                <span class="sk-bar sk-env"></span>
                <span class="sk-bar sk-env"></span>
                <span class="sk-bar sk-env"></span>
                <span class="sk-bar sk-env"></span>
                <span class="sk-bar sk-env"></span>
                <span class="sk-bar sk-env"></span>
                <span class="sk-bar sk-state"></span>
              </div>
              <div class="ff-skeleton-rows">
                <div class="sk-row"></div><div class="sk-row"></div><div class="sk-row"></div>
                <div class="sk-row"></div><div class="sk-row"></div><div class="sk-row"></div>
                <div class="sk-row"></div><div class="sk-row"></div>
              </div>
              <div class="ff-skeleton-label">Loading feature flags…</div>
            </div>
          </div>

          <div class="ff-toast-strip" id="ffToast"></div>
        </div>

        <div class="flag-inspector-mount" id="ffInspectorMount" hidden></div>
      </div>
    `;

    this._mount.querySelector('#ffRefreshBtn').addEventListener('click', () => this.refreshFM());
    this._mount.querySelector('#ffResetBtn').addEventListener('click', () => this.resetAll());
    const filterInput = this._mount.querySelector('#ffFilterInput');
    const filterClear = this._mount.querySelector('#ffFilterClear');
    filterInput.addEventListener('input', (e) => {
      const next = (e.target.value || '').toLowerCase().trim();
      filterClear.hidden = !e.target.value;
      // Debounce — 36 rows is cheap to re-render but keystrokes can still
      // feel laggy when each fires a synchronous innerHTML rebuild.
      if (this._filterDebounceTimer) clearTimeout(this._filterDebounceTimer);
      this._filterDebounceTimer = setTimeout(() => {
        this._filterDebounceTimer = null;
        if (this._filterText === next) return;
        this._filterText = next;
        this._renderTable();
      }, 80);
    });
    filterClear.addEventListener('click', () => {
      filterInput.value = '';
      filterClear.hidden = true;
      this._filterText = '';
      this._renderTable();
      filterInput.focus();
    });
    const togglePill = (el) => {
      const key = el.dataset.filter;
      if (this._activeFilters.has(key)) this._activeFilters.delete(key);
      else this._activeFilters.add(key);
      const active = this._activeFilters.has(key);
      el.classList.toggle('active', active);
      el.setAttribute('aria-pressed', active ? 'true' : 'false');
      this._renderTable();
    };
    this._mount.querySelectorAll('.ff-pill[data-filter]').forEach(el => {
      el.addEventListener('click', () => togglePill(el));
      el.addEventListener('keydown', (e) => {
        if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); togglePill(el); }
      });
    });
    const sovBtn = this._mount.querySelector('#ffSovToggle');
    const toggleSov = () => {
      this._sovExpanded = !this._sovExpanded;
      sovBtn.classList.toggle('active', this._sovExpanded);
      sovBtn.setAttribute('aria-pressed', this._sovExpanded ? 'true' : 'false');
      sovBtn.textContent = this._sovExpanded ? 'Sov: expanded' : 'Sov: folded';
      this._renderTable();
    };
    sovBtn.addEventListener('click', toggleSov);
    sovBtn.addEventListener('keydown', (e) => {
      if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggleSov(); }
    });

    // ── Scroll-aware status strip ──
    this._initStatusStrip();
  }

  // ── Status strip: scroll-aware card summary ──────────────────────

  _initStatusStrip() {
    const panel = this._mount.querySelector('#environmentPanel');
    const grid = this._mount.querySelector('.ecard-grid');
    const strip = this._mount.querySelector('#ecardStatusStrip');
    if (!panel || !grid || !strip) return;

    // Click a strip segment → scroll to its card
    strip.addEventListener('click', (e) => {
      const seg = e.target.closest('.estrip-seg');
      if (!seg) return;
      const cardId = seg.dataset.card;
      const card = this._mount.querySelector('#' + cardId);
      if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    // Scroll listener: show strip when card grid scrolls mostly out of view.
    // We check the grid's bottom edge relative to the panel's top — once the
    // bottom of the grid is within 40px of the panel top, the cards are gone.
    let stripVisible = false;
    const onScroll = () => {
      const panelRect = panel.getBoundingClientRect();
      const gridRect = grid.getBoundingClientRect();
      const gridBottomInPanel = gridRect.bottom - panelRect.top;
      const shouldShow = gridBottomInPanel < 40;
      if (shouldShow !== stripVisible) {
        stripVisible = shouldShow;
        strip.classList.toggle('visible', shouldShow);
        strip.setAttribute('aria-hidden', shouldShow ? 'false' : 'true');
      }
    };
    panel.addEventListener('scroll', onScroll, { passive: true });
    this._stripScrollCleanup = () => panel.removeEventListener('scroll', onScroll);

    // Sync badge text: MutationObserver mirrors card badges → strip badges
    const cardIds = ['card-config-snapshot', 'card-token-state', 'card-build-patch', 'card-interceptors'];
    this._badgeObserver = new MutationObserver(() => this._syncStripBadges());
    for (const id of cardIds) {
      const badge = this._mount.querySelector('#' + id + ' .ecard-header-badge');
      if (badge) this._badgeObserver.observe(badge, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    }
    // Initial sync
    this._syncStripBadges();
  }

  _syncStripBadges() {
    const strip = this._mount.querySelector('#ecardStatusStrip');
    if (!strip) return;
    strip.querySelectorAll('.estrip-badge[data-mirror]').forEach((el) => {
      const cardId = el.dataset.mirror;
      const badge = this._mount.querySelector('#' + cardId + ' .ecard-header-badge');
      if (badge) {
        el.textContent = badge.textContent;
        el.className = 'estrip-badge';
        if (badge.classList.contains('ok')) el.classList.add('ok');
        else if (badge.classList.contains('warn')) el.classList.add('warn');
        else if (badge.classList.contains('error')) el.classList.add('error');
      }
    });
  }

  _render() {
    if (!this._catalog) return;
    this._renderHeader();
    this._renderStrip();
    this._renderTable();
    this._updateRefreshBtn();
    const resetBtn = this._mount.querySelector('#ffResetBtn');
    if (resetBtn) {
      const count = Object.keys(this._overrides).length;
      resetBtn.disabled = count === 0;
      resetBtn.title = count === 0 ? 'No overrides to clear' : `Clear ${count} override${count === 1 ? '' : 's'}`;
    }
    // Keep the inspector pane in sync with optimistic mutations (it pins to
    // a specific row, and the row object is patched in place — but the
    // overrides reference is replaced, so we re-show with the fresh map).
    this._refreshInspector();
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
    const stripText = this._mount.querySelector('#ffStripText');
    if (stripText) {
      stripText.textContent = keys.length === 1
        ? ' override active this session.'
        : ' overrides active this session.';
    }
    const chipsEl = this._mount.querySelector('#ffStripChips');
    chipsEl.innerHTML = '';
    keys.forEach(k => {
      const chip = document.createElement('span');
      chip.className = 'strip-chip';
      const safe = this._escape(k);
      chip.innerHTML = `<span>${safe}</span><span class="chip-x" role="button" tabindex="0" aria-label="Clear override for ${safe}" title="Clear override">&#10005;</span>`;
      const x = chip.querySelector('.chip-x');
      x.addEventListener('click', () => this.clearOverride(k));
      x.addEventListener('keydown', (e) => {
        if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); this.clearOverride(k); }
      });
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
    const inFlight = this._mutationsInFlight.has(row.wireKey);
    const switchCls = `ff-switch${overridden ? ' on' : ''}${inFlight ? ' is-loading' : ''}`;
    const switchAria = inFlight ? ' aria-busy="true" aria-disabled="true"' : '';

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
            <span class="${switchCls}" role="switch" aria-checked="${overridden}" tabindex="0" data-flag="${this._escape(row.wireKey)}" title="${inFlight ? 'Working…' : `Click to ${overridden ? 'clear' : 'force-ON'} override`}"${switchAria}></span>
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
    const wireKey = data.featureName || data.wireKey || data.flagName;
    if (!wireKey) return;
    const now = Date.now();
    const obs = this._observations.get(wireKey) || { lastEvalAt: 0, lastResult: null, history: [] };
    obs.lastEvalAt = now;
    obs.lastResult = !!data.result;
    obs.overridden = !!data.overridden;
    // Keep last 50 evaluations per flag
    obs.history.push({ time: now, result: !!data.result, overridden: !!data.overridden, durationMs: data.durationMs });
    if (obs.history.length > 50) obs.history.shift();
    obs.evalCount = (obs.evalCount || 0) + 1;
    this._observations.set(wireKey, obs);
    // Re-paint the obs cell incrementally without a full table redraw.
    const cell = this._mount.querySelector(`tr[data-flag="${CSS.escape(wireKey)}"] .ff-obs`);
    if (cell) {
      const cls = this._observationClassFor(wireKey);
      cell.classList.remove('live', 'cached', 'unobserved');
      cell.classList.add(cls);
      cell.textContent = cls.toUpperCase() + (obs.evalCount > 1 ? ` (${obs.evalCount})` : '');
      cell.title = this._obsTooltip(cls) + (obs.evalCount ? `\nEvaluated ${obs.evalCount} time(s)` : '');
      cell.style.cursor = obs.history.length > 0 ? 'pointer' : '';
      cell.onclick = obs.history.length > 0 ? () => this._showEvalHistory(wireKey) : null;
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

  _showEvalHistory(wireKey) {
    const obs = this._observations.get(wireKey);
    if (!obs || !obs.history || obs.history.length === 0) return;

    // Remove any existing popover
    var existing = this._mount.querySelector('.ff-eval-history');
    if (existing) existing.remove();

    var cell = this._mount.querySelector(`tr[data-flag="${CSS.escape(wireKey)}"] .ff-obs`);
    if (!cell) return;

    var panel = document.createElement('div');
    panel.className = 'ff-eval-history';

    var header = `<div class="ff-eh-header"><span class="ff-eh-title">${this._esc(wireKey)}</span><span class="ff-eh-count">${obs.evalCount} evaluation(s)</span><button class="ff-eh-close">\u2715</button></div>`;

    var rows = obs.history.slice().reverse().map(function(h) {
      var t = new Date(h.time);
      var timeStr = t.toLocaleTimeString();
      var resultCls = h.result ? 'ff-eh-true' : 'ff-eh-false';
      var resultText = h.result ? 'TRUE' : 'FALSE';
      var overrideTag = h.overridden ? ' <span class="ff-eh-override">OVERRIDE</span>' : '';
      var durText = h.durationMs != null ? h.durationMs.toFixed(2) + 'ms' : '\u2014';
      return `<tr><td class="ff-eh-time">${timeStr}</td><td class="${resultCls}">${resultText}${overrideTag}</td><td class="ff-eh-dur">${durText}</td></tr>`;
    }).join('');

    var table = `<table class="ff-eh-table"><thead><tr><th>Time</th><th>Result</th><th>Duration</th></tr></thead><tbody>${rows}</tbody></table>`;

    panel.innerHTML = header + table;

    // Position near the cell
    var rect = cell.getBoundingClientRect();
    var mountRect = this._mount.getBoundingClientRect();
    panel.style.position = 'absolute';
    panel.style.top = (rect.bottom - mountRect.top + 4) + 'px';
    panel.style.right = '8px';
    panel.style.zIndex = '200';

    this._mount.style.position = 'relative';
    this._mount.appendChild(panel);

    // Close handlers
    var close = function() { if (panel.parentNode) panel.remove(); };
    panel.querySelector('.ff-eh-close').addEventListener('click', close);
    setTimeout(function() {
      document.addEventListener('click', function handler(e) {
        if (!panel.contains(e.target) && e.target !== cell) {
          close();
          document.removeEventListener('click', handler);
        }
      });
    }, 0);
  }

  _esc(s) {
    if (s == null) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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
