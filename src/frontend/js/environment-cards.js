/* ──────────────────────────────────────────────────────────────────────
 * Environment Panel — Cards 1-4: Config · Token · Build · Interceptors
 * F11 spec. Fetches live APIs and renders collapsible key-value cards
 * above the Feature Flags matrix.
 *
 * APIs:
 *   GET /api/flt/config            → Config Snapshot
 *   GET /api/edog/health           → Token State + Build & Patch
 *   GET /api/edog/patch-warnings   → Patch warning count
 *   GET /api/edog/interceptors-status → Interceptor wrap status
 *
 * @author Pixel — EDOG Studio hivemind
 * ────────────────────────────────────────────────────────────────────── */
class EnvironmentCards {
  constructor() {
    this._active = false;
    this._collapsed = { config: false, token: false, build: false, interceptors: false };
  }

  /* ── Lifecycle ────────────────────────────────────────────────────── */

  activate() {
    if (this._active) return;
    this._active = true;
    this._bindCollapse();
    this._bindRefresh();
    this.loadAll();
  }

  deactivate() {
    this._active = false;
  }

  /* ── Data loading ─────────────────────────────────────────────────── */

  loadAll() {
    this._loadConfig();
    this._loadHealth();
    this._loadInterceptors();
  }

  async _loadConfig() {
    var card = document.getElementById('card-config-snapshot');
    if (!card) return;
    var body = card.querySelector('.env-card-body');
    body.innerHTML = '<div class="ecard-shimmer"><span class="sk-bar sk-kv"></span><span class="sk-bar sk-kv"></span><span class="sk-bar sk-kv"></span></div>';
    try {
      var resp = await fetch('/api/flt/config');
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      var data = await resp.json();
      this._renderConfig(body, data);
      this._setBadge(card, 'ok', data.phase === 'connected' ? 'connected' : 'disconnected');
    } catch (err) {
      body.innerHTML = '<div class="ecard-error">Failed to load config: ' + _ecEsc(err.message) + '</div>';
      this._setBadge(card, 'error', 'error');
    }
  }

  async _loadHealth() {
    var tokenCard = document.getElementById('card-token-state');
    var buildCard = document.getElementById('card-build-patch');
    if (!tokenCard && !buildCard) return;
    var tokenBody = tokenCard ? tokenCard.querySelector('.env-card-body') : null;
    var buildBody = buildCard ? buildCard.querySelector('.env-card-body') : null;
    if (tokenBody) tokenBody.innerHTML = '<div class="ecard-shimmer"><span class="sk-bar sk-kv"></span><span class="sk-bar sk-kv"></span></div>';
    if (buildBody) buildBody.innerHTML = '<div class="ecard-shimmer"><span class="sk-bar sk-kv"></span><span class="sk-bar sk-kv"></span></div>';

    var health = null;
    var config = null;
    var patchWarnings = [];
    try {
      var results = await Promise.all([
        fetch('/api/edog/health').then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; }),
        fetch('/api/flt/config').then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; }),
        fetch('/api/edog/patch-warnings').then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; })
      ]);
      health = results[0];
      config = results[1];
      patchWarnings = results[2];
    } catch (_) { /* handled below */ }

    if (tokenBody) {
      if (health) {
        this._renderToken(tokenBody, health, config);
        var tokenOk = health.hasBearerToken && health.bearerExpiresIn > 300;
        this._setBadge(tokenCard, tokenOk ? 'ok' : 'error', tokenOk ? 'valid' : 'expired');
      } else {
        tokenBody.innerHTML = '<div class="ecard-error">Health endpoint unreachable</div>';
        this._setBadge(tokenCard, 'error', 'error');
      }
    }

    if (buildBody) {
      if (health) {
        this._renderBuild(buildBody, health, patchWarnings);
        var warnCount = Array.isArray(patchWarnings) ? patchWarnings.length : 0;
        this._setBadge(buildCard, warnCount > 0 ? 'warn' : 'ok', warnCount > 0 ? warnCount + ' warnings' : 'clean');
      } else {
        buildBody.innerHTML = '<div class="ecard-error">Health endpoint unreachable</div>';
        this._setBadge(buildCard, 'error', 'error');
      }
    }
  }

  async _loadInterceptors() {
    var card = document.getElementById('card-interceptors');
    if (!card) return;
    var body = card.querySelector('.env-card-body');
    body.innerHTML = '<div class="ecard-shimmer"><span class="sk-bar sk-kv"></span><span class="sk-bar sk-kv"></span><span class="sk-bar sk-kv"></span></div>';
    try {
      var resp = await fetch('/api/edog/interceptors-status');
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      var data = await resp.json();
      this._renderInterceptors(body, data);
      var summary = data.summary || { wrapped: 0, total: 0 };
      this._setBadge(card, summary.wrapped === summary.total ? 'ok' : 'warn',
        summary.wrapped + '/' + summary.total + ' wrapped');
    } catch (err) {
      body.innerHTML = '<div class="ecard-error">Interceptors unavailable: ' + _ecEsc(err.message) + '</div>';
      this._setBadge(card, 'error', 'unavailable');
    }
  }

  /* ── Renderers ────────────────────────────────────────────────────── */

  _renderConfig(body, data) {
    var phase = data.phase || 'unknown';
    var phaseClass = (phase === 'connected') ? 'connected' : 'disconnected';
    var studioPhase = data.studioPhase || '—';
    var studioClass = (studioPhase === 'running') ? 'running' : 'disconnected';

    var rows = [
      { label: 'Phase', value: phase, phase: phaseClass },
      { label: 'Studio', value: studioPhase, phase: studioClass },
      { label: 'Workspace', value: data.workspaceId || '—', copy: true, mono: true },
      { label: 'Artifact', value: data.artifactId || '—', copy: true, mono: true },
      { label: 'Capacity', value: data.capacityId || '—', copy: true, mono: true },
      { label: 'FLT Port', value: data.fltPort != null ? String(data.fltPort) : '—' }
    ];
    body.innerHTML = this._kvGrid(rows);
    this._bindCopyButtons(body);
  }

  _renderToken(body, health, config) {
    var bearerOk = health.hasBearerToken && health.bearerExpiresIn > 0;
    var expiresText = bearerOk ? _ecFmtDuration(health.bearerExpiresIn) : 'expired';

    /* Progress bar: assume 1h (3600s) max token lifetime */
    var maxLife = 3600;
    var pct = bearerOk ? Math.min(100, Math.round((health.bearerExpiresIn / maxLife) * 100)) : 0;
    var barClass = pct > 40 ? 'ok' : pct > 15 ? 'warn' : 'error';

    var mwcText = (config && config.mwcToken) ? 'proxy-managed' : 'unavailable';
    var mwcStatus = (config && config.mwcToken) ? 'ok' : 'warn';

    var username = health.lastUsername || '—';

    var rows = [
      { label: 'User', value: username, username: true },
      { label: 'Bearer', value: '', bearer: { text: bearerOk ? expiresText + ' remaining' : 'expired', pct: pct, barClass: barClass } },
      { label: 'MWC', value: mwcText, pill: mwcStatus },
      { label: 'Token Helper', value: health.tokenHelperBuilt ? 'built' : 'not built', pill: health.tokenHelperBuilt ? 'ok' : 'warn' }
    ];
    body.innerHTML = this._kvGrid(rows);
  }

  _renderBuild(body, health, patchWarnings) {
    var dirtyCount = health.gitDirtyFiles || 0;
    var dirtyLabel = String(dirtyCount);
    if (health.gitDirtyEdogFiles) {
      dirtyLabel += ' (edog: ' + health.gitDirtyEdogFiles + ')';
    }

    var repo = health.fltRepo || {};
    var repoPath = repo.path || '—';
    var repoValid = repo.configured && repo.valid;

    var warnCount = Array.isArray(patchWarnings) ? patchWarnings.length : 0;

    var rows = [
      { label: 'Branch', value: health.gitBranch || '—', branch: true },
      { label: 'Dirty Files', value: dirtyLabel, dirty: dirtyCount },
      { label: 'FLT Repo', value: repoPath, pill: repoValid ? 'ok' : 'error', mono: true, truncate: true, title: repoPath },
      { label: 'Patch Warnings', value: warnCount > 0 ? String(warnCount) : 'none', pill: warnCount > 0 ? 'warn' : 'ok' }
    ];
    body.innerHTML = this._kvGrid(rows);
  }

  _renderInterceptors(body, data) {
    var list = data.interceptors || [];
    if (list.length === 0) {
      body.innerHTML = '<div class="ecard-empty">No interceptors registered</div>';
      return;
    }
    var html = '<div class="ecard-ix-grid">';
    for (var i = 0; i < list.length; i++) {
      var ix = list[i];
      var ok = ix.wrapped;
      var dotClass = ok ? 'ix-ok' : 'ix-fail';
      var glyph = ok ? '\u2713' : '\u2717';
      var errTitle = ix.recordedError ? ' title="' + _ecEsc(ix.recordedError) + '"' : '';
      html += '<div class="ecard-ix-cell"' + errTitle + '>'
        + '<span class="ix-glyph ' + dotClass + '">' + glyph + '</span>'
        + '<span class="ix-name">' + _ecEsc(ix.name) + '</span>'
        + '</div>';
    }
    html += '</div>';
    body.innerHTML = html;
  }

  /* ── Helpers ──────────────────────────────────────────────────────── */

  _kvGrid(rows) {
    var html = '<div class="ecard-kv-grid">';
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      html += '<div class="ecard-kv-row">';
      html += '<span class="ecard-kv-label">' + _ecEsc(r.label) + '</span>';

      var valClasses = 'ecard-kv-value' + (r.mono ? ' mono' : '');
      html += '<span class="' + valClasses + '">';

      if (r.phase) {
        /* Phase indicator: colored dot + text */
        html += '<span class="ecard-phase-indicator">'
          + '<span class="ecard-phase-dot ' + r.phase + '"></span>'
          + _ecEsc(r.value) + '</span>';
      } else if (r.bearer) {
        /* Bearer expiry progress bar */
        html += '<div class="ecard-bearer-bar">'
          + '<div class="ecard-bearer-track"><div class="ecard-bearer-fill ' + r.bearer.barClass + '" style="width:' + r.bearer.pct + '%"></div></div>'
          + '<span class="ecard-bearer-text">' + _ecEsc(r.bearer.text) + '</span>'
          + '</div>';
      } else if (r.username) {
        html += '<span class="ecard-username">' + _ecEsc(r.value) + '</span>';
      } else if (r.branch) {
        /* Git branch as styled pill */
        html += '<span class="ecard-branch-pill">'
          + '<span class="ecard-branch-icon">'
          + '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M9.5 3.25a2.25 2.25 0 113 2.122V6.5A2.5 2.5 0 0110 9H6a1 1 0 00-1 1v1.128a2.251 2.251 0 11-1.5 0V5.372a2.25 2.25 0 111.5 0v1.836A2.492 2.492 0 016 7h4a1 1 0 001-1v-1.128A2.251 2.251 0 019.5 3.25z"/></svg>'
          + '</span>'
          + _ecEsc(r.value) + '</span>';
      } else if (r.dirty !== undefined) {
        /* Dirty file count with color coding */
        var dirtyClass = r.dirty > 0 ? 'ecard-dirty-warn' : 'ecard-dirty-clean';
        html += '<span class="' + dirtyClass + '">' + _ecEsc(r.value) + '</span>';
        if (r.dirty === 0) html += ' <span class="ecard-pill ok"><span class="ecard-pill-dot"></span>clean</span>';
      } else if (r.pill) {
        html += '<span class="ecard-pill ' + r.pill + '">'
          + '<span class="ecard-pill-dot"></span>';
        if (r.truncate) {
          html += '<span class="ecard-repo-path" title="' + _ecEsc(r.title || r.value) + '">' + _ecEsc(r.value) + '</span>';
        } else {
          html += _ecEsc(r.value);
        }
        html += '</span>';
      } else if (r.truncate) {
        html += '<span class="ecard-repo-path" title="' + _ecEsc(r.title || r.value) + '">' + _ecEsc(r.value) + '</span>';
      } else {
        html += _ecEsc(r.value);
      }

      if (r.copy && r.value && r.value !== '\u2014') {
        html += ' <button class="ecard-copy" data-copy="' + _ecEsc(r.value) + '" title="Copy to clipboard">'
          + '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4">'
          + '<rect x="5" y="5" width="9" height="9" rx="1.5"/>'
          + '<path d="M11 5V3.5A1.5 1.5 0 009.5 2h-6A1.5 1.5 0 002 3.5v6A1.5 1.5 0 003.5 11H5"/>'
          + '</svg></button>';
      }
      html += '</span>';
      html += '</div>';
    }
    html += '</div>';
    return html;
  }

  _setBadge(card, status, text) {
    var badge = card.querySelector('.ecard-header-badge');
    if (!badge) return;
    badge.className = 'ecard-header-badge ' + status;
    badge.textContent = text;
  }

  _bindCopyButtons(container) {
    container.addEventListener('click', function (e) {
      var btn = e.target.closest('.ecard-copy');
      if (!btn) return;
      var val = btn.getAttribute('data-copy');
      if (!val) return;
      navigator.clipboard.writeText(val).then(function () {
        btn.classList.add('copied');
        setTimeout(function () { btn.classList.remove('copied'); }, 1200);
        _ecShowCopyToast('Copied to clipboard');
      });
    });
  }

  _bindCollapse() {
    var self = this;
    var ids = ['card-config-snapshot', 'card-token-state', 'card-build-patch', 'card-interceptors'];
    var keys = ['config', 'token', 'build', 'interceptors'];
    for (var i = 0; i < ids.length; i++) {
      (function (cardId, key) {
        var card = document.getElementById(cardId);
        if (!card) return;
        var header = card.querySelector('.env-card-header');
        if (!header) return;
        header.style.cursor = 'pointer';
        header.addEventListener('click', function (e) {
          if (e.target.closest('.ecard-refresh-btn') || e.target.closest('.ecard-copy')) return;
          self._collapsed[key] = !self._collapsed[key];
          var body = card.querySelector('.env-card-body');
          if (body) body.style.display = self._collapsed[key] ? 'none' : '';
          var chevron = header.querySelector('.ecard-chevron');
          if (chevron) chevron.textContent = self._collapsed[key] ? '\u25B8' : '\u25BE';
        });
      })(ids[i], keys[i]);
    }
  }

  _bindRefresh() {
    var self = this;
    var map = {
      'card-config-snapshot': function () { self._loadConfig(); },
      'card-token-state': function () { self._loadHealth(); },
      'card-build-patch': function () { self._loadHealth(); },
      'card-interceptors': function () { self._loadInterceptors(); }
    };
    Object.keys(map).forEach(function (id) {
      var card = document.getElementById(id);
      if (!card) return;
      var btn = card.querySelector('.ecard-refresh-btn');
      if (!btn) return;
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        map[id]();
      });
    });
  }
}

/* ── Module-level helpers (no collision with other modules) ─────────── */

function _ecEsc(s) {
  if (typeof s !== 'string') return String(s || '');
  var d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function _ecFmtDuration(seconds) {
  if (seconds >= 3600) {
    var h = Math.floor(seconds / 3600);
    var m = Math.floor((seconds % 3600) / 60);
    return h + 'h ' + m + 'm';
  }
  if (seconds >= 60) {
    return Math.floor(seconds / 60) + 'm';
  }
  return seconds + 's';
}

function _ecShowCopyToast(msg) {
  var existing = document.getElementById('ecardCopyToast');
  if (existing) existing.remove();
  var toast = document.createElement('div');
  toast.id = 'ecardCopyToast';
  toast.className = 'ecard-copy-toast';
  toast.textContent = msg;
  document.body.appendChild(toast);
  requestAnimationFrame(function () {
    toast.classList.add('visible');
  });
  setTimeout(function () {
    toast.classList.remove('visible');
    setTimeout(function () { toast.remove(); }, 200);
  }, 1400);
}
