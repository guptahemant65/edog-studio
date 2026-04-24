/**
 * FileChangeWatcher — polls for FLT source changes, renders notification bar.
 *
 * Polls /api/studio/file-changes every 5 seconds when FLT is running.
 * Renders into #file-change-bar with changed file list, Re-deploy, and Dismiss.
 *
 * @author Pixel — EDOG Studio hivemind
 */
class FileChangeWatcher {
  constructor() {
    this._el = document.getElementById('file-change-bar');
    this._pollTimer = null;
    this._active = false;
    this._lastVersion = 0;
    this._onRedeploy = null;  // callback set by main.js
  }

  /**
   * Start polling for file changes. Call when FLT reaches "running" state.
   */
  start() {
    if (this._active) return;
    this._active = true;
    this._lastVersion = 0;
    this._poll();
    this._pollTimer = setInterval(this._poll.bind(this), 5000);
  }

  /**
   * Stop polling. Call when deploying, stopped, or crashed.
   */
  stop() {
    this._active = false;
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
    this._hide();
  }

  /**
   * Poll the backend for file changes.
   * @private
   */
  _poll() {
    if (!this._active) return;
    var self = this;
    fetch('/api/studio/file-changes')
      .then(function (resp) {
        if (!resp.ok) return null;
        return resp.json();
      })
      .then(function (data) {
        if (!data || !self._active) return;
        if (data.files && data.files.length > 0) {
          self._lastVersion = data.version;
          self._render(data.files, data.version);
        } else {
          self._hide();
        }
      })
      .catch(function () {
        // Ignore — server might be restarting
      });
  }

  /**
   * Render the notification bar with changed files.
   * @param {string[]} files - Relative paths of changed files
   * @param {number} version - Change version for dismiss
   * @private
   */
  _render(files, version) {
    if (!this._el) return;
    var count = files.length;
    var label = count === 1 ? '1 file changed' : count + ' files changed';
    var shortNames = files.map(function (f) {
      var parts = f.replace(/\\/g, '/').split('/');
      return parts[parts.length - 1];
    });
    var fileList = shortNames.join(', ');

    this._el.innerHTML =
      '<span class="fcb-indicator">' + String.fromCharCode(9670) + ' Stale</span>' +
      '<span class="fcb-label">' + label + '</span>' +
      '<span class="fcb-files" title="' + files.join('\n') + '">' + fileList + '</span>' +
      '<span class="fcb-spacer"></span>' +
      '<button class="fcb-redeploy">Re-deploy</button>' +
      '<button class="fcb-dismiss" title="Dismiss">' + String.fromCharCode(10005) + '</button>';

    this._el.classList.add('active');

    var self = this;
    var redeployBtn = this._el.querySelector('.fcb-redeploy');
    var dismissBtn = this._el.querySelector('.fcb-dismiss');

    if (redeployBtn) {
      redeployBtn.onclick = function () {
        self._hide();
        if (self._onRedeploy) self._onRedeploy();
      };
    }
    if (dismissBtn) {
      dismissBtn.onclick = function () {
        self._dismiss(version);
      };
    }
  }

  /**
   * Hide the notification bar.
   * @private
   */
  _hide() {
    if (!this._el) return;
    this._el.classList.remove('active');
    this._el.innerHTML = '';
  }

  /**
   * Dismiss changes through a specific version.
   * @param {number} version
   * @private
   */
  _dismiss(version) {
    this._hide();
    fetch('/api/studio/file-changes/dismiss', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: version })
    }).catch(function () {});
  }

  /**
   * Clean up timers.
   */
  destroy() {
    this.stop();
  }
}
