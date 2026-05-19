/**
 * DeployContextStrip — persistent deploy context notification.
 *
 * Shows tenant, capacity, workspace, lakehouse, commit SHA in a breadcrumb
 * strip when FLT is connected. Renders into #deploy-context-strip.
 *
 * @author Pixel — EDOG Studio hivemind
 */
class DeployContextStrip {
  constructor() {
    this._el = document.getElementById('deploy-context-strip');
    this._tooltip = null;
    this._deployedAt = null;
    this._timeTimer = null;
    this._createTooltip();
  }

  /**
   * Update strip with deploy config data.
   * @param {object|null} status — from /api/studio/status
   *
   * Visibility rule: only show after deploy is fully complete (phase === 'running').
   * Previously the strip appeared during 'deploying' too, which made it pop up
   * mid-build with empty fields — confusing and premature.
   */
  update(status) {
    if (!this._el) return;

    if (!status || !status.deployTarget || status.phase !== 'running') {
      this._el.classList.remove('active');
      if (this._timeTimer) { clearInterval(this._timeTimer); this._timeTimer = null; }
      return;
    }

    var t = status.deployTarget;
    var self = this;

    this._el.innerHTML = '';

    // Badge
    var badge = document.createElement('div');
    badge.className = 'ds-badge';
    badge.innerHTML = '<span class="ds-dot"></span><span class="ds-badge-label">Connected</span>';
    this._el.appendChild(badge);

    // Breadcrumb path: workspace > lakehouse (names, IDs on tooltip)
    var path = document.createElement('div');
    path.className = 'ds-path';
    var segments = [
      { text: t.workspaceName || 'workspace', title: t.workspaceId || '', bold: true },
      { text: t.lakehouseName || 'lakehouse', title: t.artifactId || '', bold: true },
    ];
    segments.forEach(function(seg, i) {
      if (i > 0) {
        var chev = document.createElement('span');
        chev.className = 'ds-chevron';
        chev.textContent = '\u203A';
        path.appendChild(chev);
      }
      var span = document.createElement('span');
      span.className = 'ds-path-seg' + (seg.bold ? ' bold' : '');
      span.textContent = seg.text;
      if (seg.title) span.title = seg.title;
      path.appendChild(span);
    });
    this._el.appendChild(path);

    // Divider
    var div = document.createElement('div');
    div.className = 'ds-divider';
    this._el.appendChild(div);

    // Commit chip
    if (t.commitSha) {
      var commit = document.createElement('div');
      commit.className = 'ds-commit';
      var sha = document.createElement('span');
      sha.className = 'ds-sha';
      sha.textContent = t.commitSha.substring(0, 7);
      commit.appendChild(sha);
      if (t.commitMessage) {
        var msg = document.createElement('span');
        msg.className = 'ds-msg';
        msg.textContent = t.commitMessage;
        commit.appendChild(msg);
      }
      commit.addEventListener('mouseenter', function(e) {
        self._showTooltip(e, t);
      });
      commit.addEventListener('mouseleave', function() {
        self._hideTooltip();
      });
      this._el.appendChild(commit);
    }

    // Spacer
    var spacer = document.createElement('div');
    spacer.className = 'ds-spacer';
    this._el.appendChild(spacer);

    // Time
    this._deployedAt = this._deployedAt || Date.now();
    var time = document.createElement('span');
    time.className = 'ds-time';
    time.id = 'ds-time';
    this._el.appendChild(time);
    this._updateTime();
    if (!this._timeTimer) {
      this._timeTimer = setInterval(function() { self._updateTime(); }, 60000);
    }

    // Disconnect button
    var disconnectBtn = document.createElement('button');
    disconnectBtn.className = 'ds-disconnect';
    disconnectBtn.textContent = 'Disconnect';
    disconnectBtn.title = 'Stop FLT service and disconnect';
    disconnectBtn.addEventListener('click', function() {
      // Call the server-side undeploy endpoint to stop FLT + revert
      fetch('/api/command/undeploy', { method: 'POST' })
        .then(function() {
          if (window.edogWs) window.edogWs.disconnect();
          if (window.edogSidebar) window.edogSidebar.setPhase('disconnected');
          if (window.edogStatusBar) window.edogStatusBar.setPhase('disconnected');
          if (window.edogDeployStrip) window.edogDeployStrip.hide();
        })
        .catch(function() {
          // Fallback: at least disconnect the UI side
          if (window.edogWs) window.edogWs.disconnect();
          if (window.edogSidebar) window.edogSidebar.setPhase('disconnected');
          if (window.edogStatusBar) window.edogStatusBar.setPhase('disconnected');
          if (window.edogDeployStrip) window.edogDeployStrip.hide();
        });
    });
    this._el.appendChild(disconnectBtn);

    this._el.classList.add('active');
  }

  _updateTime() {
    var el = document.getElementById('ds-time');
    if (!el || !this._deployedAt) return;
    var sec = Math.floor((Date.now() - this._deployedAt) / 1000);
    if (sec < 60) el.textContent = 'just now';
    else if (sec < 3600) el.textContent = Math.floor(sec / 60) + 'm ago';
    else el.textContent = Math.floor(sec / 3600) + 'h ago';
  }

  _createTooltip() {
    this._tooltip = document.createElement('div');
    this._tooltip.className = 'ds-tooltip';
    document.body.appendChild(this._tooltip);
  }

  _showTooltip(event, target) {
    if (!this._tooltip) return;
    this._tooltip.innerHTML =
      '<div class="dt-sha">' + this._esc(target.commitSha || '') + '</div>' +
      '<div class="dt-msg">' + this._esc(target.commitMessage || '') + '</div>' +
      '<div class="dt-author">' + this._esc(target.commitAuthor || '') + '</div>';
    var rect = event.currentTarget.getBoundingClientRect();
    this._tooltip.style.left = rect.left + 'px';
    this._tooltip.style.top = (rect.bottom + 6) + 'px';
    this._tooltip.classList.add('visible');
  }

  _hideTooltip() {
    if (this._tooltip) this._tooltip.classList.remove('visible');
  }

  _esc(s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

  /** Hide strip and stop timers. */
  hide() {
    if (this._el) this._el.classList.remove('active');
    if (this._timeTimer) { clearInterval(this._timeTimer); this._timeTimer = null; }
    this._deployedAt = null;
  }
}

window.edogDeployStrip = new DeployContextStrip();
