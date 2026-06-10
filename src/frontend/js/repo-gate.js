/* ============================================================================
   REPO GATE — Startup gate for FLT repo discovery/selection.
   Resolves flt_repo_path before dashboard loads. On first run it always lets
   the user confirm/choose (even for a single scan hit) rather than silently
   auto-selecting; offers a native folder picker (Browse) and manual entry.

   Scoped under .repo-gate-overlay for CSS isolation.
   ============================================================================ */

// eslint-disable-next-line no-unused-vars
class RepoGateOverlay {
  constructor() {
    this._overlay = null;
    this._onComplete = null;
  }

  /**
   * Check if repo gate needs user interaction.
   * @param {object} health - Health response from /api/edog/health
   * @returns {Promise<boolean>} true if repo resolved (no gate needed)
   */
  async tryResolve(health) {
    const repo = health.fltRepo;
    if (repo && repo.valid) return true;

    // Repo not configured or invalid — scan for candidates. We deliberately do
    // NOT auto-select even when the scan returns a single hit: that silent
    // auto-set was how a wrong repo (a decoy clone, or a leaked config path)
    // got locked in without the user ever seeing it. Always surface the picker
    // so the first-run choice is explicit and overridable. See _doRescan/show.
    try {
      const resp = await fetch('/api/edog/repo-scan', { method: 'POST' });
      if (!resp.ok) {
        this._scanResults = [];
        return false;
      }
      const scan = await resp.json();
      this._scanResults = scan.found || [];
      return false;
    } catch {
      this._scanResults = [];
      return false;
    }
  }

  /**
   * Show the repo picker/entry overlay.
   * @param {function} onComplete - Called with repo info on success.
   */
  async show(onComplete) {
    this._onComplete = onComplete || null;
    this._createOverlay();
    document.body.appendChild(this._overlay);

    const results = this._scanResults || [];
    if (results.length >= 1) {
      this._renderPicker(results);
    } else {
      this._renderManualEntry();
    }
  }

  dismiss() {
    if (!this._overlay) return;
    this._overlay.classList.add('fade-out');
    setTimeout(() => {
      if (this._overlay && this._overlay.parentNode) {
        this._overlay.parentNode.removeChild(this._overlay);
      }
      this._overlay = null;
    }, 400);
  }

  // --- Private: DOM ---

  _createOverlay() {
    const overlay = document.createElement('div');
    overlay.className = 'repo-gate-overlay';

    const card = document.createElement('div');
    card.className = 'rg-card';

    const title = document.createElement('h2');
    title.className = 'rg-title';
    title.textContent = 'Locate FLT Repository';

    const subtitle = document.createElement('p');
    subtitle.className = 'rg-subtitle';
    subtitle.textContent = 'EDOG needs your workload-fabriclivetable repo to show branch info and enable deploy.';

    card.appendChild(title);
    card.appendChild(subtitle);

    this._content = document.createElement('div');
    this._content.className = 'rg-content';
    card.appendChild(this._content);

    overlay.appendChild(card);
    this._overlay = overlay;
  }

  _renderPicker(paths) {
    this._content.innerHTML = '';
    this._selectedPath = null;

    const label = document.createElement('p');
    label.className = 'rg-label';
    label.textContent = paths.length === 1
      ? 'Found this repository. Confirm it, or browse to pick a different one:'
      : 'Multiple repositories found. Select one (or browse for another):';
    this._content.appendChild(label);

    const list = document.createElement('div');
    list.className = 'rg-list';

    paths.forEach((p, i) => {
      const item = document.createElement('button');
      item.className = 'rg-item';
      item.type = 'button';
      item.dataset.path = p;

      const pathText = document.createElement('span');
      pathText.className = 'rg-path';
      pathText.textContent = p;
      item.appendChild(pathText);

      item.addEventListener('click', () => {
        list.querySelectorAll('.rg-item').forEach(el => el.classList.remove('selected'));
        item.classList.add('selected');
        this._selectedPath = p;
      });

      // Auto-select first
      if (i === 0) {
        item.classList.add('selected');
        this._selectedPath = p;
      }

      list.appendChild(item);
    });

    this._content.appendChild(list);

    this._errorEl = document.createElement('p');
    this._errorEl.className = 'rg-error';
    this._content.appendChild(this._errorEl);

    this._addConfirmButton();
    this._addBrowseButton();
  }

  _renderManualEntry() {
    this._content.innerHTML = '';
    this._selectedPath = null;

    const label = document.createElement('p');
    label.className = 'rg-label';
    label.textContent = 'No FLT repository found automatically. Browse for it or enter the path:';
    this._content.appendChild(label);

    const inputRow = document.createElement('div');
    inputRow.className = 'rg-input-row';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'rg-input';
    input.placeholder = 'C:\\repos\\workload-fabriclivetable';
    this._input = input;

    inputRow.appendChild(input);
    this._content.appendChild(inputRow);

    this._errorEl = document.createElement('p');
    this._errorEl.className = 'rg-error';
    this._content.appendChild(this._errorEl);

    this._addConfirmButton();
    this._addBrowseButton();

    // Also add a rescan button
    const rescan = document.createElement('button');
    rescan.type = 'button';
    rescan.className = 'rg-rescan';
    rescan.textContent = 'Rescan';
    rescan.addEventListener('click', () => this._doRescan());
    this._content.appendChild(rescan);

    input.focus();
  }

  _addConfirmButton() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'rg-confirm';
    btn.textContent = 'Continue';
    btn.addEventListener('click', () => this._handleConfirm());
    this._content.appendChild(btn);
    this._confirmBtn = btn;
  }

  _addBrowseButton() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'rg-browse';
    btn.textContent = 'Browse\u2026';
    btn.addEventListener('click', () => this._browse());
    this._content.appendChild(btn);
    this._browseBtn = btn;
  }

  /**
   * Open a native OS folder picker (served by the local dev-server) and feed
   * the chosen path through the same validation as a typed/selected path.
   * Browser sandboxing makes a real client-side folder dialog impossible —
   * <input webkitdirectory> yields relative file lists, not an absolute dir —
   * so the picker is backend-driven (POST /api/edog/repo-browse).
   */
  async _browse() {
    this._showError('');
    if (this._browseBtn) {
      this._browseBtn.disabled = true;
      this._browseBtn.textContent = 'Opening\u2026';
    }
    try {
      const resp = await fetch('/api/edog/repo-browse', { method: 'POST' });
      const data = await resp.json().catch(() => ({}));
      if (data && data.path) {
        await this._setRepo(data.path);
      } else if (data && data.error) {
        // No native picker on this host (non-Windows, or PowerShell failed to
        // spawn). The picker view has no text field, so drop to manual entry —
        // which has an input AND a Rescan button — otherwise the instruction to
        // "enter the path manually" points at a field that doesn't exist.
        const prev = this._selectedPath || (this._input && this._input.value.trim());
        this._renderManualEntry();
        if (this._input && prev) this._input.value = prev;
        this._showError('Folder picker is unavailable here — enter the path manually.');
      }
      // cancelled (no path, no error) — leave the overlay as-is.
    } catch {
      this._showError('Could not open the folder picker.');
    } finally {
      if (this._browseBtn) {
        this._browseBtn.disabled = false;
        this._browseBtn.textContent = 'Browse\u2026';
      }
    }
  }

  // --- Private: Actions ---

  async _handleConfirm() {
    const path = this._selectedPath || (this._input && this._input.value.trim());
    if (!path) {
      this._showError('Please enter a path');
      return;
    }

    this._confirmBtn.disabled = true;
    this._confirmBtn.textContent = 'Validating...';

    const ok = await this._setRepo(path);
    if (!ok) {
      this._confirmBtn.disabled = false;
      this._confirmBtn.textContent = 'Continue';
    }
  }

  async _setRepo(path) {
    try {
      const resp = await fetch('/api/edog/repo-set', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        const reason = err.reason || 'unknown';
        const messages = {
          path_not_found: 'Path does not exist',
          not_a_directory: 'Path is not a directory',
          missing_flt_marker: 'Not a valid FLT repo (missing Service/Microsoft.LiveTable.Service)',
        };
        this._showError(messages[reason] || `Invalid path: ${reason}`);
        return false;
      }
      const info = await resp.json();
      this.dismiss();
      if (this._onComplete) this._onComplete(info);
      return true;
    } catch {
      this._showError('Failed to validate path');
      return false;
    }
  }

  async _doRescan() {
    this._showError('');
    try {
      const resp = await fetch('/api/edog/repo-scan', { method: 'POST' });
      if (!resp.ok) return;
      const scan = await resp.json();
      const found = scan.found || [];
      if (found.length > 0) {
        // Always present the choices — never silently lock in a single hit.
        this._scanResults = found;
        this._renderPicker(found);
      } else {
        this._showError('No FLT repositories found');
      }
    } catch {
      this._showError('Scan failed');
    }
  }

  _showError(msg) {
    if (this._errorEl) {
      this._errorEl.textContent = msg || '';
    }
  }
}
