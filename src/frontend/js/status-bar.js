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
    this._feedbackPopover = null;
    this._feedbackOpen = false;
    this._bindEvents();
    this._fetchVersion();
  }

  _bindEvents() {
    var self = this;
    if (this._feedbackBtn) {
      this._feedbackBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        self._toggleFeedback();
      });
    }
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape' && self._feedbackOpen) self._closeFeedback();
    });
    document.addEventListener('mousedown', function(e) {
      if (self._feedbackOpen && self._feedbackPopover && !self._feedbackPopover.contains(e.target) && e.target !== self._feedbackBtn) {
        self._closeFeedback();
      }
    });
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

  _toggleFeedback() {
    if (this._feedbackOpen) {
      this._closeFeedback();
    } else {
      this._openFeedback();
    }
  }

  _openFeedback() {
    if (this._feedbackOpen) return;
    this._feedbackOpen = true;

    if (!this._feedbackPopover) {
      this._feedbackPopover = this._createPopover();
      document.body.appendChild(this._feedbackPopover);
    }

    this._feedbackPopover.classList.remove('closing');
    this._feedbackPopover.classList.add('open');

    var titleInput = this._feedbackPopover.querySelector('[data-fb-title]');
    if (titleInput) {
      titleInput.value = '';
      setTimeout(function() { titleInput.focus(); }, 60);
    }
    var descEl = this._feedbackPopover.querySelector('[data-fb-desc]');
    if (descEl) descEl.value = '';
    var catEl = this._feedbackPopover.querySelector('[data-fb-cat]');
    if (catEl) catEl.value = 'bug';
    this._updateSubmitState();
  }

  _closeFeedback() {
    if (!this._feedbackOpen || !this._feedbackPopover) return;
    this._feedbackOpen = false;
    var pop = this._feedbackPopover;
    pop.classList.add('closing');
    pop.addEventListener('animationend', function handler() {
      pop.classList.remove('open', 'closing');
      pop.removeEventListener('animationend', handler);
    });
  }

  _createPopover() {
    var self = this;
    var el = document.createElement('div');
    el.className = 'sb-feedback-popover';
    el.innerHTML =
      '<div class="sb-fb-header">' +
        '<h4>Send Feedback</h4>' +
        '<button class="sb-fb-close" title="Close">\u2715</button>' +
      '</div>' +
      '<div class="sb-fb-body">' +
        '<div class="sb-fb-field">' +
          '<label>Category</label>' +
          '<select data-fb-cat>' +
            '<option value="bug">Bug Report</option>' +
            '<option value="feature">Feature Request</option>' +
            '<option value="ux">UX Improvement</option>' +
            '<option value="other">Other</option>' +
          '</select>' +
        '</div>' +
        '<div class="sb-fb-field">' +
          '<label>Title</label>' +
          '<input type="text" data-fb-title placeholder="Brief summary..." maxlength="120" />' +
        '</div>' +
        '<div class="sb-fb-field">' +
          '<label>Description <span style="color:var(--text-dim);font-weight:400">(optional)</span></label>' +
          '<textarea data-fb-desc placeholder="Steps to reproduce, expected behavior, suggestions..." rows="3"></textarea>' +
        '</div>' +
        '<div class="sb-fb-actions">' +
          '<button class="sb-fb-submit" data-fb-send disabled>Submit</button>' +
        '</div>' +
      '</div>';

    el.querySelector('.sb-fb-close').addEventListener('click', function() { self._closeFeedback(); });

    var titleInput = el.querySelector('[data-fb-title]');
    titleInput.addEventListener('input', function() { self._updateSubmitState(); });

    el.querySelector('[data-fb-send]').addEventListener('click', function() { self._submitFeedback(); });

    titleInput.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && titleInput.value.trim()) self._submitFeedback();
    });

    return el;
  }

  _updateSubmitState() {
    if (!this._feedbackPopover) return;
    var title = this._feedbackPopover.querySelector('[data-fb-title]');
    var btn = this._feedbackPopover.querySelector('[data-fb-send]');
    if (title && btn) {
      btn.disabled = !title.value.trim();
    }
  }

  _submitFeedback() {
    if (!this._feedbackPopover) return;
    var titleEl = this._feedbackPopover.querySelector('[data-fb-title]');
    var descEl = this._feedbackPopover.querySelector('[data-fb-desc]');
    var catEl = this._feedbackPopover.querySelector('[data-fb-cat]');
    var sendBtn = this._feedbackPopover.querySelector('[data-fb-send]');
    var title = titleEl ? titleEl.value.trim() : '';
    if (!title) return;
    var desc = descEl ? descEl.value.trim() : '';
    var cat = catEl ? catEl.value : 'other';
    var catLabels = { bug: 'Bug', feature: 'Feature', ux: 'UX', other: 'Other' };
    var fullTitle = '[' + (catLabels[cat] || 'Feedback') + '] ' + title;

    if (sendBtn) {
      sendBtn.classList.add('sending');
      sendBtn.textContent = 'Sending...';
    }

    var self = this;
    fetch('/api/studio/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: fullTitle, body: desc }),
    }).then(function(r) {
      if (r.ok) return r.json();
      throw new Error('Backend feedback failed');
    }).then(function(data) {
      window.edogToast('Feedback submitted' + (data.issueNumber ? ' \u2014 issue #' + data.issueNumber : ''), 'success');
      self._closeFeedback();
    }).catch(function() {
      var url = 'https://github.com/guptahemant65/edog-studio/issues/new?title=' + encodeURIComponent(fullTitle) + '&body=' + encodeURIComponent(desc);
      window.open(url, '_blank');
      window.edogToast('Opened feedback in browser', 'info');
      self._closeFeedback();
    }).finally(function() {
      if (sendBtn) {
        sendBtn.classList.remove('sending');
        sendBtn.textContent = 'Submit';
      }
    });
  }
}

window.edogStatusBar = new StatusBar();
