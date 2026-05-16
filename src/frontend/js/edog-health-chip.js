/**
 * EdogHealthChip — topbar status chip for EDOG interceptors.
 *
 * Shows "Interceptors: N/M" with traffic-light color:
 *   green  — N == M, all DI-bound interceptors wrapped
 *   amber  — N <  M, some failed but the status endpoint responded
 *   red    — endpoint unreachable / probe exception / patchWarnings present
 *   hidden — phase is idle/stopped (nothing useful to report)
 *
 * Click opens a dropdown listing every interceptor with its wrap status and
 * last error (if any) — the deep-dive surface for verifying that Phase 2
 * fixes actually re-attached the wrappers.
 *
 * Data flows through the dev-server proxy /api/edog/interceptors-status,
 * which forwards to the FLT-side EdogLogServer. Same origin → no CORS dance.
 *
 * @author Pixel — EDOG Studio hivemind
 */
class EdogHealthChip {
  constructor() {
    this._el = document.getElementById('edog-health-chip');
    this._dot = this._el ? this._el.querySelector('.ehc-dot') : null;
    this._count = this._el ? this._el.querySelector('.ehc-count') : null;
    this._panel = null;
    this._lastData = null;
    if (this._el) {
      this._el.addEventListener('click', () => this._togglePanel());
    }
    document.addEventListener('click', (e) => {
      if (!this._panel || !this._panel.classList.contains('open')) return;
      if (this._el.contains(e.target) || this._panel.contains(e.target)) return;
      this._closePanel();
    });
  }

  /**
   * Update chip from the studio status payload (for patchWarnings) and
   * the proxied interceptor status payload (for wrapped counts).
   * @param {object} studioStatus — /api/studio/status
   * @param {object} interceptors — /api/edog/interceptors-status
   */
  update(studioStatus, interceptors) {
    if (!this._el) return;

    var phase = studioStatus && studioStatus.phase;
    // Only show the chip when FLT is actually running. Pre-deploy, the count
    // is meaningless and would be noise in the topbar.
    if (phase !== 'running') {
      this._el.style.display = 'none';
      this._lastData = null;
      return;
    }

    var available = interceptors && interceptors.available;
    var summary = (interceptors && interceptors.summary) || { total: 0, wrapped: 0, failed: 0 };
    var warnings = (studioStatus && studioStatus.patchWarnings) || [];

    var color;
    var text;
    if (!available) {
      color = 'red';
      text = '? / ?';
      this._el.title = 'EDOG status endpoint unreachable\n' + (interceptors && interceptors.error ? interceptors.error : 'FLT may not have the interceptor registry loaded.');
    } else {
      var wrapped = summary.wrapped || 0;
      var total = summary.total || 0;
      text = wrapped + ' / ' + total;
      if (warnings.length > 0 || (summary.failed || 0) > 0) {
        color = 'red';
      } else if (wrapped < total) {
        color = 'amber';
      } else {
        color = 'green';
      }
      this._el.title = wrapped + ' of ' + total + ' EDOG interceptors wrapped'
        + (warnings.length ? '\n' + warnings.length + ' patch warning(s) — click for details' : '')
        + (summary.failed ? '\n' + summary.failed + ' DI resolution failure(s)' : '');
    }

    this._el.style.display = '';
    if (this._count) this._count.textContent = text;
    if (this._dot) {
      this._dot.classList.remove('green', 'amber', 'red');
      this._dot.classList.add(color);
    }
    this._lastData = { studio: studioStatus, interceptors: interceptors };

    // If panel is open, refresh its content live.
    if (this._panel && this._panel.classList.contains('open')) {
      this._renderPanel();
    }
  }

  _togglePanel() {
    if (!this._panel) this._createPanel();
    if (this._panel.classList.contains('open')) {
      this._closePanel();
    } else {
      this._renderPanel();
      this._positionPanel();
      this._panel.classList.add('open');
    }
  }

  _closePanel() {
    if (this._panel) this._panel.classList.remove('open');
  }

  _createPanel() {
    this._panel = document.createElement('div');
    this._panel.className = 'ehc-panel';
    document.body.appendChild(this._panel);
  }

  _positionPanel() {
    if (!this._panel || !this._el) return;
    var rect = this._el.getBoundingClientRect();
    this._panel.style.top = (rect.bottom + 6) + 'px';
    this._panel.style.right = (window.innerWidth - rect.right) + 'px';
  }

  _renderPanel() {
    if (!this._panel) return;
    var data = this._lastData || {};
    var ix = data.interceptors || {};
    var warnings = (data.studio && data.studio.patchWarnings) || [];
    var list = ix.interceptors || [];

    var parts = [];
    parts.push('<div class="ehc-panel-header">EDOG interceptor health</div>');

    if (warnings.length > 0) {
      parts.push('<div class="ehc-panel-section warn">');
      parts.push('<div class="ehc-section-title">Patch warnings (' + warnings.length + ')</div>');
      warnings.forEach(function(w) {
        parts.push('<div class="ehc-warning-row">' + escapeHtml(w) + '</div>');
      });
      parts.push('</div>');
    }

    if (!ix.available) {
      parts.push('<div class="ehc-panel-section">');
      parts.push('<div class="ehc-empty">Status endpoint unreachable.</div>');
      if (ix.error) parts.push('<div class="ehc-empty">' + escapeHtml(String(ix.error)) + '</div>');
      parts.push('</div>');
    } else if (!list.length) {
      parts.push('<div class="ehc-panel-section">');
      parts.push('<div class="ehc-empty">No interceptors reported by FLT.</div>');
      parts.push('</div>');
    } else {
      parts.push('<div class="ehc-panel-section">');
      parts.push('<div class="ehc-section-title">Interceptors</div>');
      list.forEach(function(i) {
        // Backend enum InterceptorKind serializes as integer: 0 = DiWrap, 1 = Static
        var isStatic = i.kind === 1;
        var ok = i.wrapped === true;
        var statusCls = ok ? 'ok' : (isStatic ? 'static' : 'fail');
        var statusGlyph = ok ? '\u2713' : (isStatic ? '\u25CB' : '\u2717');
        parts.push('<div class="ehc-row ' + statusCls + '">');
        parts.push('<span class="ehc-row-glyph">' + statusGlyph + '</span>');
        parts.push('<span class="ehc-row-name">' + escapeHtml(i.name || '?') + '</span>');
        var kindLbl = isStatic ? 'static' : (i.interfaceType ? shortType(i.interfaceType) : '');
        if (kindLbl) parts.push('<span class="ehc-row-kind">' + escapeHtml(kindLbl) + '</span>');
        var err = i.probeError || i.recordedError;
        if (err) {
          parts.push('<div class="ehc-row-error">' + escapeHtml(err) + '</div>');
        }
        parts.push('</div>');
      });
      parts.push('</div>');
    }

    parts.push('<div class="ehc-panel-footer">');
    parts.push('<button class="ehc-refresh" type="button">Refresh</button>');
    parts.push('</div>');

    this._panel.innerHTML = parts.join('');

    var refresh = this._panel.querySelector('.ehc-refresh');
    if (refresh) {
      refresh.addEventListener('click', () => {
        if (window.edogTopbar && typeof window.edogTopbar.fetchConfig === 'function') {
          window.edogTopbar.fetchConfig();
        }
      });
    }

    function escapeHtml(s) {
      var d = document.createElement('div');
      d.textContent = s;
      return d.innerHTML;
    }
    function shortType(t) {
      if (typeof t !== 'string') return '';
      var idx = t.lastIndexOf('.');
      return idx >= 0 ? t.substring(idx + 1) : t;
    }
  }
}

window.edogHealthChip = new EdogHealthChip();
