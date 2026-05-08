/**
 * StatusBar — footer status bar.
 *
 * VS Code-style 24px bar at bottom of viewport.
 * Left: phase indicator. Center: coverage badge. Right: feedback + version.
 * Replaces sidebar footer.
 *
 * @author Pixel — EDOG Studio hivemind
 */
class StatusBar {
  constructor() {
    this._phaseDot = document.getElementById('sb-phase-dot');
    this._phaseLabel = document.getElementById('sb-phase-label');
    this._coverageBtn = document.getElementById('sb-coverage');
    this._feedbackBtn = document.getElementById('sb-feedback');
    this._versionEl = document.getElementById('sb-version');
    this._bindEvents();
    this._fetchVersion();
  }

  _bindEvents() {
    var self = this;
    if (this._feedbackBtn) {
      this._feedbackBtn.addEventListener('click', function() { self._openFeedback(); });
    }
  }

  /**
   * Update phase indicator.
   * @param {string} phase — 'connected' | 'disconnected' | 'deploying'
   */
  setPhase(phase) {
    if (this._phaseDot) {
      this._phaseDot.className = 'sb-phase-dot ' + phase;
    }
    if (this._phaseLabel) {
      var labels = { connected: 'Connected', disconnected: 'Disconnected', deploying: 'Deploying' };
      this._phaseLabel.textContent = labels[phase] || phase;
    }
  }

  /**
   * Update coverage badge text.
   * @param {string} text — e.g., "72% L · 65% B · 80% M" or "--"
   */
  setCoverage(text) {
    if (this._coverageBtn) {
      this._coverageBtn.textContent = text || '--';
    }
  }

  _fetchVersion() {
    var self = this;
    fetch('/api/edog/health').then(function(r) {
      return r.ok ? r.json() : null;
    }).then(function(h) {
      if (h && h.version && self._versionEl) {
        self._versionEl.textContent = 'EDOG v' + h.version;
      }
    }).catch(function() {});
  }

  _openFeedback() {
    var title = prompt('Feedback title:');
    if (!title) return;
    var body = prompt('Description (optional):') || '';

    fetch('/api/studio/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: title, body: body }),
    }).then(function(r) {
      if (r.ok) return r.json();
      throw new Error('Backend feedback failed');
    }).then(function(data) {
      window.edogToast('Feedback submitted' + (data.issueNumber ? ' \u2014 issue #' + data.issueNumber : ''), 'success');
    }).catch(function() {
      var url = 'https://github.com/guptahemant65/edog-studio/issues/new?title=' + encodeURIComponent('[Feedback] ' + title) + '&body=' + encodeURIComponent(body);
      window.open(url, '_blank');
      window.edogToast('Opened feedback form in browser', 'info');
    });
  }
}

window.edogStatusBar = new StatusBar();
