/* ──────────────────────────────────────────────────────────────────────
 * Environment Panel — Card 3 / Flag Inspector
 * Click a flag name in the matrix → opens this read-only inspector view.
 *
 * Sections:
 *   1. Breadcrumb + back button
 *   2. Overview      — name, wireKey, summary, effective state, FM source
 *   3. Per-env       — vertical list with target-group sub-rows + gated reveal
 *   4. Override      — current state + Force ON / Clear button
 *   5. Raw JSON      — collapsed, syntax-highlighted FM definition
 *
 * Talks to the matrix via callbacks (onClose, onOverrideSet, onOverrideClear).
 * Fetches raw JSON on demand from GET /api/edog/feature-flags/raw/{wireKey}.
 * ────────────────────────────────────────────────────────────────────── */

class FlagInspector {
  /**
   * @param {HTMLElement} mountEl
   * @param {{
   *   catalog: any,
   *   overrides: Record<string, boolean>,
   *   onClose: () => void,
   *   onOverrideSet: (wireKey: string) => Promise<void>,
   *   onOverrideClear: (wireKey: string) => Promise<void>,
   * }} ctx
   */
  constructor(mountEl, ctx) {
    this._mount = mountEl;
    this._ctx = ctx;
    this._currentRow = null;
    this._rawDoc = null;
    this._rawLoading = false;
    this._rawError = null;
    this._showRaw = false;
    this._showValuesFor = new Set();
    this._hidden = true;
  }

  isHidden() { return this._hidden; }
  currentWireKey() { return this._currentRow ? this._currentRow.wireKey : null; }

  show(row, ctx) {
    this._hidden = false;
    this._currentRow = row;
    this._ctx.catalog = ctx.catalog;
    this._ctx.overrides = ctx.overrides;
    // Reset transient state when switching flags
    if (!this._lastWireKey || this._lastWireKey !== row.wireKey) {
      this._rawDoc = null;
      this._rawError = null;
      this._showRaw = false;
      this._showValuesFor = new Set();
    }
    this._lastWireKey = row.wireKey;
    this._render();
  }

  hide() {
    this._hidden = true;
  }

  destroy() {
    this._mount.innerHTML = '';
    this._currentRow = null;
  }

  /* ── Render ───────────────────────────────────────────────────────── */

  _render() {
    if (!this._currentRow) return;
    const row = this._currentRow;
    const liveOverrides = (this._ctx && this._ctx.overrides) || {};
    const overridden = !!liveOverrides[row.wireKey];
    // Server stamps effectiveForMyWorkspace at catalog-build time; mirror
    // the force-ON logic client-side so optimistic toggles render correctly
    // without re-fetching the catalog.
    const baseEffective = !!row.effectiveForMyWorkspace;
    const effectiveOn = overridden ? true : baseEffective;
    const effective = overridden ? 'FORCED ON' : (effectiveOn ? 'ON' : 'OFF');
    const effectiveCls = overridden ? 'forced' : (effectiveOn ? 'on' : 'off');

    const mainline = (this._ctx.catalog.workspace && this._ctx.catalog.workspace.mainlineEnvs) || [];
    const sovereign = (this._ctx.catalog.workspace && this._ctx.catalog.workspace.sovereignEnvs) || [];

    const sourcePath = this._sourcePath(row.wireKey);
    const fmRepoLink = this._fmRepoLink(sourcePath);

    this._mount.innerHTML = `
      <div class="env-card flag-inspector">
        <div class="env-card-header inspector-breadcrumb">
          <div class="env-card-title">
            <button class="env-btn inspector-back" id="fiBack" title="Back to matrix">&#8592; Back</button>
            <span class="inspector-crumb">Feature Flags</span>
            <span class="inspector-crumb-sep">/</span>
            <span class="inspector-crumb-current">${this._escape(row.name)}</span>
          </div>
        </div>

        <div class="inspector-body">

          <section class="inspector-section">
            <h3 class="inspector-section-title">Overview</h3>
            <div class="inspector-overview">
              <div class="ov-row"><span class="ov-key">Name</span><span class="ov-val">${this._escape(row.name)}</span></div>
              <div class="ov-row"><span class="ov-key">Wire key</span><span class="ov-val mono">${this._escape(row.wireKey)}</span></div>
              ${row.summary ? `<div class="ov-row"><span class="ov-key">Summary</span><span class="ov-val">${this._escape(row.summary)}</span></div>` : ''}
              <div class="ov-row"><span class="ov-key">Effective</span><span class="ov-val"><span class="ff-effective ${effectiveCls}">${effective}</span><span class="ov-effective-note">${overridden ? 'force-ON override active for this session' : (baseEffective ? 'enabled for your workspace via FM' : 'no env matches your workspace')}</span></span></div>
              ${row.missingReason === 'missing-in-fm'
                ? `<div class="ov-row"><span class="ov-key">FM source</span><span class="ov-val warn">Not found in FeatureManagement repo</span></div>`
                : `<div class="ov-row"><span class="ov-key">FM source</span><span class="ov-val"><span class="mono">${this._escape(sourcePath)}</span>${fmRepoLink ? ` <a class="inspector-link" href="${fmRepoLink}" target="_blank" rel="noopener">Open in repo &#8599;</a>` : ''}</span></div>`}
            </div>
          </section>

          <section class="inspector-section">
            <h3 class="inspector-section-title">Per-environment targeting</h3>
            <div class="inspector-env-list">
              ${mainline.map(env => this._renderEnvBlock(env, row.perEnv[env] || { state: 'missing' }, row.wireKey)).join('')}
              <details class="env-sov-fold">
                <summary>Sovereign envs (${sovereign.length})</summary>
                ${sovereign.map(env => this._renderEnvBlock(env, row.perEnv[env] || { state: 'missing' }, row.wireKey)).join('')}
              </details>
            </div>
          </section>

          <section class="inspector-section">
            <h3 class="inspector-section-title">Session override</h3>
            <div class="inspector-override">
              ${overridden
                ? `<div class="ov-row"><span class="ov-key">Status</span><span class="ov-val"><span class="ff-effective forced">FORCED ON</span></span></div>
                   <button class="env-btn danger" id="fiClearOverride">Clear override</button>`
                : `<div class="ov-row"><span class="ov-key">Status</span><span class="ov-val muted">No override — effective state follows FM truth.</span></div>
                   <button class="env-btn" id="fiSetOverride">Force ON for this session</button>`}
              <p class="inspector-hint">Overrides take effect on <strong>future</strong> evaluations. Code paths that cached <code>IsEnabled</code> at startup are unaffected until FLT restarts.</p>
            </div>
          </section>

          <section class="inspector-section">
            <h3 class="inspector-section-title">Raw FM definition</h3>
            <div class="inspector-raw">
              ${this._renderRawSection(row.wireKey)}
            </div>
          </section>

        </div>
      </div>
    `;

    this._wireHandlers(row);
  }

  _renderEnvBlock(env, cell, wireKey) {
    const state = cell.state || 'missing';
    const stateLabel = {
      on: 'ON', off: 'OFF', partial: 'Partial', empty: 'Not deployed', missing: 'Missing in FM',
    }[state] || state;
    const stateCls = `env-state-${state}` + (cell.unevaluable ? ' unevaluable' : '');
    const meta = this._envMeta(cell);

    let body = '';
    if (state === 'partial') {
      if (cell.unevaluable) {
        body = `<div class="env-empty muted">All target groups use pivots we can\u2019t evaluate locally (RegionName, MemberOf). The cell renders as partial but matching can\u2019t be confirmed.</div>${this._renderTargets(cell, wireKey, env)}`;
      } else {
        body = this._renderTargets(cell, wireKey, env);
      }
    } else if (state === 'missing') {
      body = '<div class="env-empty muted">Flag is declared by FLT but not present in the FeatureManagement repo.</div>';
    } else if (state === 'empty') {
      body = '<div class="env-empty muted">No configuration block for this environment.</div>';
    }

    return `
      <div class="env-block ${stateCls}">
        <div class="env-block-head">
          <span class="env-name">${this._escape(env.toUpperCase())}</span>
          <span class="env-state-pill state-${state}">${stateLabel}</span>
          ${meta ? `<span class="env-meta muted">${meta}</span>` : ''}
          ${cell.includesMyWorkspace ? '<span class="env-my-match" title="Your workspace matches a target group in this env">your match</span>' : ''}
        </div>
        ${body}
      </div>
    `;
  }

  _envMeta(cell) {
    if (cell.state !== 'partial' || !Array.isArray(cell.targets)) return '';
    const n = cell.targets.length;
    if (n === 0) return '';
    return n === 1 ? '1 target group' : `${n} target groups`;
  }

  _renderTargets(cell, wireKey, env) {
    const targets = cell.targets || [];
    if (targets.length === 0) return '<div class="env-empty muted">No target groups declared.</div>';
    return `<ul class="env-target-list">${targets.map((t, idx) => this._renderTargetItem(t, idx, wireKey, env)).join('')}</ul>`;
  }

  _renderTargetItem(t, idx, wireKey, env) {
    const revealKey = `${env}#${idx}`;
    const revealed = this._showValuesFor.has(revealKey);
    const pivot = t.pivot || '(unknown pivot)';
    const valueCount = typeof t.valueCount === 'number' ? t.valueCount : (t.valuesPreview ? t.valuesPreview.length : 0);
    const name = t.name || '(unnamed group)';
    const group = t.group || '';
    const hasValues = valueCount > 0;
    const previewN = (t.valuesPreview || []).length;
    const moreN = valueCount - previewN;

    return `
      <li class="target-item" data-reveal="${this._escape(revealKey)}">
        <div class="target-head">
          ${group ? `<span class="target-group" title="Rollout group from FM definition">${this._escape(group)}</span>` : ''}
          <span class="target-name">${this._escape(name)}</span>
          <span class="target-pivot mono">${this._escape(pivot)}</span>
          <span class="target-count muted">${valueCount} ${valueCount === 1 ? 'value' : 'values'}</span>
          ${hasValues ? `<button class="env-btn target-reveal" data-reveal-key="${this._escape(revealKey)}">${revealed ? 'Hide values' : 'Show values'}</button>` : ''}
        </div>
        ${revealed && hasValues
          ? `<div class="target-values mono">${(t.valuesPreview || []).map(v => `<code>${this._escape(v)}</code>`).join('')}${moreN > 0 ? `<span class="target-more muted">+${moreN} more (not loaded)</span>` : ''}</div>`
          : ''}
      </li>
    `;
  }

  _renderRawSection(wireKey) {
    if (!this._showRaw) {
      return `<button class="env-btn" id="fiToggleRaw">Show raw definition</button>`;
    }
    if (this._rawError) {
      return `<button class="env-btn" id="fiToggleRaw">Hide</button>
              <div class="inspector-error">Failed to load raw definition: ${this._escape(this._rawError)}</div>`;
    }
    if (this._rawLoading || !this._rawDoc) {
      return `<button class="env-btn" id="fiToggleRaw">Hide</button>
              <div class="inspector-raw-loading muted">Loading FM definition…</div>`;
    }
    return `
      <div class="raw-toolbar">
        <button class="env-btn" id="fiToggleRaw">Hide raw definition</button>
        <button class="env-btn" id="fiCopyRaw" title="Copy JSON to clipboard">Copy JSON</button>
      </div>
      <pre class="inspector-raw-json"><code>${this._highlightJson(this._rawDoc)}</code></pre>
    `;
  }

  _wireHandlers(row) {
    const back = this._mount.querySelector('#fiBack');
    if (back) back.addEventListener('click', () => this._ctx.onClose && this._ctx.onClose());

    const setBtn = this._mount.querySelector('#fiSetOverride');
    if (setBtn) setBtn.addEventListener('click', () => this._ctx.onOverrideSet && this._ctx.onOverrideSet(row.wireKey));

    const clearBtn = this._mount.querySelector('#fiClearOverride');
    if (clearBtn) clearBtn.addEventListener('click', () => this._ctx.onOverrideClear && this._ctx.onOverrideClear(row.wireKey));

    this._mount.querySelectorAll('.target-reveal[data-reveal-key]').forEach(btn => {
      btn.addEventListener('click', () => {
        const k = btn.dataset.revealKey;
        if (this._showValuesFor.has(k)) this._showValuesFor.delete(k);
        else this._showValuesFor.add(k);
        this._render();
      });
    });

    const rawBtn = this._mount.querySelector('#fiToggleRaw');
    if (rawBtn) {
      rawBtn.addEventListener('click', () => {
        if (this._showRaw) {
          this._showRaw = false;
          this._render();
        } else {
          this._showRaw = true;
          if (!this._rawDoc && !this._rawLoading) this._loadRaw(row.wireKey);
          else this._render();
        }
      });
    }

    const copyBtn = this._mount.querySelector('#fiCopyRaw');
    if (copyBtn && this._rawDoc) {
      copyBtn.addEventListener('click', () => {
        try {
          navigator.clipboard.writeText(JSON.stringify(this._rawDoc, null, 2));
          copyBtn.textContent = 'Copied!';
          setTimeout(() => { copyBtn.textContent = 'Copy JSON'; }, 1200);
        } catch (_) { /* noop */ }
      });
    }
  }

  async _loadRaw(wireKey) {
    this._rawLoading = true;
    this._rawError = null;
    this._render();
    try {
      const resp = await fetch(`/api/edog/feature-flags/raw/${encodeURIComponent(wireKey)}`);
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        this._rawError = body.detail || body.error || `HTTP ${resp.status}`;
      } else {
        const body = await resp.json();
        this._rawDoc = body.definition;
      }
    } catch (err) {
      this._rawError = err.message || String(err);
    } finally {
      this._rawLoading = false;
      this._render();
    }
  }

  /* ── Helpers ──────────────────────────────────────────────────────── */

  _sourcePath(wireKey) {
    // FM convention: Features/<area>/<wireKey>.json. We don't know the area
    // for sure without the doc, but the path pattern is consistent enough
    // for a "human-readable hint" until the user opens the raw definition.
    return `Features/.../${wireKey}.json`;
  }

  _fmRepoLink(_sourcePath) {
    // We could build a deep-link if we knew the area folder. Without that
    // structural info, link to the repo root — the user can navigate from there.
    const fm = (this._ctx.catalog && this._ctx.catalog.fm) || {};
    return fm.repoUrl || null;
  }

  _highlightJson(value) {
    const json = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    const escaped = json.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return escaped.replace(
      /("(\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g,
      (match) => {
        let cls = 'json-num';
        if (/^"/.test(match)) cls = /:$/.test(match) ? 'json-key' : 'json-str';
        else if (/true|false/.test(match)) cls = 'json-bool';
        else if (/null/.test(match)) cls = 'json-null';
        return `<span class="${cls}">${match}</span>`;
      },
    );
  }

  _escape(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
}
