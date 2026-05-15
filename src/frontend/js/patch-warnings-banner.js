/**
 * PatchWarningsBanner — surfaces edog.py "pattern not found" warnings.
 *
 * Renders into #patch-warnings-banner. Visible whenever the most recent deploy
 * emitted regex-anchor failures from edog.py. When FLT renames or removes an
 * anchor line, our patch silently no-ops and the deploy still goes green —
 * this banner is the only thing that tells the developer the EDOG fleet is
 * incomplete.
 *
 * Driven by `status.patchWarnings` from /api/studio/status (already polled by
 * topbar.js every 30s). Click → opens Inspector EDOG Health tile.
 *
 * @author Pixel — EDOG Studio hivemind
 */
class PatchWarningsBanner {
  constructor() {
    this._el = document.getElementById('patch-warnings-banner');
    this._lastKey = '';
  }

  /**
   * Update from studio status payload.
   * @param {object|null} status — must include .patchWarnings (array<string>)
   */
  update(status) {
    if (!this._el) return;

    var warnings = (status && Array.isArray(status.patchWarnings)) ? status.patchWarnings : [];
    if (!warnings.length) {
      this.hide();
      return;
    }

    // Skip re-render if the warning set is unchanged — avoids DOM thrash
    // on every 30s poll.
    var key = warnings.join('||');
    if (key === this._lastKey && this._el.classList.contains('active')) return;
    this._lastKey = key;

    this._el.innerHTML = '';

    var icon = document.createElement('span');
    icon.className = 'pwb-icon';
    icon.textContent = '\u26A0';
    this._el.appendChild(icon);

    var label = document.createElement('span');
    label.className = 'pwb-label';
    label.textContent = warnings.length === 1
      ? '1 EDOG patch warning'
      : warnings.length + ' EDOG patch warnings';
    this._el.appendChild(label);

    var detail = document.createElement('span');
    detail.className = 'pwb-detail';
    detail.textContent = 'Some interceptors may be inactive. The deploy succeeded but at least one regex anchor in edog.py did not match.';
    this._el.appendChild(detail);

    var btn = document.createElement('button');
    btn.className = 'pwb-btn';
    btn.type = 'button';
    btn.textContent = 'Details';
    btn.title = warnings.map(function(w) { return '\u2022 ' + w; }).join('\n');
    btn.addEventListener('click', function() {
      // Open Inspector and scroll to EDOG Health tile if present.
      if (window.edogTopbar && typeof window.edogTopbar.openInspector === 'function') {
        window.edogTopbar.openInspector('edog-health');
      } else {
        // Fallback: surface in console so the warning isn't lost.
        console.warn('[EDOG patch warnings]\n' + warnings.join('\n'));
      }
    });
    this._el.appendChild(btn);

    this._el.classList.add('active');
  }

  hide() {
    if (!this._el) return;
    this._el.classList.remove('active');
    this._el.innerHTML = '';
    this._lastKey = '';
  }
}

window.edogPatchWarnings = new PatchWarningsBanner();
